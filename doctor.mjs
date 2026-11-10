// doctor.mjs: health check for the gateway and the Claude Code runner. Run: node gateway.mjs doctor (or npm run doctor)
// Prints "ok|warn|fail <check>: <detail>" lines and exits 1 on any fail. It never prints secrets, hashes or file
// contents: the runner token is compared by hash, and only the last runner.log line (ids and outcomes) is shown.
// The checks reach the machine only through `probe`, so doctorcheck.mjs can fake it on any OS.
// Windows and macOS differ in where the runner lives and what keeps it running; `probe.platform` picks the set.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_UNSAFE, everydayFlags, isBrowser, refusedFlags } from "./web.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = "C:\\ProgramData\\duet-agent"; // where setup-agent.ps1 installs the runner
export const TASK = "duet-agent-runner";
export const MAC_AGENT_DIR = "/Library/Application Support/duet-agent"; // where setup-agent-mac.sh installs it
export const DAEMON = "com.duet-agent.runner";
export const DAEMON_PLIST = `/Library/LaunchDaemons/${DAEMON}.plist`;
const AGENT_USER = "duet-agent";
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const MAX_LOG_LINE = 200;

const sha = s => createHash("sha256").update(s).digest("hex");
const norm = p => path.resolve(p).toLowerCase().replace(/[\\/]+$/, "");
const within = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const run = (cmd, args, opts = {}) => new Promise(resolve =>
  execFile(cmd, args, { windowsHide: true, timeout: 15_000, ...opts }, (err, stdout) => resolve(err ? null : String(stdout))));

// Which of the paths (one per line in DOCTOR_PATHS) the current user owns: Danny's repos when he runs the doctor.
// It prints indexes, not paths, because Windows PowerShell's output is not UTF-8.
// git for Windows also counts a repo owned by Administrators as an admin's own. whoami lists that group even when
// UAC makes it deny-only, so a normal prompt counts those repos too.
const OWNER_PS = `$ErrorActionPreference = 'SilentlyContinue'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$admin = [bool]((whoami /groups) -match 'S-1-5-32-544')
$ps = $env:DOCTOR_PATHS -split "\`n"
for ($i = 0; $i -lt $ps.Length; $i++) {
  $acl = if ([IO.Directory]::Exists($ps[$i])) { [IO.Directory]::GetAccessControl($ps[$i]) } else { [IO.File]::GetAccessControl($ps[$i]) }
  $o = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($o -eq $me -or ($admin -and $o -eq 'S-1-5-32-544')) { $i }
}
exit 0`;
// -EncodedCommand (UTF-16LE base64) so no quote or newline in the script depends on command-line escaping.
// The script uses .NET rather than Get-Acl: run from PowerShell 7, Windows PowerShell inherits a PSModulePath whose
// Microsoft.PowerShell.Security it cannot load. PSModulePath is dropped from its environment for the same reason.
export const ownerArgs = () => ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(OWNER_PS, "utf16le").toString("base64")];

// Whether `ls -lde` output has an ACL entry that denies `user` both list and search, as setup-agent-mac.sh adds to the
// home folder. Without search nothing inside the folder can be reached by path.
export const deniesUser = (acl, user) => String(acl).split("\n").some(l => {
  const m = /^\s*\d+:\s+user:(\S+)\s+(?:inherited\s+)?deny\s+(\S+)/.exec(l);
  return m?.[1] === user && ["list", "search"].every(r => m[2].split(",").includes(r));
});

export function realProbe() {
  return {
    platform: process.platform,
    env: process.env,
    exists: p => fs.existsSync(p),
    isDir: p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    readFile: p => fs.readFileSync(p, "utf8"),
    readdir: p => fs.readdirSync(p),
    real: p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } },
    // The last `bytes` of a file, so a big log is not read whole.
    tail(p, bytes = 4096) {
      const fd = fs.openSync(p, "r");
      try {
        const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, size - n);
        return buf.toString("utf8");
      } finally { fs.closeSync(fd); }
    },
    port: (port, ms = 1500) => new Promise(resolve => {
      const s = net.connect({ host: "127.0.0.1", port });
      const done = ok => { s.destroy(); resolve(ok); };
      s.setTimeout(ms, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    }),
    async mine(paths) {
      if (!paths.length) return [];
      if (process.platform !== "win32") {
        // Under sudo the repos are still Danny's, so the user who ran sudo is the one to compare.
        const uid = (process.getuid?.() === 0 && Number(process.env.SUDO_UID)) || process.getuid?.();
        return paths.filter(p => { try { return fs.statSync(p).uid === uid; } catch { return false; } });
      }
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"));
      const out = await run(POWERSHELL, ownerArgs(), { env: { ...env, DOCTOR_PATHS: paths.join("\n") } });
      return out === null ? null : out.split(/\r?\n/).filter(s => s.trim()).map(s => paths[Number(s)]).filter(Boolean);
    },
    // Status column of `schtasks /query`, e.g. "Running" or "Ready"; null if the task is missing or not visible.
    async task(name) {
      const out = await run("schtasks", ["/query", "/tn", name, "/fo", "csv", "/nh"]);
      const row = out?.split(/\r?\n/).find(l => l.trim());
      return row ? row.trim().replace(/^"|"$/g, "").split('","').at(-1) : null;
    },
    // macOS. sudo keeps HOME there, so this is Danny's home folder either way.
    home: () => os.homedir(),
    // `ls -lde`: the folder's own line, then one line per ACL entry. null if it can't be read.
    acl: p => run("/bin/ls", ["-lde", p]),
    // Command lines of the processes `user` is running; null if they can't be listed (no such user). ps rather than
    // pgrep: only ps may read another user's arguments. -x keeps processes with no terminal (a daemon has none), and
    // -ww stops ps cutting lines at 79 columns when it has no terminal itself.
    async commands(user) {
      const out = await run("ps", ["-x", "-ww", "-U", user, "-o", "command="]);
      return out === null ? null : out.split("\n").map(l => l.trim()).filter(Boolean);
    },
  };
}

// Finds a bare command name on PATH the way the shell would.
function findCommand(cmd, probe) {
  if (/[\\/]/.test(cmd)) return probe.exists(cmd);
  const win = probe.platform === "win32";
  const dirs = String(probe.env.PATH || probe.env.Path || "").split(win ? ";" : ":").filter(Boolean);
  const exts = win && !path.extname(cmd) ? String(probe.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  return dirs.some(d => exts.some(e => probe.exists(path.join(d, cmd + e))));
}

export async function diagnose({ file = process.env.DUET_GATEWAY_CONFIG || path.join(HERE, "config.json"),
  probe = realProbe(), agentDir } = {}) {
  const out = [];
  const add = (level, check, detail) => out.push({ level, check, detail });
  const win = probe.platform === "win32", mac = probe.platform === "darwin";
  agentDir ??= mac ? MAC_AGENT_DIR : AGENT_DIR;
  const setup = mac ? "sudo ./setup-agent-mac.sh" : "setup-agent.ps1";

  let cfg;
  try { cfg = JSON.parse(probe.readFile(file)); }
  catch (e) {
    // JSON.parse messages quote the config text around the error, so only the position is shown.
    const where = /position \d+( \(line \d+ column \d+\))?/.exec(e.message)?.[0];
    add("fail", "config", e.code === "ENOENT" ? `${file} not found (copy ${mac ? "config.example.mac.json" : "config.example.json"})`
      : e instanceof SyntaxError ? `${file} is not valid JSON${where ? ` (${where})` : ""}` : `${file} unreadable (${e.code || "error"})`);
    return out;
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) { add("fail", "config", `${file} is not a JSON object`); return out; }
  add("ok", "config", file);

  add(...(/^scrypt\$[0-9a-f]+\$[0-9a-f]{64}$/.test(cfg.passphraseHash || "") ? ["ok", "passphrase", "set"]
    : ["fail", "passphrase", "not set, so nobody can sign in: run npm run set-passphrase"]));

  let url = null;
  try { url = new URL(cfg.publicUrl); } catch {}
  add(...(url?.protocol === "https:" ? ["ok", "publicUrl", url.origin]
    : ["fail", "publicUrl", url ? `${url.origin} is not https (Claude needs the Tailscale Funnel https URL)` : "missing or not a URL"]));

  const str = v => typeof v === "string" && v !== "";
  const strs = v => (Array.isArray(v) ? v.filter(str) : []);
  const cc = cfg.claude && typeof cfg.claude === "object" ? cfg.claude : null;
  // The Egnyte drive is Z:\ on Windows. Elsewhere there is none unless egnyteRoot names one, and its checks are skipped.
  const egnyteRoot = str(cc?.egnyteRoot) ? cc.egnyteRoot : win ? "Z:\\" : null;
  // Both spellings of a folder, as written and its real path (a junction or link may point somewhere else).
  const both = p => [...new Set([norm(p), norm(probe.real(p))])];
  const eg = egnyteRoot ? both(egnyteRoot) : [];
  const onEgnyte = p => both(p).some(n => eg.some(e => within(n, e)));
  const deny = strs(cfg.deny).flatMap(both);
  const roots = strs(cfg.roots);
  if (!roots.length) add("warn", "roots", "none, so files_* can read nothing");
  for (const r of roots) {
    if (onEgnyte(r)) add("fail", `root ${r}`, `is on the Egnyte drive (${egnyteRoot}); work files must stay out of roots`);
    else if (both(r).some(n => eg.some(e => within(e, n))) && !deny.some(d => eg.some(e => within(e, d))))
      add("fail", `root ${r}`, `contains the Egnyte drive (${egnyteRoot}) and deny does not cover it`);
    else if (!probe.isDir(r)) add("fail", `root ${r}`, "folder not found");
    else add("ok", `root ${r}`, "exists");
  }

  const offFile = path.join(path.dirname(file), "duet.OFF");
  add(...(probe.exists(offFile) ? ["warn", "duet.OFF", "present: new Claude Code turns are refused (delete it to turn them back on)"]
    : ["ok", "duet.OFF", "absent"]));

  const pc = Array.isArray(cfg.upstreams) ? cfg.upstreams.find(u => u?.prefix === "pc") : null;
  // Tools that would get around the allowlist or reach outside the screen (clipboard, toasts, batch's sub-commands).
  const UNSAFE = ["clipboard_get", "clipboard_set", "clipboard_clear", "batch", "list_notifications", "notification_action",
    "dismiss_notification", "dismiss_all_notifications"].map(n => "desktop_" + n);
  const unsafe = Array.isArray(pc?.allow) ? pc.allow.filter(n => UNSAFE.includes(n)) : [];
  // Same rule as makeContext: an upstream runs unless enabled is false.
  add(...(!pc || pc.enabled === false ? ["ok", "desktop control", "off"]
    : !Array.isArray(pc.allow) || !str(pc.offFile)
      ? ["fail", "desktop control", "pc upstream has no allowlist or offFile (see config.example.json)"]
    : unsafe.length ? ["fail", "desktop control", `pc allowlist includes ${unsafe.join(", ")}`]
    : !probe.exists(String(pc.command)) ? ["fail", "desktop control", `agent-desktop not found at ${pc.command}`]
    // The same file the gateway checks: offFile next to config.json.
    : probe.exists(path.join(path.dirname(file), pc.offFile)) ? ["warn", "desktop control", `switched off (${pc.offFile})`]
    : ["ok", "desktop control", "on; claude.ai decides whether act tools ask first (README: Approvals)"]));
  // The work-app guard is gone, so a screenGuard left in config.json does nothing. Say so instead of letting it look active.
  const stale = (Array.isArray(cfg.upstreams) ? cfg.upstreams : []).filter(u => u?.screenGuard !== undefined).map(u => String(u.prefix));
  if (stale.length) add("warn", "screenGuard", `ignored on ${stale.join(", ")}: the work-app guard was removed, so open work apps are not blocked. Delete it from config.json`);

  // The web browser (Playwright MCP): the same startup rules as the gateway, plus what only the doctor can see.
  const web = (Array.isArray(cfg.upstreams) ? cfg.upstreams : []).find(u => u && isBrowser(u));
  const webUnsafe = Array.isArray(web?.allow) ? web.allow.filter(n => BROWSER_UNSAFE.includes(n)) : [];
  const script = strs(web?.args).find(a => /\.[cm]?js$/i.test(a));
  add(...(!web || web.enabled === false ? ["ok", "web browser", "off"]
    : !Array.isArray(web.allow) || !str(web.offFile)
      ? ["fail", "web browser", `${web.prefix} upstream has no allowlist or offFile (see config.example.json)`]
    : refusedFlags(web.args).length ? ["fail", "web browser", `${web.prefix} upstream may not use ${refusedFlags(web.args).join(", ")}`]
    : webUnsafe.length ? ["fail", "web browser", `${web.prefix} allowlist includes ${webUnsafe.join(", ")}`]
    : !findCommand(String(web.command), probe) ? ["fail", "web browser", `${web.command} not found`]
    : script && !probe.exists(script) ? ["fail", "web browser", `Playwright MCP not found at ${script}: run npm install`]
    : probe.exists(path.join(path.dirname(file), web.offFile)) ? ["warn", "web browser", `switched off (${web.offFile})`]
    : everydayFlags(web.args).length
      ? ["warn", "web browser", `on, attached to your everyday browser (${everydayFlags(web.args).join(", ")}): every sign-in in it is in reach, work ones too`]
    : ["ok", "web browser", "on, with its own profile"]));

  const port = cfg.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) add("fail", "gateway port", `port is not set in config.json (normally ${mac ? 8790 : 8787})`);
  else add(...(await probe.port(port) ? ["ok", "gateway port", `127.0.0.1:${port} answers`]
    : ["fail", "gateway port", `nothing answers on 127.0.0.1:${port}: start the gateway (${mac ? "./gateway-launchd.sh" : "npm start"})`]));

  if (!cc) { add("warn", "claude", "no claude section, so Claude Code sessions are off"); return out; }

  if (!str(cc.command)) add("fail", "claude.command", "not set");
  else add(...(findCommand(cc.command, probe) ? ["ok", "claude.command", cc.command] : ["fail", "claude.command", `${cc.command} not found`]));

  const tokenFile = path.join(agentDir, "runner-token");
  if (!cc.runnerToken) add("warn", "runnerToken", `not set, so normal sessions are off (run ${setup})`);
  else {
    let disk = null, missing = false;
    try { disk = probe.readFile(tokenFile).trim(); } catch (e) { missing = e.code === "ENOENT"; }
    add(...(missing ? ["fail", "runnerToken", `set, but ${tokenFile} is missing: run ${setup} again`]
      : disk === null ? ["ok", "runnerToken", `set (${tokenFile} is not readable here, so not compared; ${mac ? "sudo npm run doctor" : "an elevated prompt"} can)`]
      : sha(disk) === sha(String(cc.runnerToken).trim()) ? ["ok", "runnerToken", `set and matches ${tokenFile}`]
      : ["fail", "runnerToken", `does not match ${tokenFile}: run ${setup} again`]));
  }

  // macOS puts every local user in staff, which can read most home folders. The deny entry setup-agent-mac.sh adds to
  // Danny's home folder is what keeps duet-agent out of it, so its loss is a fail.
  if (mac && cc.runnerToken) {
    const home = probe.home(), acl = await probe.acl(home);
    add(...(acl === null ? ["warn", "home folder", `could not read the ACL of ${home}`]
      : deniesUser(acl, AGENT_USER) ? ["ok", "home folder", `${home} denies ${AGENT_USER}`]
      : ["fail", "home folder", `${home} has no deny entry for ${AGENT_USER}, so sessions can read it: run ${setup} again`]));
  }

  // A repo of Danny's in or above a workspace runs whatever duet-agent writes there (hooks, .vscode, .claude) as Danny.
  // Each workspace's real path is scanned: itself, its direct children, its ancestors, and its parent's direct children
  // (no deeper; not when the parent is a drive root, since D:\Duet next to a repo in D:\ is fine).
  const ws = cc.workspaces && typeof cc.workspaces === "object" ? Object.entries(cc.workspaces).filter(([, d]) => str(d)) : [];
  if (!ws.length) add("warn", "workspaces", "none, so normal sessions have nowhere to work");
  const gitsIn = d => { try { return probe.readdir(d).map(k => path.join(d, k, ".git")); } catch { return []; } };
  const scans = ws.map(([name, dir]) => {
    if (onEgnyte(dir)) return { name, dir, bad: `${dir} is on the Egnyte drive` };
    if (!probe.isDir(dir)) return { name, dir, bad: `${dir} not found` };
    const abs = path.resolve(probe.real(dir)), parent = path.dirname(abs);
    const inside = [path.join(abs, ".git"), ...gitsIn(abs)];
    for (let d = parent; ; d = path.dirname(d)) {
      inside.push(path.join(d, ".git"));
      if (path.dirname(d) === d) break;
    }
    const near = path.dirname(parent) === parent ? [] : gitsIn(parent).filter(g => norm(g) !== norm(path.join(abs, ".git")));
    return { name, dir, parent, inside: inside.filter(probe.exists), near: near.filter(probe.exists) };
  });
  const mine = await probe.mine([...new Set(scans.flatMap(s => [...(s.inside || []), ...(s.near || [])]))]);
  const hit = list => mine.find(m => list.some(g => norm(g) === norm(m)));
  for (const s of scans) {
    const check = `workspace ${s.name}`;
    if (s.bad) add("fail", check, s.bad);
    else if (mine === null) add("warn", check, `${s.dir} exists; could not check who owns the repos near it`);
    else if (hit(s.inside)) add("fail", check, `${s.dir} holds or is inside your own repo (${path.dirname(hit(s.inside))}); anything duet-agent writes there runs as you`);
    else if (hit(s.near)) add("fail", check, `${s.dir} is inside ${s.parent}, which holds your own repos; use a folder of its own such as ${mac ? "/Users/Shared/Duet" : "D:\\Duet"}`);
    else add("ok", check, `${s.dir} exists, none of your repos in, above or beside it`);
  }

  add(...(cc.egnyteEnabled !== true ? ["ok", "egnyteEnabled", "off"]
    : egnyteRoot ? ["warn", "egnyteEnabled", "on: confirm both Egnyte tools are Needs approval in claude.ai"]
    : ["warn", "egnyteEnabled", "on, but this machine has no Egnyte drive: set it to false"]));
  if (egnyteRoot) add(...(probe.exists(egnyteRoot) ? ["ok", "Egnyte drive", `${egnyteRoot} mounted`]
    : [cc.egnyteEnabled === true ? "warn" : "ok", "Egnyte drive", `${egnyteRoot} not mounted${cc.egnyteEnabled === true ? " (sign in to the desktop with Egnyte running)" : ""}`]));

  const rport = cc.runnerPort || 8788;
  add(...(await probe.port(rport) ? ["ok", "runner port", `127.0.0.1:${rport} answers`]
    : [cc.runnerToken ? "fail" : "warn", "runner port", `nothing answers on 127.0.0.1:${rport}${cc.runnerToken ? " (the gateway opens it when runnerToken is set)" : ""}`]));

  if (win) {
    const state = await probe.task(TASK);
    add(...(state === null ? ["warn", "runner task", `${TASK} not found or not visible here (run setup-agent.ps1, or try an elevated prompt)`]
      : /^running$/i.test(state) ? ["ok", "runner task", `${TASK} Running`]
      : ["warn", "runner task", `${TASK} ${state}: Start-ScheduledTask ${TASK}`]));
  } else if (mac) {
    // The LaunchDaemon's plist says it is installed; the runner process, run as duet-agent, says it is up.
    const runner = path.join(agentDir, "bin", "runner.mjs");
    add(...(!probe.exists(DAEMON_PLIST) ? ["warn", "runner daemon", `${DAEMON} is not installed (run ${setup})`]
      : (await probe.commands(AGENT_USER))?.some(c => c.endsWith(runner)) ? ["ok", "runner daemon", `${DAEMON} running as ${AGENT_USER}`]
      : ["warn", "runner daemon", `${DAEMON} is installed but not running: sudo launchctl kickstart -k system/${DAEMON}`]));
  }

  const logFile = path.join(agentDir, "logs", "runner.log");
  let last = null;
  try { last = probe.tail(logFile).split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) ?? ""; } catch {}
  if (last === null) add(cc.runnerToken ? "warn" : "ok", "runner log", `${logFile} not readable`);
  else {
    last = last.replace(/[\x00-\x1f\x7f]/g, " ");
    if (last.length > MAX_LOG_LINE) last = last.slice(0, MAX_LOG_LINE) + "…";
    add(/fail|error/i.test(last) ? "warn" : "ok", "runner log", last || "empty");
  }
  return out;
}

export const format = r => `${r.level.padEnd(4)} ${r.check}: ${r.detail}`;

export async function runDoctor(opts = {}, print = console.log) {
  const results = await diagnose(opts);
  for (const r of results) print(format(r));
  return results.some(r => r.level === "fail") ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runDoctor();

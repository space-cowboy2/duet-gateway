// doctor.mjs: health check for the gateway and the Claude Code runner. Run: node gateway.mjs doctor (or npm run doctor)
// Prints "ok|warn|fail <check>: <detail>" lines and exits 1 on any fail. It never prints secrets, hashes or file
// contents: the runner token is compared by hash, and only the last runner.log line (ids and outcomes) is shown.
// The checks reach the machine only through `probe`, so doctorcheck.mjs can fake it on any OS.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = "C:\\ProgramData\\duet-agent"; // where setup-agent.ps1 installs the runner
export const TASK = "duet-agent-runner";
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
        const uid = process.getuid?.();
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
  probe = realProbe(), agentDir = AGENT_DIR } = {}) {
  const out = [];
  const add = (level, check, detail) => out.push({ level, check, detail });

  let cfg;
  try { cfg = JSON.parse(probe.readFile(file)); }
  catch (e) {
    // JSON.parse messages quote the config text around the error, so only the position is shown.
    const where = /position \d+( \(line \d+ column \d+\))?/.exec(e.message)?.[0];
    add("fail", "config", e.code === "ENOENT" ? `${file} not found (copy config.example.json)`
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
  const egnyteRoot = str(cc?.egnyteRoot) ? cc.egnyteRoot : "Z:\\";
  // Both spellings of a folder, as written and its real path (a junction or link may point somewhere else).
  const both = p => [...new Set([norm(p), norm(probe.real(p))])];
  const eg = both(egnyteRoot);
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
  // Tools that would get around the guard or show work data (clipboard, toasts, batch's sub-commands).
  const UNSAFE = ["clipboard_get", "clipboard_set", "clipboard_clear", "batch", "list_notifications", "notification_action",
    "dismiss_notification", "dismiss_all_notifications"].map(n => "desktop_" + n);
  const guard = pc?.screenGuard;
  const unsafe = Array.isArray(pc?.allow) ? pc.allow.filter(n => UNSAFE.includes(n)) : [];
  // Same rule as makeContext: an upstream runs unless enabled is false.
  add(...(!pc || pc.enabled === false ? ["ok", "desktop control", "off"]
    : !Array.isArray(pc.allow) || !(strs(guard?.apps).length || strs(guard?.titles).length)
      ? ["fail", "desktop control", "pc upstream has no allowlist or screen guard (see config.example.json)"]
    : unsafe.length ? ["fail", "desktop control", `pc allowlist includes ${unsafe.join(", ")}`]
    : !probe.exists(String(pc.command)) ? ["fail", "desktop control", `agent-desktop not found at ${pc.command}`]
    : probe.exists(path.join(path.dirname(file), "desktop.OFF")) ? ["warn", "desktop control", "switched off (desktop.OFF)"]
    : ["ok", "desktop control", "on; turn on Needs approval for act tools in claude.ai"]));

  const port = cfg.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) add("fail", "gateway port", "port is not set in config.json (normally 8787)");
  else add(...(await probe.port(port) ? ["ok", "gateway port", `127.0.0.1:${port} answers`]
    : ["fail", "gateway port", `nothing answers on 127.0.0.1:${port}: start the gateway (npm start)`]));

  if (!cc) { add("warn", "claude", "no claude section, so Claude Code sessions are off"); return out; }

  if (!str(cc.command)) add("fail", "claude.command", "not set");
  else add(...(findCommand(cc.command, probe) ? ["ok", "claude.command", cc.command] : ["fail", "claude.command", `${cc.command} not found`]));

  const tokenFile = path.join(agentDir, "runner-token");
  if (!cc.runnerToken) add("warn", "runnerToken", "not set, so normal sessions are off (run setup-agent.ps1)");
  else {
    let disk = null, missing = false;
    try { disk = probe.readFile(tokenFile).trim(); } catch (e) { missing = e.code === "ENOENT"; }
    add(...(missing ? ["fail", "runnerToken", `set, but ${tokenFile} is missing: run setup-agent.ps1 again`]
      : disk === null ? ["ok", "runnerToken", `set (${tokenFile} is not readable here, so not compared; an elevated prompt can)`]
      : sha(disk) === sha(String(cc.runnerToken).trim()) ? ["ok", "runnerToken", `set and matches ${tokenFile}`]
      : ["fail", "runnerToken", `does not match ${tokenFile}: run setup-agent.ps1 again`]));
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
    else if (hit(s.near)) add("fail", check, `${s.dir} is inside ${s.parent}, which holds your own repos; use a folder of its own such as D:\\Duet`);
    else add("ok", check, `${s.dir} exists, none of your repos in, above or beside it`);
  }


  add(...(cc.egnyteEnabled === true ? ["warn", "egnyteEnabled", "on: confirm both Egnyte tools are Needs approval in claude.ai"]
    : ["ok", "egnyteEnabled", "off"]));
  add(...(probe.exists(egnyteRoot) ? ["ok", "Egnyte drive", `${egnyteRoot} mounted`]
    : [cc.egnyteEnabled === true ? "warn" : "ok", "Egnyte drive", `${egnyteRoot} not mounted${cc.egnyteEnabled === true ? " (sign in to the desktop with Egnyte running)" : ""}`]));

  const rport = cc.runnerPort || 8788;
  add(...(await probe.port(rport) ? ["ok", "runner port", `127.0.0.1:${rport} answers`]
    : [cc.runnerToken ? "fail" : "warn", "runner port", `nothing answers on 127.0.0.1:${rport}${cc.runnerToken ? " (the gateway opens it when runnerToken is set)" : ""}`]));

  if (probe.platform === "win32") {
    const state = await probe.task(TASK);
    add(...(state === null ? ["warn", "runner task", `${TASK} not found or not visible here (run setup-agent.ps1, or try an elevated prompt)`]
      : /^running$/i.test(state) ? ["ok", "runner task", `${TASK} Running`]
      : ["warn", "runner task", `${TASK} ${state}: Start-ScheduledTask ${TASK}`]));
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

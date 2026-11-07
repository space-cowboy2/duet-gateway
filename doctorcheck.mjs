// Doctor check: the health checks in doctor.mjs against a fake machine, plus the real probe's port and owner checks
// and `node gateway.mjs doctor` with a missing config. Runs on Windows, macOS and Linux. Run: node doctorcheck.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { diagnose, format, realProbe, runDoctor } from "./doctor.mjs";

const B = path.resolve("/fake"), P = (...a) => path.join(B, ...a);
const HASH = "scrypt$" + "ab".repeat(16) + "$" + "cd".repeat(32), TOKEN = "secret-runner-token-123";
const agentDir = P("agent"), cfgFile = P("gw", "config.json");

// A fake machine: dirs, files (path → text), which .git dirs are Danny's, listening ports, task state, links (path → real path).
function fakeProbe({ dirs = [], files = {}, mine = [], ports = [], task = "Running", platform = "win32", env = {}, links = {} } = {}) {
  const D = new Set(dirs.map(d => path.resolve(d))), F = new Map(Object.entries(files).map(([k, v]) => [path.resolve(k), v]));
  const all = () => [...D, ...F.keys()];
  return {
    platform, env,
    exists: p => D.has(path.resolve(p)) || F.has(path.resolve(p)),
    isDir: p => D.has(path.resolve(p)),
    readFile: p => { if (!F.has(path.resolve(p))) throw Object.assign(new Error("nope"), { code: "ENOENT" }); return F.get(path.resolve(p)); },
    readdir: p => { const r = path.resolve(p); if (!D.has(r)) throw new Error("nope"); return [...new Set(all().filter(x => path.dirname(x) === r).map(x => path.basename(x)))]; },
    tail(p) { return this.readFile(p); },
    port: async n => ports.includes(n),
    async mine(ps) { this.calls.mine++; return (mine === null ? null : ps.filter(p => mine.some(m => path.resolve(m) === path.resolve(p)))); },
    task: async () => task,
    real: p => path.resolve(links[path.resolve(p)] ?? p),
    calls: { mine: 0 },
  };
}

const goodCfg = over => JSON.stringify({
  port: 8787, publicUrl: "https://pc.example.ts.net", passphraseHash: HASH, roots: [P("docs")], deny: [],
  ...over, claude: { command: P("bin", "claude.exe"), runnerPort: 8788, runnerToken: TOKEN, egnyteRoot: P("Z"),
    workspaces: { duet: P("Duet") }, ...over?.claude },
});
const healthy = (over = {}, probeOver = {}) => fakeProbe({
  dirs: [B, P("gw"), P("docs"), P("Duet"), P("Duet", "clone"), P("Duet", "clone", ".git"), P("Z"), P("bin"), agentDir],
  files: { [cfgFile]: goodCfg(over), [P("bin", "claude.exe")]: "", [path.join(agentDir, "runner-token")]: TOKEN + "\n",
    [path.join(agentDir, "logs", "runner.log")]: "2026-11-01T00:00:00Z runner started\n2026-11-01T00:01:00Z turn s_1 done\n" },
  ports: [8787, 8788], ...probeOver,
});
const run = async (probe, opts = {}) => {
  const r = await diagnose({ file: cfgFile, probe, agentDir, ...opts });
  const text = r.map(format).join("\n");
  assert.ok(!text.includes(TOKEN) && !text.includes(HASH) && !text.includes("cd".repeat(32)), "doctor printed a secret:\n" + text);
  const by = check => r.find(x => x.check === check) || assert.fail(`no ${check} line in:\n${text}`);
  return { r, text, by, fails: r.filter(x => x.level === "fail").map(x => x.check) };
};

// 1. Healthy machine: all ok, duet clone owned by duet-agent is fine.
{
  const { r, text, fails, by } = await run(healthy());
  assert.deepEqual(fails, [], text);
  assert.ok(r.every(x => x.level === "ok"), text);
  assert.match(by("runnerToken").detail, /matches/);
  assert.match(by("runner task").detail, /Running/);
  assert.match(by("runner log").detail, /turn s_1 done$/);
  assert.match(by("Egnyte drive").detail, /mounted/);
  for (const line of text.split("\n")) assert.match(line, /^(ok  |warn|fail) [^:]+: /);
}

// 2. Config: missing, broken (the error must not quote the file), not an object.
{
  let { r } = await run(fakeProbe());
  assert.equal(r.length, 1); assert.equal(r[0].level, "fail"); assert.match(r[0].detail, /not found/);
  ({ r } = await run(fakeProbe({ files: { [cfgFile]: `{"passphraseHash": "${HASH}" "runnerToken": "${TOKEN}"}` } })));
  assert.equal(r[0].level, "fail"); assert.match(r[0].detail, /not valid JSON/);
  ({ r } = await run(fakeProbe({ files: { [cfgFile]: "[1]" } })));
  assert.match(r[0].detail, /not a JSON object/);
}

// 3. Gateway-level problems.
{
  const { by, fails } = await run(healthy({ passphraseHash: "", publicUrl: "http://pc.example.ts.net", roots: [P("Z", "work"), P("gone")] },
    { ports: [8788] }));
  assert.deepEqual(fails.sort(), ["gateway port", "passphrase", "publicUrl", `root ${P("Z", "work")}`, `root ${P("gone")}`].sort());
  assert.match(by(`root ${P("Z", "work")}`).detail, /Egnyte/);
  assert.equal((await run(healthy({ roots: [B] }))).by(`root ${B}`).level, "fail"); // contains Z, not denied
  assert.equal((await run(healthy({ roots: [B], deny: [P("Z")] }))).by(`root ${B}`).level, "ok");
}

// 4. Claude section: token mismatch, unreadable token, missing command, workspaces near Danny's repos.
{
  const mismatch = healthy({ claude: { runnerToken: "other-token" } });
  assert.match((await run(mismatch)).by("runnerToken").detail, /does not match/);
  const p = healthy(); p.readFile = (f => x => { if (x.endsWith("runner-token")) throw new Error("EPERM"); return f(x); })(p.readFile);
  const t = (await run(p)).by("runnerToken");
  assert.equal(t.level, "ok"); assert.match(t.detail, /not readable/);
  assert.equal((await run(healthy({ claude: { command: P("nope.exe") } }))).by("claude.command").level, "fail");
  // Bare command found on PATH (with PATHEXT on Windows).
  assert.equal((await run(healthy({ claude: { command: "claude" } }, { env: { PATH: P("bin"), PATHEXT: ".com;.exe" } }))).by("claude.command").level, "ok");
  assert.equal((await run(healthy({ claude: { command: "claude" } }, { env: { PATH: P("gw") } }))).by("claude.command").level, "fail");

  const repos = { dirs: [B, P("gw"), P("docs"), P("Z"), P("bin"), P("Projects"), P("Projects", "app"), P("Projects", "app", ".git"),
    P("Projects", "scratch"), P("Duet"), P("Duet", "clone"), P("Duet", "clone", ".git")], mine: [P("Projects", "app", ".git")] };
  const ws = async (dir, probeOver = {}) => (await run(healthy({ claude: { workspaces: { w: dir } } }, { ...repos, ...probeOver }))).by("workspace w");
  assert.equal((await ws(P("Projects"))).level, "fail");                        // holds Danny's repo
  assert.equal((await ws(P("Projects", "app"))).level, "fail");                 // is Danny's repo
  assert.equal((await ws(P("Projects", "app", "src"), { dirs: [...repos.dirs, P("Projects", "app", "src")] })).level, "fail"); // inside it
  assert.match((await ws(P("Projects", "scratch"))).detail, /holds your own repos/); // beside it
  assert.equal((await ws(P("Duet"))).level, "ok");                              // duet-agent's own clones are fine
  assert.equal((await ws(P("Duet"), { mine: [P("Duet", "clone", ".git")] })).level, "fail");
  assert.equal((await ws(P("Duet"), { mine: null })).level, "warn");
  assert.equal((await ws(P("missing"))).level, "fail");
  assert.equal((await ws(P("Z", "w"))).level, "fail");
  // A junction is judged by where it points.
  const linked = { dirs: [...repos.dirs, P("Projects", "app", "work")], links: { [P("Duet")]: P("Projects", "app", "work") } };
  assert.equal((await ws(P("Duet"), linked)).level, "fail");
  assert.equal((await run(healthy({ roots: [P("docs")] }, { links: { [P("docs")]: P("Z", "Shared") } }))).by(`root ${P("docs")}`).level, "fail");
  // All workspaces share one owner lookup (one PowerShell start on Windows).
  const two = healthy({ claude: { workspaces: { a: P("Duet"), b: P("Projects", "scratch") } } }, repos);
  await run(two);
  assert.equal(two.calls.mine, 1);

  const gone = healthy(); gone.readFile = (f => x => { if (x.endsWith("runner-token")) throw Object.assign(new Error("x"), { code: "ENOENT" }); return f(x); })(gone.readFile);
  assert.match((await run(gone)).by("runnerToken").detail, /missing/);
}

// 4b. Wrong types in config.json give lines, not a crash; a missing port is a fail.
{
  const { by, text } = await run(healthy({ port: undefined, deny: "Z:\\", roots: [5, P("docs")],
    claude: { egnyteRoot: 3, command: 7, workspaces: { a: 1, duet: P("Duet") }, runnerPort: 8788 } }));
  assert.equal(by("gateway port").level, "fail");
  assert.equal(by("claude.command").level, "fail");
  assert.equal(by(`root ${P("docs")}`).level, "ok");
  assert.equal(by("workspace duet").level, "ok");
  assert.match(text, /runner log/);
}

// 5. Egnyte, kill switch, runner port/task/log.
{
  let { by } = await run(healthy({ claude: { egnyteEnabled: true } }, { dirs: [B, P("gw"), P("docs"), P("Duet"), P("bin")] }));
  assert.equal(by("egnyteEnabled").level, "warn"); assert.match(by("egnyteEnabled").detail, /Needs approval/);
  assert.equal(by("Egnyte drive").level, "warn");
  ({ by } = await run(healthy({}, { dirs: [B, P("gw"), P("docs"), P("Duet"), P("bin")] })));
  assert.equal(by("Egnyte drive").level, "ok");                                 // not mounted, but Egnyte is off

  const off = healthy(); const f = off.exists; off.exists = x => path.resolve(x) === P("gw", "duet.OFF") || f(x);
  assert.equal((await run(off)).by("duet.OFF").level, "warn");

  assert.equal((await run(healthy({}, { ports: [8787] }))).by("runner port").level, "fail");
  ({ by } = await run(healthy({ claude: { runnerToken: "" } }, { ports: [8787] })));
  assert.equal(by("runner port").level, "warn"); assert.equal(by("runnerToken").level, "warn");
  assert.equal((await run(healthy({}, { task: "Ready" }))).by("runner task").level, "warn");
  assert.equal((await run(healthy({}, { task: null }))).by("runner task").level, "warn");
  assert.ok(!(await run(healthy({}, { platform: "linux" }))).r.some(x => x.check === "runner task"));

  const long = healthy(); long.tail = () => "a\n" + "turn x failed " + "y".repeat(500) + "\x1b[31m\n\n";
  ({ by } = await run(long));
  assert.equal(by("runner log").level, "warn"); assert.ok(by("runner log").detail.length <= 201); assert.ok(!by("runner log").detail.includes("\x1b"));

  ({ by } = await run(healthy({ claude: undefined }, { files: { [cfgFile]: JSON.stringify({ port: 8787, publicUrl: "https://x.ts.net", passphraseHash: HASH, roots: [] }) } })));
  assert.equal(by("claude").level, "warn");
}

// 6. Exit code.
{
  const lines = [];
  assert.equal(await runDoctor({ file: cfgFile, probe: healthy(), agentDir }, l => lines.push(l)), 0);
  assert.ok(lines.length > 10);
  assert.equal(await runDoctor({ file: cfgFile, probe: healthy({}, { ports: [] }), agentDir }, () => {}), 1);
}

// 7. The real probe: ports, owner of a .git this process made, log tail.
{
  const real = realProbe();
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise(r => srv.once("listening", r));
  const port = srv.address().port;
  assert.equal(await real.port(port), true);
  await new Promise(r => srv.close(r));
  assert.equal(await real.port(port), false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duet-doctor-"));
  const git = path.join(tmp, "repo", ".git");
  fs.mkdirSync(git, { recursive: true });
  assert.deepEqual(await real.mine([git]), [git], "a .git this process created should count as the current user's");
  assert.deepEqual(await real.mine([path.join(tmp, "missing")]), []);
  fs.writeFileSync(path.join(tmp, "log"), "x".repeat(10_000) + "\nlast line\n");
  assert.equal(real.tail(path.join(tmp, "log"), 64).trim().split("\n").at(-1), "last line");

  // `node gateway.mjs doctor` reports a missing config instead of crashing.
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "gateway.mjs"), "doctor"],
    { encoding: "utf8", env: { ...process.env, DUET_GATEWAY_CONFIG: path.join(tmp, "nope.json") } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^fail config: .*not found/m);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("doctorcheck: all passed");

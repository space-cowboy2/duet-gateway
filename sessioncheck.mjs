// Session check: Duet's Claude Code session tools, Egnyte flags, the runner protocol and the kill switch,
// with a fake Claude Code. Runs on Windows and macOS. Run: node sessioncheck.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { makeContext, setLogFile } from "./gateway.mjs";
import { startRunner } from "./runner.mjs";
import { egnyteFlags, pathRule } from "./sessions.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duet-sess-"));
const egnyte = path.join(tmp, "egnyte"), ws = path.join(tmp, "ws"), other = path.join(tmp, "other");
for (const d of [egnyte, ws, other]) fs.mkdirSync(d);
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");

// Fake Claude Code: echoes what it was asked to do and which permission flags it got.
const fake = path.join(tmp, "fake-claude.mjs");
fs.writeFileSync(fake, `
import fs from "node:fs"; import path from "node:path";
const a = process.argv.slice(2), val = f => a[a.indexOf(f) + 1];
const id = val("--session-id") || val("--resume");
let prompt = ""; for await (const c of process.stdin) prompt += c;
if (prompt.includes("FAIL")) { console.error("boom"); process.exit(3); }
if (prompt.includes("SLEEP")) await new Promise(r => setTimeout(r, 1500));
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "p"); fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, id + ".jsonl"), "{}\\n");
const allowed = a.includes("--allowedTools") ? a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools")) : [];
console.log(JSON.stringify({ type: "result", is_error: false, session_id: id, result: [
  a.includes("--resume") ? "resumed" : "new", "mode=" + val("--permission-mode"), "cwd=" + process.cwd(),
  "allowed=" + allowed.join(","), "bash_denied=" + a.slice(a.indexOf("--disallowedTools")).includes("Bash"),
  "rules=" + a.includes("--append-system-prompt"), "prompt=" + prompt].join(" | ") }));
`);

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = "runner-token-for-tests";
fs.writeFileSync(path.join(tmp, "runner-token"), TOKEN);
const runnerPort = await freePort();
const claude = { command: process.execPath, args: [fake] };
const cfg = {
  roots: [tmp], deny: [], denyNames: [], commands: {}, upstreams: [], stateFile: path.join(tmp, "state.json"),
  claude: { ...claude, runnerToken: TOKEN, runnerPort, egnyteRoot: egnyte, egnyteEnabled: true, workspaces: { projects: ws, other }, turnTimeoutSecs: 20 },
};
setLogFile(path.join(tmp, "gateway.log"));
const call = async (ctx, name, args) => {
  const r = await ctx.callTool(name, args);
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

let srv, runner;
try {
  const ctx = makeContext(cfg);
  const names = (await ctx.listTools()).map(t => t.name);
  for (const n of ["start_session", "send_message", "read_messages", "list_sessions", "end_session", "start_egnyte_session", "send_egnyte_message"])
    assert.ok(names.includes(n), n);

  // Egnyte, read mode: read-only tools, rules, runs in the Egnyte folder
  let r = await call(ctx, "start_egnyte_session", { prompt: "summarize the budget", mode: "read", wait_seconds: 10 });
  const eid = r.session_id;
  assert.equal(r.replies.length, 1, JSON.stringify(r));
  const t = r.replies[0].text;
  assert.match(t, /^new \| mode=dontAsk/);
  assert.ok(t.includes(`allowed=Read(${pathRule(egnyte)}),Glob,Grep |`), t);
  assert.match(t, /bash_denied=true/);
  assert.match(t, /rules=true/);
  assert.ok(t.includes("cwd=" + fs.realpathSync(egnyte)) || t.includes("cwd=" + egnyte), t);
  assert.match(t, /Session from Duet: summarize the budget/);
  await assert.rejects(call(ctx, "send_message", { session_id: eid, text: "more" }), /send_egnyte_message/);
  r = await call(ctx, "send_egnyte_message", { session_id: eid, text: "and the totals", wait_seconds: 10 });
  assert.match(r.replies[0].text, /^resumed \| mode=dontAsk.*prompt=and the totals$/s);
  assert.equal((await call(ctx, "read_messages", { session_id: eid })).replies.length, 0, "replies are read once");

  // Egnyte, edit mode
  r = await call(ctx, "start_egnyte_session", { prompt: "fix the typo", mode: "edit", wait_seconds: 10 });
  assert.match(r.replies[0].text, /mode=dontAsk/);
  assert.ok(r.replies[0].text.includes(`allowed=Read(${pathRule(egnyte)}),Edit(${pathRule(egnyte)}),Glob,Grep |`), r.replies[0].text);
  assert.match(r.replies[0].text, /bash_denied=true/);
  await assert.rejects(call(ctx, "start_egnyte_session", { prompt: "x", mode: "admin" }), /mode/);

  // Normal session: refused before the runner port is known to have a token
  await assert.rejects(call(ctx, "start_session", { prompt: "x", workspace: "nope" }), /unknown workspace/);
  await assert.rejects(call(ctx, "send_egnyte_message", { session_id: "s_missing", text: "x" }), /no session/);

  // Runner port: token required
  srv = ctx.sessions.runnerApp().listen(runnerPort, "127.0.0.1");
  await new Promise(res => srv.once("listening", res));
  const base = `http://127.0.0.1:${runnerPort}`;
  assert.equal((await fetch(base + "/runner/next", { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(base + "/runner/next", { method: "POST" })).status, 401);

  runner = startRunner({ gateway: base, tokenFile: path.join(tmp, "runner-token"), claude, workspaces: [ws, other],
    maxParallel: 2, pollMs: 100, retryMs: 200, trustAllRepos: false });

  r = await call(ctx, "start_session", { prompt: "build the thing", wait_seconds: 15 });
  const sid = r.session_id;
  assert.equal(r.replies.length, 1, JSON.stringify(r));
  assert.match(r.replies[0].text, /^new \| mode=auto/);
  assert.ok(r.replies[0].text.includes(path.basename(ws)), r.replies[0].text);
  await assert.rejects(call(ctx, "send_egnyte_message", { session_id: sid, text: "x" }), /Not an Egnyte session/);

  // One runner at a time: while the real runner polls, another instance (or one without an id) is refused and counted
  const poll = (url, instance, route = "/runner/next", body = { running: [], free: 1 }) => fetch(url + route, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(instance ? { "x-runner-instance": instance } : {}) },
  });
  const conflicts = async c => (await call(c, "list_sessions", {})).runner_conflicts;
  const c0 = await conflicts(ctx);
  assert.equal((await poll(base, "intruder-0001")).status, 409);
  assert.equal((await poll(base, "intruder-0001", "/runner/done", { sessionId: sid, turnId: "x", ok: true, text: "forged" })).status, 409);
  assert.equal((await poll(base, null)).status, 409);
  assert.equal(await conflicts(ctx), c0 + 3);
  let logText = fs.readFileSync(path.join(tmp, "gateway.log"), "utf8");
  assert.match(logText, /runner: second instance refused/);
  assert.match(logText, /runner: request without an instance id refused .*setup-agent\.ps1/);
  r = await call(ctx, "send_message", { session_id: sid, text: "still served", wait_seconds: 15 });
  assert.match(r.replies[0].text, /prompt=still served/, "the real runner keeps working");

  {
    // Pinning, answers only from the instance a turn went to, and takeover after the pinned instance goes quiet
    const cfgP = { ...cfg, stateFile: path.join(tmp, "p", "state.json"), claude: { ...cfg.claude, runnerLostAfterSecs: 1 } };
    fs.mkdirSync(path.dirname(cfgP.stateFile));
    const logBefore = fs.readFileSync(path.join(tmp, "gateway.log"), "utf8").length;
    const ctxP = makeContext(cfgP);
    const srvP = ctxP.sessions.runnerApp().listen(await freePort(), "127.0.0.1");
    try {
      await new Promise(res => srvP.once("listening", res));
      const baseP = `http://127.0.0.1:${srvP.address().port}`;
      const A = "instance-aaaaaaaa", B = "instance-bbbbbbbb";
      assert.deepEqual(await (await poll(baseP, A)).json(), {});
      const pid = (await call(ctxP, "start_session", { prompt: "pinned work", wait_seconds: 0 })).session_id;
      const { turn } = await (await poll(baseP, A)).json();
      assert.equal(turn.sessionId, pid);
      assert.equal((await poll(baseP, B)).status, 409, "a second instance is refused while A polls");
      assert.equal(await conflicts(ctxP), 1);
      await new Promise(res => setTimeout(res, 2100)); // A goes quiet past the lost-after window
      const forged = { sessionId: pid, turnId: turn.turnId, ok: true, text: "forged" };
      assert.equal((await poll(baseP, B, "/runner/done", forged)).status, 409, "B takes over but may not answer A's turn");
      assert.equal(ctxP.sessions.get(pid).status, "running");
      assert.equal(ctxP.sessions.get(pid).replies.length, 0);
      assert.equal((await poll(baseP, A, "/runner/done", forged)).status, 409, "A is no longer served");
      assert.deepEqual(await (await poll(baseP, B)).json(), {});
      r = await call(ctxP, "read_messages", { session_id: pid });
      assert.equal(r.replies.length, 1, JSON.stringify(r));
      assert.equal(r.replies[0].ok, false);
      assert.match(r.replies[0].text, /runner lost this turn/);
      assert.equal(await conflicts(ctxP), 3);
      const logP = fs.readFileSync(path.join(tmp, "gateway.log"), "utf8").slice(logBefore);
      assert.equal(logP.match(/runner: new instance/g)?.length, 2, logP);

      // The pin survives a gateway restart: B gets the grace window, a newcomer is refused
      const ctxR = makeContext(cfgP);
      const srvR = ctxR.sessions.runnerApp().listen(await freePort(), "127.0.0.1");
      try {
        await new Promise(res => srvR.once("listening", res));
        const baseR = `http://127.0.0.1:${srvR.address().port}`;
        assert.equal((await poll(baseR, "instance-cccccccc")).status, 409, "a newcomer can't take the pin after a restart");
        assert.equal((await poll(baseR, B)).status, 200);
      } finally { srvR.close(); }
    } finally { srvP.close(); }
  }

  // Messages sent while a turn runs are batched into the next turn
  r = await call(ctx, "send_message", { session_id: sid, text: "SLEEP first", wait_seconds: 0 });
  await call(ctx, "send_message", { session_id: sid, text: "second", wait_seconds: 0 });
  await call(ctx, "send_message", { session_id: sid, text: "third", wait_seconds: 0 });
  const got = [];
  for (let i = 0; i < 3 && got.length < 2; i++) got.push(...(await call(ctx, "read_messages", { session_id: sid, wait_seconds: 15 })).replies);
  assert.equal(got.length, 2, JSON.stringify(got));
  assert.match(got[0].text, /resumed.*prompt=SLEEP first/s);
  assert.match(got[1].text, /Duet sent these messages.*\[1\] second.*\[2\] third/s);

  // A failing turn reports the error and the session keeps working
  r = await call(ctx, "send_message", { session_id: sid, text: "FAIL now", wait_seconds: 15 });
  assert.equal(r.replies[0].ok, false);
  assert.match(r.replies[0].text, /exited with code 3/);

  // Second workspace
  r = await call(ctx, "start_session", { prompt: "elsewhere", workspace: "other", wait_seconds: 15 });
  assert.ok(r.replies[0].text.includes(path.basename(other)), r.replies[0].text);

  // list, end, read-all
  let list = await call(ctx, "list_sessions", {});
  assert.ok(list.runner_last_seen_seconds_ago <= 2, JSON.stringify(list));
  assert.equal(list.switched_off, false);
  await call(ctx, "end_session", { session_id: sid });
  await assert.rejects(call(ctx, "send_message", { session_id: sid, text: "x" }), /ended/);
  assert.ok(Array.isArray(await call(ctx, "read_messages", {})));

  // Kill switch: no new sessions or messages
  fs.writeFileSync(ctx.sessions.offFile, "");
  await assert.rejects(call(ctx, "start_session", { prompt: "x" }), /switched off/);
  await assert.rejects(call(ctx, "send_egnyte_message", { session_id: eid, text: "x" }), /switched off/);
  fs.rmSync(ctx.sessions.offFile);

  // Egnyte drive missing
  const cfg2 = { ...cfg, stateFile: path.join(tmp, "b", "state.json"), claude: { ...cfg.claude, egnyteRoot: path.join(tmp, "no-such-drive") } };
  fs.mkdirSync(path.dirname(cfg2.stateFile));
  r = await call(makeContext(cfg2), "start_egnyte_session", { prompt: "x", mode: "read", wait_seconds: 5 });
  assert.equal(r.replies[0].ok, false);
  assert.match(r.replies[0].text, /not mounted/);

  // Egnyte tools are opt-in on the PC
  const cfg3 = { ...cfg, stateFile: path.join(tmp, "c", "state.json"), claude: { ...cfg.claude, egnyteEnabled: undefined } };
  fs.mkdirSync(path.dirname(cfg3.stateFile));
  const off3 = (await makeContext(cfg3).listTools()).map(t => t.name);
  assert.ok(!off3.includes("start_egnyte_session") && !off3.includes("send_egnyte_message") && off3.includes("start_session"), off3.join());

  // Egnyte flags on Windows: no shell, files only inside the Egnyte root, every other drive and the profile denied
  assert.equal(pathRule("Z:\\"), "//z/**");
  assert.equal(pathRule("Z:\\Shared\\Team\\"), "//z/Shared/Team/**");
  for (const mode of ["read", "edit"]) {
    const f = egnyteFlags(mode, "Z:\\");
    const allowed = f.slice(f.indexOf("--allowedTools") + 1, f.indexOf("--disallowedTools")), denied = f.slice(f.indexOf("--disallowedTools") + 1);
    assert.equal(f[f.indexOf("--permission-mode") + 1], "dontAsk");
    assert.deepEqual(allowed, mode === "edit" ? ["Read(//z/**)", "Edit(//z/**)", "Glob", "Grep"] : ["Read(//z/**)", "Glob", "Grep"]);
    for (const d of ["Bash", "PowerShell", "WebFetch", "Agent", "Read(//c/**)", "Edit(//c/**)", "Read(//d/**)", "Read(~/**)", "Edit(~/**)", "Read(**/.env*)"])
      assert.ok(denied.includes(d), `${mode} denies ${d}`);
    assert.ok(!denied.some(d => d.includes("//z/")), "Z: is not denied");
    assert.equal(denied.includes("Edit"), mode === "read");
  }

  // Sessions survive a restart
  list = await call(makeContext(cfg), "list_sessions", {});
  assert.ok(list.sessions.some(s => s.session_id === eid && s.kind === "egnyte (read)"), JSON.stringify(list));

  // The log has ids and outcomes, never prompts or answers
  const logged = fs.readFileSync(path.join(tmp, "gateway.log"), "utf8");
  assert.ok(!/budget|typo|build the thing|resumed/.test(logged), logged);
  console.log("sessioncheck: all passed");
} finally {
  await runner?.stop();
  srv?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Health check tests: health.mjs summarizes fake logs, scrubs what could identify Danny, and turns problems into
// findings with stable fingerprints. Runs on any OS. Run: node healthcheck.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findings, scrub, summarize, tail } from "./health.mjs";

const now = Date.parse("2026-11-10T12:00:00Z");
const at = mins => new Date(now - mins * 60_000).toISOString();
const gatewayLog = [
  `${at(2000)} tool old_tool error 5ms`, // outside 24 h
  `${at(300)} listening on 127.0.0.1:8787; public https://pc.example.ts.net/mcp`,
  `${at(290)} upstream money unavailable: node.exe started and exited at once (wrong script path, or it crashed)`,
  `${at(280)} tool money_get_balances upstream down 3ms`,
  ...Array.from({ length: 4 }, (_, i) => `${at(270 - i)} tool files_read error 12ms`),
  ...Array.from({ length: 6 }, (_, i) => `${at(260 - i)} tool files_read ok ${10 + i}ms`),
  ...["TIMEOUT", "TIMEOUT", "AMBIGUOUS_TARGET"].map((c, i) => `${at(255 - i)} tool pc_desktop_launch error ${c} 20000ms`),
  `${at(250)} tool pc_desktop_click refused: desktop.OFF 1ms`,
  ...Array.from({ length: 3 }, (_, i) => `${at(240 - i)} tool web_browser_navigate ok 45000ms`),
  `${at(230)} mcp request failed: ENOENT C:\\Users\\trand\\secret\\x.json`,
  `${at(220)} login failed (1/5) from 100.64.1.2`,
  `${at(210)} session abc123 turn 2 failed`,
  `${at(209)} session abc123 turn 3 failed`,
  `${at(200)} something exploded: TypeError at token sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  `${at(199)} something exploded: TypeError at token sk-ant-oat01-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`,
  "not a log line",
  `${at(-10)} tool future error 1ms`, // after now
  ...Array.from({ length: 4 }, (_, i) => `${at(150 - i)} tool read_messages ok 45000ms`),
].join("\n");
const runnerLog = [
  `${at(100)} runner started (instance abcd1234, up to 2 at a time)`,
  `${at(90)} turn s1 done`,
  `${at(80)} turn s2 failed (answer not delivered)`,
  `${at(70)} gateway unreachable: connect ECONNREFUSED 127.0.0.1:8788`,
].join("\r\n");

const sum = summarize({ gatewayLog, runnerLog, hours: 24, now });
assert.equal(sum.tools.old_tool, undefined, "old lines are left out");
assert.equal(sum.tools.future, undefined, "lines after now are left out");
assert.deepEqual(
  { calls: sum.tools.files_read.calls, ok: sum.tools.files_read.ok, error: sum.tools.files_read.error },
  { calls: 10, ok: 6, error: 4 });
assert.equal(sum.tools.money_get_balances.upstreamDown, 1);
assert.deepEqual(sum.tools.pc_desktop_click.refused, { "desktop.OFF": 1 });
assert.equal(sum.tools.web_browser_navigate.slow, 3);
assert.equal(sum.tools.web_browser_navigate.p95ms, 45000);
assert.equal(sum.upstreams.money.downEvents, 1);
assert.equal(sum.gateway.restarts, 1);
assert.equal(sum.gateway.loginFailed, 1);
assert.equal(sum.gateway.turnsFailed, 2);
assert.equal(sum.runner.turnsDone, 1);
assert.equal(sum.runner.turnsFailed, 1);
assert.equal(sum.runner.notDelivered, 1);
assert.equal(sum.runner.gatewayUnreachable, 1);
assert.equal(sum.runner.starts, 1);

// Nothing that identifies Danny leaves: no user folder, address or token.
const text = JSON.stringify(sum);
for (const bad of ["trand", "100.64.1.2", "127.0.0.1", "sk-ant", "AAAAAAAA"]) assert(!text.includes(bad), `report leaks ${bad}`);
assert.equal(scrub("C:\\Users\\trand\\x and /Users/danny/y"), "~\\x and ~/y");
assert(scrub("x".repeat(500)).length <= 201);

assert.deepEqual(sum.tools.pc_desktop_launch.errorCodes, { TIMEOUT: 2, AMBIGUOUS_TARGET: 1 });
assert.equal(sum.tools.pc_desktop_launch.error, 3);
assert.equal(sum.tools.files_read.error, 4, "an error with no code still counts");
const f = findings(sum, [{ level: "fail", check: "runner port", detail: "nothing answers" }, { level: "ok", check: "config", detail: "x" }]);
const fps = f.map(x => x.fingerprint);
for (const fp of ["tool-errors:files_read", "tool-upstream-down:money_get_balances", "tool-slow:web_browser_navigate",
  "upstream-down:money", "session-turns-failed", "runner-not-delivered", "doctor:runner port"])
  assert(fps.includes(fp), `missing finding ${fp}`);
assert(f.find(x => x.fingerprint === "tool-errors:pc_desktop_launch").detail.includes("TIMEOUT ×2"), "finding names the codes");
assert(fps.some(x => x.startsWith("mcp-error:")));
assert(fps.some(x => x.startsWith("log-error:something exploded")), "repeated unknown errors group into one finding");
assert(!fps.includes("tool-slow:read_messages"), "long-poll waits are not slowness");
assert(!fps.includes("gateway-restarts"), "one restart a day is not a finding");
const restarts = Array.from({ length: 8 }, (_, i) => `${at(100 - i)} listening on 127.0.0.1:8787`).join("\n");
assert(findings(summarize({ gatewayLog: restarts, now })).some(x => x.fingerprint === "gateway-restarts"), "8 restarts in a day is");
assert(!findings(summarize({ gatewayLog: restarts, hours: 72, now })).some(x => x.fingerprint === "gateway-restarts"), "8 in 3 days is not");
assert(!fps.includes("doctor:config"), "ok doctor lines are not findings");
assert(!fps.includes("login-failures"), "one failed sign-in is not a finding");
assert.equal(new Set(fps).size, fps.length, "fingerprints are unique");
// Same input, same fingerprints: the monitor relies on that to update an issue instead of filing a new one.
assert.deepEqual(findings(summarize({ gatewayLog, runnerLog, hours: 24, now })).map(x => x.fingerprint), findings(sum).map(x => x.fingerprint));

// A healthy log gives no findings.
assert.deepEqual(findings(summarize({ gatewayLog: `${at(5)} tool guide ok 3ms`, now })), []);

// tail drops a cut first line and returns "" for a missing file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
const file = path.join(dir, "g.log");
fs.writeFileSync(file, "first line\nsecond line\nthird\n");
assert.equal(tail(file, 15), "third\n");
assert.equal(tail(file), "first line\nsecond line\nthird\n");
assert.equal(tail(path.join(dir, "missing.log")), "");
fs.rmSync(dir, { recursive: true, force: true });

console.log("healthcheck: all passed");

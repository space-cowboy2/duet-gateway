// Alerts check: alerts.mjs files one issue per finding against a fake GitHub, comments instead of filing twice,
// respects ignore, the repeat window and the hourly cap, and never puts the token anywhere but the auth header.
// Runs on any OS. Run: node alertscheck.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeAlerter } from "./alerts.mjs";

const TOKEN = "github_pat_SECRET_TOKEN_VALUE_1234567890";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alerts-"));
const logFile = path.join(dir, "gateway.log");
let t = Date.parse("2026-11-10T12:00:00Z");
const now = () => t;
const at = mins => new Date(t - mins * 60_000).toISOString();
const write = lines => fs.writeFileSync(logFile, lines.join("\n") + "\n");

// Fake GitHub: records every request, keeps issues in memory.
const calls = [], issues = new Map();
let next = 1, failWith = null;
const fetchFn = async (url, opts) => {
  calls.push({ url, ...opts });
  if (failWith) return { ok: false, status: failWith, json: async () => ({}) };
  const u = new URL(url), m = u.pathname.match(/\/repos\/me\/gw\/issues(?:\/(\d+))?(\/comments)?$/);
  assert(m, `unexpected url ${url}`);
  const body = opts.body && JSON.parse(opts.body);
  if (opts.method === "POST" && !m[1]) { const n = next++; issues.set(n, { ...body, number: n, state: "open", labels: body.labels.map(name => ({ name })) }); return { ok: true, status: 201, json: async () => issues.get(n) }; }
  if (opts.method === "GET") return { ok: true, status: 200, json: async () => issues.get(+m[1]) };
  if (opts.method === "POST" && m[2]) return { ok: true, status: 201, json: async () => ({}) };
  throw new Error("unhandled");
};
const logged = [];
const cfg = { alerts: { enabled: true, repo: "me/gw", ignore: ["upstream-down:tv", "tool-upstream-down:tv_*"] } };
const make = (over = {}) => makeAlerter({ cfg, dir, logFile, log: m => logged.push(m), fetchFn, now, debounceMs: 10, ...over });

// No alerts config, or a bad repo: no alerter.
assert.equal(makeAlerter({ cfg: {}, dir, logFile, log() {} }), null);
assert.equal(makeAlerter({ cfg: { alerts: { enabled: true, repo: "x; rm" } }, dir, logFile, log() {} }), null);
// The shipped example is off, so copying it never files issues.
const example = JSON.parse(fs.readFileSync(new URL("./config.example.json", import.meta.url), "utf8"));
assert.equal(example.alerts.enabled, false);
assert.equal(makeAlerter({ cfg: example, dir, logFile, log() {} }), null);

const errors = n => Array.from({ length: n }, (_, i) => `${at(10 - i * 0.1)} tool files_read error 5ms`);
write([...errors(4), `${at(5)} upstream tv unavailable: timed out`, `${at(4)} tool tv_power upstream down 1ms`]);

// Without a token file nothing is sent.
let al = make();
await al.check();
assert.equal(calls.length, 0);
assert(logged.some(l => /not filed \(no github-token\)/.test(l)));

fs.writeFileSync(path.join(dir, "github-token"), TOKEN + "\n");
al = make();
await al.check();
const posts = calls.filter(c => c.method === "POST");
assert.equal(posts.length, 1, "one issue for files_read; tv findings are ignored");
const issue = issues.get(1);
assert.equal(issue.title, "files_read fails often");
assert.deepEqual(issue.labels.map(l => l.name), ["monitor", "bug"]);
assert.match(issue.body, /^fingerprint: tool-errors:files_read\nseverity: bug\n/);
assert.equal(posts[0].headers.Authorization, `Bearer ${TOKEN}`);
assert(posts[0].url.startsWith("https://api.github.com/repos/me/gw/"));
for (const c of calls) assert(!c.url.includes(TOKEN) && !(c.body || "").includes(TOKEN), "token only in the header");
assert(!logged.join("\n").includes(TOKEN), "token never logged");
assert(logged.includes("alert: tool-errors:files_read filed #1"));

// Same problem soon after: nothing (repeat window).
calls.length = 0;
t += 30 * 60_000; write(errors(5));
await make().check();
assert.equal(calls.length, 0, "state survives a restart and holds repeats back");

// After the repeat window, while the issue is open: a comment, not a new issue.
t += 7 * 3600_000; write(errors(5));
await make().check();
assert.deepEqual(calls.map(c => `${c.method} ${new URL(c.url).pathname}`), ["GET /repos/me/gw/issues/1", "POST /repos/me/gw/issues/1/comments"]);
assert.equal(issues.size, 1);

// Closed and back: a new issue.
calls.length = 0; issues.get(1).state = "closed";
t += 7 * 3600_000; write(errors(5));
await make().check();
assert.equal(issues.size, 2);

// wontfix-auto on the open issue: skipped.
calls.length = 0; issues.get(2).labels.push({ name: "wontfix-auto" });
t += 7 * 3600_000; write(errors(5));
await make().check();
assert(!calls.some(c => c.method === "POST"));

// Hourly cap.
fs.rmSync(path.join(dir, "alerts.json"));
calls.length = 0; issues.clear(); next = 1;
t += 7 * 3600_000;
write(["a", "b", "c", "d", "e", "f", "g"].flatMap(x => Array.from({ length: 4 }, (_, i) => `${at(10 - i * 0.1)} tool t_${x} error 5ms`)));
await make({ maxPerHour: 3 }).check();
assert.equal(issues.size, 3);
assert(logged.some(l => /3 issues this hour/.test(l)));

// A GitHub refusal is logged by status and stops the run.
fs.rmSync(path.join(dir, "alerts.json"));
calls.length = 0; failWith = 401; t += 7 * 3600_000; write(errors(4));
await make().check();
assert.equal(calls.length, 1);
assert(logged.some(l => /failed \(GitHub 401\)/.test(l)));
failWith = null;

// onLog: only trouble lines start a check, a burst makes one check, and its own lines are ignored.
fs.rmSync(path.join(dir, "alerts.json"));
calls.length = 0; issues.clear(); next = 1; t += 7 * 3600_000; write(errors(4));
al = make();
al.onLog("tool guide ok 3ms");
al.onLog("alert: x filed #9");
await new Promise(r => setTimeout(r, 40));
assert.equal(calls.length, 0);
for (let i = 0; i < 5; i++) al.onLog("tool files_read error 5ms");
await new Promise(r => setTimeout(r, 40));
await al.flush();
assert.equal(issues.size, 1);
al.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log("alertscheck: all passed");

// health.mjs: a read-only usage and error summary for the health_report tool, built from gateway.log and runner.log.
// The monitor (a scheduled Claude task) calls health_report, files GitHub issues for what it finds, and a fixer task
// works those issues into draft PRs. See MONITOR.md.
// The logs hold tool names, outcomes and ids only. What this returns is counts and fixed-format lines, with anything
// that looks like a user path, address or token blanked, so the report carries nothing the logs don't already hold.
import fs from "node:fs";

const MAX_BYTES = 4 << 20; // the tail of each log that is read
const MAX_SAMPLES = 5, MAX_LINE = 200, SLOW_MS = 30_000;
// Tools that wait on purpose (session long-polls up to 45 s, explicit waits), so a long call is not slowness.
export const WAITS = /^(start_session|send_message|read_messages|start_egnyte_session|send_egnyte_message|pc_desktop_wait|web_browser_wait_for)$/;

// Reads the last `bytes` of a file; "" when it is missing or unreadable.
export function tail(file, bytes = MAX_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const s = buf.toString("utf8");
    return n < size ? s.slice(s.indexOf("\n") + 1) : s; // drop a cut first line
  } catch { return ""; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Blanks what could identify Danny or his network, and clips the line.
export function scrub(s) {
  let t = String(s).replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, "~").replace(/\/(Users|home)\/[^/\s"']+/g, "~")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "[ip]").replace(/\b[0-9a-f:]{2,}:[0-9a-f:]{2,}\b/gi, "[ip]")
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, "[redacted]").replace(/sk-ant-\S+/g, "[redacted]");
  if (t.length > MAX_LINE) t = t.slice(0, MAX_LINE) + "…";
  return t;
}

// Splits "2026-11-09T12:00:00.000Z rest" into time and text; lines without a timestamp return null.
const parse = line => {
  const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : { t, msg: m[2] };
};
const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const sample = (o, k, line) => { (o[k] ??= []).length < MAX_SAMPLES && o[k].push(scrub(line)); };

// Summarizes gateway.log and runner.log text for the `hours` before `now`.
export function summarize({ gatewayLog = "", runnerLog = "", hours = 24, now = Date.now() } = {}) {
  const since = now - hours * 3600_000;
  const tools = {}, durations = {}, upstreams = {}, mcpErrors = {}, other = {}, samples = {};
  const g = { restarts: 0, loginFailed: 0, loginOk: 0, turnsOk: 0, turnsFailed: 0, runnerRefused: 0, warnings: 0, lines: 0 };
  let first = null, last = null;
  for (const raw of gatewayLog.split(/\r?\n/)) {
    const p = parse(raw);
    if (!p || p.t < since || p.t > now) continue;
    g.lines++; first ??= p.t; last = p.t;
    const { msg } = p;
    let m;
    if ((m = /^tool (\S+) (.+?) (\d+)ms$/.exec(msg))) {
      const [, name, outcome, ms] = m;
      const s = (tools[name] ??= { calls: 0, ok: 0, error: 0, refused: {}, errorCodes: {}, upstreamDown: 0, slow: 0 });
      s.calls++;
      if (outcome === "ok") s.ok++;
      else if (outcome === "upstream down") s.upstreamDown++;
      else if (outcome.startsWith("refused: ")) bump(s.refused, outcome.slice(9));
      else { s.error++; if ((m = /^error ([A-Z][A-Z0-9_]{1,39})$/.exec(outcome))) bump(s.errorCodes, m[1]); }
      if (+ms >= SLOW_MS) s.slow++;
      (durations[name] ??= []).push(+ms);
    } else if ((m = /^upstream (\S+) (.*)$/.exec(msg))) {
      const u = (upstreams[m[1]] ??= { downEvents: 0, last: "" });
      if (/^unavailable/.test(m[2])) { u.downEvents++; sample(samples, `upstream ${m[1]}`, m[2]); }
      u.last = scrub(m[2]);
    } else if ((m = /^mcp request failed: (.*)$/.exec(msg))) bump(mcpErrors, scrub(m[1]));
    else if (/^listening on /.test(msg)) g.restarts++;
    else if (/^login failed/.test(msg)) g.loginFailed++;
    else if (/^login ok/.test(msg)) g.loginOk++;
    else if ((m = /^session \S+ turn \d+ (ok|failed)$/.exec(msg))) m[1] === "ok" ? g.turnsOk++ : g.turnsFailed++;
    else if (/^runner: second instance refused/.test(msg)) g.runnerRefused++;
    else if (/^WARNING/.test(msg)) { g.warnings++; sample(samples, "warnings", msg); }
    else if (/error|fail|exception|cannot|refused|timed? ?out/i.test(msg)) {
      const key = scrub(msg).replace(/\b[0-9a-f]{6,}\b/gi, "#").replace(/\d+/g, "N").slice(0, 80);
      bump(other, key); sample(samples, "other errors", msg);
    }
  }
  for (const [name, xs] of Object.entries(durations)) {
    xs.sort((a, b) => a - b);
    Object.assign(tools[name], { p50ms: pct(xs, 50), p95ms: pct(xs, 95), maxMs: xs.at(-1) });
  }

  const r = { turnsDone: 0, turnsFailed: 0, notDelivered: 0, gatewayUnreachable: 0, refusedByGateway: 0, reportFailed: 0, starts: 0, lines: 0 };
  for (const raw of runnerLog.split(/\r?\n/)) {
    const p = parse(raw);
    if (!p || p.t < since || p.t > now) continue;
    r.lines++;
    const { msg } = p;
    if (/^turn \S+ done/.test(msg)) r.turnsDone++;
    else if (/^turn \S+ failed/.test(msg)) r.turnsFailed++;
    if (/answer not delivered/.test(msg)) r.notDelivered++;
    if (/^gateway unreachable/.test(msg)) { r.gatewayUnreachable++; sample(samples, "runner", msg); }
    else if (/^gateway refused this runner/.test(msg)) r.refusedByGateway++;
    else if (/^report failed/.test(msg)) { r.reportFailed++; sample(samples, "runner", msg); }
    else if (/^runner started/.test(msg)) r.starts++;
  }

  return {
    window: { hours, from: first && new Date(first).toISOString(), to: last && new Date(last).toISOString() },
    gateway: g, tools, upstreams, mcpErrors, otherErrors: other, runner: r, samples,
  };
}

// Problems worth an issue, each with a stable fingerprint so the monitor can find an issue it already filed.
export function findings(sum, doctor = []) {
  const out = [];
  const add = (fingerprint, severity, title, detail) => out.push({ fingerprint, severity, title, detail });
  for (const [name, s] of Object.entries(sum.tools)) {
    if (s.error >= 3 && s.error / s.calls >= 0.2) add(`tool-errors:${name}`, "bug", `${name} fails often`, `${s.error} of ${s.calls} calls returned an error${Object.keys(s.errorCodes).length ? ` (${Object.entries(s.errorCodes).map(([c, n]) => `${c} ×${n}`).join(", ")})` : ""}`);
    if (s.upstreamDown >= 1) add(`tool-upstream-down:${name}`, "problem", `${name} called while its server was down`, `${s.upstreamDown} of ${s.calls} calls`);
    if (!WAITS.test(name) && (s.slow >= 3 || (s.calls >= 5 && s.p95ms >= SLOW_MS))) add(`tool-slow:${name}`, "perf", `${name} is slow`, `p95 ${s.p95ms} ms, max ${s.maxMs} ms, ${s.slow} calls over ${SLOW_MS / 1000} s`);
  }
  for (const [u, s] of Object.entries(sum.upstreams))
    if (s.downEvents) add(`upstream-down:${u}`, "problem", `${u} upstream went down`, `${s.downEvents} time(s); last state: ${s.last}`);
  for (const [msg, n] of Object.entries(sum.mcpErrors)) add(`mcp-error:${msg.slice(0, 60)}`, "bug", "MCP request failed", `${n}× ${msg}`);
  for (const [msg, n] of Object.entries(sum.otherErrors)) if (n >= 2) add(`log-error:${msg}`, "bug", "Error in gateway.log", `${n}× ${msg}`);
  // Deploys and config changes restart it too, so only a high rate counts: 6 or more a day.
  const perDay = sum.gateway.restarts / Math.max(1, sum.window.hours / 24);
  if (sum.gateway.restarts >= 3 && perDay >= 6) add("gateway-restarts", "problem", "Gateway restarts often", `${sum.gateway.restarts} starts in ${sum.window.hours} h; check for crashes (deploys and config changes also restart it)`);
  if (sum.gateway.turnsFailed >= 2) add("session-turns-failed", "bug", "Claude Code session turns fail", `${sum.gateway.turnsFailed} failed, ${sum.gateway.turnsOk} ok`);
  if (sum.gateway.runnerRefused >= 3) add("runner-second-instance", "security", "Second runner instance keeps polling", `${sum.gateway.runnerRefused} refusals`);
  if (sum.gateway.loginFailed >= 5) add("login-failures", "security", "Repeated failed sign-ins", `${sum.gateway.loginFailed} failed sign-ins`);
  if (sum.runner.gatewayUnreachable >= 3) add("runner-unreachable", "problem", "Runner cannot reach the gateway", `${sum.runner.gatewayUnreachable} times`);
  if (sum.runner.notDelivered >= 1 || sum.runner.reportFailed >= 1) add("runner-not-delivered", "bug", "Runner answers not delivered", `${sum.runner.notDelivered} not delivered, ${sum.runner.reportFailed} report failures`);
  for (const d of doctor) if (d.level === "fail") add(`doctor:${d.check}`, "problem", `doctor: ${d.check} fails`, scrub(d.detail));
  return out;
}

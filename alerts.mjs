// alerts.mjs: files a GitHub issue as soon as gateway.log shows a problem, instead of waiting for the daily monitor.
// After a log line that looks like trouble, it waits a little (so a burst becomes one check), sums up the last hour of
// gateway.log with health.mjs, and files or updates one issue per finding fingerprint. The fixer task picks the issues
// up. See MONITOR.md.
// Config (config.json): "alerts": { "repo": "owner/name", "tokenFile": "github-token", "ignore": ["upstream-down:tv"] }
// The token is a fine-grained GitHub token for that repo with Issues read/write only. It is read when an issue is
// filed, never logged, and sent only to api.github.com.
import fs from "node:fs";
import path from "node:path";
import { findings, summarize, tail } from "./health.mjs";

const API = "https://api.github.com";
// Log lines that can lead to a finding. Anything else (a successful call, a sign-in) does not start a check.
const TROUBLE = /^(tool \S+ (error|upstream down) |upstream \S+ unavailable|mcp request failed|listening on |session \S+ turn \d+ failed|runner: second instance|login failed)|error|fail|exception/i;
const globRe = g => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const LABELS = { bug: "bug", perf: "enhancement", problem: "bug", security: "bug" };

export function makeAlerter({ cfg, dir, logFile, log, fetchFn = globalThis.fetch, now = Date.now,
  debounceMs = 30_000, windowHours = 1, repeatMs = 6 * 3600_000, maxPerHour = 5 }) {
  const a = cfg.alerts;
  if (!a || typeof a !== "object" || !/^[\w.-]+\/[\w.-]+$/.test(a.repo || "")) return null;
  const tokenFile = path.resolve(dir, a.tokenFile || "github-token");
  const stateFile = path.join(dir, "alerts.json");
  const ignore = (Array.isArray(a.ignore) ? a.ignore : []).filter(s => typeof s === "string").map(globRe);
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { state = {}; }
  state.fp ??= {}; state.sent ??= [];
  const save = () => { try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch {} };
  let timer = null, running = null;

  const gh = async (method, url, body) => {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const res = await fetchFn(`${API}/repos/${a.repo}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "duet-gateway", "X-GitHub-Api-Version": "2022-11-28", ...(body && { "Content-Type": "application/json" }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${url.split("?")[0]} answered ${res.status}`), { status: res.status });
    return res.status === 204 ? null : res.json();
  };

  const bodyOf = (f, sum) => [
    `fingerprint: ${f.fingerprint}`, `severity: ${f.severity}`, "",
    "## What the logs show", `${f.detail} (last ${sum.window.hours} h, ${sum.window.from} to ${sum.window.to})`,
    ...(sum.samples && Object.keys(sum.samples).length ? ["", "Sample lines:", "```", ...Object.values(sum.samples).flat().slice(0, 8), "```"] : []),
    "", "## Likely cause", "_Filed by the gateway as it happened. The daily monitor or the fixer fills this in._",
  ].join("\n");

  // Files a new issue, or comments on the open one it filed before for the same fingerprint.
  async function report(f, sum) {
    const known = state.fp[f.fingerprint];
    if (known?.issue) {
      const issue = await gh("GET", `/issues/${known.issue}`);
      if (issue.state === "open") {
        if (issue.labels?.some(l => l.name === "wontfix-auto")) return "skipped";
        await gh("POST", `/issues/${known.issue}/comments`, { body: `Seen again: ${f.detail} (last ${sum.window.hours} h, to ${sum.window.to}).` });
        return `updated #${known.issue}`;
      }
      if (issue.labels?.some(l => l.name === "wontfix-auto")) return "skipped";
    }
    const issue = await gh("POST", "/issues", { title: f.title, body: bodyOf(f, sum), labels: ["monitor", LABELS[f.severity] || "bug"] });
    state.fp[f.fingerprint] = { ...state.fp[f.fingerprint], issue: issue.number };
    return `filed #${issue.number}`;
  }

  async function check() {
    const t = now();
    const sum = summarize({ gatewayLog: tail(logFile), hours: windowHours, now: t });
    state.sent = state.sent.filter(s => s > t - 3600_000);
    for (const f of findings(sum)) {
      if (ignore.some(re => re.test(f.fingerprint))) continue;
      const known = state.fp[f.fingerprint];
      if (known?.last && t - known.last < repeatMs) continue;
      if (state.sent.length >= maxPerHour) { log(`alert: ${maxPerHour} issues this hour, holding the rest`); break; }
      if (!fs.existsSync(tokenFile)) { log(`alert: ${f.fingerprint} not filed (no ${path.basename(tokenFile)})`); break; }
      try {
        const what = await report(f, sum);
        state.fp[f.fingerprint] = { ...state.fp[f.fingerprint], last: t };
        if (what !== "skipped") state.sent.push(t);
        log(`alert: ${f.fingerprint} ${what}`);
      } catch (e) {
        log(`alert: ${f.fingerprint} failed (${e.status ? `GitHub ${e.status}` : e.code || "error"})`);
        if (e.status === 401 || e.status === 403) break;
      }
      save();
    }
    save();
  }

  return {
    // Called with every gateway.log line. Its own lines never start a check.
    onLog(msg) {
      if (msg.startsWith("alert:") || !TROUBLE.test(msg) || timer) return;
      timer = setTimeout(() => {
        timer = null;
        running = (running || Promise.resolve()).then(check).catch(e => log(`alert: check failed (${e?.code || "error"})`));
      }, debounceMs);
      timer.unref?.();
    },
    check,
    flush: () => running,
    close() { clearTimeout(timer); timer = null; },
  };
}

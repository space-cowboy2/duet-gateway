// runner.mjs: runs normal Duet sessions with full autonomy, as the separate user "duet-agent".
// setup-agent.ps1 (Windows) copies this file and claude.mjs to C:\ProgramData\duet-agent\bin and starts it at boot;
// setup-agent-mac.sh does the same in /Library/Application Support/duet-agent with a LaunchDaemon.
// It asks the gateway for work on a loopback-only port, so it never takes calls from the internet.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn } from "./claude.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = p => path.resolve(p).toLowerCase().replace(/[\\/]+$/, "");

export function startRunner(cfg) {
  const log = msg => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    if (cfg.logFile) try { fs.appendFileSync(cfg.logFile, line + "\n"); } catch {}
  };
  const read = f => fs.readFileSync(f, "utf8").trim();
  const roots = (cfg.workspaces || []).map(norm);
  const inWorkspace = p => typeof p === "string" && roots.some(r => norm(p) === r || norm(p).startsWith(r + path.sep));
  const flags = ["--permission-mode", cfg.permissionMode || "auto", "--strict-mcp-config"];
  const running = new Map();
  // The gateway serves one runner instance at a time and refuses others (HTTP 409); see sessions.mjs.
  const instance = randomBytes(16).toString("hex");
  let stopped = false;

  // Danny owns the repos, so git would refuse them as "dubious ownership" for this user.
  if (cfg.trustAllRepos !== false) {
    const have = spawnSync("git", ["config", "--global", "--get-all", "safe.directory"], { encoding: "utf8", windowsHide: true });
    if (!String(have.stdout || "").split(/\r?\n/).includes("*"))
      spawnSync("git", ["config", "--global", "--add", "safe.directory", "*"], { windowsHide: true });
  }

  async function post(route, body) {
    const res = await fetch(cfg.gateway + route, {
      method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: `Bearer ${read(cfg.tokenFile)}`, "x-runner-instance": instance },
    });
    if (!res.ok) throw Object.assign(new Error(`${route}: HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  async function work(turn) {
    let result;
    if (!inWorkspace(turn.cwd) || !fs.existsSync(turn.cwd)) {
      result = { ok: false, text: `The runner may not work in ${turn.cwd}.`, started: false };
    } else {
      const env = cfg.claudeTokenFile && fs.existsSync(cfg.claudeTokenFile) ? { CLAUDE_CODE_OAUTH_TOKEN: read(cfg.claudeTokenFile) } : {};
      result = await runTurn({ claude: cfg.claude, claudeId: turn.claudeId, prompt: turn.prompt, cwd: turn.cwd, flags,
        timeoutSecs: turn.timeoutSecs || 3600, env, configDir: cfg.claudeConfigDir });
    }
    let reported = false;
    for (let i = 0; i < 5; i++) {
      try { await post("/runner/done", { sessionId: turn.sessionId, turnId: turn.turnId, ...result }); reported = true; break; }
      catch (e) {
        log(`report failed: ${e.message}`);
        if (e.status === 409) break; // the gateway handed this turn to another instance, or serves another one now
        await sleep(3000 * (i + 1));
      }
    }
    log(`turn ${turn.sessionId} ${result.ok ? "done" : "failed"}${reported ? "" : " (answer not delivered)"}`);
  }

  const done = (async () => {
    log(`runner started (instance ${instance.slice(0, 8)}, up to ${cfg.maxParallel || 2} at a time)`);
    while (!stopped) {
      try {
        const free = (cfg.maxParallel || 2) - running.size;
        const { turn } = await post("/runner/next", { running: [...running.keys()], free });
        if (turn) {
          log(`turn ${turn.sessionId} started`);
          running.set(turn.turnId, work(turn).finally(() => running.delete(turn.turnId)));
          continue;
        }
      } catch (e) {
        log(e.status === 409 ? "gateway refused this runner: another runner instance is active (retrying)" : `gateway unreachable: ${e.message}`);
        await sleep(cfg.retryMs ?? 15000);
        continue;
      }
      await sleep(cfg.pollMs ?? 2000);
    }
    await Promise.allSettled(running.values());
  })();
  return { stop: () => { stopped = true; return done; } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.env.DUET_RUNNER_CONFIG || path.join(HERE, "..", "runner.json");
  startRunner(JSON.parse(fs.readFileSync(file, "utf8")));
}

# Monitor agent and Fixer agent

Three parts keep the gateway improving. GitHub issues are the queue between them, and nothing merges without Danny.

```
gateway.log ──▶ alerts.mjs (in the gateway, seconds after a problem) ──┐
gateway.log, runner.log, doctor ──▶ health_report ──▶ Monitor (daily) ─┴─▶ GitHub issue labelled "monitor"
                                                                              │ (issues event)
                                    Danny reviews and merges ◀── draft PR ◀── Fixer (.github/workflows/fixer.yml)
```

- **Alerts** (`alerts.mjs`): after a log line that looks like trouble, the gateway waits 30 s, sums up the last hour
  and files or comments on one issue per finding. At most 5 issues an hour, and one update per finding every 6 hours.
  Turn it on with `"alerts": { "enabled": true, "repo": "space-cowboy2/duet-gateway", "ignore": ["upstream-down:tv", "tool-upstream-down:tv_*"] }`
  in `config.json` and a `github-token` file next to it: a fine-grained token for this repo with Issues read/write only.
  `gateway.log` gets `alert: <fingerprint> filed #n`, `updated #n` or why not. State is kept in `alerts.json`.
- **Monitor agent** (scheduled Claude task "Monitor agent", daily): the wider look, trends and CI, and fills in the cause on issues.
- **Fixer agent** (GitHub Actions workflow "Fixer agent"): starts as soon as an issue opened by the owner gets the `monitor` label, plus a daily
  sweep and a manual run (Actions → Fixer agent → Run workflow).

- **Where the data comes from.** Every tool call already writes one line to `gateway.log`: the tool name, the outcome
  (ok, error, refused, upstream down) and how long it took. Upstream outages, restarts, sign-in failures and Claude Code
  session turns are logged too, and the runner writes `runner.log`. Neither log holds arguments or results.
  `health_report` (read-only, in `health.mjs`) sums them up for a time window, runs the doctor checks and lists
  findings, each with a stable fingerprint. It blanks user folders, IP addresses and anything token-shaped.
- **The tasks read this file on every run.** To change how they work, edit this file in a PR.

The monitor runs in the cloud and needs the duet-gateway connector (to call `health_report`) and GitHub. The fixer runs
in GitHub Actions with the same Claude secret as the PR review.

## Labels

| Label | Meaning |
|---|---|
| `monitor` | Filed by the monitor. The fixer only takes issues with this label |
| `fixer:pr-open` | The fixer opened a draft PR for it |
| `needs-danny` | Can't be fixed in code: a setting, a sign-in or a hardware fix on the PC. The fixer skips it |
| `wontfix-auto` | Danny says leave it. Both tasks skip it |

Create a missing label before using it.

## Monitor agent

1. Call `health_report` with `hours: 26` (a little overlap with the last run). If the connector can't be reached, file
   or update one issue, fingerprint `monitor-unreachable`, and stop.
2. Look at the last day of GitHub Actions runs on `main`. A failing `check` workflow is a finding too, fingerprint
   `ci:<workflow>:<job>`.
3. Look beyond `findings`. The report also has per-tool counts. Use judgement: a tool that started failing, a new error
   kind, a refusal count that keeps rising. Give each new kind of problem its own fingerprint (`kind:subject`).
   Don't file normal behaviour: a refusal from `desktop.OFF` while that switch is on, one failed sign-in, a single
   timeout. Known noise: the TV upstream is off on purpose (no TV is paired), so `upstream-down:tv` and
   `tool-upstream-down:tv_*` are one `needs-danny` issue at most (remove or disable the `tv` upstream in config.json),
   never a bug for the fixer.
4. For each finding, search open and recently closed issues for `fingerprint: <fp>` in the body.
   - Open issue: add one comment with the new counts and window. Don't comment again if nothing changed.
   - Closed in the last 7 days as fixed, and it is back: reopen it and say so.
   - `wontfix-auto`: skip.
   - Otherwise open a new issue (below).
5. If an open `monitor` issue's problem has not shown up for 7 days, comment that and close it as completed.
6. File at most 5 new issues per run, worst first. If nothing is wrong, do nothing: no "all clear" issue.

**Issue format.** End the body with `_Filed by the Monitor agent._` and start comments with `Monitor agent:`. Title: short and specific (`files_read fails on paths with spaces`). Labels: `monitor` plus `bug`,
`enhancement` or `needs-danny`. Body:

```
fingerprint: <fp>
severity: bug | problem | perf | security

## What the logs show
<counts, window, sample lines from health_report>

## Likely cause
<your reading of the code, with file:line links. Say when it is a guess.>

## Suggested fix
<what the fixer should change, or why this needs Danny>
```

Never paste anything from the report that looks personal: it is already scrubbed, keep it that way.

## Fixer agent

1. Take the oldest open issue labelled `monitor` without `fixer:pr-open`, `needs-danny` or `wontfix-auto`. Prefer
   `bug` over `enhancement`. If there is none, stop. One issue per run.
2. Read the issue, `README.md`, `REVIEW.md` and the code it points at. Reproduce the problem in a test where you can
   (the `*check.mjs` files are the tests).
3. If it can't be fixed in code (config, sign-in, the PC itself), comment what Danny needs to do, add `needs-danny`, stop.
4. Fix it on a branch `fix/<issue-number>-<slug>`. Keep the change to what the issue needs. Add or extend a test.
5. Run `npm run check`. `selfcheck.mjs` needs Windows; on Linux run the checks the `linux` job in
   `.github/workflows/check.yml` runs. Don't open a PR with a failing check.
6. Open a **draft** PR titled `Fixer agent: <what it fixes>` that says `Fixes #<n>`, what changed, and how it was tested. Comment the PR link on the issue and
   add `fixer:pr-open`.

**Hard limits.** Everything in `REVIEW.md` under Blocking applies. Never weaken auth, the path guard, kill switches
(`duet.OFF`, `desktop.OFF`, `web.OFF`), the act tools' approval marking, the sandbox for sessions, or the rules in
`HOW_TO_WORK` and `PLAYBOOK.md`. Never add a tool that moves money or sends as Danny. Never merge, approve, push to
`main`, or mark a PR ready. Never skip or delete a test. If the right fix would need any of that, comment on the issue
and add `needs-danny` instead.

## Where to look

- Live issues: label [`monitor`](https://github.com/space-cowboy2/duet-gateway/issues?q=label%3Amonitor)
- Fixer agent PRs: [`head:fix/`](https://github.com/space-cowboy2/duet-gateway/pulls?q=is%3Apr+head%3Afix%2F)
- Fixer agent runs: Actions → [Fixer agent](https://github.com/space-cowboy2/duet-gateway/actions/workflows/fixer.yml)
- Monitor agent runs: a thread per run in the Duet bridge project, and claude.ai/code → Scheduled

## Turning them off

Monitor agent: pause it at claude.ai/code (Scheduled). Alerts: remove `alerts` from `config.json` or delete `github-token`.
Fixer agent: disable the Fixer agent workflow in GitHub Actions. One issue: add `wontfix-auto`.

# duet-gateway

Remote MCP gateway that lets Claude (claude.ai connectors, Duet) reach tools on a home PC:
- `tv_*`: proxied from the TV remote MCP server
- `money_*`: a read-only allowlist proxied from the Plaid bridge
- `files_list`, `files_read`, `files_search`: read-only, limited to the folders in `roots`
- `run_command`: only the named commands listed in `commands`, which is empty by default
- `start_session`, `send_message`, `read_messages`, `list_sessions`, `end_session`: Claude Code sessions with full autonomy, run as a separate Windows user that cannot see Egnyte or your profile
- `start_egnyte_session`, `send_egnyte_message`: Claude Code on the Egnyte drive (Z:\), run as you, only with your approval tap

OAuth, single user: Claude signs in with a passphrase stored as a scrypt hash. Tokens are kept hashed in `state.json`.

## How Claude Code sessions work

```
Duet ──OAuth──▶ Tailscale Funnel ──▶ gateway.mjs (you, desktop logon, Z:\ mounted)
                                       │  Egnyte sessions: claude.exe as you, cwd Z:\
                                       │
                                       └─ 127.0.0.1:8788 (not on Funnel) ◀── runner.mjs (user duet-agent)
                                                                              normal sessions: claude.exe, --permission-mode auto,
                                                                              only in D:\Projects and D:\Duet
```

- **Normal sessions** edit files, run commands and use git without asking. They run as `duet-agent`, a standard Windows user. Windows itself keeps that user out of `C:\Users\trand` (`.ssh`, `plaid-bridge`, Claude's sign-in, Egnyte's cache) and it has no Z:\ drive. It has no GitHub sign-in, so it cannot push. Folders inside a workspace that hold code running as you (the TV plugin) are write-protected from it (`-Protect` in `setup-agent.ps1`); add any others there.
- **Egnyte sessions** need your tap: in claude.ai, open the connector's tool settings and set `start_egnyte_session` and `send_egnyte_message` to **Needs approval**. The approval card shows `mode`: `read` can only read files; `edit` can change them, and changes sync to the company. Web tools and your secret folders are blocked in both modes. Z:\ only exists while you are signed in to the desktop.
- Each message is one turn of `claude -p`; the session remembers earlier turns. Calls wait up to 45 s for the answer; after that, Duet uses `read_messages`.
- Every session is told never to send messages, post, buy, move money or touch credentials. Duet reads your email, so treat these as guards, not walls: a normal session has a real shell inside its workspaces.
- `gateway.log` and `runner.log` hold ids and outcomes only, never prompts or answers. Sessions and answers are kept in `sessions.json`.

## Setup on a new machine
`files_search` needs ripgrep (`rg`) on PATH: `winget install BurntSushi.ripgrep.MSVC`.
```bash
npm install
cp config.example.json config.json   # edit roots, deny, upstream paths and publicUrl for this machine
npm run check                        # self-tests (selfcheck.mjs is Windows-only)
npm run set-passphrase               # 12+ characters; also revokes existing tokens
npm start                            # listens on 127.0.0.1:<port>
tailscale funnel --bg 8787           # public HTTPS at https://<machine>.<tailnet>.ts.net
```
Then in claude.ai go to Settings → Connectors → Add custom connector, enter `https://<machine>.<tailnet>.ts.net/mcp`, and sign in.

To start it at every Windows logon, create a hidden task. It must run in your desktop logon ("Interactive only"), because that is where Z:\ is mounted:
```powershell
$a = New-ScheduledTaskAction -Execute conhost.exe -Argument "--headless `"C:\Program Files\nodejs\node.exe`" `"$PWD\gateway.mjs`"" -WorkingDirectory $PWD
Register-ScheduledTask duet-gateway -Action $a -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1))
```

### Claude Code sessions (one time)
In an elevated PowerShell in this folder:
```powershell
powershell -ExecutionPolicy Bypass -File .\setup-agent.ps1
```
It creates `duet-agent`, copies `runner.mjs`, `claude.mjs` and `claude.exe` to `C:\ProgramData\duet-agent`, gives the user modify rights on the workspaces (default `D:\Projects`, `D:\Duet`; change with `-Workspaces`), asks for a token from `claude setup-token` (run that in a normal terminal), fills in `claude` in `config.json`, and starts the `duet-agent-runner` task at every boot.

- Update the runner or Claude Code: run the script again. New sign-in token: add `-NewClaudeToken`.
- Remove everything: `setup-agent.ps1 -Uninstall`.

Canary checks after setup (ask Duet):
1. "Start a session and run `dir Z:\` and `type C:\Users\trand\duet-gateway\config.json`": both must fail.
2. "Start a session in duet and create hello.txt": `D:\Duet\hello.txt` appears.
3. "Start an Egnyte session in read mode and list the top folders": claude.ai asks you to approve first.

## Pull request review
Every PR into `main` runs `.github/workflows/pr-review.yml`:
- **Tests**: `npm run check` on a Windows runner.
- **Claude review**: Claude reviews the diff against [REVIEW.md](REVIEW.md) and leaves inline comments. A blocking finding posts "Changes requested" and fails the check; once a later push passes, that review is dismissed. Draft PRs are skipped until they are marked ready.

One-time setup on GitHub:
1. Settings → Secrets and variables → Actions → add `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token`; uses your Claude plan) or `ANTHROPIC_API_KEY`.
2. Settings → Rules → Rulesets (or Branches) → protect `main`: require a pull request, and require the status checks **Tests** and **Claude review**.

The review action refuses to run when a PR changes `pr-review.yml` itself (the file must match `main`), so such a PR's Claude review fails. Merge it with the ruleset's bypass (add Repository admin to the bypass list), then review the workflow change yourself.

To change the bar, edit `REVIEW.md`. The reviewer always judges a PR by the `REVIEW.md` on `main`, so a PR can't lower the bar for itself.

## Not in git (per machine)
`config.json` (passphrase hash, runner token, local paths), `state.json` (tokens), `sessions.json`, `gateway.log`, `duet.OFF`.

## Notes
- Kill switches: create `duet.OFF` in this folder to refuse new Claude Code turns; `tailscale funnel reset` closes the endpoint; `Stop-ScheduledTask duet-agent-runner` stops the runner.
- Anything Claude reads through these tools is sent to Anthropic's cloud. Keep work data (Z:\ Egnyte, Vista) out of `roots`; Egnyte is reachable only through the approval-gated Egnyte tools.
- Normal and Egnyte sessions share your Claude plan's usage limits.
- Unverified: whether Duet accepts custom connectors.

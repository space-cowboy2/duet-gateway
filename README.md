# duet-gateway

Remote MCP gateway that lets Claude (claude.ai connectors, Duet) reach tools on a home PC:
- `tv_*`: proxied from the TV remote MCP server
- `money_*`: a read-only allowlist proxied from the Plaid bridge
- `files_list`, `files_read`, `files_search`: read-only, limited to the folders in `roots`
- `run_command`: only the named commands listed in `commands`, which is empty by default
- `start_session`, `send_message`, `read_messages`, `list_sessions`, `end_session`: Claude Code sessions with full autonomy, run as a separate Windows user that cannot see Egnyte or your profile
- `start_egnyte_session`, `send_egnyte_message`: Claude Code on the Egnyte drive (Z:\), run as you with no shell, only with your approval tap. Off until you set `egnyteEnabled`

OAuth, single user: Claude signs in with a passphrase stored as a scrypt hash. Tokens are kept hashed in `state.json`.

## How Claude Code sessions work

```
Duet ──OAuth──▶ Tailscale Funnel ──▶ gateway.mjs (you, desktop logon, Z:\ mounted)
                                       │  Egnyte sessions: claude.exe as you, cwd Z:\
                                       │
                                       └─ 127.0.0.1:8788 (not on Funnel) ◀── runner.mjs (user duet-agent)
                                                                              normal sessions: claude.exe, --permission-mode auto,
                                                                              writes only in D:\Duet
```

- **Normal sessions** edit files, run commands and use git without asking. They run as `duet-agent`, a standard Windows user. Windows itself keeps that user out of `C:\Users\trand` (`.ssh`, `plaid-bridge`, Claude's sign-in, Egnyte's cache) and it has no Z:\ drive. It has no GitHub sign-in, so it cannot push.
- **It writes only in D:\Duet, never in your own repos.** Anything it can write in a repo you use runs as you later: git hooks and `core.fsmonitor` in `.git`, `.vscode` tasks, `.claude` hooks, npm scripts. VS Code runs git as soon as you open a folder, so that would need no click. So `D:\Projects` is read-only for it (`-Protect` in `setup-agent.ps1`, an explicit deny that also beats drive-wide grants); protect any other folder with code you run the same way. It can still *read* `D:\Projects`, `.env` files included, and it has a full network: a normal session can send anything it can read.
- **Egnyte sessions** need your tap. Set it up first: in claude.ai, open the connector's tool settings and set `start_egnyte_session` and `send_egnyte_message` to **Needs approval**; then set `"egnyteEnabled": true` under `claude` in `config.json` and restart the gateway. Until then the tools don't exist. The approval card shows `mode`: `read` can only read files; `edit` can also change them, and changes sync to the company. Neither mode has a shell or web tools, and Claude Code's permission rules limit file access to Z:\ (every other drive and your profile are denied). Your tap covers what Duet sends, not what the session does after reading a booby-trapped file, which is why it gets no shell. Z:\ only exists while you are signed in to the desktop.
- **One runner at a time.** A normal session runs as `duet-agent` too, so it can read `runner-token` and could ask the gateway for work itself, taking queued prompts or posting fake answers. So each runner process sends a random instance id, and the gateway serves only the first one it sees. Any other is refused while that one keeps polling; each refusal goes to `gateway.log` (`runner: second instance refused`) and counts in `list_sessions` as `runner_conflicts`. Answers are taken only from the instance the turn was handed to. After the runner is quiet for 30 s, the next instance takes over, so a real restart recovers on its own within about 45 s (it adds one or two refusals, and its running turns fail). A count that keeps rising means something other than your runner is polling. The pin survives a gateway restart, so a stray poller can't get in first while the runner reconnects. This detects and blocks a second poller; it can't stop a session that kills the runner first, since both are the same Windows user. A runner that sends no instance id (an old `runner.mjs`) is refused too: run `setup-agent.ps1` again.
- Each message is one turn of `claude -p`; the session remembers earlier turns. Calls wait up to 45 s for the answer; after that, Duet uses `read_messages`.
- Every session is told never to send messages, post, buy, move money or touch credentials. Duet reads your email, so treat these as guards, not walls: a normal session has a real shell inside its workspaces.
- `gateway.log` and `runner.log` hold ids and outcomes only, never prompts or answers. Sessions and answers are kept in `sessions.json`.

## Setup on a new machine
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
It creates `duet-agent`, copies `runner.mjs`, `claude.mjs` and `claude.exe` to `C:\ProgramData\duet-agent`, gives the user modify rights on the workspaces (default `D:\Duet`; change with `-Workspaces`), denies it writes in `-Protect` folders (default `D:\Projects`), asks for a token from `claude setup-token` (run that in a normal terminal), fills in `claude` in `config.json`, and starts the `duet-agent-runner` task at every boot.

- Update the runner or Claude Code: run the script again. If you set it up before `D:\Projects` stopped being a workspace, run it again now: it removes that grant. New sign-in token: add `-NewClaudeToken`.
- Remove everything: `setup-agent.ps1 -Uninstall`.

Canary checks after setup (ask Duet):
1. "Start a session and run `dir Z:\` and `type C:\Users\trand\duet-gateway\config.json`": both must fail.
2. "Start a session and create `D:\Projects\canary.txt`": must fail.
3. "Start a session in duet and create hello.txt": `D:\Duet\hello.txt` appears.
4. "Start an Egnyte session in read mode and list the top folders": claude.ai asks you to approve first.
5. "Start an Egnyte session in read mode, run `dir`, then read `C:\Users\trand\.gitconfig`": both must be refused while Z:\ files still read fine. If Z:\ reads are refused too, Claude Code is treating the mapped drive as a network path; see its permissions docs.

### Getting work out of D:\Duet
Have the session clone your repo into `D:\Duet` and work there. Don't open those clones in VS Code or run git in them yourself, and don't add them to git's `safe.directory`. git refuses them by default because `duet-agent` owns them, and that refusal is what keeps their hooks from running as you. To bring changes over, ask the session for a bundle (`git bundle create D:\Duet\work.bundle main`), then in your own repo:
```bash
git fetch D:/Duet/work.bundle main:duet/work
git diff main duet/work
```

## Not in git (per machine)
`config.json` (passphrase hash, runner token, local paths), `state.json` (tokens), `sessions.json`, `gateway.log`, `duet.OFF`.

## Notes
- Health check: `npm run doctor` (or `node gateway.mjs doctor`) prints one `ok`, `warn` or `fail` line per check and exits 1 on any `fail`. It checks config.json, the passphrase, `publicUrl`, `roots`, the `claude` section (command, runner token, workspaces that hold or sit inside your own repos), `egnyteEnabled`, the Egnyte drive, `duet.OFF`, both loopback ports, the `duet-agent-runner` task and the last `runner.log` line. It never prints secrets or file contents. Run it from an elevated prompt to also compare the runner token with `C:\ProgramData\duet-agent\runner-token`.
- Kill switches: create `duet.OFF` in this folder to refuse new Claude Code turns; `tailscale funnel reset` closes the endpoint; `Stop-ScheduledTask duet-agent-runner` stops the runner.
- Anything Claude reads through these tools is sent to Anthropic's cloud. Keep work data (Z:\ Egnyte, Vista) out of `roots`; Egnyte is reachable only through the approval-gated Egnyte tools.
- Normal and Egnyte sessions share your Claude plan's usage limits.
- Unverified: whether Duet accepts custom connectors.

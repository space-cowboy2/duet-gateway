# duet-gateway

Remote MCP gateway that lets Claude (claude.ai connectors, Duet) reach tools on a home PC:
- `tv_*`: proxied from the TV remote MCP server
- `money_*`: a read-only allowlist proxied from the Plaid bridge
- `files_list`, `files_read`, `files_search`: read-only, limited to the folders in `roots`
- `run_command`: only the named commands listed in `commands`, which is empty by default

OAuth, single user: Claude signs in with a passphrase stored as a scrypt hash. Tokens are kept hashed in `state.json`.

## Setup on a new machine
```bash
npm install
cp config.example.json config.json   # edit roots, deny, upstream paths and publicUrl for this machine
npm run check                        # self-test: path guard, OAuth flow, auth on /mcp
npm run set-passphrase               # 12+ characters; also revokes existing tokens
npm start                            # listens on 127.0.0.1:<port>
tailscale funnel --bg 8787           # public HTTPS at https://<machine>.<tailnet>.ts.net
```
Then in claude.ai go to Settings → Connectors → Add custom connector, enter `https://<machine>.<tailnet>.ts.net/mcp`, and sign in.

To start it at every Windows logon, create a hidden task:
```powershell
$a = New-ScheduledTaskAction -Execute conhost.exe -Argument "--headless `"C:\Program Files\nodejs\node.exe`" `"$PWD\gateway.mjs`"" -WorkingDirectory $PWD
Register-ScheduledTask duet-gateway -Action $a -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1))
```

## Not in git (per machine)
`config.json` (passphrase hash, local paths), `state.json` (tokens), `gateway.log`.

## Notes
- To close the endpoint immediately, run `tailscale funnel reset`.
- Anything Claude reads through these tools is sent to Anthropic's cloud. Never add work data (Z:\ Egnyte, Vista) to `roots`.
- Unverified: whether Duet accepts custom connectors.

// Self-check: path guard, command allowlist, full OAuth flow and /mcp auth. Run: node selfcheck.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { makeGuard, makeContext, createApp, hashPassphrase, checkPassphrase, setLogFile } from "./gateway.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duet-gw-"));
const root = path.join(tmp, "root"), outside = path.join(tmp, "outside");
fs.mkdirSync(path.join(root, "sub"), { recursive: true });
fs.mkdirSync(path.join(root, "blocked"));
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, "sub", "hello.txt"), "hello world");
fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
fs.writeFileSync(path.join(root, "blocked", "x.txt"), "blocked text");
fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
const WIN = process.platform === "win32";
// A link out of the root: a junction on Windows, a symlink elsewhere. The guard must follow it and refuse.
if (WIN) assert.equal(spawnSync("cmd.exe", ["/c", "mklink", "/J", path.join(root, "jump"), outside]).status, 0, "junction");
else fs.symlinkSync(outside, path.join(root, "jump"));

const PASS = "correct horse battery staple";
const port = await new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const cfg = {
  port, publicUrl: `http://127.0.0.1:${port}`, passphraseHash: hashPassphrase(PASS),
  roots: [root], deny: [path.join(root, "blocked")], denyNames: [".env", "*.key"],
  commands: { hi: WIN ? "Write-Output hi" : "echo hi" }, upstreams: [], stateFile: path.join(tmp, "state.json"),
  redirectOrigins: ["http://127.0.0.1:1"],
};
setLogFile(path.join(tmp, "gateway.log"));
let server;
try {
  // passphrase
  assert.ok(checkPassphrase(PASS, cfg.passphraseHash));
  assert.ok(!checkPassphrase("wrong", cfg.passphraseHash));
  assert.ok(!checkPassphrase(PASS, ""));

  // path guard
  const g = makeGuard(cfg);
  assert.ok(g.check(path.join(root, "sub", "hello.txt")));
  for (const bad of [path.join(root, "..", "outside", "secret.txt"), path.join(root, "jump", "secret.txt"), path.join(root, ".env"),
    path.join(root, "blocked", "x.txt"), "C:\\Windows\\win.ini", "Z:\\", "", "sub\\hello.txt", "sub/hello.txt", "/etc/hosts", "/",
    "\\\\127.0.0.1\\c$\\x", "//127.0.0.1/c$/x", "\\\\?\\" + path.join(root, "sub", "hello.txt")]) assert.throws(() => g.check(bad), /not allowed|required/, `allowed: ${bad}`);
  // The same folders by their real path (on CI the temp dir is a short name like RUNNER~1): roots still work, deny still holds.
  const realRoot = fs.realpathSync.native(root);
  assert.ok(g.check(path.join(realRoot, "sub", "hello.txt")));
  assert.throws(() => g.check(path.join(realRoot, "blocked", "x.txt")), /not allowed/);

  // tools
  const ctx = makeContext(cfg);
  const text = r => r.content[0].text;
  // Off Windows the instructions describe the Mac and leave out tools this machine doesn't have.
  if (!WIN) assert.ok(/always-on Mac/.test(ctx.instructions()) && !/Egnyte|money_/.test(ctx.instructions()), ctx.instructions());
  assert.deepEqual((await ctx.listTools()).map(t => t.name).sort(), ["files_list", "files_read", "files_search", "guide", "health_report", "run_command"]);
  // health_report is read-only and returns the summary as JSON.
  const hr = (await ctx.listTools()).find(t => t.name === "health_report");
  assert.equal(hr.annotations?.readOnlyHint, true);
  const report = JSON.parse(text(await ctx.callTool("health_report", { hours: 2 })));
  assert.ok(report.window.hours === 2 && Array.isArray(report.findings) && Array.isArray(report.doctor), JSON.stringify(report).slice(0, 300));
  // The guide's playbook is written for the PC, so off Windows the status names this machine first.
  if (!WIN) assert.match(text(await ctx.callTool("guide", {})),
    /## On this Mac right now\n\n- This machine: Danny's Mac, a Mac\. Where this guide says PC or Windows, read this Mac\. A session here is a separate macOS user\.\n- Desktop control: not set up on this Mac\n/);
  assert.equal(text(await ctx.callTool("files_read", { path: path.join(root, "sub", "hello.txt") })), "hello world");
  assert.ok((await ctx.callTool("files_read", { path: path.join(root, "jump", "secret.txt") })).isError);
  assert.ok((await ctx.callTool("files_read", { path: path.join(root, "bin.dat") })).isError);
  const listing = text(await ctx.callTool("files_list", { path: root }));
  assert.ok(listing.includes("sub" + path.sep) && !listing.includes(".env"), listing);
  const found = text(await ctx.callTool("files_search", { pattern: "hello|SECRET|nope|blocked" }));
  assert.ok(found.includes("hello world"), found);
  assert.ok(!/SECRET|nope|blocked text/.test(found), found);
  assert.ok(!/SECRET/.test(text(await ctx.callTool("files_search", { pattern: "SECRET", glob: "**/.env" }))));
  assert.equal(text(await ctx.callTool("run_command", { name: "hi" })).trim(), "hi");
  assert.ok((await ctx.callTool("run_command", { name: "Remove-Item C:\\" })).isError);
  assert.ok((await ctx.callTool("tv_send_keys", {})).isError);

  // HTTP + OAuth
  server = createApp(cfg, ctx).listen(port, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = cfg.publicUrl;
  const post = (url, body, headers = {}) => fetch(url, { method: "POST", body, headers, redirect: "manual" });
  const mcpCall = token => post(base + "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" });

  let res = await post(base + "/mcp", "{}", { "content-type": "application/json" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /resource_metadata=/);
  assert.equal((await mcpCall("bogus")).status, 401);
  const meta = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
  assert.equal((await fetch(base + "/.well-known/oauth-protected-resource/mcp")).status, 200);

  const redirect = "http://127.0.0.1:1/callback";
  const client = await (await post(meta.registration_endpoint,
    JSON.stringify({ redirect_uris: [redirect], client_name: "selfcheck", token_endpoint_auth_method: "none" }),
    { "content-type": "application/json" })).json();
  assert.ok(client.client_id, JSON.stringify(client));
  assert.equal((await post(meta.registration_endpoint, JSON.stringify({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
    { "content-type": "application/json" })).status, 400, "foreign redirect_uri registered");

  const startLogin = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const u = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, state: "xyz",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const r = await fetch(u);
    assert.equal(r.status, 200);
    return { verifier, id: (await r.text()).match(/name="id" value="([0-9a-f]+)"/)[1] };
  };
  const login = (id, p) => post(base + "/login", new URLSearchParams({ id, passphrase: p }));

  // lockout after 5 wrong tries
  const locked = await startLogin();
  for (let i = 1; i < 5; i++) assert.equal((await login(locked.id, "wrong")).status, 401);
  assert.equal((await login(locked.id, "wrong")).status, 403);
  assert.equal((await login(locked.id, PASS)).status, 400);

  const { verifier, id } = await startLogin();
  res = await login(id, PASS);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location"));
  assert.equal(loc.searchParams.get("state"), "xyz");
  const codeBody = () => new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code"),
    code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect });
  const tok = await (await post(meta.token_endpoint, codeBody())).json();
  assert.ok(tok.access_token, JSON.stringify(tok));
  assert.equal((await post(meta.token_endpoint, codeBody())).status, 400, "code replay");

  res = await mcpCall(tok.access_token);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /files_read/);

  const refreshBody = () => new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id });
  const tok2 = await (await post(meta.token_endpoint, refreshBody())).json();
  assert.ok(tok2.access_token, JSON.stringify(tok2));
  assert.equal((await post(meta.token_endpoint, refreshBody())).status, 400, "refresh rotation");
  assert.equal((await mcpCall(tok2.access_token)).status, 200);

  const logged = fs.readFileSync(path.join(tmp, "gateway.log"), "utf8");
  assert.ok(!/hello world|SECRET|correct horse/.test(logged), "log leaks content");
  console.log("selfcheck: all passed");
} finally {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// duet-gateway: a remote MCP server for Claude custom connectors (claude.ai, Duet).
// Re-exposes Danny's local stdio MCP servers (tv, money) plus read-only file tools,
// behind single-user OAuth (passphrase). Listens on 127.0.0.1 only; Tailscale Funnel publishes it.
import express from "express";
import { rateLimit } from "express-rate-limit";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { execFile } from "node:child_process";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_READ = 1 << 20, MAX_OUT = 60_000, MAX_LIST = 500;
const ACCESS_TTL = 3600, REFRESH_TTL = 30 * 86400, CODE_TTL = 300, LOGIN_TTL = 600, MAX_TRIES = 5;
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const INSTRUCTIONS = `Tools on Danny's personal Windows PC.
- files_* are read-only and limited to a few allowed folders. Work data is never available here.
- tv_* control his TV through his hub; money_* read his bank balances and transactions (summarize, don't echo account numbers).`;

let logFile = path.join(HERE, "gateway.log");
export const setLogFile = f => { logFile = f; };
// Tool name and outcome only: never arguments, file contents or amounts.
const log = msg => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + "\n"); } catch {}
};
const now = () => Math.floor(Date.now() / 1000);
const sha = s => createHash("sha256").update(s).digest("hex");
const clip = s => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n… truncated (${s.length} chars)` : s);

export function loadConfig(file = process.env.DUET_GATEWAY_CONFIG || path.join(HERE, "config.json")) {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  return { ...cfg, file, stateFile: path.join(path.dirname(file), "state.json") };
}

// ---- passphrase ----
export function hashPassphrase(p) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(p, salt, 32).toString("hex")}`;
}
export function checkPassphrase(p, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || hash?.length !== 64 || typeof p !== "string" || !p) return false;
  return timingSafeEqual(scryptSync(p, Buffer.from(salt, "hex"), 32), Buffer.from(hash, "hex"));
}

// ---- path guard ----
const norm = p => path.resolve(p).toLowerCase().replace(/[\\/]+$/, "");
const within = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const globRe = g => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");

export function makeGuard(cfg) {
  const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const roots = cfg.roots.map(r => norm(real(r)));
  const deny = (cfg.deny || []).map(norm);
  const names = (cfg.denyNames || []).map(globRe);
  const deniedName = n => names.some(re => re.test(n));
  // Checks a resolved path string; used directly on ripgrep output.
  const allowed = p => {
    const n = norm(p);
    return roots.some(r => within(n, r)) && !deny.some(d => within(n, d)) && !n.split(path.sep).some(deniedName);
  };
  // realpath follows junctions/symlinks, so a link inside a root can't point outside it.
  const check = p => {
    if (typeof p !== "string" || !p) throw new Error("path is required");
    let abs;
    try { abs = fs.realpathSync.native(path.resolve(p)); } catch { throw new Error(`not found: ${p}`); }
    if (!allowed(abs)) throw new Error(`not allowed: ${p}`);
    return abs;
  };
  return { check, allowed, deniedName };
}

// ---- local tools ----
function run(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) => {
      if (err && !stdout && !(opts.okCodes || []).includes(err.code)) reject(new Error(stderr?.trim() || err.message));
      else resolve(String(stdout));
    });
  });
}

function localTools(cfg, guard) {
  const obj = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
  const tools = {
    files_list: {
      description: "List a folder on Danny's PC (read-only). Call with no path to see the allowed folders.",
      inputSchema: obj({ path: { type: "string", description: "Absolute Windows path" } }),
      run: ({ path: p }) => {
        if (!p) return "Allowed folders:\n" + cfg.roots.join("\n");
        const dir = guard.check(p);
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !guard.deniedName(e.name));
        const lines = entries.slice(0, MAX_LIST).map(e => (e.isDirectory() ? e.name + "\\" : e.name));
        if (entries.length > MAX_LIST) lines.push(`… ${entries.length - MAX_LIST} more`);
        return lines.join("\n") || "(empty)";
      },
    },
    files_read: {
      description: "Read a text file on Danny's PC (read-only, up to 1 MB).",
      inputSchema: obj({ path: { type: "string", description: "Absolute Windows path" } }, ["path"]),
      run: ({ path: p }) => {
        const file = guard.check(p);
        const st = fs.statSync(file);
        if (!st.isFile()) throw new Error("not a file");
        if (st.size > MAX_READ) throw new Error(`file is ${st.size} bytes; the limit is ${MAX_READ}`);
        const buf = fs.readFileSync(file);
        if (buf.subarray(0, 8192).includes(0)) throw new Error("binary file; only text files can be read");
        return buf.toString("utf8");
      },
    },
    files_search: {
      description: "Search text in files on Danny's PC with a regex (ripgrep). Up to 5 matches per file.",
      inputSchema: obj({
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "Folder to search; default: all allowed folders" },
        glob: { type: "string", description: "Optional file filter, e.g. *.md" },
      }, ["pattern"]),
      run: async ({ pattern, path: p, glob }) => {
        if (typeof pattern !== "string" || !pattern) throw new Error("pattern is required");
        const args = ["--null", "--line-number", "--no-heading", "--color", "never", "--max-count", "5",
          "--max-columns", "300", "--max-filesize", "1M"];
        if (glob) args.push("--glob", String(glob));
        // Deny globs go last: in ripgrep the last matching glob wins.
        for (const g of cfg.denyNames || []) args.push("--iglob", "!" + g);
        args.push("--regexp", pattern, "--", ...(p ? [guard.check(p)] : cfg.roots));
        const out = await run("rg", args, { timeout: 20_000, okCodes: [1] });
        const lines = out.split("\n").filter(l => l.includes("\0") && guard.allowed(l.slice(0, l.indexOf("\0"))));
        return clip(lines.map(l => l.replace("\0", ":")).join("\n")) || "(no matches)";
      },
    },
  };
  const names = Object.keys(cfg.commands || {});
  if (names.length) tools.run_command = {
    description: "Run one of Danny's pre-approved PowerShell commands by name: " + names.join(", "),
    inputSchema: obj({ name: { type: "string", enum: names } }, ["name"]),
    run: async ({ name }) => {
      if (!Object.hasOwn(cfg.commands, name)) throw new Error(`unknown command: ${name}`);
      return clip(await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", cfg.commands[name]], { timeout: 60_000 }));
    },
  };
  return tools;
}

// ---- upstream stdio servers ----
class Upstream {
  constructor(spec) { Object.assign(this, spec); this.client = null; this.connecting = null; }
  get() {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const client = new Client({ name: "duet-gateway", version: VERSION });
      client.onclose = () => { if (this.client === client) this.client = null; };
      await client.connect(new StdioClientTransport({ command: this.command, args: this.args, env: process.env, stderr: "ignore" }));
      this.client = client;
      return client;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async tools() {
    const { tools } = await (await this.get()).listTools();
    return tools.filter(t => !this.allow || this.allow.includes(t.name))
      .map(t => ({ ...t, name: `${this.prefix}_${t.name}`, description: `[${this.prefix}] ${t.description || ""}` }));
  }
  async call(name, args) {
    if (this.allow && !this.allow.includes(name)) throw new Error(`not allowed: ${this.prefix}_${name}`);
    // TV macros take ~25 s and long sequences more; the SDK default is 60 s.
    return (await this.get()).callTool({ name, arguments: args }, undefined, { timeout: 200_000 });
  }
  close() { return this.client?.close(); }
}

export function makeContext(cfg) {
  const guard = makeGuard(cfg);
  const local = localTools(cfg, guard);
  const ups = (cfg.upstreams || []).map(s => new Upstream(s));
  return {
    ups,
    instructions: () => [INSTRUCTIONS, ...ups.map(u => u.client?.getInstructions()).filter(Boolean)].join("\n\n"),
    async listTools() {
      const lists = await Promise.allSettled(ups.map(u => u.tools()));
      lists.forEach((r, i) => r.status === "rejected" && log(`upstream ${ups[i].prefix} unavailable: ${r.reason?.message}`));
      return [
        ...Object.entries(local).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
        ...lists.flatMap(r => (r.status === "fulfilled" ? r.value : [])),
      ];
    },
    async callTool(name, args) {
      const t0 = Date.now();
      let ok = false;
      try {
        if (Object.hasOwn(local, name)) {
          const text = String(await local[name].run(args || {}));
          ok = true;
          return { content: [{ type: "text", text }] };
        }
        const i = name.indexOf("_");
        const up = i > 0 && ups.find(u => u.prefix === name.slice(0, i));
        if (!up) throw new Error(`unknown tool: ${name}`);
        const res = await up.call(name.slice(i + 1), args || {});
        ok = !res.isError;
        return res;
      } catch (e) {
        return { content: [{ type: "text", text: String(e?.message || e) }], isError: true };
      } finally {
        log(`tool ${name} ${ok ? "ok" : "error"} ${Date.now() - t0}ms`);
      }
    },
  };
}

function buildServer(ctx) {
  const server = new Server({ name: "dannys-pc", version: VERSION }, { capabilities: { tools: {} }, instructions: ctx.instructions() });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await ctx.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, req => ctx.callTool(req.params.name, req.params.arguments));
  return server;
}

// ---- single-user OAuth ----
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function sendLogin(res, status, id, clientName, error = "") {
  res.status(status).set({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Cache-Control": "no-store" })
    .type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Danny's PC sign-in</title>
<style>body{font:16px system-ui,sans-serif;max-width:24rem;margin:12vh auto;padding:0 16px;background:#fff;color:#111}
input,button{font:inherit;width:100%;padding:.6rem;margin:.4rem 0;box-sizing:border-box}.err{color:#b00020}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.err{color:#ff8a80}}</style>
<h1>Danny's PC</h1><p>${esc(clientName || "Claude")} is asking for the TV, finance and file tools.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/login"><input type="hidden" name="id" value="${esc(id)}">
<label for="p">Passphrase</label><input id="p" name="passphrase" type="password" autocomplete="current-password" required autofocus>
<button>Allow</button></form></html>`);
}

export function makeAuth(cfg) {
  let state;
  try { state = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")); } catch { state = {}; }
  state.clients ??= {};
  state.tokens ??= {};
  const save = () => {
    for (const [h, t] of Object.entries(state.tokens)) if (t.exp < now()) delete state.tokens[h];
    fs.writeFileSync(cfg.stateFile, JSON.stringify(state));
  };
  const pending = new Map(), codes = new Map();
  // Tokens are stored only as hashes.
  const issue = clientId => {
    const access = randomBytes(32).toString("base64url"), refresh = randomBytes(32).toString("base64url");
    state.tokens[sha(access)] = { type: "access", clientId, exp: now() + ACCESS_TTL };
    state.tokens[sha(refresh)] = { type: "refresh", clientId, exp: now() + REFRESH_TTL };
    save();
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh };
  };
  const liveCode = (client, code) => {
    const c = codes.get(code);
    if (!c || c.clientId !== client.client_id || c.exp < now()) throw new InvalidGrantError("invalid or expired code");
    return c;
  };

  const provider = {
    clientsStore: {
      getClient: id => state.clients[id],
      registerClient: c => { state.clients[c.client_id] = c; save(); return c; },
    },
    async authorize(client, params, res) {
      const id = randomBytes(16).toString("hex");
      pending.set(id, { clientId: client.client_id, params, exp: now() + LOGIN_TTL, tries: 0 });
      sendLogin(res, 200, id, client.client_name);
    },
    async challengeForAuthorizationCode(client, code) { return liveCode(client, code).params.codeChallenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const c = liveCode(client, code);
      codes.delete(code);
      if (redirectUri && redirectUri !== c.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
      return issue(client.client_id);
    },
    async exchangeRefreshToken(client, refreshToken) {
      const h = sha(refreshToken), t = state.tokens[h];
      if (!t || t.type !== "refresh" || t.clientId !== client.client_id || t.exp < now()) throw new InvalidGrantError("invalid refresh token");
      delete state.tokens[h]; // rotate
      return issue(client.client_id);
    },
    async verifyAccessToken(token) {
      const t = state.tokens[sha(token)];
      if (!t || t.type !== "access" || t.exp < now()) throw new InvalidTokenError("invalid or expired token");
      return { token, clientId: t.clientId, scopes: [], expiresAt: t.exp };
    },
    async revokeToken(client, { token }) {
      const h = sha(token);
      if (state.tokens[h]?.clientId === client.client_id) { delete state.tokens[h]; save(); }
    },
  };

  function login(req, res) {
    const { id, passphrase } = req.body || {};
    const p = pending.get(id);
    if (!p || p.exp < now()) {
      pending.delete(id);
      return res.status(400).type("text").send("This sign-in expired. Start again from Claude.");
    }
    if (!checkPassphrase(passphrase, cfg.passphraseHash)) {
      log(`login failed (${p.tries + 1}/${MAX_TRIES}) from ${req.ip}`);
      if (++p.tries >= MAX_TRIES) {
        pending.delete(id);
        return res.status(403).type("text").send("Too many attempts. Start again from Claude.");
      }
      return sendLogin(res, 401, id, state.clients[p.clientId]?.client_name, "Wrong passphrase.");
    }
    pending.delete(id);
    const code = randomBytes(32).toString("base64url");
    codes.set(code, { clientId: p.clientId, params: p.params, exp: now() + CODE_TTL });
    const url = new URL(p.params.redirectUri);
    url.searchParams.set("code", code);
    if (p.params.state !== undefined) url.searchParams.set("state", p.params.state);
    log(`login ok for client ${p.clientId}`);
    res.redirect(302, url.href);
  }
  return { provider, login };
}

// ---- HTTP ----
export function createApp(cfg, ctx) {
  const auth = makeAuth(cfg);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback"); // Tailscale Funnel proxies from localhost
  const mcpUrl = new URL("/mcp", cfg.publicUrl);
  app.use(mcpAuthRouter({ provider: auth.provider, issuerUrl: new URL(cfg.publicUrl), resourceServerUrl: mcpUrl, resourceName: "Danny's PC" }));
  app.post("/login", rateLimit({ windowMs: 15 * 60_000, limit: 20 }), express.urlencoded({ extended: false, limit: "4kb" }), auth.login);
  const bearer = requireBearerAuth({ verifier: auth.provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const server = buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`mcp request failed: ${e?.message || e}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  });
  app.all("/mcp", bearer, (_req, res) => res.status(405).set("Allow", "POST").end());
  return app;
}

async function main() {
  const cfg = loadConfig();
  if (process.argv[2] === "set-passphrase") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const p = (await rl.question("New passphrase (12+ characters): ")).trim();
    rl.close();
    if (p.length < 12) { console.error("Too short; nothing saved."); process.exit(1); }
    const raw = JSON.parse(fs.readFileSync(cfg.file, "utf8"));
    raw.passphraseHash = hashPassphrase(p);
    fs.writeFileSync(cfg.file, JSON.stringify(raw, null, 2) + "\n");
    try {
      const s = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8"));
      s.tokens = {};
      fs.writeFileSync(cfg.stateFile, JSON.stringify(s));
    } catch {}
    console.log("Saved. Existing sign-ins are revoked; restart the gateway.");
    return;
  }
  if (!cfg.passphraseHash) log("WARNING: no passphrase set, so sign-in is disabled. Run: npm run set-passphrase");
  const ctx = makeContext(cfg);
  const server = createApp(cfg, ctx).listen(cfg.port, "127.0.0.1", () => log(`listening on 127.0.0.1:${cfg.port}; public ${cfg.publicUrl}/mcp`));
  const stop = async () => { server.close(); await Promise.allSettled(ctx.ups.map(u => u.close())); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

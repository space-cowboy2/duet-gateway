// web.mjs: what the gateway knows about a browser upstream (Playwright MCP). Shared by gateway.mjs and doctor.mjs.
// The browser runs as Danny in his desktop logon, with its own profile. These checks keep it on the internet:
// no local files, no pages on the PC or the home network, no code run in the page or the server.
import net from "node:net";
import path from "node:path";

// Playwright MCP is started through node, so it is recognised by its script path, or by "kind": "browser" in config.json.
const PLAYWRIGHT = /@?playwright[\\/-]mcp/i;
export const isBrowser = spec => spec?.kind === "browser"
  || [spec?.command, ...(Array.isArray(spec?.args) ? spec.args : [])].some(a => PLAYWRIGHT.test(String(a)));

// Tools that run code in the page or in the server, read local files, or install software.
export const BROWSER_UNSAFE = ["browser_evaluate", "browser_run_code_unsafe", "browser_file_upload", "browser_drop", "browser_install"];

// Flags the gateway refuses to start with: local file access, and a config file that could turn it on unseen.
const REFUSED_FLAGS = ["--allow-unrestricted-file-access", "--config"];
// Flags that attach to Danny's everyday browser, with every sign-in in it (work ones too). The doctor warns about them.
const EVERYDAY_FLAGS = ["--extension", "--cdp-endpoint", "--endpoint"];
const flagsIn = (args, flags) => flags.filter(f => (Array.isArray(args) ? args : []).some(a => String(a) === f || String(a).startsWith(f + "=")));
export const refusedFlags = args => flagsIn(args, REFUSED_FLAGS);
export const everydayFlags = args => flagsIn(args, EVERYDAY_FLAGS);

// IPv4 ranges that are this PC, the home network or the tailnet: [first address, prefix length].
const LOCAL_V4 = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]];
const v4 = s => s.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const localV4 = host => LOCAL_V4.some(([base, bits]) => Math.floor(v4(host) / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits)));
const LOCAL_NAMES = /(^|\.)(localhost|local|lan|home|internal|home\.arpa|ts\.net)$/;

export function isLocalHost(host) {
  if (net.isIPv4(host)) return localV4(host);
  // Loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10) and every IPv4-mapped address.
  if (net.isIPv6(host)) return /^(::1?$|f[cd]|fe[89ab]|::ffff:)/.test(host);
  // A name with no dot is a machine on the home network.
  return !host.includes(".") || LOCAL_NAMES.test(host);
}

/**
 * Why the browser may not open this URL, or null when it may. `localHosts` are host names Danny listed in config.json.
 * new URL() already turns 0x7f.1, 2130706433 and the like into 127.0.0.1, so those are caught as addresses.
 * This checks the address Duet asks for. It can't see where a page redirects or links to, so it is a guard, not a wall.
 */
export function webUrlProblem(raw, localHosts = []) {
  let url;
  try { url = new URL(String(raw)); } catch { return "that is not a full web address (start it with https://)"; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `only http and https pages can be opened, not ${url.protocol}`;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if ((Array.isArray(localHosts) ? localHosts : []).some(h => String(h).toLowerCase() === host)) return null;
  return isLocalHost(host) ? `${host} is on the PC or the home network; the web browser opens internet pages only` : null;
}

const after = (args, flag) => { const i = (Array.isArray(args) ? args : []).indexOf(flag); return i < 0 ? null : args[i + 1] ?? null; };
// Where the browser keeps its sign-ins, read from the upstream's own flags.
export const profileDir = spec => after(spec?.args, "--user-data-dir");

/**
 * The web upstream for this machine, built from the entry in config.example.json: `node gateway.mjs enable-web` writes it.
 * Only the machine's paths change (node, Playwright MCP's cli.js, the data folder). `old` is the entry already in
 * config.json, if any: its localHosts list is kept.
 */
export function webUpstream(example, { node, cli, dataDir, old }) {
  const args = [cli, ...example.args.slice(1)];
  for (const [flag, name] of [["--user-data-dir", "web-profile"], ["--output-dir", "web-files"]]) args[args.indexOf(flag) + 1] = path.join(dataDir, name);
  return { ...example, enabled: true, command: node, args, localHosts: Array.isArray(old?.localHosts) ? old.localHosts : [] };
}

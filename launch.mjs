// launch.mjs: turns the app name Duet passes to <prefix>_desktop_launch into something agent-desktop can start on Windows.
// agent-desktop takes an absolute path, or a bare name that exists under System32 or the Windows folder. Duet says
// "Calculator" or "Microsoft Edge", which is neither, and the call failed with APP_NOT_FOUND (issue #17).
// The name is looked up in this order: an absolute path or a system program as given, a short list of everyday names,
// the App Paths registry key, then the Start Menu shortcuts. Nothing here runs a command built from the name: the
// registry is read with reg.exe and a fixed key, and shortcut files are parsed in this file.
// The machine is reached only through `probe`, so desktopcheck.mjs can fake it on any OS.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const win = path.win32;
export const MAX_LAUNCH_MS = 60_000;
const MAX_SHORTCUTS = 2000, MAX_LNK = 1 << 20;

// Everyday names for programs whose file name is something else. Values are bare program names: each is then found
// under the Windows folders or in App Paths like any other.
export const ALIASES = {
  calculator: "calc", "file explorer": "explorer", explorer: "explorer", "windows explorer": "explorer", paint: "mspaint",
  "task manager": "taskmgr", "snipping tool": "SnippingTool", "control panel": "control", "registry editor": "regedit",
  "character map": "charmap", "remote desktop": "mstsc", "remote desktop connection": "mstsc", "resource monitor": "resmon",
  "event viewer": "eventvwr", "system information": "msinfo32", "disk cleanup": "cleanmgr", "on-screen keyboard": "osk",
  edge: "msedge", "microsoft edge": "msedge", chrome: "chrome", "google chrome": "chrome", firefox: "firefox", "mozilla firefox": "firefox",
  word: "winword", "microsoft word": "winword", excel: "excel", "microsoft excel": "excel", powerpoint: "powerpnt",
  "microsoft powerpoint": "powerpnt", outlook: "outlook", "microsoft outlook": "outlook", onenote: "onenote", teams: "ms-teams",
  "vs code": "code", "visual studio code": "code", "windows media player": "wmplayer", wordpad: "wordpad",
};

const isAbsolute = p => /^[A-Za-z]:[\\/]/.test(p);
const bare = s => s.replace(/\.exe$/i, "");
// A program name that is safe to put into a registry key or a file name: letters, digits, space, dot, dash, plus, underscore.
const plainName = s => /^[\w][\w .+-]{0,63}$/.test(s);

/**
 * Reads the target of a Windows shortcut (.lnk, the Shell Link format) from its bytes.
 * Returns { target, args } or null when the file is not a shortcut to a local file.
 */
export function parseShortcut(buf) {
  try {
    if (buf.length < 76 || buf.readUInt32LE(0) !== 0x4c) return null;
    const flags = buf.readUInt32LE(20);
    const has = bit => (flags & (1 << bit)) !== 0;
    let at = 76;
    if (has(0)) at += 2 + buf.readUInt16LE(at); // the item id list
    let target = null;
    if (has(1)) {
      const size = buf.readUInt32LE(at), header = buf.readUInt32LE(at + 4), info = buf.readUInt32LE(at + 8);
      const cstr = off => { const s = at + off, e = buf.indexOf(0, s); return buf.toString("latin1", s, e < 0 || e > at + size ? at + size : e); };
      const wstr = off => { let e = at + off; while (e + 1 < at + size && buf.readUInt16LE(e) !== 0) e += 2; return buf.toString("utf16le", at + off, e); };
      if (info & 1) { // a path on a local drive
        const unicode = header >= 0x24 && buf.readUInt32LE(at + 28);
        const base = unicode ? wstr(unicode) : cstr(buf.readUInt32LE(at + 16));
        const suffixAt = header >= 0x24 && buf.readUInt32LE(at + 32);
        target = base + (suffixAt ? wstr(suffixAt) : cstr(buf.readUInt32LE(at + 24)));
      }
      at += size;
    }
    // The strings that follow, in this order: name, relative path, working folder, arguments, icon.
    let args = "";
    for (const bit of [2, 3, 4, 5, 6]) {
      if (!has(bit)) continue;
      const n = buf.readUInt16LE(at), bytes = has(7) ? n * 2 : n;
      if (bit === 5) args = buf.toString(has(7) ? "utf16le" : "latin1", at + 2, at + 2 + bytes);
      at += 2 + bytes;
    }
    return target && isAbsolute(target) ? { target, args } : null;
  } catch { return null; }
}

// Splits a shortcut's argument string the way Windows does for the simple cases: spaces separate, double quotes group.
export const splitArgs = s => [...String(s).matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);

// The real machine. Every method is safe to call with any string: none builds a command line from it.
export function realLaunchProbe(env = process.env) {
  const root = env.SystemRoot || "C:\\Windows";
  const menus = [env.ProgramData && win.join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"),
    env.APPDATA && win.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")].filter(Boolean);
  return {
    systemDirs: [win.join(root, "System32"), root],
    exists: p => { try { return fs.statSync(p).isFile(); } catch { return false; } },
    // The default value of HKCU or HKLM ...\App Paths\<name>.exe, which is where installers register a program by name.
    appPath: name => new Promise(resolve => {
      const ask = (hive, next) => execFile(win.join(root, "System32", "reg.exe"),
        ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}.exe`, "/ve"],
        { windowsHide: true, timeout: 5000 }, (err, out) => {
          const m = !err && /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(out));
          m ? resolve(m[1].replace(/^"|"$/g, "").replace(/%(\w+)%/g, (all, k) => env[k] ?? all)) : next();
        });
      ask("HKCU", () => ask("HKLM", () => resolve(null)));
    }),
    // Every Start Menu shortcut: [{ name, file }]. Names are the file names without ".lnk".
    shortcuts: () => {
      const out = [];
      const walk = (dir, depth) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= MAX_SHORTCUTS) return;
          const file = win.join(dir, e.name);
          if (e.isDirectory()) { if (depth < 4) walk(file, depth + 1); }
          else if (/\.lnk$/i.test(e.name)) out.push({ name: e.name.slice(0, -4), file });
        }
      };
      for (const m of menus) walk(m, 0);
      return out;
    },
    readShortcut: file => { try { return fs.statSync(file).size <= MAX_LNK ? parseShortcut(fs.readFileSync(file)) : null; } catch { return null; } },
  };
}

const notFound = (app, close = []) => Object.assign(
  new Error(`No app named "${app}" was found on the PC. Nothing was started. ${close.length ? `Close matches in the Start Menu: ${close.join(", ")}. ` : ""}Pass the name as the Start Menu shows it, a program name such as calc or msedge, or the full path of an .exe. A Microsoft Store app with no shortcut (Settings, for one) can't be started this way: use list_windows to find it if it is open.`),
  { launch: true, code: "APP_NOT_FOUND" });

/**
 * What to pass to agent-desktop for `app`: { app, args?, how }. `args` is set only when a shortcut carries its own.
 * Throws an error with code APP_NOT_FOUND (and close matches) when the name leads nowhere.
 */
export async function resolveLaunch(app, probe) {
  if (typeof app !== "string" || !app.trim()) throw notFound(String(app ?? ""));
  const asked = app.trim();
  if (isAbsolute(asked)) return { app: asked, how: "path" };
  if (/[\\/]/.test(asked)) throw notFound(asked); // a relative or network path: never guessed at
  const inSystem = name => probe.systemDirs.some(d => probe.exists(win.join(d, `${bare(name)}.exe`)));
  const byName = async name => {
    if (!plainName(name)) return null;
    if (inSystem(name)) return { app: bare(name), how: "system" };
    const p = await probe.appPath(bare(name));
    return p && isAbsolute(p) && probe.exists(p) ? { app: p, how: "app-path" } : null;
  };
  const key = bare(asked).toLowerCase().replace(/\s+/g, " ");
  const direct = await byName(asked) || (Object.hasOwn(ALIASES, key) ? await byName(ALIASES[key]) : null);
  if (direct) return direct;
  // Start Menu: the exact name first, then a name that starts with it, then one that contains it. One match only.
  const all = probe.shortcuts(), lower = s => s.toLowerCase();
  const pick = test => { const hits = all.filter(s => test(lower(s.name))); return new Set(hits.map(h => lower(h.name))).size === 1 ? hits : []; };
  const hits = [n => n === key, n => n.startsWith(key), n => n.includes(key)].map(pick).find(h => h.length) || [];
  for (const h of hits) {
    const link = probe.readShortcut(h.file);
    if (link && /\.exe$/i.test(link.target) && probe.exists(link.target))
      return { app: link.target, how: "shortcut", ...(link.args && { args: splitArgs(link.args) }) };
  }
  const close = [...new Set(all.filter(s => key.length >= 3 && (lower(s.name).includes(key) || key.includes(lower(s.name)))).map(s => s.name))].slice(0, 6);
  throw notFound(asked, close);
}

/**
 * The arguments for a desktop_launch call, with the app resolved and the time limit capped. The caller's own
 * arguments win over a shortcut's.
 */
export async function launchArgs(args, probe) {
  const found = await resolveLaunch(args.app, probe);
  const out = { ...args, app: found.app };
  if (found.args?.length && !(Array.isArray(args.args) && args.args.length)) out.args = found.args;
  if (Number(out.timeout) > MAX_LAUNCH_MS) out.timeout = MAX_LAUNCH_MS;
  return out;
}

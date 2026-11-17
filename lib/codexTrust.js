'use strict';
// Read and set trust for OUR hooks through the official Codex app-server API
// (hooks/list + config/batchWrite), exactly what Codex's own "Trust" button does.
// The binary is located from the installed official extension, so it follows
// whatever Codex version and install path the user has.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { MARK } = require('./hooks');

function versionKey(name) {
  const m = name.match(/openai\.chatgpt-([\d.]+)-/);
  return m ? m[1].split('.').map(Number) : [0];
}
function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}

// Windows: prefer the extension VS Code actually activated; else newest non-obsolete install.
function windowsBinary(activeExtensionPath) {
  const rel = path.join('bin', 'windows-x86_64', 'codex.exe');
  if (activeExtensionPath && fs.existsSync(path.join(activeExtensionPath, rel))) return path.join(activeExtensionPath, rel);
  const root = path.join(os.homedir(), '.vscode', 'extensions');
  let obsolete = {};
  try { obsolete = JSON.parse(fs.readFileSync(path.join(root, '.obsolete'), 'utf8')); } catch { /* none */ }
  const candidates = (fs.existsSync(root) ? fs.readdirSync(root) : [])
    .filter((n) => /^openai\.chatgpt-[\d.]+-win32-x64$/.test(n) && !obsolete[n] && fs.existsSync(path.join(root, n, rel)))
    .sort((a, b) => compare(versionKey(b), versionKey(a)));
  if (!candidates.length) throw new Error('codex_extension_not_found_on_windows');
  return path.join(root, candidates[0], rel);
}

// WSL: newest non-obsolete official Linux extension in ~/.vscode-server (or -insiders).
const FIND_WSL = `
import json, os, re, sys
best = None
for base in ("~/.vscode-server/extensions", "~/.vscode-server-insiders/extensions"):
    root = os.path.expanduser(base)
    try: obsolete = json.load(open(os.path.join(root, ".obsolete")))
    except Exception: obsolete = {}
    try: names = os.listdir(root)
    except Exception: continue
    for n in names:
        m = re.fullmatch(r"openai\\.chatgpt-([\\d.]+)-linux-x64", n)
        b = os.path.join(root, n, "bin/linux-x86_64/codex")
        if m and not obsolete.get(n) and os.access(b, os.X_OK):
            v = [int(x) for x in m.group(1).split(".")]
            if best is None or v > best[0]: best = (v, b)
print(json.dumps({"home": os.path.expanduser("~"), "binary": best[1] if best else None}))
`;
function wslTarget(distro) {
  const out = execFileSync('wsl.exe', ['-d', distro, '--exec', 'python3', '-c', FIND_WSL], { windowsHide: true, timeout: 30000 });
  const info = JSON.parse(out.toString('utf8').trim().split(/\r?\n/).pop());
  if (!info.binary) throw new Error('codex_extension_not_found_in_wsl');
  return info;
}

// Minimal line-delimited JSON-RPC session with a short-lived app-server.
function session(command, args, cwd) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], cwd });
  let buffer = ''; let next = 1; const waiting = new Map();
  child.stdout.on('data', (d) => {
    buffer += d.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && waiting.has(m.id) && (m.result !== undefined || m.error !== undefined)) {
        const w = waiting.get(m.id); waiting.delete(m.id);
        if (m.error) w.reject(new Error(`codex_rpc_error: ${m.error.message || ''}`.slice(0, 200))); else w.resolve(m.result);
      }
    }
  });
  const failAll = (e) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); };
  child.on('error', () => failAll(new Error('codex_start_failed')));
  child.on('close', () => failAll(new Error('codex_exited')));
  const request = (method, params, timeout = 40000) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('codex_timeout')); }, timeout);
    waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { request, notify, close: () => { try { child.kill(); } catch { /* ignore */ } } };
}

const SERVER_ARGS = ['--no-daemon', 'app-server', '-c', 'analytics.enabled=false'];

async function withServer(platform, activeExtensionPath, fn) {
  let s; let home;
  if (platform === 'windows') {
    home = os.homedir();
    s = session(windowsBinary(activeExtensionPath), SERVER_ARGS, home);
  } else {
    const t = wslTarget(platform);
    home = t.home;
    s = session('wsl.exe', ['-d', platform, '--cd', '~', '--exec', t.binary, ...SERVER_ARGS]);
  }
  try {
    await s.request('initialize', { clientInfo: { name: 'codex-notify', version: '2' } });
    s.notify('initialized');
    return await fn(s, home);
  } finally { s.close(); }
}

async function listOurs(s, home) {
  const r = await s.request('hooks/list', { cwds: [home] });
  const hooks = [];
  for (const entry of (r && r.data) || []) {
    for (const h of entry.hooks || []) {
      if (typeof h.command === 'string' && h.command.includes(MARK) && h.source === 'user') hooks.push(h);
    }
  }
  return hooks;
}

function summarize(hooks) {
  return hooks.map((h) => ({ key: h.key, event: h.eventName, command: h.command, trust: h.trustStatus }));
}

async function status(platform, activeExtensionPath) {
  return withServer(platform, activeExtensionPath, async (s, home) => summarize(await listOurs(s, home)));
}

async function trust(platform, activeExtensionPath) {
  return withServer(platform, activeExtensionPath, async (s, home) => {
    const ours = (await listOurs(s, home)).filter((h) => h.trustStatus !== 'trusted' && h.currentHash);
    if (ours.length) {
      const edits = ours.flatMap((h) => {
        const base = `hooks.state.${JSON.stringify(h.key)}`;
        return [{ keyPath: `${base}.enabled`, value: true, mergeStrategy: 'upsert' },
          { keyPath: `${base}.trusted_hash`, value: h.currentHash, mergeStrategy: 'upsert' }];
      });
      const r = await s.request('config/batchWrite', { edits, filePath: null, expectedVersion: null, reloadUserConfig: true });
      if (r && r.status === 'okOverridden') throw new Error('codex_hook_settings_overridden_by_other_config');
    }
    return summarize(await listOurs(s, home));
  });
}

module.exports = { status, trust, windowsBinary, wslTarget };

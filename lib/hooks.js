'use strict';
// Install/remove our three entries in Codex hooks.json (Windows and WSL).
// Entries owned by anyone else are preserved. A backup is written first.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const MARK = 'codex-notify-hooks';
const EVENTS = [
  { name: 'Stop' },
  { name: 'PreToolUse', matcher: '(^|[.])request_user_input(_async)?$' },
  { name: 'PermissionRequest' },
];

function localRoot() { return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'codex-notify'); }
function spoolDir() { return path.join(localRoot(), 'spool'); }

function isOurs(entry) {
  return entry && typeof entry.command === 'string' && entry.command.includes(MARK);
}

function readHooks(file) {
  if (!fs.existsSync(file)) return { hooks: {} };
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const data = text.trim() ? JSON.parse(text) : {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('hooks_json_not_object');
  if (data.hooks === undefined) data.hooks = {};
  if (typeof data.hooks !== 'object' || Array.isArray(data.hooks)) throw new Error('hooks_json_invalid');
  return data;
}

function stripOurs(data) {
  for (const name of Object.keys(data.hooks)) {
    const groups = Array.isArray(data.hooks[name]) ? data.hooks[name] : [];
    data.hooks[name] = groups
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
  }
  return data;
}

function merge(data, command) {
  stripOurs(data);
  for (const event of EVENTS) {
    const group = { hooks: [{ type: 'command', command, async: true, timeout: 10 }] };
    if (event.matcher) group.matcher = event.matcher;
    if (!Array.isArray(data.hooks[event.name])) data.hooks[event.name] = [];
    data.hooks[event.name].push(group);
  }
  return data;
}

function installedIn(data) {
  return EVENTS.every((e) => (data.hooks[e.name] || []).some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs)));
}

function writeWithBackup(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-codex-notify-${Date.now()}`);
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

// ---------- Windows ----------
function windowsCodexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function windowsHookScript() { return path.join(localRoot(), MARK, 'hook.ps1'); }
function windowsCommand() {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${windowsHookScript()}"`;
}

function installWindows(extensionRoot) {
  fs.mkdirSync(spoolDir(), { recursive: true });
  fs.mkdirSync(path.dirname(windowsHookScript()), { recursive: true });
  fs.copyFileSync(path.join(extensionRoot, 'hooks', 'hook.ps1'), windowsHookScript());
  const file = path.join(windowsCodexHome(), 'hooks.json');
  writeWithBackup(file, merge(readHooks(file), windowsCommand()));
  return file;
}

function removeWindows() {
  const file = path.join(windowsCodexHome(), 'hooks.json');
  if (fs.existsSync(file)) writeWithBackup(file, stripOurs(readHooks(file)));
}

function statusWindows() {
  const file = path.join(windowsCodexHome(), 'hooks.json');
  let installed = false;
  try { installed = installedIn(readHooks(file)); } catch { /* ignore */ }
  return { installed };
}

// ---------- WSL ----------
function listDistros() {
  try {
    const raw = execFileSync('wsl.exe', ['-l', '-q'], { windowsHide: true, timeout: 15000 });
    return raw.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s && !/^docker-desktop/i.test(s));
  } catch { return []; }
}

function wslInfo(distro) {
  const spoolUnix = spoolDir().replace(/\\/g, '/');
  const out = execFileSync('wsl.exe', ['-d', distro, '--exec', 'sh', '-c',
    'printf "%s\\n" "$HOME"; command -v python3 || echo; wslpath -u "$1"', 'sh', spoolUnix],
  { windowsHide: true, timeout: 30000 }).toString('utf8').split(/\r?\n/);
  const [home, python, spool] = out;
  if (!home || !home.startsWith('/')) throw new Error('wsl_home_unknown');
  if (!python) throw new Error('wsl_python3_missing');
  if (!spool || !spool.startsWith('/')) throw new Error('wsl_spool_path_unknown');
  return { home, python, spool };
}

function unc(distro, unixPath) { return `\\\\wsl.localhost\\${distro}${unixPath.replace(/\//g, '\\')}`; }

function installWsl(extensionRoot, distro) {
  fs.mkdirSync(spoolDir(), { recursive: true });
  const info = wslInfo(distro);
  const scriptUnix = `${info.home}/.local/share/${MARK}/hook.py`;
  const source = fs.readFileSync(path.join(extensionRoot, 'hooks', 'hook.py'), 'utf8')
    .replace('"__SPOOL__"', JSON.stringify(info.spool))
    .replace('"__PLATFORM__"', JSON.stringify(`wsl:${distro}`));
  fs.mkdirSync(path.dirname(unc(distro, scriptUnix)), { recursive: true });
  fs.writeFileSync(unc(distro, scriptUnix), source, 'utf8');
  const file = unc(distro, `${info.home}/.codex/hooks.json`);
  writeWithBackup(file, merge(readHooks(file), `${info.python} ${scriptUnix}`));
  return { distro, home: info.home };
}

function removeWsl(distro, home) {
  const file = unc(distro, `${home}/.codex/hooks.json`);
  if (fs.existsSync(file)) writeWithBackup(file, stripOurs(readHooks(file)));
}

function statusWsl(distro, home) {
  const file = unc(distro, `${home}/.codex/hooks.json`);
  let installed = false;
  try { installed = installedIn(readHooks(file)); } catch { /* ignore */ }
  return { installed };
}

module.exports = {
  MARK, spoolDir, localRoot, merge, stripOurs, installedIn, readHooks,
  installWindows, removeWindows, statusWindows, listDistros, installWsl, removeWsl, statusWsl,
};

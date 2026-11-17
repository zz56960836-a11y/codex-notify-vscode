'use strict';
/**
 * Codex Notify - VS Code extension entry point (runs on the Windows UI side).
 *
 * Flow: Codex hook scripts drop small JSON records into the spool folder
 * (%LOCALAPPDATA%\\codex-notify\\spool). This module polls that folder, claims
 * each record atomically (so only one VS Code window handles it), de-duplicates,
 * and delivers it to Windows / Bark according to the user's settings.
 * It also wires up the settings panel and the hook install/trust commands.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const notify = require('./lib/notify');
const hooks = require('./lib/hooks');
const { openPanel } = require('./lib/panel');
const codexTrust = require('./lib/codexTrust');

const SECRET_DEVICE = 'codexNotify.bark.deviceKey';
const SECRET_ENCRYPTION = 'codexNotify.bark.encryptionKey';
const KINDS = {
  complete: { label: '任务完成', text: '本回合已结束，请查看 Codex。' },
  input: { label: '等待回答', text: 'Codex 有问题等你回答。' },
  approval: { label: '等待审批', text: 'Codex 需要你批准一个操作。' },
};
const MAX_AGE_SECONDS = 15 * 60;

let output;
const recent = [];          // delivery log for the panel; never contains content or secrets
const seen = new Map();     // dedupe key -> time

function log(line) {
  const entry = `${new Date().toLocaleTimeString()} ${line}`;
  recent.unshift(entry); recent.length = Math.min(recent.length, 30);
  if (output) output.appendLine(entry);
}

function cfg() { return vscode.workspace.getConfiguration('codexNotify'); }

function projectName(cwd) {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  return (parts[parts.length - 1] || 'workspace').slice(0, 40);
}

function sessionLabel(record) {
  return crypto.createHash('sha256').update(`${record.platform}|${record.session}`).digest('hex').slice(0, 6);
}

// ---------- focus: any VS Code window focused? (shared via small marker files) ----------
function focusDir() { return path.join(hooks.localRoot(), 'focus'); }
function focusFile() { return path.join(focusDir(), vscode.env.sessionId.replace(/[^A-Za-z0-9-]/g, '') + '.focus'); }
function markFocus(focused) {
  try {
    fs.mkdirSync(focusDir(), { recursive: true });
    if (focused) fs.writeFileSync(focusFile(), String(Date.now()));
    else fs.rmSync(focusFile(), { force: true });
  } catch { /* best effort */ }
}
function anyWindowFocused() {
  try {
    const now = Date.now();
    return fs.readdirSync(focusDir()).some((n) => {
      try { return now - fs.statSync(path.join(focusDir(), n)).mtimeMs < 15000; } catch { return false; }
    });
  } catch { return false; }
}

// ---------- delivery ----------
async function barkOptions(context) {
  const c = cfg();
  return {
    server: c.get('bark.server'), mode: c.get('bark.mode'), cipher: c.get('bark.cipher'),
    deviceKey: await context.secrets.get(SECRET_DEVICE),
    encryptionKey: await context.secrets.get(SECRET_ENCRYPTION),
  };
}

async function deliver(context, record) {
  const kind = KINDS[record.kind];
  if (!kind) return;
  const c = cfg();
  const rules = (c.get('events') || {})[record.kind] || {};
  const label = sessionLabel(record);
  const where = record.platform === 'windows' ? 'Windows' : 'WSL';
  const title = `Codex · ${kind.label} · ${projectName(record.cwd)}`;
  const summary = c.get('includeSummary') && record.summary ? String(record.summary).slice(0, 80) : '';
  const body = `${summary || kind.text}\n${where} · 会话 ${label}`;
  const jobs = [];
  if (c.get('windows.enabled') && rules.windows !== false) {
    if (c.get('onlyWhenUnfocused') && anyWindowFocused()) log(`${kind.label} ${label} windows=跳过(VS Code 在前台)`);
    else jobs.push(notify.windowsToast(title, body, c.get('windows.sound'))
      .then(() => log(`${kind.label} ${label} windows=已提交`), (e) => log(`${kind.label} ${label} windows=失败 ${code(e)}`)));
  }
  if (c.get('bark.enabled') && rules.bark !== false) {
    const urgent = c.get('bark.urgent') && record.kind !== 'complete';
    jobs.push(barkOptions(context).then((o) => notify.bark(o, { title, body, urgent }))
      .then(() => log(`${kind.label} ${label} bark=已接收`), (e) => log(`${kind.label} ${label} bark=失败 ${code(e)}`)));
  }
  await Promise.all(jobs);
}

function code(error) { return error instanceof notify.SafeError ? error.message : 'error'; }

// ---------- spool consumer ----------
function dedupeKey(r) {
  return [r.platform, r.session, r.turn, r.kind, r.id].join('|');
}

function isDuplicate(record) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3600 * 1000) seen.delete(k);
  const key = dedupeKey(record);
  // Approvals carry no stable id: repeat within 5s is a duplicate, later ones are new requests.
  const window = record.kind === 'approval' && !record.id ? 5000 : 3600 * 1000;
  if (seen.has(key) && now - seen.get(key) < window) return true;
  seen.set(key, now);
  return false;
}

let scanning = false;
async function scan(context) {
  if (scanning) return;
  scanning = true;
  try {
    const dir = hooks.spoolDir();
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      if (name.endsWith('.work') || name.startsWith('.')) {
        // Leftovers from a crashed window or an interrupted hook.
        try { if (Date.now() - fs.statSync(full).mtimeMs > 600000) fs.rmSync(full, { force: true }); } catch { /* ignore */ }
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const claimed = `${full}.${process.pid}.work`;
      try { fs.renameSync(full, claimed); } catch { continue; } // another VS Code window took it
      let record;
      try { record = JSON.parse(fs.readFileSync(claimed, 'utf8').replace(/^﻿/, '')); } catch { record = null; }
      fs.rmSync(claimed, { force: true });
      if (!record || record.v !== 1 || !KINDS[record.kind]) continue;
      if (Date.now() / 1000 - Number(record.ts || 0) > MAX_AGE_SECONDS) continue;
      if (isDuplicate(record)) continue;
      const lastSeen = context.globalState.get('lastEvent', {});
      lastSeen[String(record.platform).startsWith('wsl:') ? record.platform.slice(4) : 'windows'] = Date.now();
      await context.globalState.update('lastEvent', lastSeen);
      await deliver(context, record);
    }
  } finally { scanning = false; }
}

// ---------- hooks: install + trust (via official Codex app-server API) ----------
const trustCache = {}; // platform -> { loading, hooks, error }

function activeCodexExtensionPath() {
  // Only usable when the official extension runs on this (Windows UI) side.
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  return ext && ext.extensionKind === vscode.ExtensionKind.UI ? ext.extensionPath : undefined;
}

function platforms(context) {
  return ['windows', ...context.globalState.get('wslInstalls', []).map((x) => x.distro)];
}

async function refreshTrust(context, only) {
  const list = only || platforms(context);
  await Promise.all(list.map(async (p) => {
    trustCache[p] = { ...(trustCache[p] || {}), loading: true };
    try { trustCache[p] = { hooks: await codexTrust.status(p, activeCodexExtensionPath()) }; }
    catch (e) { trustCache[p] = { error: e.message }; }
  }));
}

async function installHooks(context, distros) {
  const results = [];
  try { hooks.installWindows(context.extensionPath); results.push('Windows ✓'); } catch (e) { results.push(`Windows ✗ ${e.message}`); }
  const installed = context.globalState.get('wslInstalls', []);
  for (const distro of distros) {
    try {
      const r = hooks.installWsl(context.extensionPath, distro);
      const next = installed.filter((x) => x.distro !== distro); next.push(r);
      installed.splice(0, installed.length, ...next);
      results.push(`WSL ${distro} ✓`);
    } catch (e) { results.push(`WSL ${distro} ✗ ${e.message}`); }
  }
  await context.globalState.update('wslInstalls', installed);
  log(`安装 hooks: ${results.join('，')}`);
  return results;
}

// Trust ONLY our own hooks, with the exact hash Codex reports for them.
async function trustHooks(context) {
  const results = [];
  for (const p of platforms(context)) {
    const name = p === 'windows' ? 'Windows' : `WSL ${p}`;
    try {
      const list = await codexTrust.trust(p, activeCodexExtensionPath());
      trustCache[p] = { hooks: list };
      results.push(list.length && list.every((h) => h.trust === 'trusted') ? `${name} ✓` : `${name} ✗ 未找到全部 hook`);
    } catch (e) { trustCache[p] = { error: e.message }; results.push(`${name} ✗ ${e.message}`); }
  }
  log(`信任 hooks: ${results.join('，')}`);
  return results;
}

async function setup(context, distros) {
  const installed = await installHooks(context, distros);
  const trusted = await trustHooks(context);
  const ok = ![...installed, ...trusted].some((x) => x.includes('✗'));
  if (ok) {
    vscode.window.showInformationMessage('Codex Notify 已安装并启用。重新加载窗口后 Codex 会开始发送事件。', '立即重新加载')
      .then((choice) => { if (choice) vscode.commands.executeCommand('workbench.action.reloadWindow'); });
  }
  return { ok, text: `安装：${installed.join('，')}；信任：${trusted.join('，')}` };
}

async function pickDistros() {
  const distros = hooks.listDistros();
  if (!distros.length) return [];
  const picked = await vscode.window.showQuickPick(distros.map((d) => ({ label: d, picked: true })),
    { canPickMany: true, title: '同时为哪些 WSL 发行版启用？（Windows 本地总会启用）' });
  return picked ? picked.map((p) => p.label) : null;
}

async function removeHooks(context) {
  const results = [];
  try { hooks.removeWindows(); results.push('Windows ✓'); } catch (e) { results.push(`Windows ✗ ${e.message}`); }
  for (const { distro, home } of context.globalState.get('wslInstalls', [])) {
    try { hooks.removeWsl(distro, home); results.push(`WSL ${distro} ✓`); } catch (e) { results.push(`WSL ${distro} ✗ ${e.message}`); }
  }
  await context.globalState.update('wslInstalls', []);
  for (const k of Object.keys(trustCache)) delete trustCache[k];
  log(`移除 hooks: ${results.join('，')}`);
  return results;
}

function hookStatus(context) {
  const last = context.globalState.get('lastEvent', {});
  const homes = Object.fromEntries(context.globalState.get('wslInstalls', []).map((x) => [x.distro, x.home]));
  return platforms(context).map((p) => ({
    platform: p,
    installed: p === 'windows' ? hooks.statusWindows().installed : hooks.statusWsl(p, homes[p]).installed,
    last: last[p] || null,
    trust: trustCache[p] || null,
  }));
}

async function test(context, channel) {
  const title = 'Codex · 测试通知';
  const body = '这是 Codex Notify 的测试消息，不是任务事件。';
  try {
    if (channel === 'windows') await notify.windowsToast(title, body, cfg().get('windows.sound'));
    else await notify.bark(await barkOptions(context), { title, body, urgent: false });
    log(`测试 ${channel}=成功`);
    return { ok: true };
  } catch (e) {
    log(`测试 ${channel}=失败 ${code(e)}`);
    return { ok: false, error: code(e) };
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel('Codex Notify');
  context.subscriptions.push(output);
  try { fs.mkdirSync(hooks.spoolDir(), { recursive: true }); } catch { /* ignore */ }

  const api = {
    SECRET_DEVICE, SECRET_ENCRYPTION, recent, hookStatus: () => hookStatus(context),
    test: (ch) => test(context, ch), setup: (d) => setup(context, d), trustHooks: () => trustHooks(context),
    refreshTrust: () => refreshTrust(context), removeHooks: () => removeHooks(context), listDistros: hooks.listDistros,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codexNotify.openPanel', () => openPanel(context, api)),
    vscode.commands.registerCommand('codexNotify.installHooks', async () => {
      const distros = await pickDistros(); if (distros) { const r = await setup(context, distros); if (!r.ok) vscode.window.showWarningMessage(r.text); }
    }),
    vscode.commands.registerCommand('codexNotify.removeHooks', () => removeHooks(context)),
    vscode.commands.registerCommand('codexNotify.testWindows', () => test(context, 'windows')),
    vscode.commands.registerCommand('codexNotify.testBark', () => test(context, 'bark')),
  );

  // Focus markers (for "only when unfocused").
  markFocus(vscode.window.state.focused);
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => markFocus(s.focused)));
  const focusTimer = setInterval(() => { if (vscode.window.state.focused) markFocus(true); }, 5000);

  // Poll the spool; fs.watch is unreliable for files written from WSL.
  const timer = setInterval(() => { scan(context).catch(() => {}); }, 1000);
  context.subscriptions.push({ dispose: () => { clearInterval(timer); clearInterval(focusTimer); markFocus(false); } });

  // Status bar entry to open the panel.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  item.text = '$(bell) Codex'; item.tooltip = 'Codex Notify 通知设置'; item.command = 'codexNotify.openPanel'; item.show();
  context.subscriptions.push(item);

  if (!context.globalState.get('welcomed')) {
    context.globalState.update('welcomed', true);
    openPanel(context, api);
  }
}

function deactivate() { markFocus(false); }

module.exports = { activate, deactivate };

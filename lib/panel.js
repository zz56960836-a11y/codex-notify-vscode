'use strict';
/**
 * Settings panel (webview). The webview never receives a secret: only hints
 * such as "last 4 characters" are sent to it, and keys typed into it are
 * stored straight into VS Code SecretStorage by the extension host.
 */
const vscode = require('vscode');
const crypto = require('crypto');
const notify = require('./notify');

let current = null;
let distroCache = null;

const ALLOWED_SETTINGS = new Set(['windows.enabled', 'windows.sound', 'bark.enabled', 'bark.server', 'bark.mode',
  'bark.cipher', 'bark.urgent', 'includeSummary', 'onlyWhenUnfocused']);

async function state(context, api) {
  const c = vscode.workspace.getConfiguration('codexNotify');
  const device = await context.secrets.get(api.SECRET_DEVICE);
  const enc = await context.secrets.get(api.SECRET_ENCRYPTION);
  if (distroCache === null) distroCache = api.listDistros();
  const settings = {};
  for (const key of ALLOWED_SETTINGS) settings[key] = c.get(key);
  return {
    settings, events: c.get('events'),
    // Only non-reversible hints of the secrets ever reach the webview.
    device: device ? `已保存（末 4 位 ${device.slice(-4)}）` : null,
    encryption: enc ? `已保存（${enc.length * 8} 位，AES-${enc.length * 8}）` : null,
    hooks: api.hookStatus(), distros: distroCache, recent: api.recent.slice(0, 15),
  };
}

function openPanel(context, api) {
  if (current) { current.reveal(); return; }
  const panel = vscode.window.createWebviewPanel('codexNotify', 'Codex 通知设置', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] });
  current = panel;
  panel.onDidDispose(() => { current = null; }, null, context.subscriptions);
  const nonce = crypto.randomBytes(16).toString('base64');
  panel.webview.html = html(nonce, panel.webview.cspSource);

  const push = async (toast) => panel.webview.postMessage({ type: 'state', state: await state(context, api), toast });
  const timer = setInterval(() => { if (panel.visible) push(); }, 4000);
  panel.onDidDispose(() => clearInterval(timer));

  panel.webview.onDidReceiveMessage(async (m) => {
    const c = vscode.workspace.getConfiguration('codexNotify');
    const G = vscode.ConfigurationTarget.Global;
    try {
      if (m.type === 'ready') { await push(); await api.refreshTrust(); return push(); }
      if (m.type === 'set' && ALLOWED_SETTINGS.has(m.key)) {
        if (m.key === 'bark.server') notify.parseServer(m.value);
        await c.update(m.key, m.value, G); return push({ ok: true, text: '已保存' });
      }
      if (m.type === 'setEvent') {
        const events = JSON.parse(JSON.stringify(c.get('events') || {}));
        if (!['complete', 'input', 'approval'].includes(m.kind) || !['windows', 'bark'].includes(m.channel)) return;
        events[m.kind] = { ...(events[m.kind] || {}), [m.channel]: !!m.value };
        await c.update('events', events, G); return push({ ok: true, text: '已保存' });
      }
      if (m.type === 'saveDevice') {
        const { key, server } = notify.parseDeviceKeyInput(m.value);
        await context.secrets.store(api.SECRET_DEVICE, key);
        if (server) await c.update('bark.server', server, G);
        return push({ ok: true, text: 'Bark 设备 Key 已保存到系统凭据管理器' });
      }
      if (m.type === 'clearDevice') { await context.secrets.delete(api.SECRET_DEVICE); return push({ ok: true, text: '已清除设备 Key' }); }
      if (m.type === 'saveEnc') {
        notify.validateEncryptionKey(m.value);
        await context.secrets.store(api.SECRET_ENCRYPTION, m.value);
        return push({ ok: true, text: '加密 Key 已保存到系统凭据管理器' });
      }
      if (m.type === 'clearEnc') { await context.secrets.delete(api.SECRET_ENCRYPTION); return push({ ok: true, text: '已清除加密 Key' }); }
      if (m.type === 'test') {
        const r = await api.test(m.channel === 'bark' ? 'bark' : 'windows');
        return push(r.ok ? { ok: true, text: '测试消息已发出，请查看' } : { ok: false, text: `测试失败：${r.error}` });
      }
      if (m.type === 'setup') {
        const distros = (Array.isArray(m.distros) ? m.distros : []).filter((d) => (distroCache || []).includes(d));
        await push({ ok: true, text: '正在安装并启用，约需 10–30 秒…' });
        const r = await api.setup(distros);
        return push({ ok: r.ok, text: r.ok ? '已安装并启用 ✓  点"重新加载窗口"让 Codex 生效' : r.text });
      }
      if (m.type === 'trust') {
        await push({ ok: true, text: '正在信任…' });
        const r = await api.trustHooks();
        return push({ ok: !r.some((x) => x.includes('✗')), text: `信任：${r.join('，')}` });
      }
      if (m.type === 'refresh') { await push({ ok: true, text: '正在检查…' }); await api.refreshTrust(); return push(); }
      if (m.type === 'reload') return vscode.commands.executeCommand('workbench.action.reloadWindow');
      if (m.type === 'remove') { const r = await api.removeHooks(); return push({ ok: true, text: `已移除：${r.join('，')}` }); }
    } catch (e) {
      const text = e instanceof notify.SafeError ? ERRORS[e.message] || e.message : '操作失败';
      return push({ ok: false, text });
    }
  });
}

const ERRORS = {
  bark_key_invalid: '设备 Key 格式不对：只填 Key（8 位以上字母数字），或粘贴 Bark 给的完整 https 链接',
  bark_encryption_key_invalid: '加密 Key 必须正好 16、24 或 32 个字符（对应 AES-128/192/256），不能有空格',
  bark_server_invalid: '服务器地址必须是 https://域名，不带路径',
};

function html(nonce, csp) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:0 20px 40px;max-width:760px}
h1{font-size:1.4em;margin:18px 0 4px} h2{font-size:1.05em;margin:0 0 10px}
section{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:14px 16px;margin:14px 0}
.muted{color:var(--vscode-descriptionForeground);font-size:.92em} label{display:flex;align-items:center;gap:8px;margin:6px 0}
table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)} td.c,th.c{text-align:center}
input[type=text],input[type=password],select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:4px 6px;border-radius:3px}
input[type=password],input[type=text]{width:260px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:5px 12px;border-radius:3px;cursor:pointer;margin:2px 4px 2px 0}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0} .ok{color:var(--vscode-testing-iconPassed)} .bad{color:var(--vscode-errorForeground)}
#toast{position:sticky;top:0;padding:6px 10px;margin-top:8px;border-radius:4px;display:none;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border)}
pre{white-space:pre-wrap;font-size:.85em;margin:0} .hidden{display:none}
</style></head><body>
<h1>Codex 通知设置</h1>
<div class="muted">Codex 任务结束、等你回答、等你审批时提醒你。密钥存放在 Windows 凭据管理器，不写入 settings.json，不会被同步或上传。</div>
<div id="toast"></div>

<section><h2>1. 连接 Codex</h2>
<table id="hookTable"><thead><tr><th>位置</th><th>hook 安装</th><th>Codex 信任</th><th>最近事件</th></tr></thead><tbody></tbody></table>
<div id="distros" class="row"></div>
<div class="row"><button id="setup">一键安装并启用</button><button id="trust" class="secondary">只做信任</button><button id="refresh" class="secondary">重新检查</button><button id="reload" class="secondary">重新加载窗口</button><button id="remove" class="secondary">移除</button></div>
<div class="muted">"一键安装并启用"会在 Codex 配置里加 3 个 hook（任务结束、提问、审批），并替你在 Codex 中信任它们，效果等同于在 Codex 设置 → Hooks 里点 Trust。只会信任本插件自己的 hook。
hook 在 Codex 沙箱外运行，作用只有一个：把事件类型写入本地文件夹 <code>%LOCALAPPDATA%\\codex-notify\\spool</code>。出错也不会影响 Codex。Codex 版本和安装路径会自动识别。完成后需要重新加载窗口。</div>
<details class="muted"><summary>hook 命令（供审核）</summary><pre id="hookCommands"></pre></details>
</section>

<section><h2>2. 通知开关</h2>
<table><thead><tr><th>通知类型</th><th class="c">Windows 通知</th><th class="c">手机 Bark</th></tr></thead>
<tbody>
<tr><th>总开关</th><td class="c"><input type="checkbox" data-set="windows.enabled"></td><td class="c"><input type="checkbox" data-set="bark.enabled"></td></tr>
<tr><td>任务完成</td><td class="c"><input type="checkbox" data-ev="complete.windows"></td><td class="c"><input type="checkbox" data-ev="complete.bark"></td></tr>
<tr><td>等待回答（Plan 选择题等）</td><td class="c"><input type="checkbox" data-ev="input.windows"></td><td class="c"><input type="checkbox" data-ev="input.bark"></td></tr>
<tr><td>等待审批（命令、改文件、权限）</td><td class="c"><input type="checkbox" data-ev="approval.windows"></td><td class="c"><input type="checkbox" data-ev="approval.bark"></td></tr>
</tbody></table>
<div class="muted">任务失败：Codex 官方 hooks 目前不提供失败事件，暂时无法单独提醒；失败后回合结束时仍会收到"任务完成"。</div>
<label><input type="checkbox" data-set="windows.sound">Windows 通知播放提示音</label>
<label><input type="checkbox" data-set="onlyWhenUnfocused">VS Code 在前台时不弹 Windows 通知（Bark 照常）</label>
<label><input type="checkbox" data-set="includeSummary">通知中带上 Codex 回复/问题/命令的前 80 个字</label>
<div class="muted">关闭时只显示类型、项目名和会话编号。开启后，常规 Bark 模式下这段文字会经过 Bark 服务器和 Apple 推送服务；加密模式下只有手机能解开。</div>
<div class="row"><button id="testWindows" class="secondary">测试 Windows 通知</button></div>
</section>

<section><h2>3. Bark 手机推送</h2>
<div class="row"><label><input type="radio" name="mode" value="plain">常规 Bark</label><label><input type="radio" name="mode" value="encrypted">加密 Bark（推荐）</label></div>
<div class="row">服务器 <input type="text" id="server"><button id="saveServer" class="secondary">保存</button></div>
<div class="row">设备 Key <input type="password" id="device" autocomplete="off" placeholder="粘贴 Key 或 Bark 的完整链接"><button id="saveDevice">保存</button><button id="clearDevice" class="secondary">清除</button></div>
<div class="muted" id="deviceStatus"></div>
<div id="encBlock">
<div class="row">加密模式 <select id="cipher"><option value="aes-cbc">AES-CBC</option><option value="aes-gcm">AES-GCM</option></select></div>
<div class="row">加密 Key <input type="password" id="enc" autocomplete="off" placeholder="16 / 24 / 32 个字符"><button id="saveEnc">保存</button><button id="clearEnc" class="secondary">清除</button></div>
<div class="muted" id="encStatus"></div>
<div class="muted">在 iPhone Bark → 设置 → 推送加密 中：算法按 Key 长度选 AES128/192/256，模式与上面一致，Key 填同一个。IV 留空即可（每条消息自动生成）。</div>
</div>
<label><input type="checkbox" data-set="bark.urgent">等待回答/审批用"时效性通知"（专注模式下也能提醒）</label>
<div class="row"><button id="testBark" class="secondary">测试 Bark</button></div>
<div class="muted">轮换 Key：在手机上重置后，在这里重新保存新 Key 即可，不影响 Codex。</div>
</section>

<section><h2>最近发送记录</h2><pre id="recent" class="muted">（暂无）</pre></section>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let S = null;
function send(m){ vscode.postMessage(m); }
function toast(t){ if(!t) return; const el=$('toast'); el.textContent=t.text; el.className=t.ok?'ok':'bad'; el.style.display='block'; clearTimeout(window._tt); window._tt=setTimeout(()=>el.style.display='none',5000); }
document.querySelectorAll('[data-set]').forEach(el=>el.addEventListener('change',()=>send({type:'set',key:el.dataset.set,value:el.checked})));
document.querySelectorAll('[data-ev]').forEach(el=>el.addEventListener('change',()=>{const [kind,channel]=el.dataset.ev.split('.');send({type:'setEvent',kind,channel,value:el.checked});}));
document.querySelectorAll('input[name=mode]').forEach(el=>el.addEventListener('change',()=>send({type:'set',key:'bark.mode',value:el.value})));
$('cipher').addEventListener('change',()=>send({type:'set',key:'bark.cipher',value:$('cipher').value}));
$('saveServer').onclick=()=>send({type:'set',key:'bark.server',value:$('server').value.trim()});
$('saveDevice').onclick=()=>{send({type:'saveDevice',value:$('device').value});$('device').value='';};
$('clearDevice').onclick=()=>send({type:'clearDevice'});
$('saveEnc').onclick=()=>{send({type:'saveEnc',value:$('enc').value});$('enc').value='';};
$('clearEnc').onclick=()=>send({type:'clearEnc'});
$('testWindows').onclick=()=>send({type:'test',channel:'windows'});
$('testBark').onclick=()=>send({type:'test',channel:'bark'});
$('setup').onclick=()=>send({type:'setup',distros:[...document.querySelectorAll('[data-distro]:checked')].map(e=>e.dataset.distro)});
$('trust').onclick=()=>send({type:'trust'}); $('refresh').onclick=()=>send({type:'refresh'}); $('reload').onclick=()=>send({type:'reload'});
$('remove').onclick=()=>send({type:'remove'});
function render(s){
  const first = !S; S = s;
  document.querySelectorAll('[data-set]').forEach(el=>el.checked=!!s.settings[el.dataset.set]);
  document.querySelectorAll('[data-ev]').forEach(el=>{const [k,c]=el.dataset.ev.split('.');el.checked=!(s.events&&s.events[k]&&s.events[k][c]===false);});
  document.querySelectorAll('input[name=mode]').forEach(el=>el.checked=el.value===s.settings['bark.mode']);
  $('encBlock').classList.toggle('hidden', s.settings['bark.mode']!=='encrypted');
  $('cipher').value=s.settings['bark.cipher'];
  if(document.activeElement!==$('server')) $('server').value=s.settings['bark.server']||'';
  $('deviceStatus').textContent = s.device ? '设备 Key：'+s.device : '设备 Key：未设置';
  $('encStatus').textContent = s.encryption ? '加密 Key：'+s.encryption : '加密 Key：未设置';
  const TR={trusted:'✓ 已信任',untrusted:'⚠ 未信任（不会运行）',modified:'⚠ 已修改，需要重新信任'};
  const tb=document.querySelector('#hookTable tbody'); tb.innerHTML=''; const cmds=new Set();
  s.hooks.forEach(h=>{
    let trust='—';
    if(h.trust&&h.trust.loading) trust='检查中…';
    else if(h.trust&&h.trust.error) trust='✗ 无法检查：'+h.trust.error;
    else if(h.trust&&h.trust.hooks){ const l=h.trust.hooks; l.forEach(x=>cmds.add(x.command));
      trust = !l.length ? '✗ Codex 未读到 hook' : l.every(x=>x.trust==='trusted') ? (l.length>=3?'✓ 已信任':'⚠ 只找到 '+l.length+' 个') : l.map(x=>x.event+'：'+(TR[x.trust]||x.trust)).join('；'); }
    const tr=document.createElement('tr');
    [h.platform==='windows'?'Windows 本地':'WSL '+h.platform, h.installed?'✓':'✗ 未安装', trust, h.last?new Date(h.last).toLocaleString():'暂无'].forEach(t=>{const td=document.createElement('td');td.textContent=t;tr.appendChild(td);});
    tb.appendChild(tr);
  });
  $('hookCommands').textContent = cmds.size ? [...cmds].join('\\n') : '（安装后显示）';
  if(first){
    const box=$('distros'); box.innerHTML='';
    if(s.distros.length){ const t=document.createElement('span'); t.className='muted'; t.textContent='同时启用 WSL：'; box.appendChild(t); }
    s.distros.forEach(d=>{const l=document.createElement('label');const c=document.createElement('input');c.type='checkbox';c.dataset.distro=d;c.checked=true;l.appendChild(c);l.appendChild(document.createTextNode(d));box.appendChild(l);});
  }
  $('recent').textContent = s.recent.length ? s.recent.join('\\n') : '（暂无）';
}
window.addEventListener('message',e=>{ if(e.data.type==='state'){ render(e.data.state); toast(e.data.toast); } });
send({type:'ready'});
</script></body></html>`;
}

module.exports = { openPanel };

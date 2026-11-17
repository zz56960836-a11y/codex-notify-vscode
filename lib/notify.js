'use strict';
// Delivery channels. Secrets arrive as arguments only; nothing here logs them.
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

class SafeError extends Error {}

const TOAST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual><audio silent="true"/></toast>')
  $nodes = $xml.GetElementsByTagName('text')
  $nodes.Item(0).AppendChild($xml.CreateTextNode([string]$data.title)) > $null
  $nodes.Item(1).AppendChild($xml.CreateTextNode([string]$data.body)) > $null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.VisualStudioCode').Show($toast)
  if ($data.sound) { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 350 }
  [Console]::Out.Write('submitted')
  exit 0
} catch { exit 1 }
`;

function windowsToast(title, body, sound) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new SafeError('windows_timeout')); }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); reject(new SafeError('windows_start_failed')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim() === 'submitted') resolve('ok');
      else reject(new SafeError('windows_toast_failed'));
    });
    child.stdin.end(Buffer.from(JSON.stringify({ title, body, sound: !!sound }), 'utf8').toString('base64'));
  });
}

function parseServer(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new SafeError('bark_server_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || !['', '/'].includes(parsed.pathname)) throw new SafeError('bark_server_invalid');
  return parsed.origin;
}

const DEVICE_KEY = /^[A-Za-z0-9_-]{8,256}$/;

// Accept either a bare key or a pasted "https://api.day.app/KEY/..." URL.
function parseDeviceKeyInput(input) {
  const text = String(input || '').trim();
  if (/^https:\/\//i.test(text)) {
    let parsed;
    try { parsed = new URL(text); } catch { throw new SafeError('bark_key_invalid'); }
    const key = parsed.pathname.split('/').filter(Boolean)[0] || '';
    if (!DEVICE_KEY.test(key)) throw new SafeError('bark_key_invalid');
    return { key, server: parsed.origin };
  }
  if (!DEVICE_KEY.test(text)) throw new SafeError('bark_key_invalid');
  return { key: text, server: null };
}

function validateEncryptionKey(key) {
  if (typeof key !== 'string' || ![16, 24, 32].includes(key.length) || !/^[\x21-\x7e]+$/.test(key)) {
    throw new SafeError('bark_encryption_key_invalid');
  }
}

function randomIv(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let iv = '';
  for (const b of bytes) iv += alphabet[b % alphabet.length];
  return iv;
}

// Bark encrypted push: AES-{128,192,256} chosen by key length; IV is a UTF-8
// string sent alongside. GCM appends the 16-byte tag to the ciphertext.
function encryptBark(content, key, cipher) {
  validateEncryptionKey(key);
  const bits = key.length * 8;
  const plain = Buffer.from(JSON.stringify(content), 'utf8');
  const keyBytes = Buffer.from(key, 'utf8');
  if (cipher === 'aes-gcm') {
    const iv = randomIv(12);
    const c = crypto.createCipheriv(`aes-${bits}-gcm`, keyBytes, Buffer.from(iv, 'utf8'));
    const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    return { ciphertext: data.toString('base64'), iv };
  }
  if (cipher === 'aes-cbc') {
    const iv = randomIv(16);
    const c = crypto.createCipheriv(`aes-${bits}-cbc`, keyBytes, Buffer.from(iv, 'utf8'));
    return { ciphertext: Buffer.concat([c.update(plain), c.final()]).toString('base64'), iv };
  }
  throw new SafeError('bark_cipher_unsupported');
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const request = https.request(url, {
      method: 'POST', timeout: 10000,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length },
    }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (d) => { size += d.length; if (size <= 16384) chunks.push(d); });
      response.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
        if (response.statusCode >= 200 && response.statusCode < 300 && data && data.code === 200) resolve('ok');
        else reject(new SafeError(`bark_rejected_http_${response.statusCode}`));
      });
    });
    request.on('timeout', () => request.destroy(new SafeError('bark_timeout')));
    request.on('error', (e) => reject(e instanceof SafeError ? e : new SafeError('bark_network_error')));
    request.end(body);
  });
}

async function bark({ server, deviceKey, mode, cipher, encryptionKey }, { title, body, urgent }) {
  const origin = parseServer(server || 'https://api.day.app');
  if (!deviceKey || !DEVICE_KEY.test(deviceKey)) throw new SafeError('bark_key_missing');
  const content = { title, body, group: 'Codex', level: urgent ? 'timeSensitive' : 'active' };
  let payload;
  if (mode === 'encrypted') {
    if (!encryptionKey) throw new SafeError('bark_encryption_key_missing');
    // Never fall back to plaintext.
    payload = { device_key: deviceKey, ...encryptBark(content, encryptionKey, cipher) };
  } else {
    payload = { device_key: deviceKey, ...content };
  }
  return postJson(origin + '/push', payload);
}

module.exports = { SafeError, windowsToast, bark, encryptBark, parseServer, parseDeviceKeyInput, validateEncryptionKey };

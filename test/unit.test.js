'use strict';
// Run: node test/unit.test.js  (no VS Code needed; network calls are stubbed)
const assert = require('assert');
const crypto = require('crypto');
const https = require('https');
const { EventEmitter } = require('events');
const notify = require('../lib/notify');
const hooks = require('../lib/hooks');

let passed = 0;
async function t(name, fn) { await fn(); passed += 1; console.log('ok -', name); }

(async () => {
  for (const len of [16, 24, 32]) {
    const key = 'k'.repeat(len - 3) + 'A1!';
    await t(`AES-CBC ${len * 8} round trip`, () => {
      const { ciphertext, iv } = notify.encryptBark({ title: '标题', body: 'b' }, key, 'aes-cbc');
      assert.strictEqual(iv.length, 16);
      const d = crypto.createDecipheriv(`aes-${len * 8}-cbc`, Buffer.from(key), Buffer.from(iv));
      const out = JSON.parse(Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]).toString());
      assert.deepStrictEqual(out, { title: '标题', body: 'b' });
    });
    await t(`AES-GCM ${len * 8} round trip (tag appended)`, () => {
      const { ciphertext, iv } = notify.encryptBark({ title: 't' }, key, 'aes-gcm');
      assert.strictEqual(iv.length, 12);
      const raw = Buffer.from(ciphertext, 'base64');
      const d = crypto.createDecipheriv(`aes-${len * 8}-gcm`, Buffer.from(key), Buffer.from(iv));
      d.setAuthTag(raw.subarray(raw.length - 16));
      const out = JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString());
      assert.deepStrictEqual(out, { title: 't' });
    });
  }
  await t('encryption key validation', () => {
    for (const bad of ['short', 'x'.repeat(20), 'has space 123456', 'é'.repeat(16)]) {
      assert.throws(() => notify.validateEncryptionKey(bad), notify.SafeError);
    }
  });
  await t('device key: bare and pasted URL', () => {
    assert.deepStrictEqual(notify.parseDeviceKeyInput(' AbCdEf123456 '), { key: 'AbCdEf123456', server: null });
    assert.deepStrictEqual(notify.parseDeviceKeyInput('https://bark.example.com/AbCdEf123456/标题/内容'),
      { key: 'AbCdEf123456', server: 'https://bark.example.com' });
    assert.throws(() => notify.parseDeviceKeyInput('http://api.day.app/AbCdEf123456'));
    assert.throws(() => notify.parseDeviceKeyInput('abc'));
  });
  await t('server must be bare https origin', () => {
    assert.strictEqual(notify.parseServer('https://api.day.app/'), 'https://api.day.app');
    for (const bad of ['http://api.day.app', 'https://u:p@x.com', 'https://x.com/path', 'https://x.com?q=1']) {
      assert.throws(() => notify.parseServer(bad));
    }
  });

  // Bark request shape, with https.request stubbed (no network).
  const sent = [];
  const realRequest = https.request;
  https.request = (url, options, callback) => {
    const req = new EventEmitter();
    req.end = (body) => {
      sent.push({ url, body: JSON.parse(body.toString()) });
      const res = new EventEmitter(); res.statusCode = 200; callback(res);
      res.emit('data', Buffer.from('{"code":200}')); res.emit('end');
    };
    req.destroy = () => {};
    return req;
  };
  await t('plain Bark payload', async () => {
    await notify.bark({ server: 'https://api.day.app', deviceKey: 'AbCdEf123456', mode: 'plain' }, { title: 'T', body: 'B', urgent: true });
    const { url, body } = sent.pop();
    assert.strictEqual(url, 'https://api.day.app/push');
    assert.deepStrictEqual(body, { device_key: 'AbCdEf123456', title: 'T', body: 'B', group: 'Codex', level: 'timeSensitive' });
  });
  await t('encrypted Bark payload never contains plaintext', async () => {
    const key = '0123456789abcdef';
    await notify.bark({ deviceKey: 'AbCdEf123456', mode: 'encrypted', cipher: 'aes-cbc', encryptionKey: key }, { title: 'SECRET-TITLE', body: 'SECRET-BODY' });
    const { body } = sent.pop();
    assert.deepStrictEqual(Object.keys(body).sort(), ['ciphertext', 'device_key', 'iv']);
    assert(!JSON.stringify(body).includes('SECRET'));
  });
  await t('encrypted mode without key fails closed', async () => {
    await assert.rejects(notify.bark({ deviceKey: 'AbCdEf123456', mode: 'encrypted', cipher: 'aes-cbc' }, { title: 'x', body: 'y' }));
    assert.strictEqual(sent.length, 0);
  });
  https.request = realRequest;

  await t('hooks merge keeps foreign entries and is idempotent', () => {
    const foreign = { type: 'command', command: 'other-tool --stop' };
    const data = { description: 'keep', hooks: { Stop: [{ hooks: [foreign] }], PostToolUse: [{ matcher: 'x', hooks: [foreign] }] } };
    const cmd = 'powershell.exe -File "C:\\x\\codex-notify-hooks\\hook.ps1"';
    const once = hooks.merge(JSON.parse(JSON.stringify(data)), cmd);
    const twice = hooks.merge(JSON.parse(JSON.stringify(once)), cmd);
    assert.deepStrictEqual(once, twice);
    assert(hooks.installedIn(once));
    assert.strictEqual(once.description, 'keep');
    assert.deepStrictEqual(once.hooks.Stop[0], { hooks: [foreign] });
    assert.deepStrictEqual(once.hooks.PostToolUse, data.hooks.PostToolUse);
    assert.strictEqual(once.hooks.PreToolUse[0].matcher, '(^|[.])request_user_input(_async)?$');
    assert(once.hooks.PermissionRequest[0].hooks[0].async === true);
    const removed = hooks.stripOurs(once);
    assert(!hooks.installedIn(removed));
    assert.deepStrictEqual(removed.hooks.Stop, [{ hooks: [foreign] }]);
    assert.deepStrictEqual(removed.hooks.PreToolUse, []);
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });

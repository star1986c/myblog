import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { signSession, readSession } from '../src/auth.js';
import { handleBarkRequest, handleBarkAdmin, buildBarkPayload, deliverBark, barkAuthToken } from '../src/bark-service.js';
import { sendHermesBark, initializeBarkQueue, queueBarkNotification, flushBarkQueue, nextBarkAlarm } from '../src/bark-notifications.js';

const migration = await readFile(new URL('../migrations/0015_bark_push.sql', import.meta.url), 'utf8');
const keypair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keypair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
class D1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec(migration); }
  prepare(sql) {
    const db = this.sqlite;
    function statement(params = []) { return {
      bind: (...values) => statement(values),
      first: async () => db.prepare(sql).get(...params) || null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => ({ meta: { changes: db.prepare(sql).run(...params).changes } }),
    }; }
    return statement();
  }
  async batch(statements) { this.sqlite.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); this.sqlite.exec('COMMIT'); return results; } catch (e) { this.sqlite.exec('ROLLBACK'); throw e; } }
}
function environment(t) {
  const db = new D1(); t.after(() => db.sqlite.close());
  return { BLOG_DB: db, BARK_SERVER_TOKEN: 'server-access-token', BARK_APNS_PRIVATE_KEY: privateKey,
    BARK_APNS_TEAM_ID: 'TESTTEAM', BARK_APNS_KEY_ID: 'TESTKEY', HERMES_CHAT_PROFILES: 'primary:主助手,personal:个人助手',
    BARK_RATE_LIMITER: { limit: async () => ({ success: true }) }, SESSION_SECRET: 'test-session-secret' };
}
function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`https://example.com/bark/server-access-token/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
}
async function register(env, params = { devicetoken: 'ab'.repeat(32) }) {
  const response = await handleBarkRequest(request('register', params), env);
  assert.equal(response.status, 200); return (await response.json()).data.device_key;
}
async function row(env, key) { return env.BLOG_DB.prepare('SELECT * FROM bark_devices WHERE device_key = ?').bind(key).first(); }
function storage(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let alarm = null;
  const sql = { exec(query, ...params) {
    if (!params.length && (query.includes('CREATE TABLE') || query.includes('CREATE INDEX'))) { db.exec(query); return {}; }
    const stmt = db.prepare(query);
    if (/^\s*SELECT|RETURNING/i.test(query)) { const rows = stmt.all(...params); return { one: () => rows[0], toArray: () => rows }; }
    const result = stmt.run(...params); return { rowsWritten: result.changes, toArray: () => [] };
  } };
  return { sql, getAlarm: async () => alarm, setAlarm: async v => { alarm = v; }, deleteAlarm: async () => { alarm = null; },
    transactionSync(fn) { db.exec('BEGIN'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}

test('Bark private base URL, rate limit, method, and malformed registration are enforced', async t => {
  const env = environment(t);
  assert.equal((await handleBarkRequest(new Request('https://example.com/bark/wrong/register'), env)).status, 404);
  assert.equal((await handleBarkRequest(request('register', { devicetoken: 'bad' }), env)).status, 400);
  assert.equal((await handleBarkRequest(request('register', undefined, 'DELETE'), env)).status, 405);
  assert.equal((await handleBarkRequest(request('push', { device_key: 'bad' }), env)).status, 400);
  assert.equal((await handleBarkRequest(request('register', { devicetoken: 'a'.repeat(20_000) }), env)).status, 413);
  env.BARK_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await handleBarkRequest(request('ping'), env)).status, 429);
});

test('registration reuses devices, rotates tokens and preserves opt-out settings', async t => {
  const env = environment(t), key = await register(env);
  assert.match(key, /^[a-f0-9]{48}$/);
  assert.equal(await register(env), key);
  await env.BLOG_DB.prepare('UPDATE bark_devices SET enabled = 0 WHERE device_key = ?').bind(key).run();
  assert.equal(await register(env, { key, devicetoken: 'cd'.repeat(32) }), key);
  const device = await row(env, key);
  assert.equal(device.device_token, 'cd'.repeat(32)); assert.equal(device.enabled, 0);
  assert.deepEqual(JSON.parse(device.profile_ids), ['primary', 'personal']);
});

test('registration has a bounded device count and does not overwrite an existing key', async t => {
  const env = environment(t);
  for (let i = 1; i <= 10; i++) await register(env, { devicetoken: i.toString(16).padStart(64, '0') });
  assert.equal((await handleBarkRequest(request('register', { devicetoken: 'ff'.repeat(32) }), env)).status, 409);
});

test('Bark standard key POST and encoded GET paths deliver the requested text', async t => {
  const env = environment(t), key = await register(env), payloads = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    payloads.push(JSON.parse(init.body)); return new Response(null, { status: 200 });
  });
  assert.equal((await handleBarkRequest(request(key, { title: '测试', body: 'POST 内容' }), env)).status, 200);
  assert.equal((await handleBarkRequest(request(`${key}/${encodeURIComponent('标题')}/${encodeURIComponent('a/b 内容')}`), env)).status, 200);
  assert.deepEqual(payloads.map(p => p.aps.alert), [{ title: '测试', body: 'POST 内容' }, { title: '标题', body: 'a/b 内容' }]);
});

test('APNs JWT is valid ES256 with URL-safe encoding and cached within the same identity', async t => {
  const env = environment(t), token = await barkAuthToken(env), [header, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'TESTKEY' });
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'TESTTEAM');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keypair.publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${claims}`)));
  assert.equal(await barkAuthToken(env), token);
});

test('Bark payload maps standard options and rejects oversize or invalid fields', () => {
  const payload = buildBarkPayload({ title: 'hello', body: 'world', group: 'notes', sound: 'bell', isArchive: 1, badge: 2 });
  assert.equal(payload.aps.alert.title, 'hello'); assert.equal(payload.aps.sound, 'bell.caf'); assert.equal(payload.isarchive, '1'); assert.equal(payload.badge, '2');
  assert.equal(payload.ttl, 15 * 86400);
  assert.equal(buildBarkPayload({ ttl: 30 * 86400 }).ttl, 15 * 86400);
  assert.equal(buildBarkPayload({ ttl: 3600 }).ttl, 3600);
  assert.throws(() => buildBarkPayload({ body: '字'.repeat(2000) }), /4 KB/);
  assert.throws(() => buildBarkPayload({ body: {} }), /格式/);
  assert.throws(() => buildBarkPayload({ badge: -1 }), /角标/);
});

test('scheduled cleanup expires only records older than 15 days and retains device settings', async t => {
  const env = environment(t), key = await register(env), now = Date.now(), cutoff = now - 15 * 86400_000;
  for (const [id, time] of [['old', cutoff - 1], ['boundary', cutoff], ['recent', now]]) {
    await env.BLOG_DB.prepare('INSERT INTO bark_deliveries (device_key, event_id, sent_at) VALUES (?, ?, ?)').bind(key, id, time).run();
  }
  await env.BLOG_DB.prepare('UPDATE bark_devices SET last_sent_at = ?, last_attempt_at = ?, last_error = ? WHERE device_key = ?').bind(cutoff - 1, cutoff - 1, 'old error', key).run();
  await worker.scheduled({ scheduledTime: now }, env, {});
  const remaining = await env.BLOG_DB.prepare('SELECT event_id FROM bark_deliveries ORDER BY event_id').all();
  assert.deepEqual(remaining.results.map(r => r.event_id), ['boundary', 'recent']);
  assert.equal((await row(env, key)).device_token, 'ab'.repeat(32));
  assert.equal((await row(env, key)).last_sent_at, null);
  assert.equal((await row(env, key)).last_attempt_at, null);
  assert.equal((await row(env, key)).last_error, null);
  assert.deepEqual(JSON.parse((await row(env, key)).profile_ids), ['primary', 'personal']);
});

test('APNs delivery uses fixed host and invalidates only the rejected token', async t => {
  const env = environment(t), key = await register(env), device = await row(env, key);
  const result = await deliverBark(env, device, buildBarkPayload({ body: 'test' }), async (url, init) => {
    assert.equal(url, `https://api.push.apple.com/3/device/${device.device_token}`);
    assert.equal(init.headers['apns-topic'], 'me.fin.bark');
    // Simulate the phone rotating its token while APNs is responding to an old send.
    await register(env, { key, devicetoken: 'cc'.repeat(32) });
    return Response.json({ reason: 'BadDeviceToken' }, { status: 400 });
  });
  assert.equal(result.retry, false); assert.equal((await row(env, key)).device_token, 'cc'.repeat(32));
  const transient = await deliverBark(env, await row(env, key), buildBarkPayload({ body: 'test' }), async () => new Response('', { status: 503 }));
  assert.equal(transient.retry, true);
});

test('admin configuration requires session and CSRF; stored device tokens never leave admin API', async t => {
  const env = environment(t), key = await register(env);
  const url = `https://example.com/api/admin/bark/devices/${key}`;
  assert.equal((await worker.fetch(new Request(url), env)).status, 401);
  const cookie = await signSession({ secret: env.SESSION_SECRET, username: 'owner' });
  const session = await readSession({ cookieHeader: cookie, secret: env.SESSION_SECRET });
  assert.equal((await worker.fetch(new Request(url, { method: 'PUT', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: '{}' }), env)).status, 403);
  const settings = await worker.fetch(new Request('https://example.com/api/admin/bark', { headers: { Cookie: cookie } }), env);
  assert.equal(settings.headers.get('Cache-Control'), 'no-store');
  const data = await settings.json(); assert.equal(data.devices.length, 1); assert.equal(JSON.stringify(data).includes('ab'.repeat(32)), false);
  const put = body => worker.fetch(new Request(url, { method: 'PUT', headers: { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
  assert.equal((await put({ label: 'My phone', enabled: false, profileIds: ['primary'] })).status, 200);
  assert.equal((await row(env, key)).enabled, 0);
  assert.equal((await put({ label: 'My phone', enabled: true, profileIds: ['unknown'] })).status, 400);
});

test('notifications filter profile and opt-out, do not replay old history and deduplicate successful devices', async t => {
  const env = environment(t), key = await register(env);
  const event = { space_id: 'primary', message_id: crypto.randomUUID(), created_at: Date.now() + 1 };
  let calls = 0;
  const deliver = async (_env, _device, payload) => { calls++; assert.equal(payload.aps.alert.body.includes('新回复'), true); assert.equal(JSON.stringify(payload).includes('ciphertext'), false); return { code: 200, retry: false }; };
  assert.equal(await sendHermesBark(env, { ...event, created_at: 1 }, deliver), false); assert.equal(calls, 0);
  await sendHermesBark(env, event, deliver); await sendHermesBark(env, event, deliver); assert.equal(calls, 1);
  await env.BLOG_DB.prepare('UPDATE bark_devices SET profile_ids = ? WHERE device_key = ?').bind('["personal"]', key).run();
  await sendHermesBark(env, { ...event, message_id: crypto.randomUUID() }, deliver); assert.equal(calls, 1);
  await env.BLOG_DB.prepare('UPDATE bark_devices SET enabled = 0 WHERE device_key = ?').bind(key).run();
  await sendHermesBark(env, { ...event, space_id: 'personal' }, deliver); assert.equal(calls, 1);
});

test('persistent queue retries with bounded backoff and recovers after object recreation', async t => {
  const env = environment(t), ctx = { storage: storage(t) }; initializeBarkQueue(ctx.storage.sql);
  queueBarkNotification(ctx, env, 'msg', 'primary', 1000); queueBarkNotification(ctx, env, 'msg', 'primary', 1200);
  assert.equal(nextBarkAlarm(ctx.storage.sql), 2500);
  await flushBarkQueue(ctx, env, 2500, async () => true); assert.equal(nextBarkAlarm(ctx.storage.sql), 12500);
  await flushBarkQueue({ storage: ctx.storage }, env, 12500, async () => false); assert.equal(nextBarkAlarm(ctx.storage.sql), null);
  queueBarkNotification(ctx, env, 'expired', 'primary', 0);
  await flushBarkQueue(ctx, env, 3600_001, async () => { throw new Error('must not send expired notification'); });
  assert.equal(nextBarkAlarm(ctx.storage.sql), null);
});

async function roomClass() {
  let source = await readFile(new URL('../src/hermes-chat-room.js', import.meta.url), 'utf8');
  source = source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
  source = source.replace(/from "(\.\/[^"]+)"/g, (_, path) => `from "${new URL('../src/' + path.slice(2), import.meta.url).href}"`);
  const { HermesChatRoom } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return HermesChatRoom;
}

test('real Hermes room enqueues WebSocket and HTTP replies once, not clients, edits or retries', async t => {
  const HermesChatRoom = await roomClass();
  const env = environment(t), pending = [];
  const ctx = { storage: storage(t), blockConcurrencyWhile: fn => fn(), getWebSockets: () => [], waitUntil: p => pending.push(p) };
  const room = new HermesChatRoom(ctx, env), sent = [];
  const socket = { deserializeAttachment: () => ({ role: 'agent', spaceId: 'primary' }), send: s => sent.push(JSON.parse(s)) };
  const frame = { v: 1, type: 'message', id: crypto.randomUUID(), sender: 'agent', sentAt: Date.now(), encrypted: { alg: 'A256GCM', nonce: 'AQIDBAUGBwgJCgsM', ciphertext: 'AQIDBAUGBwgJCgsMDQ4PEA' } };
  await room.webSocketMessage(socket, JSON.stringify(frame));
  assert.equal(sent[0].type, 'ack');
  await room.publishAgentMessage('primary', JSON.stringify(frame));
  await room.webSocketMessage(socket, JSON.stringify({ v: 1, type: 'edit', targetSeq: sent[0].seq, final: true, message: { ...frame, id: crypto.randomUUID() } }));
  room.storeMessage({ ...frame, id: crypto.randomUUID(), sender: 'client' }, 'primary');
  const queued = ctx.storage.sql.exec('SELECT * FROM bark_pending').toArray(); assert.equal(queued.length, 1);
  await room.publishAgentMessage('personal', JSON.stringify({ ...frame, id: crypto.randomUUID() }));
  assert.equal(ctx.storage.sql.exec('SELECT * FROM bark_pending').toArray().length, 2);
  assert.ok(await ctx.storage.getAlarm());
  await room.purgeHistory(); assert.equal(nextBarkAlarm(ctx.storage.sql), null);
  await Promise.all(pending);
});


test('stream previews and interim progress stay silent; final and authorization each notify once', async t => {
  const HermesChatRoom = await roomClass();
  const env = environment(t), pending = [];
  const ctx = { storage: storage(t), blockConcurrencyWhile: fn => fn(), getWebSockets: () => [], waitUntil: p => pending.push(p) };
  let room = new HermesChatRoom(ctx, env), sent = [];
  const socket = { deserializeAttachment: () => ({ role: 'agent', spaceId: 'primary' }), send: s => sent.push(JSON.parse(s)) };
  const frame = { v: 1, type: 'message', id: crypto.randomUUID(), sender: 'agent', sentAt: Date.now(), notification: 'stream', encrypted: { alg: 'A256GCM', nonce: 'AQIDBAUGBwgJCgsM', ciphertext: 'AQIDBAUGBwgJCgsMDQ4PEA' } };
  const queued = () => ctx.storage.sql.exec('SELECT * FROM bark_pending').toArray();
  await room.webSocketMessage(socket, JSON.stringify(frame));
  const targetSeq = sent[0].seq;
  await room.publishAgentMessage('primary', JSON.stringify(frame)); // ACK loss / HTTP confirmation
  const edit = { v: 1, type: 'edit', targetSeq, final: false, message: { ...frame, notification: undefined, id: crypto.randomUUID() } };
  await room.webSocketMessage(socket, JSON.stringify(edit));
  await room.publishAgentMessage('primary', JSON.stringify({ ...frame, notification: 'silent', id: crypto.randomUUID() }));
  assert.equal(queued().length, 0);
  await flushBarkQueue(ctx, env, Date.now() + 60_000, async () => assert.fail('must not infer completion from silence'));
  room = new HermesChatRoom(ctx, env); // Durable state survives hibernation/reconnect.
  const approval = { ...frame, notification: 'approval', id: crypto.randomUUID() };
  await room.webSocketMessage(socket, JSON.stringify(approval));
  await room.publishAgentMessage('primary', JSON.stringify(approval));
  assert.deepEqual(queued().map(e => e.message_id), [approval.id]);
  const final = { ...edit, final: true, message: { ...edit.message, id: crypto.randomUUID() } };
  await room.webSocketMessage(socket, JSON.stringify(final));
  await room.webSocketMessage(socket, JSON.stringify(final));
  await room.webSocketMessage(socket, JSON.stringify({ ...final, message: { ...final.message, id: crypto.randomUUID() } }));
  assert.deepEqual(new Set(queued().map(e => e.message_id)), new Set([approval.id, frame.id]));
  const key = await register(env);
  // Queue events predate registration: align the synthetic fixture, never production data.
  await env.BLOG_DB.prepare('UPDATE bark_devices SET created_at = ? WHERE device_key = ?').bind(0, key).run();
  let deliveries = 0;
  const send = (env, event) => sendHermesBark(env, event, async () => { deliveries++; return { code: 200, retry: false }; });
  await flushBarkQueue(ctx, env, Date.now() + 2000, send);
  assert.equal(deliveries, 2);
  await room.webSocketMessage(socket, JSON.stringify({ ...final, message: { ...final.message, id: crypto.randomUUID() } }));
  await flushBarkQueue(ctx, env, Date.now() + 2000, send);
  assert.equal(deliveries, 2);
  await Promise.all(pending);
});

test('only authenticated agents can supply a supported notification hint', async () => {
  const { validateHermesChatMessage } = await import('../src/hermes-chat-protocol.js');
  assert.throws(() => validateHermesChatMessage({ notification: 'approval' }, 'client'), /notification hint/);
  for (const hint of [null, true, 'unknown', {}]) {
    assert.throws(() => validateHermesChatMessage({ notification: hint }, 'agent'), /notification hint/);
  }
});

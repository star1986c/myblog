// Bark-compatible endpoints and APNs transport. Protocol reference:
// https://github.com/cwxiaos/bark-worker (no upstream implementation embedded).
import { ServiceError } from './blog-repository.js';
import { configuredHermesChatProfiles } from './hermes-chat-gateway.js';

const encoder = new TextEncoder();
const KEY = /^[a-f0-9]{48}$/;
const TOKEN = /^[a-f0-9]{64,160}$/i;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_DEVICES = 10;
export const BARK_RETENTION_DAYS = 15;
let jwtCache;

export function barkConfigured(env) {
  return Boolean(env.BARK_SERVER_TOKEN && env.BARK_APNS_PRIVATE_KEY && env.BARK_APNS_TEAM_ID && env.BARK_APNS_KEY_ID && env.BLOG_DB);
}

export async function barkJSON(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new ServiceError('需要 JSON 请求。', 415);
  const text = await boundedText(request);
  let body;
  try { body = JSON.parse(text); } catch { throw new ServiceError('JSON 格式无效。', 400); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new ServiceError('请求格式无效。', 400);
  return body;
}

async function boundedText(request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ServiceError('推送请求过大。', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function reply(code, message, data) {
  return Response.json({ code, message, ...(data === undefined ? {} : { data }), timestamp: Math.floor(Date.now() / 1000) },
    { status: code, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function constantEqual(a, b) {
  const left = encoder.encode(a), right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

export async function handleBarkRequest(request, env) {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').slice(2);
    // Private base URL shown only after the owner signs in to settings.
    if (!env.BARK_SERVER_TOKEN || !constantEqual(parts.shift() || '', env.BARK_SERVER_TOKEN)) return reply(404, 'Not found');
    if (!barkConfigured(env)) return reply(503, 'Bark 尚未配置完成。');
    if (!['GET', 'POST'].includes(request.method)) return reply(405, 'Method not allowed');
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limiter = env.BARK_RATE_LIMITER;
    if (!limiter || !(await limiter.limit({ key: `bark:${ip}` })).success) return reply(429, '请求过于频繁，请稍后重试。');
    const operation = parts[0] || '';
    if (operation === 'ping') return reply(200, 'pong');
    if (operation === 'healthz' || !operation) return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });
    if (operation === 'info') return Response.json({ version: 'mynotes-bark-1', arch: 'cloudflare-worker' }, { headers: { 'Cache-Control': 'no-store' } });
    let params = Object.fromEntries(url.searchParams);
    if (request.method === 'POST') {
      if ((request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) params = { ...params, ...await barkJSON(request) };
      else params = { ...params, ...Object.fromEntries(new URLSearchParams(await boundedText(request))) };
    }
    if (operation === 'register') return await registerDevice(env, params);
    if (operation !== 'push') {
      let path;
      try { path = parts.map(decodeURIComponent); } catch { throw new ServiceError('路径编码无效。', 400); }
      if (path.length < 1 || path.length > 4 || (path.length === 1 && request.method !== 'POST')) return reply(404, 'Not found');
      params.device_key = path[0];
      if (path.length === 2) params.body = path[1];
      if (path.length === 3) { params.title = path[1]; params.body = path[2]; }
      if (path.length === 4) { params.title = path[1]; params.subtitle = path[2]; params.body = path[3]; }
    }
    const keys = Array.isArray(params.device_keys) && params.device_keys.length ? params.device_keys : [params.device_key];
    if (keys.length > MAX_DEVICES || keys.some(key => typeof key !== 'string' || !KEY.test(key))) return reply(400, '设备 Key 无效。');
    const payload = buildBarkPayload(params);
    const results = [];
    for (const key of new Set(keys)) {
      const device = await env.BLOG_DB.prepare('SELECT * FROM bark_devices WHERE device_key = ?').bind(key).first();
      if (!device || !device.device_token) { results.push({ code: 400, message: '设备未注册或令牌失效。' }); continue; }
      results.push(await deliverBark(env, device, payload));
    }
    const failed = results.find(item => item.code !== 200);
    return failed ? reply(failed.code, failed.message) : reply(200, 'success');
  } catch (error) {
    // Do not echo request URLs, keys, tokens, or third-party response bodies.
    return reply(error instanceof ServiceError ? error.status : 500, error instanceof ServiceError ? error.message : 'Bark 服务暂不可用。');
  }
}

async function registerDevice(env, params) {
  const token = String(params.devicetoken || '').toLowerCase();
  if (!TOKEN.test(token)) throw new ServiceError('设备令牌无效。', 400);
  const db = env.BLOG_DB;
  const existing = typeof params.key === 'string' && KEY.test(params.key)
    ? await db.prepare('SELECT * FROM bark_devices WHERE device_key = ?').bind(params.key).first() : null;
  if (existing) {
    await db.prepare('UPDATE bark_devices SET device_token = ?, updated_at = ?, last_error = NULL WHERE device_key = ?')
      .bind(token, Date.now(), existing.device_key).run();
    return reply(200, 'success', { key: existing.device_key, device_key: existing.device_key, device_token: token });
  }
  // Re-adding the server after losing the local key reuses this phone's existing entry.
  const sameDevice = await db.prepare('SELECT * FROM bark_devices WHERE device_token = ?').bind(token).first();
  if (sameDevice) return reply(200, 'success', { key: sameDevice.device_key, device_key: sameDevice.device_key, device_token: token });
  const key = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  const added = await db.prepare(`INSERT INTO bark_devices (device_key, device_token, profile_ids, created_at, updated_at)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM bark_devices) < ?`)
    .bind(key, token, JSON.stringify(configuredHermesChatProfiles(env).map(p => p.id)), now, now, MAX_DEVICES).run();
  if (!added.meta?.changes) throw new ServiceError('设备数量已达上限，请在设置中移除旧设备。', 409);
  return reply(200, 'success', { key, device_key: key, device_token: token });
}

export function buildBarkPayload(params) {
  const payload = { ttl: BARK_RETENTION_DAYS * 86400, aps: { alert: {}, sound: '1107', 'mutable-content': 1, category: 'myNotificationCategory' } };
  if (params.ttl != null) {
    const ttl = Number(params.ttl);
    if (!Number.isSafeInteger(ttl) || ttl < 1) throw new ServiceError('通知保留时间无效。', 400);
    payload.ttl = Math.min(ttl, BARK_RETENTION_DAYS * 86400);
  }
  for (const name of ['title', 'subtitle', 'body']) {
    if (params[name] != null) {
      if (typeof params[name] !== 'string') throw new ServiceError('通知文字格式无效。', 400);
      payload.aps.alert[name] = params[name];
    }
  }
  if (!Object.values(payload.aps.alert).some(Boolean)) payload.aps.alert.body = '新消息';
  for (const name of ['group', 'url', 'icon', 'image', 'copy', 'ciphertext', 'iv', 'id', 'markdown']) {
    if (params[name] != null) {
      if (typeof params[name] !== 'string') throw new ServiceError('推送参数格式无效。', 400);
      payload[name] = params[name];
    }
  }
  if (params.sound) {
    if (typeof params.sound !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(params.sound)) throw new ServiceError('提示音无效。', 400);
    payload.aps.sound = params.sound.endsWith('.caf') ? params.sound : `${params.sound}.caf`;
  }
  if (payload.group) payload.aps['thread-id'] = payload.group;
  if (params.level) {
    if (!['active', 'passive', 'timeSensitive'].includes(params.level)) throw new ServiceError('通知级别无效。', 400);
    payload.level = params.level;
  }
  for (const [name, source] of [['isarchive', params.isArchive ?? params.isarchive], ['autocopy', params.autoCopy ?? params.autocopy]]) {
    if (source != null) payload[name] = String(source) === '1' ? '1' : '0';
  }
  if (params.badge != null) {
    const badge = Number(params.badge);
    if (!Number.isSafeInteger(badge) || badge < 0 || badge > 99999) throw new ServiceError('角标无效。', 400);
    payload.badge = String(badge);
  }
  if (encoder.encode(JSON.stringify(payload)).length > 4096) throw new ServiceError('通知内容超过 APNs 4 KB 限制。', 413);
  return payload;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function barkAuthToken(env, now = Date.now()) {
  const identity = `${env.BARK_APNS_TEAM_ID}:${env.BARK_APNS_KEY_ID}:${env.BARK_APNS_PRIVATE_KEY}`;
  if (jwtCache?.identity === identity && now - jwtCache.createdAt < 45 * 60_000) return jwtCache.token;
  const pem = env.BARK_APNS_PRIVATE_KEY.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: env.BARK_APNS_KEY_ID })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: env.BARK_APNS_TEAM_ID, iat: Math.floor(now / 1000) })));
  const message = `${header}.${claims}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(message));
  const token = `${message}.${base64url(new Uint8Array(signature))}`;
  jwtCache = { identity, createdAt: now, token };
  return token;
}

export async function deliverBark(env, device, payload, fetchImpl = fetch) {
  let result;
  try {
    const headers = { authorization: `bearer ${await barkAuthToken(env)}`, 'apns-topic': 'me.fin.bark',
      'apns-push-type': 'alert', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600), 'content-type': 'application/json' };
    if (payload.id) headers['apns-collapse-id'] = payload.id.slice(0, 64);
    const response = await fetchImpl(`https://api.push.apple.com/3/device/${device.device_token}`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
    });
    if (response.ok) result = { code: 200, message: 'success', retry: false };
    else {
      const reason = (await response.json().catch(() => ({}))).reason;
      const invalidToken = response.status === 410 || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic';
      result = { code: 502, message: invalidToken ? '设备令牌失效，请在 Bark 中重新添加服务器。' : `APNs 暂未接受通知（${response.status}）。`, retry: !invalidToken };
      if (invalidToken) await env.BLOG_DB.prepare('UPDATE bark_devices SET device_token = ? WHERE device_key = ? AND device_token = ?')
        .bind('', device.device_key, device.device_token).run();
    }
  } catch { result = { code: 502, message: 'APNs 连接失败，请稍后重试。', retry: true }; }
  const now = Date.now();
  await env.BLOG_DB.prepare('UPDATE bark_devices SET last_error = ?, last_attempt_at = ?, last_sent_at = COALESCE(?, last_sent_at) WHERE device_key = ?')
    .bind(result.code === 200 ? null : result.message, now, result.code === 200 ? now : null, device.device_key).run();
  return result;
}

export async function handleBarkAdmin(request, env, path) {
  const db = env.BLOG_DB;
  if (path === '/api/admin/bark' && request.method === 'GET') {
    const { results } = await db.prepare('SELECT device_key, label, enabled, profile_ids, created_at, last_sent_at, last_error, length(device_token) AS token_length FROM bark_devices ORDER BY created_at').all();
    return Response.json({ configured: barkConfigured(env), serverURL: barkConfigured(env) ? `${new URL(request.url).origin}/bark/${env.BARK_SERVER_TOKEN}` : null,
      profiles: configuredHermesChatProfiles(env), devices: results.map(d => ({ key: d.device_key, label: d.label, enabled: d.enabled === 1,
        profileIds: JSON.parse(d.profile_ids), registeredAt: d.created_at, lastSentAt: d.last_sent_at, lastError: d.last_error, validToken: d.token_length > 0 })) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const match = path.match(/^\/api\/admin\/bark\/devices\/([a-f0-9]{48})(\/test)?$/);
  if (!match) throw new ServiceError('Not found', 404);
  const device = await db.prepare('SELECT * FROM bark_devices WHERE device_key = ?').bind(match[1]).first();
  if (!device) throw new ServiceError('设备不存在。', 404);
  if (match[2] && request.method === 'POST') {
    if (!barkConfigured(env) || !device.device_token) throw new ServiceError('服务或设备未就绪。', 409);
    const result = await deliverBark(env, device, buildBarkPayload({ title: 'My Notes', body: 'Bark 测试推送成功，Hermes 新消息将通过这里提醒。', group: 'My Notes', isArchive: '1' }));
    if (result.code !== 200) throw new ServiceError(result.message, result.code);
    return Response.json({ ok: true });
  }
  if (!match[2] && request.method === 'DELETE') {
    await db.batch([db.prepare('DELETE FROM bark_deliveries WHERE device_key = ?').bind(device.device_key), db.prepare('DELETE FROM bark_devices WHERE device_key = ?').bind(device.device_key)]);
    return Response.json({ ok: true });
  }
  if (!match[2] && request.method === 'PUT') {
    const body = await barkJSON(request);
    const allowed = new Set(configuredHermesChatProfiles(env).map(p => p.id));
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 60 || typeof body.enabled !== 'boolean'
      || !Array.isArray(body.profileIds) || body.profileIds.length > allowed.size || body.profileIds.some(p => !allowed.has(p))) throw new ServiceError('设备设置无效。', 400);
    await db.prepare('UPDATE bark_devices SET label = ?, enabled = ?, profile_ids = ?, updated_at = ? WHERE device_key = ?')
      .bind(body.label.trim(), body.enabled ? 1 : 0, JSON.stringify([...new Set(body.profileIds)]), Date.now(), device.device_key).run();
    return Response.json({ ok: true });
  }
  throw new ServiceError('Method not allowed', 405);
}

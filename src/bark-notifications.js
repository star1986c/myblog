import { barkConfigured, buildBarkPayload, deliverBark, BARK_RETENTION_DAYS } from './bark-service.js';
import { configuredHermesChatProfiles } from './hermes-chat-gateway.js';

export function initializeBarkQueue(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS bark_pending (
    message_id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, next_attempt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
  )`);
}

export function queueBarkNotification(ctx, env, id, spaceId, now = Date.now()) {
  if (!barkConfigured(env) || !spaceId) return;
  ctx.storage.sql.exec('INSERT OR IGNORE INTO bark_pending (message_id, space_id, created_at, next_attempt) VALUES (?, ?, ?, ?)', id, spaceId, now, now + 1500);
}

export function nextBarkAlarm(sql) {
  return sql.exec('SELECT MIN(next_attempt) AS due FROM bark_pending').one().due;
}

export async function sendHermesBark(env, event, deliver = deliverBark) {
  if (!barkConfigured(env)) return false;
  const profile = configuredHermesChatProfiles(env).find(p => p.id === event.space_id);
  if (!profile) return false;
  const db = env.BLOG_DB;
  const { results } = await db.prepare('SELECT * FROM bark_devices WHERE enabled = 1 AND device_token <> ? AND created_at <= ?').bind('', event.created_at).all();
  const eventId = `${event.space_id}:${event.message_id}`;
  const payload = buildBarkPayload({ title: profile.label, body: 'Hermes 有新回复，请打开 My Notes 查看。', group: `Hermes · ${profile.label}`,
    isArchive: '1', id: event.message_id });
  const outcomes = await Promise.all(results.filter(d => JSON.parse(d.profile_ids).includes(event.space_id)).map(async device => {
    const sent = await db.prepare('SELECT sent_at FROM bark_deliveries WHERE device_key = ? AND event_id = ?').bind(device.device_key, eventId).first();
    if (sent) return false;
    const result = await deliver(env, device, payload);
    if (result.code === 200) await db.prepare('INSERT OR IGNORE INTO bark_deliveries (device_key, event_id, sent_at) VALUES (?, ?, ?)').bind(device.device_key, eventId, Date.now()).run();
    return result.retry;
  }));
  return outcomes.some(Boolean);
}

export async function cleanupBarkData(env, now = Date.now()) {
  if (!env.BLOG_DB) return;
  // Keep registration and preferences: only transient delivery records expire.
  await env.BLOG_DB.prepare('DELETE FROM bark_deliveries WHERE sent_at < ?').bind(now - BARK_RETENTION_DAYS * 86400_000).run();
  await env.BLOG_DB.prepare('UPDATE bark_devices SET last_sent_at = NULL WHERE last_sent_at < ?').bind(now - BARK_RETENTION_DAYS * 86400_000).run();
  await env.BLOG_DB.prepare('UPDATE bark_devices SET last_attempt_at = NULL, last_error = NULL WHERE last_attempt_at < ?').bind(now - BARK_RETENTION_DAYS * 86400_000).run();
}

export async function flushBarkQueue(ctx, env, now = Date.now(), send = sendHermesBark) {
  const sql = ctx.storage.sql;
  sql.exec('DELETE FROM bark_pending WHERE created_at < ?', now - 3600_000);
  const due = sql.exec('SELECT * FROM bark_pending WHERE next_attempt <= ? ORDER BY next_attempt LIMIT 5', now).toArray();
  for (const event of due) {
    let retry;
    try { retry = await send(env, event); }
    catch { retry = true; console.warn('Hermes Bark delivery will retry.'); }
    if (retry && event.attempts < 5) {
      sql.exec('UPDATE bark_pending SET attempts = attempts + 1, next_attempt = ? WHERE message_id = ?', now + Math.min(300_000, 10_000 * 2 ** event.attempts), event.message_id);
    } else {
      if (retry) console.warn('Hermes Bark retry limit reached; chat delivery is unaffected.');
      sql.exec('DELETE FROM bark_pending WHERE message_id = ?', event.message_id);
    }
  }
}

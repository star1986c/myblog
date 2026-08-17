const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const MINIMUM_ALARM_DELAY_MILLISECONDS = 60 * 1000;
const DEFAULT_HERMES_CHAT_CLOUD_RETENTION_DAYS = 30;
const MAXIMUM_HERMES_CHAT_CLOUD_RETENTION_DAYS = 3650;

function resolveHermesChatCloudRetentionDays(env = {}) {
  const value = Number(env.HERMES_CHAT_CLOUD_RETENTION_DAYS);
  return Number.isInteger(value)
    && value >= 1
    && value <= MAXIMUM_HERMES_CHAT_CLOUD_RETENTION_DAYS
    ? value
    : DEFAULT_HERMES_CHAT_CLOUD_RETENTION_DAYS;
}

function hermesChatRetentionCutoff(env = {}, now = Date.now()) {
  return now - resolveHermesChatCloudRetentionDays(env) * DAY_MILLISECONDS;
}

function nextHermesChatCleanupAt(oldestCreatedAt, retentionDays, now = Date.now()) {
  if (!Number.isSafeInteger(oldestCreatedAt) || oldestCreatedAt < 0) {
    throw new TypeError("Hermes chat oldest message timestamp is invalid.");
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError("Hermes chat retention days is invalid.");
  }
  const expiresAt = oldestCreatedAt + retentionDays * DAY_MILLISECONDS;
  const utcDayBoundary = Math.ceil(expiresAt / DAY_MILLISECONDS) * DAY_MILLISECONDS;
  return Math.max(now + MINIMUM_ALARM_DELAY_MILLISECONDS, utcDayBoundary);
}

export {
  DAY_MILLISECONDS,
  DEFAULT_HERMES_CHAT_CLOUD_RETENTION_DAYS,
  hermesChatRetentionCutoff,
  nextHermesChatCleanupAt,
  resolveHermesChatCloudRetentionDays,
};

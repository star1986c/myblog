import { DurableObject } from "cloudflare:workers";
import {
  CHAT_PROTOCOL_VERSION,
  buildHermesChatDeliveryFrame,
  hasConnectedHermesChatAgent,
  parseHermesChatFrame,
  validateHermesChatMessage,
  validateHermesChatEdit,
  validateHermesChatReceipt,
} from "./hermes-chat-protocol.js";
import {
  hermesChatRetentionCutoff,
  nextHermesChatCleanupAt,
  resolveHermesChatCloudRetentionDays,
} from "./hermes-chat-retention.js";

const MESSAGE_RETENTION_COUNT = 500;
const REPLAY_BATCH_SIZE = 100;

class HermesChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          sender_role TEXT NOT NULL CHECK (sender_role IN ('client', 'agent')),
          envelope TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
        CREATE TABLE IF NOT EXISTS used_tickets (
          id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_used_tickets_expires_at ON used_tickets(expires_at);
        CREATE TABLE IF NOT EXISTS consumer_offsets (
          consumer_role TEXT NOT NULL CHECK (consumer_role IN ('client', 'agent')),
          consumer_id TEXT NOT NULL,
          last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (consumer_role, consumer_id)
        );
        CREATE TABLE IF NOT EXISTS room_state (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (1, unixepoch() * 1000);
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (2, unixepoch() * 1000);
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (3, unixepoch() * 1000);
      `);
    });
  }

  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return jsonError("WebSocket upgrade required.", 426);
    }

    const role = request.headers.get("X-Hermes-Role") || "";
    const spaceId = request.headers.get("X-Hermes-Space") || "";
    const userId = request.headers.get("X-Hermes-User") || "";
    if (!["client", "agent"].includes(role) || !spaceId || !userId) {
      return jsonError("Unauthorized.", 401);
    }

    if (role === "client") {
      const ticketId = request.headers.get("X-Hermes-Ticket-Id") || "";
      const ticketExpiresAt = Number(request.headers.get("X-Hermes-Ticket-Expires") || 0);
      if (!ticketId || !Number.isSafeInteger(ticketExpiresAt) || ticketExpiresAt <= Date.now()) {
        return jsonError("Hermes chat ticket expired.", 401);
      }
      this.ctx.storage.sql.exec("DELETE FROM used_tickets WHERE expires_at <= ?", Date.now());
      try {
        this.ctx.storage.sql.exec(
          "INSERT INTO used_tickets (id, expires_at) VALUES (?, ?)",
          ticketId,
          ticketExpiresAt,
        );
      } catch {
        return jsonError("Hermes chat ticket was already used.", 401);
      }
    } else {
      const existingAgents = this.ctx.getWebSockets("role:agent");
      if (hasConnectedHermesChatAgent(existingAgents)) {
        return jsonError("Another Hermes agent is already connected for this space.", 409);
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connectionId = crypto.randomUUID();
    server.serializeAttachment({ role, spaceId, userId, connectionId });
    this.ctx.acceptWebSocket(server, [`role:${role}`, `user:${safeTag(userId)}`]);
    server.send(JSON.stringify({
      v: CHAT_PROTOCOL_VERSION,
      type: "ready",
      connectionId,
      latestSeq: this.latestSequence(),
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    const attachment = readSocketAttachment(socket);
    try {
      const frame = parseHermesChatFrame(message);
      if (frame.type === "ping") {
        socket.send(JSON.stringify({
          v: CHAT_PROTOCOL_VERSION,
          type: "pong",
          sentAt: Date.now(),
        }));
        return;
      }
      if (frame.type === "resume") {
        this.replay(socket, attachment, frame.afterSeq);
        return;
      }
      if (frame.type === "received") {
        const sequence = validateHermesChatReceipt(frame, attachment.role);
        this.recordConsumerOffset(attachment.role, attachment.userId, sequence);
        return;
      }
      if (frame.type === "typing") {
        this.broadcastToOtherRole(attachment.role, {
          v: CHAT_PROTOCOL_VERSION,
          type: "typing",
          sender: attachment.role,
          active: frame.active === true,
        });
        return;
      }
      if (frame.type === "edit") {
        const edit = validateHermesChatEdit(frame, attachment.role);
        this.ensureEditableTarget(edit.targetSeq);
        const stored = edit.final ? this.storeStreamEdit(edit) : null;
        if (stored && !stored.duplicate) await this.ensureCleanupAlarm();
        socket.send(JSON.stringify({
          v: CHAT_PROTOCOL_VERSION,
          type: "ack",
          id: edit.message.id,
          seq: stored?.seq || edit.targetSeq,
          targetSeq: edit.targetSeq,
          final: edit.final,
          durable: edit.final,
          duplicate: stored?.duplicate || false,
        }));
        if (!stored?.duplicate) {
          this.broadcastToOtherRole(
            attachment.role,
            stored
              ? buildHermesChatDeliveryFrame(edit, stored.seq)
              : edit,
          );
        }
        return;
      }
      if (frame.type !== "message") {
        throw new Error("Unsupported Hermes chat frame.");
      }
      const envelope = validateHermesChatMessage(frame, attachment.role);
      const stored = this.storeMessage(envelope);
      if (!stored.duplicate) await this.ensureCleanupAlarm();
      socket.send(JSON.stringify({
        v: CHAT_PROTOCOL_VERSION,
        type: "ack",
        id: envelope.id,
        seq: stored.seq,
        duplicate: stored.duplicate,
      }));
      if (!stored.duplicate) {
        this.broadcastToOtherRole(
          attachment.role,
          buildHermesChatDeliveryFrame(envelope, stored.seq),
        );
      }
    } catch (error) {
      sendSocketError(socket, error);
    }
  }

  webSocketError(socket, error) {
    console.error(JSON.stringify({
      level: "error",
      event: "hermes_chat_websocket_error",
      connectionId: readSocketAttachment(socket).connectionId,
      message: error instanceof Error ? error.message : "Unknown WebSocket error",
    }));
  }

  webSocketClose(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {
      // The runtime may already have completed the reciprocal close handshake.
    }
  }

  async alarm() {
    const now = Date.now();
    const cutoff = hermesChatRetentionCutoff(this.env, now);
    const expired = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS count FROM messages WHERE created_at <= ?", cutoff)
      .one().count;
    if (expired > 0) {
      this.preserveLatestSequence();
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE created_at <= ?", cutoff);
    }
    this.ctx.storage.sql.exec("DELETE FROM used_tickets WHERE expires_at <= ?", now);
    await this.ensureCleanupAlarm(now);
  }

  async purgeHistory() {
    const messagesDeleted = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS count FROM messages")
      .one().count;
    const lastSequence = this.latestSequence();
    if (messagesDeleted > 0) this.preserveLatestSequence(lastSequence);
    this.ctx.storage.sql.exec("DELETE FROM messages");
    await this.ctx.storage.deleteAlarm();
    return { messagesDeleted, lastSequence };
  }

  latestSequence() {
    return this.ctx.storage.sql
      .exec(`SELECT MAX(seq) AS seq FROM (
        SELECT COALESCE(MAX(seq), 0) AS seq FROM messages
        UNION ALL
        SELECT value AS seq FROM room_state WHERE key = 'latest_sequence'
      )`)
      .one().seq;
  }

  preserveLatestSequence(sequence = this.latestSequence()) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO room_state (key, value) VALUES ('latest_sequence', ?)
       ON CONFLICT (key) DO UPDATE SET value = MAX(room_state.value, excluded.value)`,
      sequence,
    );
  }

  async ensureCleanupAlarm(now = Date.now()) {
    const oldest = this.ctx.storage.sql
      .exec("SELECT MIN(created_at) AS created_at FROM messages")
      .one().created_at;
    const existing = await this.ctx.storage.getAlarm();
    if (!Number.isSafeInteger(oldest) || oldest < 0) {
      if (existing !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const target = nextHermesChatCleanupAt(
      oldest,
      resolveHermesChatCloudRetentionDays(this.env),
      now,
    );
    if (existing === null || target < existing) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  storeMessage(envelope) {
    return this.storeEvent(envelope.id, envelope.sender, envelope);
  }

  storeStreamEdit(edit) {
    return this.storeEvent(edit.message.id, "agent", edit);
  }

  storeEvent(id, senderRole, event) {
    try {
      const result = this.ctx.storage.sql.exec(
        `INSERT INTO messages (id, sender_role, envelope, created_at)
         VALUES (?, ?, ?, ?)
         RETURNING seq`,
        id,
        senderRole,
        JSON.stringify(event),
        Date.now(),
      );
      const seq = result.one().seq;
      this.ctx.storage.sql.exec(
        `DELETE FROM messages
         WHERE seq <= (SELECT COALESCE(MAX(seq), 0) - ? FROM messages)`,
        MESSAGE_RETENTION_COUNT,
      );
      return { seq, duplicate: false };
    } catch (error) {
      const existing = this.ctx.storage.sql
        .exec("SELECT seq FROM messages WHERE id = ?", id)
        .toArray()[0];
      if (existing) return { seq: existing.seq, duplicate: true };
      throw error;
    }
  }

  ensureEditableTarget(targetSeq) {
    const row = this.ctx.storage.sql.exec(
      "SELECT sender_role, envelope FROM messages WHERE seq = ?",
      targetSeq,
    ).toArray()[0];
    if (!row || row.sender_role !== "agent") {
      throw new Error("Hermes chat edit target is unavailable.");
    }
    let event;
    try {
      event = JSON.parse(row.envelope);
    } catch {
      throw new Error("Hermes chat edit target is invalid.");
    }
    if (event?.v !== CHAT_PROTOCOL_VERSION || event?.type !== "message" || event?.sender !== "agent") {
      throw new Error("Hermes chat edit target is invalid.");
    }
  }

  replay(socket, receiver, afterSeqValue) {
    const afterSeq = Number(afterSeqValue);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new Error("Invalid Hermes chat resume sequence.");
    }
    const receiverRole = receiver.role;
    const serverOffset = this.consumerOffset(receiverRole, receiver.userId);
    const effectiveAfterSeq = Math.max(afterSeq, serverOffset);
    const rows = receiverRole === "client"
      ? this.ctx.storage.sql.exec(
        `SELECT seq, envelope FROM messages
         WHERE seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
        effectiveAfterSeq,
        REPLAY_BATCH_SIZE,
      ).toArray()
      : this.ctx.storage.sql.exec(
        `SELECT seq, envelope FROM messages
         WHERE seq > ? AND sender_role <> ?
         ORDER BY seq ASC
         LIMIT ?`,
        effectiveAfterSeq,
        receiverRole,
        REPLAY_BATCH_SIZE,
      ).toArray();
    for (const row of rows) {
      socket.send(JSON.stringify(buildHermesChatDeliveryFrame(
        JSON.parse(row.envelope),
        row.seq,
        true,
      )));
    }
    socket.send(JSON.stringify({
      v: CHAT_PROTOCOL_VERSION,
      type: "resume_complete",
      latestSeq: this.latestSequence(),
      hasMore: rows.length === REPLAY_BATCH_SIZE,
    }));
  }

  consumerOffset(role, userId) {
    const row = this.ctx.storage.sql.exec(
      `SELECT last_seq FROM consumer_offsets
       WHERE consumer_role = ? AND consumer_id = ?`,
      role,
      userId,
    ).toArray()[0];
    return Number(row?.last_seq || 0);
  }

  recordConsumerOffset(role, userId, sequence) {
    if (sequence > this.latestSequence()) {
      throw new Error("Hermes chat receipt is ahead of the room sequence.");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO consumer_offsets (consumer_role, consumer_id, last_seq, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_role, consumer_id) DO UPDATE SET
         last_seq = MAX(consumer_offsets.last_seq, excluded.last_seq),
         updated_at = excluded.updated_at`,
      role,
      userId,
      sequence,
      Date.now(),
    );
  }

  broadcastToOtherRole(senderRole, frame) {
    const receiverRole = senderRole === "client" ? "agent" : "client";
    const encoded = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets(`role:${receiverRole}`)) {
      try {
        socket.send(encoded);
      } catch (error) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "hermes_chat_broadcast_failed",
          message: error instanceof Error ? error.message : "Unknown send error",
        }));
      }
    }
  }
}

function readSocketAttachment(socket) {
  const attachment = socket.deserializeAttachment();
  return attachment && typeof attachment === "object" ? attachment : {};
}

function safeTag(value) {
  return String(value).replace(/[^A-Za-z0-9_.:@-]/g, "_").slice(0, 200) || "unknown";
}

function sendSocketError(socket, error) {
  const status = Number.isInteger(error?.status) ? error.status : 400;
  socket.send(JSON.stringify({
    v: CHAT_PROTOCOL_VERSION,
    type: "error",
    code: status,
    message: status >= 500 ? "Internal Server Error" : String(error?.message || "Invalid frame"),
  }));
}

function jsonError(message, status) {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export { HermesChatRoom };

import { DurableObject } from "cloudflare:workers";
import {
  CHAT_PROTOCOL_VERSION,
  buildHermesChatDeliveryFrame,
  isReplacedHermesChatAgentAttachment,
  parseHermesChatFrame,
  planHermesChatAgentAdmission,
  validateHermesChatMessage,
  validateHermesChatEdit,
  validateHermesChatReceipt,
} from "./hermes-chat-protocol.js";
import {
  hermesChatRetentionCutoff,
  nextHermesChatCleanupAt,
  resolveHermesChatCloudRetentionDays,
} from "./hermes-chat-retention.js";
import { resolveHermesChatMessageDeletion } from "./hermes-chat-message-deletion.js";

const MESSAGE_RETENTION_COUNT = 500;
const REPLAY_BATCH_SIZE = 100;
const CLIENT_HUB_REGISTRATION_GRACE_MS = 30_000;

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
        CREATE TABLE IF NOT EXISTS client_hubs (
          hub_key TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (1, unixepoch() * 1000);
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (2, unixepoch() * 1000);
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (3, unixepoch() * 1000);
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (4, unixepoch() * 1000);
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

    let agentReplacements = [];
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
      const admission = planHermesChatAgentAdmission(existingAgents, {
        spaceId,
        agentId: userId,
      });
      if (existingAgents.length > 0) {
        console.log(JSON.stringify({
          level: "info",
          event: "hermes_chat_agent_admission",
          spaceId,
          agentId: userId,
          existingConnections: existingAgents.length,
          replacementConnections: admission.replacementConnections.length,
          conflict: admission.conflict,
          readyStates: existingAgents.map((connection) => connection.readyState),
        }));
      }
      if (admission.conflict) {
        return jsonError("Another Hermes agent is already connected for this space.", 409);
      }
      agentReplacements = admission.replacementConnections;
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
    for (const existing of agentReplacements) {
      try {
        existing.serializeAttachment({
          ...readSocketAttachment(existing),
          replacedByConnectionId: connectionId,
        });
      } catch (error) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "hermes_chat_agent_replacement_mark_failed",
          spaceId,
          agentId: userId,
          message: error instanceof Error ? error.message : "Unknown attachment error",
        }));
      }
      try {
        existing.close(1000, "Replaced by a newer Hermes agent connection");
      } catch (error) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "hermes_chat_agent_replacement_close_failed",
          spaceId,
          agentId: userId,
          message: error instanceof Error ? error.message : "Unknown close error",
        }));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    const attachment = readSocketAttachment(socket);
    if (isReplacedHermesChatAgentAttachment(attachment)) return;
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
        }, attachment.spaceId);
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
            attachment.spaceId,
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
          attachment.spaceId,
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

  async deleteMessages(messageIds) {
    const rows = this.ctx.storage.sql
      .exec("SELECT seq, id, envelope FROM messages ORDER BY seq ASC")
      .toArray();
    const deletion = resolveHermesChatMessageDeletion(rows, messageIds);
    const ids = deletion.deletedIds;
    const lastSequence = this.latestSequence();
    if (ids.length > 0) {
      this.preserveLatestSequence(lastSequence);
      const placeholders = ids.map(() => "?").join(",");
      this.ctx.storage.sql.exec(
        `DELETE FROM messages WHERE id IN (${placeholders})`,
        ...ids,
      );
      await this.ensureCleanupAlarm();
    }
    return {
      messagesDeleted: ids.length,
      requestedMessages: deletion.requestedIds.length,
      lastSequence,
    };
  }

  async registerClientHub(hubKey, userId, spaceId) {
    if (!/^[0-9a-f]{64}$/.test(String(hubKey || ""))) {
      throw new Error("Invalid Hermes chat hub.");
    }
    if (!String(userId || "").trim() || String(userId).length > 256) {
      throw new Error("Invalid Hermes chat hub user.");
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(spaceId || ""))) {
      throw new Error("Invalid Hermes chat hub space.");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO client_hubs (hub_key, user_id, space_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (hub_key) DO UPDATE SET
         user_id = excluded.user_id,
         space_id = excluded.space_id,
         updated_at = excluded.updated_at`,
      hubKey,
      userId,
      spaceId,
      Date.now(),
    );
    return { latestSeq: this.latestSequence() };
  }

  async handleMultiplexClientFrame(spaceId, userId, rawFrame) {
    if (!String(userId || "").trim()) throw new Error("Invalid Hermes chat user.");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(spaceId || ""))) {
      throw new Error("Invalid Hermes chat space.");
    }
    const frame = parseHermesChatFrame(JSON.stringify(rawFrame));
    const receiver = { role: "client", userId };
    if (frame.type === "resume") {
      return this.replayFrames(receiver, frame.afterSeq);
    }
    if (frame.type === "typing") {
      this.broadcastToOtherRole("client", {
        v: CHAT_PROTOCOL_VERSION,
        type: "typing",
        sender: "client",
        active: frame.active === true,
      }, spaceId);
      return [];
    }
    if (frame.type !== "message") {
      throw new Error("Unsupported Hermes chat frame.");
    }
    const envelope = validateHermesChatMessage(frame, "client");
    const stored = this.storeMessage(envelope);
    if (!stored.duplicate) await this.ensureCleanupAlarm();
    if (!stored.duplicate) {
      this.broadcastToOtherRole(
        "client",
        buildHermesChatDeliveryFrame(envelope, stored.seq),
        spaceId,
      );
    }
    return [{
      v: CHAT_PROTOCOL_VERSION,
      type: "ack",
      id: envelope.id,
      seq: stored.seq,
      duplicate: stored.duplicate,
    }];
  }

  async publishAgentMessage(spaceId, rawFrame) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(spaceId || ""))) {
      throw new Error("Invalid Hermes chat space.");
    }
    const frame = parseHermesChatFrame(rawFrame);
    if (frame.type !== "message") {
      throw new Error("Standalone Hermes delivery only supports new messages.");
    }
    const envelope = validateHermesChatMessage(frame, "agent");
    const stored = this.storeMessage(envelope);
    if (!stored.duplicate) {
      await this.ensureCleanupAlarm();
      this.broadcastToOtherRole(
        "agent",
        buildHermesChatDeliveryFrame(envelope, stored.seq),
        spaceId,
      );
    }
    return {
      v: CHAT_PROTOCOL_VERSION,
      type: "ack",
      id: envelope.id,
      seq: stored.seq,
      duplicate: stored.duplicate,
    };
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
    for (const frame of this.replayFrames(receiver, afterSeqValue)) {
      socket.send(JSON.stringify(frame));
    }
  }

  replayFrames(receiver, afterSeqValue) {
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
    const frames = rows.map((row) => buildHermesChatDeliveryFrame(
        JSON.parse(row.envelope),
        row.seq,
        true,
      ));
    frames.push({
      v: CHAT_PROTOCOL_VERSION,
      type: "resume_complete",
      latestSeq: this.latestSequence(),
      hasMore: rows.length === REPLAY_BATCH_SIZE,
    });
    return frames;
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

  broadcastToOtherRole(senderRole, frame, spaceId = "") {
    const receiverRole = senderRole === "client" ? "agent" : "client";
    const encoded = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets(`role:${receiverRole}`)) {
      try {
        if (
          receiverRole === "agent"
          && isReplacedHermesChatAgentAttachment(readSocketAttachment(socket))
        ) continue;
        socket.send(encoded);
      } catch (error) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "hermes_chat_broadcast_failed",
          message: error instanceof Error ? error.message : "Unknown send error",
        }));
      }
    }
    if (receiverRole === "client") {
      this.ctx.waitUntil(this.broadcastToClientHubs(spaceId, frame));
    }
  }

  async broadcastToClientHubs(spaceId, frame) {
    const hubs = this.ctx.storage.sql
      .exec("SELECT hub_key, space_id, updated_at FROM client_hubs")
      .toArray();
    await Promise.all(hubs.map(async (hub) => {
      try {
        const routedSpace = String(hub.space_id || spaceId || "");
        const stub = this.env.HERMES_CHAT_HUBS.getByName(`user:${hub.hub_key}`, {
          locationHint: "apac",
        });
        const delivered = await stub.deliver(routedSpace, frame);
        if (
          Number(delivered || 0) === 0
          && Number(hub.updated_at) <= Date.now() - CLIENT_HUB_REGISTRATION_GRACE_MS
        ) {
          this.ctx.storage.sql.exec(
            "DELETE FROM client_hubs WHERE hub_key = ? AND updated_at = ?",
            hub.hub_key,
            hub.updated_at,
          );
        }
      } catch (error) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "hermes_chat_hub_broadcast_failed",
          spaceId,
          message: error instanceof Error ? error.message : "Unknown hub delivery error",
        }));
      }
    }));
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

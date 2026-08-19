import { DurableObject } from "cloudflare:workers";
import {
  CHAT_PROTOCOL_VERSION,
  normalizeHermesChatSpaceId,
  normalizeHermesChatSpaceIds,
  parseHermesChatFrame,
} from "./hermes-chat-protocol.js";

/** Terminates hibernatable native-client WebSockets and routes frames to profile rooms. */
class HermesChatHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS used_tickets (
          id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_used_tickets_expires_at ON used_tickets(expires_at);
      `);
    });
  }

  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return jsonError("WebSocket upgrade required.", 426);
    }
    if (
      request.headers.get("X-Hermes-Role") !== "client"
      || request.headers.get("X-Hermes-Mode") !== "multiplex"
    ) {
      return jsonError("Unauthorized.", 401);
    }

    const userId = request.headers.get("X-Hermes-User") || "";
    const hubKey = request.headers.get("X-Hermes-Hub-Key") || "";
    const spaceIds = readSpaceIds(request.headers.get("X-Hermes-Spaces"));
    const ticketId = request.headers.get("X-Hermes-Ticket-Id") || "";
    const ticketExpiresAt = Number(request.headers.get("X-Hermes-Ticket-Expires") || 0);
    if (
      !userId
      || !/^[0-9a-f]{64}$/.test(hubKey)
      || !ticketId
      || !Number.isSafeInteger(ticketExpiresAt)
      || ticketExpiresAt <= Date.now()
    ) {
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

    const connectionId = crypto.randomUUID();
    const attachment = { userId, hubKey, spaceIds, connectionId };
    try {
      await this.registerWithRooms(attachment);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "hermes_chat_hub_registration_failed",
        message: error instanceof Error ? error.message : "Unknown registration error",
      }));
      return jsonError("Hermes chat routing is temporarily unavailable.", 503);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, ["role:client", `user:${safeTag(userId)}`]);
    server.send(JSON.stringify({
      v: CHAT_PROTOCOL_VERSION,
      type: "ready",
      multiplex: true,
      connectionId,
      spaceIds,
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    const attachment = readSocketAttachment(socket);
    let spaceId = "";
    try {
      const routedFrame = parseHermesChatFrame(message);
      if (routedFrame.type === "ping" && !routedFrame.spaceId) {
        socket.send(JSON.stringify({
          v: CHAT_PROTOCOL_VERSION,
          type: "pong",
          sentAt: Date.now(),
        }));
        return;
      }
      spaceId = normalizeHermesChatSpaceId(routedFrame.spaceId);
      if (!attachment.spaceIds?.includes(spaceId)) {
        throw new Error("Hermes chat space is not subscribed.");
      }
      const frame = { ...routedFrame };
      delete frame.spaceId;
      const responses = await this.room(spaceId).handleMultiplexClientFrame(
        spaceId,
        attachment.userId,
        frame,
      );
      for (const response of Array.isArray(responses) ? responses : []) {
        sendRoutedFrame(socket, spaceId, response);
      }
    } catch (error) {
      sendSocketError(socket, error, spaceId);
    }
  }

  async deliver(spaceIdValue, frame) {
    const spaceId = normalizeHermesChatSpaceId(spaceIdValue);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets("role:client")) {
      const attachment = readSocketAttachment(socket);
      if (!attachment.spaceIds?.includes(spaceId)) continue;
      try {
        sendRoutedFrame(socket, spaceId, frame);
        delivered += 1;
      } catch (error) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "hermes_chat_hub_delivery_failed",
          spaceId,
          message: error instanceof Error ? error.message : "Unknown send error",
        }));
      }
    }
    return delivered;
  }

  webSocketError(socket, error) {
    console.error(JSON.stringify({
      level: "error",
      event: "hermes_chat_hub_websocket_error",
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

  async registerWithRooms(attachment) {
    const registrations = attachment.spaceIds.map((spaceId) => this.room(spaceId)
      .registerClientHub(attachment.hubKey, attachment.userId, spaceId));
    await Promise.all(registrations);
  }

  room(spaceId) {
    return this.env.HERMES_CHAT_ROOMS.getByName(`space:${spaceId}`, {
      locationHint: "apac",
    });
  }
}

function readSpaceIds(value) {
  try {
    return normalizeHermesChatSpaceIds(JSON.parse(value || "[]"));
  } catch {
    throw new Error("Invalid Hermes chat spaces.");
  }
}

function readSocketAttachment(socket) {
  const attachment = socket.deserializeAttachment();
  return attachment && typeof attachment === "object" ? attachment : {};
}

function sendRoutedFrame(socket, spaceId, frame) {
  socket.send(JSON.stringify({ ...frame, spaceId }));
}

function sendSocketError(socket, error, spaceId) {
  const status = Number.isInteger(error?.status) ? error.status : 400;
  const frame = {
    v: CHAT_PROTOCOL_VERSION,
    type: "error",
    code: status,
    message: status >= 500 ? "Internal Server Error" : String(error?.message || "Invalid frame"),
  };
  if (spaceId) frame.spaceId = spaceId;
  socket.send(JSON.stringify(frame));
}

function safeTag(value) {
  return String(value).replace(/[^A-Za-z0-9_.:@-]/g, "_").slice(0, 200) || "unknown";
}

function jsonError(message, status) {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export { HermesChatHub };

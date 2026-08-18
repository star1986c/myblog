import { ServiceError } from "./blog-repository.js";
import {
  constantTimeSecretEqual,
  hermesChatHubKey,
  normalizeHermesChatSpaceId,
  readBearerToken,
  verifyHermesChatMultiplexTicket,
  verifyHermesChatTicket,
} from "./hermes-chat-protocol.js";

const HERMES_CHAT_FRAME_MAX_BYTES = 64 * 1024;

async function handleHermesChatWebSocket(request, env) {
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    throw new ServiceError("WebSocket upgrade required.", 426);
  }
  const requestedRole = request.headers.get("X-Hermes-Role") || "";
  const requestedMode = request.headers.get("X-Hermes-Mode") || "";

  if (requestedRole === "client" && requestedMode === "multiplex") {
    return await handleHermesChatMultiplexWebSocket(request, env);
  }

  const requestedSpace = requireConfiguredHermesChatSpace(env, request.headers.get("X-Hermes-Space")).id;

  let principal;
  let ticketId = "";
  let ticketExpiresAt = "";
  if (requestedRole === "agent") {
    const authorized = await constantTimeSecretEqual(
      readBearerToken(request),
      env.HERMES_CHAT_AGENT_SECRET,
    );
    if (!authorized) throw new ServiceError("Unauthorized.", 401);
    principal = normalizeAgentId(request.headers.get("X-Hermes-Agent-Id"));
  } else if (requestedRole === "client") {
    const ticket = await verifyHermesChatTicket({
      token: readBearerToken(request),
      secret: env.SESSION_SECRET,
    });
    if (!ticket || ticket.spaceId !== requestedSpace) {
      throw new ServiceError("Hermes chat ticket is invalid or expired.", 401);
    }
    principal = ticket.username;
    ticketId = ticket.jti;
    ticketExpiresAt = String(ticket.exp * 1000);
  } else {
    throw new ServiceError("Invalid Hermes chat role.", 400);
  }

  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set("X-Hermes-Role", requestedRole);
  headers.set("X-Hermes-Space", requestedSpace);
  headers.set("X-Hermes-User", principal);
  if (ticketId) {
    headers.set("X-Hermes-Ticket-Id", ticketId);
    headers.set("X-Hermes-Ticket-Expires", ticketExpiresAt);
  }
  const internalRequest = new Request("https://hermes-chat.internal/ws", {
    method: "GET",
    headers,
  });
  const room = hermesChatRoom(env, requestedSpace);
  return await room.fetch(internalRequest);
}

async function handleHermesChatMultiplexWebSocket(request, env) {
  const ticket = await verifyHermesChatMultiplexTicket({
    token: readBearerToken(request),
    secret: env.SESSION_SECRET,
  });
  if (!ticket) {
    throw new ServiceError("Hermes chat ticket is invalid or expired.", 401);
  }
  const configuredSpaces = ticket.spaceIds.map(
    (spaceId) => requireConfiguredHermesChatSpace(env, spaceId).id,
  );
  const hubKey = await hermesChatHubKey(ticket.username);
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set("X-Hermes-Role", "client");
  headers.set("X-Hermes-Mode", "multiplex");
  headers.set("X-Hermes-Spaces", JSON.stringify(configuredSpaces));
  headers.set("X-Hermes-User", ticket.username);
  headers.set("X-Hermes-Hub-Key", hubKey);
  headers.set("X-Hermes-Ticket-Id", ticket.jti);
  headers.set("X-Hermes-Ticket-Expires", String(ticket.exp * 1000));
  const internalRequest = new Request("https://hermes-chat.internal/multiplex-ws", {
    method: "GET",
    headers,
  });
  return await hermesChatHub(env, hubKey).fetch(internalRequest);
}

async function handleHermesChatAgentMessage(request, env) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, {
      status: 405,
      headers: { Allow: "POST", "Cache-Control": "no-store" },
    });
  }

  const agent = await authorizeHermesChatAgent(request, env);
  if (!agent) throw new ServiceError("Unauthorized.", 401);
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    throw new ServiceError("Hermes chat message must be JSON.", 415);
  }

  const spaceId = requireConfiguredHermesChatSpace(
    env,
    request.headers.get("X-Hermes-Space"),
  ).id;
  const rawFrame = await readBoundedText(request, HERMES_CHAT_FRAME_MAX_BYTES);
  const ack = await hermesChatRoom(env, spaceId).publishAgentMessage(spaceId, rawFrame);
  return Response.json({ ok: true, ack }, {
    status: ack.duplicate ? 200 : 201,
    headers: { "Cache-Control": "no-store" },
  });
}

function hermesChatRoom(env, spaceId) {
  if (!env.HERMES_CHAT_ROOMS || typeof env.HERMES_CHAT_ROOMS.getByName !== "function") {
    throw new ServiceError("Hermes chat is unavailable.", 503);
  }
  return env.HERMES_CHAT_ROOMS.getByName(`space:${spaceId}`, {
    locationHint: "apac",
  });
}

function hermesChatHub(env, hubKey) {
  if (!env.HERMES_CHAT_HUBS || typeof env.HERMES_CHAT_HUBS.getByName !== "function") {
    throw new ServiceError("Hermes chat multiplexing is unavailable.", 503);
  }
  return env.HERMES_CHAT_HUBS.getByName(`user:${hubKey}`, {
    locationHint: "apac",
  });
}

async function authorizeHermesChatAgent(request, env) {
  if ((request.headers.get("X-Hermes-Role") || "") !== "agent") return null;
  const authorized = await constantTimeSecretEqual(
    readBearerToken(request),
    env.HERMES_CHAT_AGENT_SECRET,
  );
  if (!authorized) return null;
  return {
    role: "agent",
    id: normalizeAgentId(request.headers.get("X-Hermes-Agent-Id")),
  };
}

function configuredHermesChatProfiles(env) {
  const configured = String(
    env.HERMES_CHAT_PROFILES || env.HERMES_CHAT_SPACE_ID || "primary:Hermes 1",
  );
  const profiles = [];
  const seen = new Set();
  for (const rawEntry of configured.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.indexOf(":");
    const id = normalizeHermesChatSpaceId(
      separator < 0 ? entry : entry.slice(0, separator),
    );
    const label = String(separator < 0 ? id : entry.slice(separator + 1)).trim();
    if (!label || label.length > 40) {
      throw new ServiceError("Hermes chat profile configuration is invalid.", 503);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    profiles.push({ id, label });
  }
  if (!profiles.length || profiles.length > 32) {
    throw new ServiceError("Hermes chat profile configuration is invalid.", 503);
  }
  return profiles;
}

function requireConfiguredHermesChatSpace(env, requestedSpace) {
  const profiles = configuredHermesChatProfiles(env);
  const spaceId = normalizeHermesChatSpaceId(requestedSpace || profiles[0].id);
  const profile = profiles.find((candidate) => candidate.id === spaceId);
  if (!profile) throw new ServiceError("Hermes chat space is unavailable.", 404);
  return profile;
}

function normalizeAgentId(value) {
  const agentId = String(value || "nas-hermes").trim();
  if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(agentId)) {
    throw new ServiceError("Invalid Hermes agent id.", 400);
  }
  return agentId;
}

async function readBoundedText(request, maximumBytes) {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 1 || length > maximumBytes) {
      throw new ServiceError("Hermes chat frame is too large.", 413);
    }
  }
  if (!request.body) throw new ServiceError("Hermes chat frame is required.", 400);

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Hermes chat frame is too large.");
        throw new ServiceError("Hermes chat frame is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1) throw new ServiceError("Hermes chat frame is required.", 400);

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ServiceError("Hermes chat frame must be UTF-8.", 400);
  }
}

export {
  authorizeHermesChatAgent,
  configuredHermesChatProfiles,
  handleHermesChatAgentMessage,
  handleHermesChatMultiplexWebSocket,
  handleHermesChatWebSocket,
  hermesChatHub,
  hermesChatRoom,
  requireConfiguredHermesChatSpace,
};

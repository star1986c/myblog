import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hub = await readFile(
  new URL("../src/hermes-chat-hub.js", import.meta.url),
  "utf8",
);
const room = await readFile(
  new URL("../src/hermes-chat-room.js", import.meta.url),
  "utf8",
);
const gateway = await readFile(
  new URL("../src/hermes-chat-gateway.js", import.meta.url),
  "utf8",
);
const hubBroadcastStart = room.indexOf("  async broadcastToClientHubs(spaceId, frame) {");
const hubStubStart = room.indexOf("  clientHubStub(hubKey) {", hubBroadcastStart);
const hubBroadcast = room.slice(hubBroadcastStart, hubStubStart);
const hubStubCache = room.slice(hubStubStart);

test("multiplex hub keeps concurrent native-client sockets with durable route metadata", () => {
  assert.match(hub, /class HermesChatHub extends DurableObject/);
  assert.match(hub, /server\.serializeAttachment\(attachment\)/);
  assert.match(hub, /this\.ctx\.acceptWebSocket\(server, \["role:client"/);
  assert.match(hub, /normalizeHermesChatSpaceId\(routedFrame\.spaceId\)/);
  assert.match(hub, /attachment\.spaceIds\?\.includes\(spaceId\)/);
  assert.match(hub, /handleMultiplexClientFrame/);
  assert.doesNotMatch(hub, /Replaced by a newer Android connection/);
  assert.doesNotMatch(hub, /existing\.close\(1000/);
});

test("profile rooms retain old client sockets and forward durable events to registered hubs", () => {
  assert.match(room, /CREATE TABLE IF NOT EXISTS client_hubs/);
  assert.match(room, /async registerClientHub\(/);
  assert.match(room, /this\.ctx\.waitUntil\(this\.broadcastToClientHubs/);
  assert.match(room, /await stub\.deliver\(routedSpace, frame\)/);
  assert.match(room, /this\.clientHubStubs = new Map\(\)/);
  assert.match(room, /this\.clientHubDeliveryTails = new Map\(\)/);
  assert.match(hubBroadcast, /enqueueClientHubDelivery\(hub, spaceId, frame\)/);
  assert.match(
    hubBroadcast,
    /previous\.then\(\(\) => this\.deliverToClientHub\(hub, spaceId, frame\)\)/,
  );
  assert.match(hubBroadcast, /stub = this\.clientHubStub\(hubKey\)/);
  assert.match(
    hubStubCache,
    /this\.clientHubStubs\.get\(hubKey\)[\s\S]*this\.clientHubStubs\.set\(hubKey, stub\)/,
  );
  assert.match(
    hubBroadcast,
    /catch \(error\)[\s\S]*this\.clientHubStubs\.get\(hubKey\) === stub[\s\S]*this\.clientHubStubs\.delete\(hubKey\)/,
  );
  assert.match(
    hubBroadcast,
    /Number\(deletion\.rowsWritten \|\| 0\) === 0[\s\S]*SELECT 1 AS registered FROM client_hubs WHERE hub_key = \? LIMIT 1/,
  );
  assert.match(
    hubBroadcast,
    /!registrationStillExists[\s\S]*this\.clientHubStubs\.get\(hubKey\) === stub[\s\S]*this\.clientHubStubs\.delete\(hubKey\)/,
  );
  assert.match(
    hubBroadcast,
    /let stub;[\s\S]*try \{[\s\S]*stub = this\.clientHubStub\(hubKey\)[\s\S]*await stub\.deliver/,
  );
  assert.match(hubBroadcast, /hermes_chat_hub_registration_cleanup_failed/);
  assert.doesNotMatch(hubBroadcast, /HERMES_CHAT_HUBS\.getByName/);
  assert.match(hubStubCache, /HERMES_CHAT_HUBS\.getByName/);
  assert.match(room, /CLIENT_HUB_REGISTRATION_GRACE_MS/);
  assert.match(room, /this\.ctx\.getWebSockets\(`role:\$\{receiverRole\}`\)/);
  assert.match(room, /async publishAgentMessage\(spaceId, rawFrame\)/);
  assert.match(room, /validateHermesChatMessage\(frame, "agent"\)/);
  assert.match(room, /buildHermesChatDeliveryFrame\(envelope, stored\.seq\)/);
  assert.match(room, /planHermesChatAgentAdmission\(existingAgents/);
  assert.match(room, /Replaced by a newer Hermes agent connection/);
  assert.match(room, /replacedByConnectionId: connectionId/);
  assert.match(room, /isReplacedHermesChatAgentAttachment\(attachment\)/);
  assert.match(room, /frame\.type === "action"/);
  assert.match(room, /validateHermesChatAction\(frame, "client"\)/);
  assert.match(room, /durable: false/);
  assert.equal(
    (room.match(/typeof frame\.terminal === "boolean"/g) || []).length,
    2,
    "legacy and multiplex typing routes must preserve the optional terminal marker",
  );
  assert.doesNotMatch(room, /storeMessage\(action/);
  assert.match(
    room,
    /handleMultiplexClientFrame[\s\S]*this\.ctx\.waitUntil\(this\.broadcastToClientHubs\(spaceId, delivery\)\)/,
  );
});

test("gateway chooses multiplex mode without removing the legacy single-space route", () => {
  assert.match(gateway, /requestedMode === "multiplex"/);
  assert.match(gateway, /verifyHermesChatMultiplexTicket/);
  assert.match(gateway, /return await hermesChatHub\(env, hubKey\)\.fetch/);
  assert.match(gateway, /return await room\.fetch\(internalRequest\)/);
});

test("recent replay is optional and filters indexed server history by creation time", () => {
  assert.match(room, /frame\.afterSeq, frame\.since/);
  assert.match(room, /normalizeHermesChatReplaySince\(sinceValue\)/);
  assert.match(room, /conditions\.push\("created_at >= \?"\)/);
  assert.match(room, /since === null \? Math\.max\(afterSeq, serverOffset\) : afterSeq/);
});

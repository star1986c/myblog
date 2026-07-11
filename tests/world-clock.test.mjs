import assert from "node:assert/strict";
import test from "node:test";

import { estimateSynchronizedEpoch } from "../public/assets/world-clock.20260711.js";

test("network time estimation compensates for half the request round trip", () => {
  assert.equal(estimateSynchronizedEpoch(1_000_000, 200, 320), 1_000_060);
});

test("network time estimation rejects invalid synchronization values", () => {
  assert.throws(() => estimateSynchronizedEpoch("invalid", 200, 320), /Invalid network time/);
  assert.throws(() => estimateSynchronizedEpoch(1_000_000, 320, 200), /Invalid network time/);
});

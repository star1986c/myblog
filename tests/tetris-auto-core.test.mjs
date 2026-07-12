import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATIC_POWER_UPS,
  chooseRandomPowerUp,
  parsePowerUpEnergy,
} from "../public/assets/tetris-auto-core.20260712.js";

test("automatic power-up selection uses only currently available effects", () => {
  const available = ["queueShift", "slowTime"];
  assert.equal(chooseRandomPowerUp(available, () => 0), "queueShift");
  assert.equal(chooseRandomPowerUp(available, () => 0.999), "slowTime");
});

test("automatic power-up selection ignores unsupported effects and invalid randomness", () => {
  assert.equal(chooseRandomPowerUp(["unsupported", "rowBlast"], () => Number.NaN), "rowBlast");
  assert.equal(chooseRandomPowerUp([], () => 0.5), null);
  assert.deepEqual(AUTOMATIC_POWER_UPS, ["rowBlast", "queueShift", "slowTime"]);
});

test("automatic power-up energy parsing detects when a charge is ready", () => {
  assert.equal(parsePowerUpEnergy("1 / 3"), 1);
  assert.equal(parsePowerUpEnergy("0 / 3"), 0);
  assert.equal(parsePowerUpEnergy("invalid"), 0);
});

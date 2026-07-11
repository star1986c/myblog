import assert from "node:assert/strict";
import test from "node:test";

import {
  TETRIS_AUDIO_SETTINGS_KEY,
  createTetrisAudio,
  readTetrisAudioSettings,
  writeTetrisAudioSettings,
} from "../public/assets/tetris-audio.20260711.js";

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set(TETRIS_AUDIO_SETTINGS_KEY, initialValue);
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function createFakeAudioContext() {
  const parameter = () => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
  });
  const context = {
    state: "suspended",
    currentTime: 1,
    destination: {},
    oscillatorCount: 0,
    async resume() {
      this.state = "running";
    },
    createGain() {
      return { gain: parameter(), connect() {} };
    },
    createOscillator() {
      this.oscillatorCount += 1;
      return {
        frequency: parameter(),
        connect() {},
        start() {},
        stop() {},
      };
    },
  };
  return context;
}

test("audio settings default to muted and ignore invalid storage", () => {
  assert.deepEqual(readTetrisAudioSettings(createStorage()), { music: false, effects: false });
  assert.deepEqual(readTetrisAudioSettings(createStorage("not-json")), { music: false, effects: false });
});

test("audio settings persist only supported boolean values", () => {
  const storage = createStorage();
  assert.equal(writeTetrisAudioSettings({ music: true, effects: "yes" }, storage), true);
  assert.deepEqual(readTetrisAudioSettings(storage), { music: true, effects: false });
});

test("music starts only after audio unlock and stops with the game", async () => {
  const storage = createStorage();
  const context = createFakeAudioContext();
  let timer = null;
  let clearedTimer = null;
  const audio = createTetrisAudio({
    storage,
    audioContextFactory: () => context,
    setInterval(callback) {
      timer = { id: 7, callback };
      return timer.id;
    },
    clearInterval(id) {
      clearedTimer = id;
    },
  });

  audio.setMusicEnabled(true);
  audio.setGameRunning(true);
  assert.equal(timer, null);
  assert.equal(await audio.unlock(), true);
  assert.equal(timer.id, 7);
  assert.ok(context.oscillatorCount >= 2);

  audio.setGameRunning(false);
  assert.equal(clearedTimer, 7);
});

test("effects are synthesized only when enabled", async () => {
  const context = createFakeAudioContext();
  const audio = createTetrisAudio({
    storage: createStorage(),
    audioContextFactory: () => context,
    setInterval: () => 1,
    clearInterval() {},
  });
  await audio.unlock();
  assert.equal(audio.playEffect("rotate"), false);
  assert.equal(context.oscillatorCount, 0);

  audio.setEffectsEnabled(true);
  assert.equal(audio.playEffect("rotate"), true);
  assert.equal(context.oscillatorCount, 1);
});

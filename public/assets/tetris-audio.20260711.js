export const TETRIS_AUDIO_SETTINGS_KEY = "ai-build-lab.tetris-audio.v1";

const DEFAULT_SETTINGS = Object.freeze({ music: false, effects: false });
const MUSIC_STEP_MS = 170;
const MELODY = Object.freeze([
  659.25, 493.88, 523.25, 587.33, 523.25, 493.88, 440, 440,
  523.25, 659.25, 587.33, 523.25, 493.88, 523.25, 587.33, 659.25,
  523.25, 440, 440, null, 587.33, 698.46, 880, 783.99,
  698.46, 659.25, 523.25, 659.25, 587.33, 523.25, 493.88, null,
]);
const BASS = Object.freeze([164.81, 130.81, 146.83, 123.47]);

function normalizedSettings(value) {
  return {
    music: value?.music === true,
    effects: value?.effects === true,
  };
}

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readTetrisAudioSettings(storage) {
  storage = resolveStorage(storage);
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    return normalizedSettings(JSON.parse(storage.getItem(TETRIS_AUDIO_SETTINGS_KEY) || "null"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeTetrisAudioSettings(settings, storage) {
  storage = resolveStorage(storage);
  if (!storage) return false;
  try {
    storage.setItem(TETRIS_AUDIO_SETTINGS_KEY, JSON.stringify(normalizedSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

function defaultAudioContextFactory() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  return AudioContextClass ? new AudioContextClass() : null;
}

export function createTetrisAudio(options = {}) {
  const storage = resolveStorage(options.storage);
  const audioContextFactory = options.audioContextFactory || defaultAudioContextFactory;
  const setIntervalFn = options.setInterval || globalThis.setInterval.bind(globalThis);
  const clearIntervalFn = options.clearInterval || globalThis.clearInterval.bind(globalThis);
  let settings = readTetrisAudioSettings(storage);
  let context = null;
  let masterGain = null;
  let musicTimer = null;
  let musicStep = 0;
  let gameRunning = false;

  function ensureContext() {
    if (context && context.state !== "closed") return context;
    try {
      context = audioContextFactory();
      if (!context) return null;
      masterGain = context.createGain();
      masterGain.gain.value = 0.82;
      masterGain.connect(context.destination);
      return context;
    } catch {
      context = null;
      masterGain = null;
      return null;
    }
  }

  function playTone(frequency, duration, volume, type = "square", delay = 0) {
    if (!context || context.state !== "running" || !masterGain || !frequency) return false;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + delay;
      const end = start + duration;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(masterGain);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
      return true;
    } catch {
      return false;
    }
  }

  function playMusicStep() {
    if (!gameRunning || !settings.music || context?.state !== "running") return;
    const melodyFrequency = MELODY[musicStep % MELODY.length];
    if (melodyFrequency) playTone(melodyFrequency, 0.13, 0.032, "square");
    if (musicStep % 4 === 0) {
      const bassFrequency = BASS[Math.floor(musicStep / 4) % BASS.length];
      playTone(bassFrequency, 0.24, 0.024, "triangle");
    }
    musicStep = (musicStep + 1) % MELODY.length;
  }

  function stopMusic() {
    if (musicTimer === null) return;
    clearIntervalFn(musicTimer);
    musicTimer = null;
  }

  function syncMusic() {
    const shouldPlay = gameRunning && settings.music && context?.state === "running";
    if (!shouldPlay) {
      stopMusic();
      return;
    }
    if (musicTimer !== null) return;
    playMusicStep();
    musicTimer = setIntervalFn(playMusicStep, MUSIC_STEP_MS);
  }

  async function unlock() {
    const audioContext = ensureContext();
    if (!audioContext) return false;
    try {
      if (audioContext.state === "suspended") await audioContext.resume();
      syncMusic();
      return audioContext.state === "running";
    } catch {
      return false;
    }
  }

  function persistSettings() {
    writeTetrisAudioSettings(settings, storage);
    syncMusic();
  }

  function setMusicEnabled(enabled) {
    settings = { ...settings, music: enabled === true };
    persistSettings();
  }

  function setEffectsEnabled(enabled) {
    settings = { ...settings, effects: enabled === true };
    persistSettings();
  }

  function setGameRunning(running) {
    gameRunning = running === true;
    syncMusic();
  }

  function playEffect(name, intensity = 1) {
    if (!settings.effects || context?.state !== "running") return false;
    const strength = Math.max(1, Math.min(4, Number(intensity) || 1));

    switch (name) {
      case "move":
        return playTone(220, 0.035, 0.018, "square");
      case "rotate":
        return playTone(329.63, 0.055, 0.026, "square");
      case "softDrop":
        return playTone(164.81, 0.025, 0.012, "triangle");
      case "lock":
        playTone(123.47, 0.08, 0.034, "square");
        return playTone(82.41, 0.1, 0.028, "triangle", 0.025);
      case "lineClear":
        playTone(523.25, 0.1, 0.04, "square");
        playTone(659.25, 0.1, 0.04, "square", 0.08);
        return playTone(783.99 + ((strength - 1) * 55), 0.16, 0.045, "square", 0.16);
      case "levelUp":
        playTone(523.25, 0.11, 0.04, "square");
        playTone(659.25, 0.11, 0.04, "square", 0.09);
        return playTone(1046.5, 0.2, 0.05, "square", 0.18);
      case "gameOver":
        playTone(392, 0.16, 0.04, "sawtooth");
        playTone(293.66, 0.18, 0.04, "sawtooth", 0.13);
        return playTone(196, 0.28, 0.045, "sawtooth", 0.28);
      case "start":
        playTone(329.63, 0.08, 0.035, "square");
        return playTone(493.88, 0.13, 0.04, "square", 0.08);
      default:
        return false;
    }
  }

  function destroy() {
    stopMusic();
    gameRunning = false;
    if (context && context.state !== "closed" && typeof context.close === "function") {
      void context.close();
    }
  }

  return {
    get settings() {
      return { ...settings };
    },
    isSupported() {
      return Boolean(options.audioContextFactory || globalThis.AudioContext || globalThis.webkitAudioContext);
    },
    unlock,
    setMusicEnabled,
    setEffectsEnabled,
    setGameRunning,
    playEffect,
    destroy,
  };
}

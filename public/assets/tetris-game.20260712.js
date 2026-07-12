import {
  BOARD_WIDTH,
  GAME_MODES,
  HIDDEN_ROWS,
  POWER_UP_CHARGE_LINES,
  POWER_UP_ENERGY_MAX,
  POWER_UPS,
  VISIBLE_BOARD_HEIGHT,
  canUsePowerUp,
  createGameState,
  getGhostPosition,
  getPieceCells,
  hardDrop,
  movePiece,
  restartGame,
  rotatePiece,
  setGameMode,
  softDrop,
  spawnPiece,
  startGame,
  tick,
  togglePause,
  usePowerUp,
} from "./tetris-core.20260712.js";
import { createTetrisAudio } from "./tetris-audio.20260712.js";

const BEST_SCORE_KEYS = Object.freeze({
  [GAME_MODES.CLASSIC]: "ai-build-lab.tetris-best-score.v1",
  [GAME_MODES.POWER_UP]: "ai-build-lab.tetris-best-score.powerup.v1",
});
const POWER_UP_MESSAGES = Object.freeze({
  [POWER_UPS.ROW_BLAST]: "Bottom occupied row cleared. No score or charge awarded.",
  [POWER_UPS.QUEUE_SHIFT]: "Next piece moved to the back of the queue.",
  [POWER_UPS.SLOW_TIME]: "Time slow active for 10 seconds.",
});
const COLORS = Object.freeze({
  I: "#65d8f3",
  J: "#6688f4",
  L: "#f3a75f",
  O: "#f4d35e",
  S: "#70d6a4",
  T: "#b68cf2",
  Z: "#f27878",
});

const app = document.querySelector("[data-tetris-game]");

if (app) {
  const boardCanvas = app.querySelector("[data-tetris-board]");
  const boardFrame = app.querySelector("[data-board-frame]");
  const nextCanvas = app.querySelector("[data-next-piece]");
  const startButton = app.querySelector('[data-game-action="start"]');
  const pauseButton = app.querySelector('[data-game-action="pause"]');
  const restartButton = app.querySelector('[data-game-action="restart"]');
  const modeButtons = app.querySelectorAll("[data-game-mode]");
  const powerUpPanel = app.querySelector("[data-power-up-panel]");
  const powerUpButtons = app.querySelectorAll("[data-power-up]");
  const chargeSegments = app.querySelectorAll("[data-charge-segment]");
  const audioButtons = app.querySelectorAll("[data-audio-toggle]");
  const touchButtons = app.querySelectorAll("[data-touch-action]");
  const announcement = app.querySelector("[data-tetris-announcement]");
  const formatter = new Intl.NumberFormat("en-US");
  const audio = createTetrisAudio();
  let state = createGameState();
  const bestScores = {
    [GAME_MODES.CLASSIC]: readBestScore(GAME_MODES.CLASSIC),
    [GAME_MODES.POWER_UP]: readBestScore(GAME_MODES.POWER_UP),
  };
  let previousTime = performance.now();
  let touchRepeatDelay = null;
  let touchRepeatTimer = null;
  let activeTouchButton = null;
  let powerEffectTimer = null;

  function readBestScore(mode) {
    try {
      const value = Number(localStorage.getItem(BEST_SCORE_KEYS[mode]));
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
      return 0;
    }
  }

  function writeBestScore(mode, value) {
    try {
      localStorage.setItem(BEST_SCORE_KEYS[mode], String(value));
    } catch {
      // Storage may be disabled; gameplay remains available without persistence.
    }
  }

  function announce(message) {
    announcement.textContent = "";
    window.setTimeout(() => {
      announcement.textContent = message;
    }, 20);
  }

  function resizeCanvas(canvas, aspectRatio) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round((rect.width / aspectRatio) * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function drawCell(context, x, y, size, color, options = {}) {
    const inset = Math.max(1, size * 0.065);
    context.save();
    context.globalAlpha = options.alpha ?? 1;
    context.fillStyle = color;
    context.strokeStyle = options.stroke || "rgba(255,255,255,0.34)";
    context.lineWidth = Math.max(1, size * 0.045);
    if (options.ghost) context.setLineDash([Math.max(2, size * 0.18), Math.max(2, size * 0.12)]);
    if (!options.ghost) {
      context.fillRect((x * size) + inset, (y * size) + inset, size - (inset * 2), size - (inset * 2));
    }
    context.strokeRect((x * size) + inset, (y * size) + inset, size - (inset * 2), size - (inset * 2));
    if (!options.ghost) {
      context.fillStyle = "rgba(255,255,255,0.18)";
      context.fillRect(
        (x * size) + (inset * 1.8),
        (y * size) + (inset * 1.8),
        size - (inset * 3.6),
        Math.max(1, size * 0.055),
      );
    }
    context.restore();
  }

  function drawBoard() {
    resizeCanvas(boardCanvas, 0.5);
    const context = boardCanvas.getContext("2d");
    const cellSize = boardCanvas.width / BOARD_WIDTH;
    context.clearRect(0, 0, boardCanvas.width, boardCanvas.height);
    context.fillStyle = "#03070c";
    context.fillRect(0, 0, boardCanvas.width, boardCanvas.height);

    context.strokeStyle = "rgba(121,217,248,0.055)";
    context.lineWidth = 1;
    for (let x = 1; x < BOARD_WIDTH; x += 1) {
      context.beginPath();
      context.moveTo(Math.round(x * cellSize) + 0.5, 0);
      context.lineTo(Math.round(x * cellSize) + 0.5, boardCanvas.height);
      context.stroke();
    }
    for (let y = 1; y < VISIBLE_BOARD_HEIGHT; y += 1) {
      context.beginPath();
      context.moveTo(0, Math.round(y * cellSize) + 0.5);
      context.lineTo(boardCanvas.width, Math.round(y * cellSize) + 0.5);
      context.stroke();
    }

    state.board.slice(HIDDEN_ROWS).forEach((row, y) => {
      row.forEach((type, x) => {
        if (type) drawCell(context, x, y, cellSize, COLORS[type]);
      });
    });

    if (state.status !== "gameover") {
      const ghost = getGhostPosition(state);
      getPieceCells(ghost).forEach(({ x, y }) => {
        if (y >= HIDDEN_ROWS) {
          drawCell(context, x, y - HIDDEN_ROWS, cellSize, COLORS[ghost.type], {
            alpha: 0.52,
            ghost: true,
            stroke: COLORS[ghost.type],
          });
        }
      });

      getPieceCells(state.active).forEach(({ x, y }) => {
        if (y >= HIDDEN_ROWS) drawCell(context, x, y - HIDDEN_ROWS, cellSize, COLORS[state.active.type]);
      });
    }
  }

  function drawNextPiece() {
    resizeCanvas(nextCanvas, 1);
    const context = nextCanvas.getContext("2d");
    context.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
    const type = state.queue[0];
    const cells = getPieceCells(spawnPiece(type));
    const minX = Math.min(...cells.map(({ x }) => x));
    const maxX = Math.max(...cells.map(({ x }) => x));
    const minY = Math.min(...cells.map(({ y }) => y));
    const maxY = Math.max(...cells.map(({ y }) => y));
    const cellSize = nextCanvas.width / 5;
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const offsetX = (5 - width) / 2;
    const offsetY = (5 - height) / 2;

    cells.forEach(({ x, y }) => {
      drawCell(context, (x - minX) + offsetX, (y - minY) + offsetY, cellSize, COLORS[type]);
    });
    nextCanvas.setAttribute("aria-label", `Next piece: ${type}`);
  }

  function statusContent(status) {
    if (status === "running") {
      return { label: "Playing", kicker: "Playing", title: "Game in progress", message: "Use the keyboard or touch controls to move the piece." };
    }
    if (status === "paused") {
      return { label: "Paused", kicker: "Paused", title: "Game paused", message: "Press P or select Resume to continue." };
    }
    if (status === "gameover") {
      return { label: "Game over", kicker: "Game over", title: "Game over", message: "Select Restart to play again, or choose another mode." };
    }
    const message = state.mode === GAME_MODES.POWER_UP
      ? "Select Start game, clear four natural lines to charge one power-up."
      : "Select Start game, then use the keyboard or touch controls.";
    return { label: "Ready", kicker: "Ready", title: "Ready to play", message };
  }

  function syncBestScore() {
    if (state.score <= bestScores[state.mode]) return;
    bestScores[state.mode] = state.score;
    writeBestScore(state.mode, state.score);
  }

  function renderAudioControls() {
    const settings = audio.settings;
    audioButtons.forEach((button) => {
      const enabled = settings[button.dataset.audioToggle] === true;
      button.setAttribute("aria-pressed", String(enabled));
      button.querySelector("[data-audio-state]").textContent = enabled ? "On" : "Off";
    });
  }

  function renderModeControls() {
    const locked = state.status === "running" || state.status === "paused";
    modeButtons.forEach((button) => {
      const selected = button.dataset.gameMode === state.mode;
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = locked;
    });
  }

  function renderPowerUpControls() {
    const isPowerUpMode = state.mode === GAME_MODES.POWER_UP;
    powerUpPanel.hidden = !isPowerUpMode;
    if (!isPowerUpMode) return;

    const atMaximum = state.energy >= POWER_UP_ENERGY_MAX;
    app.querySelector("[data-energy]").textContent = `${state.energy} / ${POWER_UP_ENERGY_MAX}`;
    app.querySelector("[data-charge-label]").textContent = atMaximum
      ? "Energy full"
      : `${state.chargeProgress} / ${POWER_UP_CHARGE_LINES} lines`;
    chargeSegments.forEach((segment, index) => {
      segment.classList.toggle("is-filled", atMaximum || index < state.chargeProgress);
    });

    powerUpButtons.forEach((button) => {
      const powerUpType = button.dataset.powerUp;
      button.disabled = !canUsePowerUp(state, powerUpType);
      if (powerUpType === POWER_UPS.SLOW_TIME) {
        const seconds = Math.max(0, state.slowRemainingMs / 1000);
        button.querySelector("[data-power-state]").textContent = seconds > 0
          ? `Active ${seconds.toFixed(1)}s`
          : "10 seconds";
      }
    });
  }

  async function prepareAudio() {
    const settings = audio.settings;
    if (!settings.music && !settings.effects) return true;
    return await audio.unlock();
  }

  function render() {
    syncBestScore();
    audio.setGameRunning(state.status === "running");
    app.dataset.state = state.status;
    app.dataset.mode = state.mode;
    app.querySelector("[data-score]").textContent = formatter.format(state.score);
    app.querySelector("[data-best-score]").textContent = formatter.format(bestScores[state.mode]);
    app.querySelector("[data-level]").textContent = formatter.format(state.level);
    app.querySelector("[data-lines]").textContent = formatter.format(state.lines);

    const content = statusContent(state.status);
    app.querySelector("[data-status-label]").textContent = content.label;
    app.querySelector("[data-overlay-kicker]").textContent = content.kicker;
    app.querySelector("[data-overlay-title]").textContent = content.title;
    app.querySelector("[data-overlay-message]").textContent = content.message;
    startButton.disabled = state.status !== "ready";
    pauseButton.disabled = state.status !== "running" && state.status !== "paused";
    pauseButton.textContent = state.status === "paused" ? "Resume" : "Pause";
    boardCanvas.setAttribute(
      "aria-label",
      `Tetris board, ${state.mode === GAME_MODES.POWER_UP ? "power-up" : "classic"} mode, ${content.label}, score ${state.score}, level ${state.level}, ${state.lines} lines cleared`,
    );
    drawBoard();
    drawNextPiece();
    renderModeControls();
    renderPowerUpControls();
    renderAudioControls();
  }

  function showPowerEffect(powerUpType, message) {
    window.clearTimeout(powerEffectTimer);
    boardFrame.dataset.powerEffect = powerUpType;
    app.querySelector("[data-power-feedback]").textContent = message;
    powerEffectTimer = window.setTimeout(() => {
      delete boardFrame.dataset.powerEffect;
    }, 220);
  }

  function applyState(next, message, options = {}) {
    const previous = state;
    state = next;
    render();

    if (options.effect) {
      audio.playEffect(options.effect);
      showPowerEffect(options.effect, message);
    } else if (!options.skipAutoEffect) {
      if (state.status === "gameover" && previous.status !== "gameover") {
        audio.playEffect("gameOver");
      } else if (state.level > previous.level) {
        audio.playEffect("levelUp");
      } else if (state.lines > previous.lines) {
        audio.playEffect("lineClear", state.lines - previous.lines);
      } else if (state.board !== previous.board) {
        audio.playEffect("lock");
      }
    }

    if (message) announce(message);
    else if (state.status === "gameover" && previous.status !== "gameover") {
      announce(`Game over. Final score: ${state.score}.`);
    } else if (state.level > previous.level) {
      announce(`Level ${state.level} reached.`);
    } else if (state.lines > previous.lines) {
      announce(`${state.lines - previous.lines} lines cleared. Current score: ${state.score}.`);
    }
  }

  async function restart() {
    await prepareAudio();
    applyState(restartGame(Math.random, state.mode), "New game started.", { skipAutoEffect: true });
    audio.playEffect("start");
    previousTime = performance.now();
    boardCanvas.focus();
  }

  startButton.addEventListener("click", async () => {
    await prepareAudio();
    applyState(startGame(state), "Game started.");
    audio.playEffect("start");
    previousTime = performance.now();
    boardCanvas.focus();
  });

  pauseButton.addEventListener("click", () => {
    const next = togglePause(state);
    applyState(next, next.status === "paused" ? "Game paused." : "Game resumed.");
    previousTime = performance.now();
    boardCanvas.focus();
  });

  restartButton.addEventListener("click", restart);

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const next = setGameMode(state, button.dataset.gameMode);
      if (next === state) return;
      const label = next.mode === GAME_MODES.POWER_UP ? "Power-up mode" : "Classic mode";
      applyState(next, `${label} selected. Select Start game when ready.`, { skipAutoEffect: true });
      previousTime = performance.now();
    });
  });

  audioButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const setting = button.dataset.audioToggle;
      const enabled = audio.settings[setting] !== true;
      if (setting === "music") audio.setMusicEnabled(enabled);
      else audio.setEffectsEnabled(enabled);

      if (enabled && !(await audio.unlock())) {
        if (setting === "music") audio.setMusicEnabled(false);
        else audio.setEffectsEnabled(false);
        announce("Audio is unavailable in this browser.");
      } else {
        announce(`${setting === "music" ? "Background music" : "Sound effects"} ${enabled ? "enabled" : "disabled"}.`);
      }
      renderAudioControls();
      if (state.status === "running") boardCanvas.focus();
    });
  });

  function performPlayerAction(action) {
    let next = state;
    let effect = null;

    switch (action) {
      case "left":
        next = movePiece(state, -1);
        effect = "move";
        break;
      case "right":
        next = movePiece(state, 1);
        effect = "move";
        break;
      case "softDrop":
        next = softDrop(state);
        effect = "softDrop";
        break;
      case "rotateRight":
        next = rotatePiece(state, 1);
        effect = "rotate";
        break;
      case "rotateLeft":
        next = rotatePiece(state, -1);
        effect = "rotate";
        break;
      case "hardDrop":
        next = hardDrop(state);
        break;
      default:
        return false;
    }

    if (next === state) return false;
    applyState(next);
    if (effect) audio.playEffect(effect);
    return true;
  }

  function performPowerUp(powerUpType) {
    const next = usePowerUp(state, powerUpType);
    if (next === state) return false;
    const message = POWER_UP_MESSAGES[powerUpType];
    applyState(next, message, { effect: powerUpType });
    boardCanvas.focus();
    return true;
  }

  powerUpButtons.forEach((button) => {
    button.addEventListener("click", () => performPowerUp(button.dataset.powerUp));
  });

  function stopTouchRepeat() {
    window.clearTimeout(touchRepeatDelay);
    window.clearInterval(touchRepeatTimer);
    touchRepeatDelay = null;
    touchRepeatTimer = null;
    activeTouchButton?.classList.remove("is-pressed");
    activeTouchButton = null;
  }

  function startTouchAction(button, event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    stopTouchRepeat();
    activeTouchButton = button;
    button.classList.add("is-pressed");
    const action = button.dataset.touchAction;
    performPlayerAction(action);

    if (["left", "right", "softDrop"].includes(action)) {
      touchRepeatDelay = window.setTimeout(() => {
        touchRepeatTimer = window.setInterval(() => performPlayerAction(action), 75);
      }, 180);
    }

    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional; release handlers still stop repetition.
    }
  }

  touchButtons.forEach((button) => {
    button.addEventListener("pointerdown", (event) => startTouchAction(button, event));
    button.addEventListener("pointerup", stopTouchRepeat);
    button.addEventListener("pointercancel", stopTouchRepeat);
    button.addEventListener("lostpointercapture", stopTouchRepeat);
    button.addEventListener("click", (event) => {
      if (event.detail === 0) performPlayerAction(button.dataset.touchAction);
    });
  });

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("a, button, input, textarea, select")) return;
    let action = null;
    let powerUpType = null;
    let handled = true;

    switch (event.code) {
      case "ArrowLeft":
        action = "left";
        break;
      case "ArrowRight":
        action = "right";
        break;
      case "ArrowDown":
        action = "softDrop";
        break;
      case "ArrowUp":
      case "KeyX":
        if (!event.repeat) action = "rotateRight";
        break;
      case "KeyZ":
        if (!event.repeat) action = "rotateLeft";
        break;
      case "Space":
        if (!event.repeat) action = "hardDrop";
        break;
      case "Digit1":
      case "Numpad1":
        if (!event.repeat) powerUpType = POWER_UPS.ROW_BLAST;
        break;
      case "Digit2":
      case "Numpad2":
        if (!event.repeat) powerUpType = POWER_UPS.QUEUE_SHIFT;
        break;
      case "Digit3":
      case "Numpad3":
        if (!event.repeat) powerUpType = POWER_UPS.SLOW_TIME;
        break;
      case "KeyP":
        if (!event.repeat) {
          const next = togglePause(state);
          applyState(next, next.status === "paused" ? "Game paused." : "Game resumed.");
          previousTime = performance.now();
        }
        break;
      case "KeyR":
        if (!event.repeat) void restart();
        break;
      default:
        handled = false;
    }

    if (!handled) return;
    event.preventDefault();
    if (action) performPlayerAction(action);
    if (powerUpType) performPowerUp(powerUpType);
  });

  document.addEventListener("visibilitychange", () => {
    stopTouchRepeat();
    if (document.hidden && state.status === "running") {
      applyState(togglePause(state), "The page moved to the background, so the game was paused automatically.");
    }
    previousTime = performance.now();
  });

  window.addEventListener("resize", () => {
    window.requestAnimationFrame(render);
  });

  window.addEventListener("pagehide", () => {
    stopTouchRepeat();
    window.clearTimeout(powerEffectTimer);
    audio.destroy();
  }, { once: true });

  function frame(time) {
    const elapsed = Math.min(Math.max(time - previousTime, 0), 250);
    previousTime = time;
    const previous = state;
    const next = tick(state, elapsed);
    const slowDisplayChanged = Math.ceil(next.slowRemainingMs / 100) !== Math.ceil(previous.slowRemainingMs / 100);
    if (
      next.active !== previous.active
      || next.board !== previous.board
      || next.score !== previous.score
      || next.status !== previous.status
    ) {
      applyState(next);
    } else {
      state = next;
      if (slowDisplayChanged) renderPowerUpControls();
    }
    window.requestAnimationFrame(frame);
  }

  render();
  window.requestAnimationFrame(frame);
}

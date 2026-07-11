import {
  BOARD_WIDTH,
  HIDDEN_ROWS,
  VISIBLE_BOARD_HEIGHT,
  createGameState,
  getGhostPosition,
  getPieceCells,
  hardDrop,
  movePiece,
  restartGame,
  rotatePiece,
  softDrop,
  spawnPiece,
  startGame,
  tick,
  togglePause,
} from "./tetris-core.20260711.js";
import { createTetrisAudio } from "./tetris-audio.20260711.js";

const BEST_SCORE_KEY = "ai-build-lab.tetris-best-score.v1";
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
  const nextCanvas = app.querySelector("[data-next-piece]");
  const startButton = app.querySelector('[data-game-action="start"]');
  const pauseButton = app.querySelector('[data-game-action="pause"]');
  const restartButton = app.querySelector('[data-game-action="restart"]');
  const audioButtons = app.querySelectorAll("[data-audio-toggle]");
  const touchButtons = app.querySelectorAll("[data-touch-action]");
  const announcement = app.querySelector("[data-tetris-announcement]");
  const formatter = new Intl.NumberFormat("zh-CN");
  const audio = createTetrisAudio();
  let state = createGameState();
  let bestScore = readBestScore();
  let previousTime = performance.now();
  let touchRepeatDelay = null;
  let touchRepeatTimer = null;
  let activeTouchButton = null;

  function readBestScore() {
    try {
      const value = Number(localStorage.getItem(BEST_SCORE_KEY));
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
      return 0;
    }
  }

  function writeBestScore(value) {
    try {
      localStorage.setItem(BEST_SCORE_KEY, String(value));
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
    if (!options.ghost) context.fillRect((x * size) + inset, (y * size) + inset, size - (inset * 2), size - (inset * 2));
    context.strokeRect((x * size) + inset, (y * size) + inset, size - (inset * 2), size - (inset * 2));
    if (!options.ghost) {
      context.fillStyle = "rgba(255,255,255,0.18)";
      context.fillRect((x * size) + (inset * 1.8), (y * size) + (inset * 1.8), size - (inset * 3.6), Math.max(1, size * 0.055));
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
    if (status === "running") return { label: "Playing", kicker: "Playing", title: "Game in progress", message: "Use the keyboard or touch controls to move the piece." };
    if (status === "paused") return { label: "Paused", kicker: "Paused", title: "Game paused", message: "Press P or select Resume to continue." };
    if (status === "gameover") return { label: "Game over", kicker: "Game over", title: "Game over", message: "Select Restart to play again." };
    return { label: "Ready", kicker: "Ready", title: "Ready to play", message: "Select Start game, then use the keyboard or touch controls." };
  }

  function syncBestScore() {
    if (state.score <= bestScore) return;
    bestScore = state.score;
    writeBestScore(bestScore);
  }

  function renderAudioControls() {
    const settings = audio.settings;
    audioButtons.forEach((button) => {
      const enabled = settings[button.dataset.audioToggle] === true;
      button.setAttribute("aria-pressed", String(enabled));
      button.querySelector("[data-audio-state]").textContent = enabled ? "On" : "Off";
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
    app.querySelector("[data-score]").textContent = formatter.format(state.score);
    app.querySelector("[data-best-score]").textContent = formatter.format(bestScore);
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
      `Tetris board, ${content.label}, score ${state.score}, level ${state.level}, ${state.lines} lines cleared`,
    );
    drawBoard();
    drawNextPiece();
    renderAudioControls();
  }

  function applyState(next, message) {
    const previous = state;
    state = next;
    render();

    if (state.status === "gameover" && previous.status !== "gameover") {
      audio.playEffect("gameOver");
    } else if (state.level > previous.level) {
      audio.playEffect("levelUp");
    } else if (state.lines > previous.lines) {
      audio.playEffect("lineClear", state.lines - previous.lines);
    } else if (state.board !== previous.board) {
      audio.playEffect("lock");
    }

    if (message) announce(message);
    else if (state.status === "gameover" && previous.status !== "gameover") announce(`Game over. Final score: ${state.score}.`);
    else if (state.level > previous.level) announce(`Level ${state.level} reached.`);
    else if (state.lines > previous.lines) announce(`${state.lines - previous.lines} lines cleared. Current score: ${state.score}.`);
  }

  async function restart() {
    await prepareAudio();
    applyState(restartGame(), "New game started.");
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
    audio.destroy();
  }, { once: true });

  function frame(time) {
    const elapsed = Math.min(Math.max(time - previousTime, 0), 250);
    previousTime = time;
    const previous = state;
    const next = tick(state, elapsed);
    if (
      next.active !== previous.active ||
      next.board !== previous.board ||
      next.score !== previous.score ||
      next.status !== previous.status
    ) {
      applyState(next);
    } else {
      state = next;
    }
    window.requestAnimationFrame(frame);
  }

  render();
  window.requestAnimationFrame(frame);
}

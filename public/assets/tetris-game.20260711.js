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
  const announcement = app.querySelector("[data-tetris-announcement]");
  const formatter = new Intl.NumberFormat("zh-CN");
  const audio = createTetrisAudio();
  let state = createGameState();
  let bestScore = readBestScore();
  let previousTime = performance.now();

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
    nextCanvas.setAttribute("aria-label", `下一块：${type}`);
  }

  function statusContent(status) {
    if (status === "running") return { label: "游戏进行中", kicker: "Playing", title: "游戏进行中", message: "使用键盘控制方块。" };
    if (status === "paused") return { label: "已暂停", kicker: "Paused", title: "游戏已暂停", message: "按 P 或点击继续游戏。" };
    if (status === "gameover") return { label: "游戏结束", kicker: "Game over", title: "游戏结束", message: "点击重新开始，再挑战一次。" };
    return { label: "等待开始", kicker: "Ready", title: "准备开始", message: "点击下方按钮，然后使用键盘控制方块。" };
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
      button.querySelector("[data-audio-state]").textContent = enabled ? "开启" : "关闭";
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
    pauseButton.textContent = state.status === "paused" ? "继续游戏" : "暂停";
    boardCanvas.setAttribute(
      "aria-label",
      `俄罗斯方块棋盘，${content.label}，得分 ${state.score}，等级 ${state.level}，已消除 ${state.lines} 行`,
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
    else if (state.status === "gameover" && previous.status !== "gameover") announce(`游戏结束，最终得分 ${state.score}。`);
    else if (state.level > previous.level) announce(`升级到第 ${state.level} 级。`);
    else if (state.lines > previous.lines) announce(`消除了 ${state.lines - previous.lines} 行，当前得分 ${state.score}。`);
  }

  async function restart() {
    await prepareAudio();
    applyState(restartGame(), "新游戏已开始。");
    audio.playEffect("start");
    previousTime = performance.now();
    boardCanvas.focus();
  }

  startButton.addEventListener("click", async () => {
    await prepareAudio();
    applyState(startGame(state), "游戏开始。");
    audio.playEffect("start");
    previousTime = performance.now();
    boardCanvas.focus();
  });

  pauseButton.addEventListener("click", () => {
    const next = togglePause(state);
    applyState(next, next.status === "paused" ? "游戏已暂停。" : "游戏继续。");
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
        announce("当前浏览器无法启用音频。");
      } else {
        announce(`${setting === "music" ? "背景音乐" : "操作音效"}已${enabled ? "开启" : "关闭"}。`);
      }
      renderAudioControls();
      if (state.status === "running") boardCanvas.focus();
    });
  });

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("a, button, input, textarea, select")) return;
    let next = state;
    let handled = true;
    let effect = null;

    switch (event.code) {
      case "ArrowLeft":
        next = movePiece(state, -1);
        effect = "move";
        break;
      case "ArrowRight":
        next = movePiece(state, 1);
        effect = "move";
        break;
      case "ArrowDown":
        next = softDrop(state);
        effect = "softDrop";
        break;
      case "ArrowUp":
      case "KeyX":
        if (!event.repeat) next = rotatePiece(state, 1);
        effect = "rotate";
        break;
      case "KeyZ":
        if (!event.repeat) next = rotatePiece(state, -1);
        effect = "rotate";
        break;
      case "Space":
        if (!event.repeat) next = hardDrop(state);
        break;
      case "KeyP":
        if (!event.repeat) next = togglePause(state);
        break;
      case "KeyR":
        if (!event.repeat) void restart();
        break;
      default:
        handled = false;
    }

    if (!handled) return;
    event.preventDefault();
    if (event.code !== "KeyR" && next !== state) {
      applyState(next);
      if (effect) audio.playEffect(effect);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.status === "running") {
      applyState(togglePause(state), "页面进入后台，游戏已自动暂停。");
    }
    previousTime = performance.now();
  });

  window.addEventListener("resize", () => {
    window.requestAnimationFrame(render);
  });

  window.addEventListener("pagehide", () => audio.destroy(), { once: true });

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

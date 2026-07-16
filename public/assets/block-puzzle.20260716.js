import {
  PUZZLE_CHARGE_CLEARS,
  PUZZLE_POWER_UPS,
  clearPuzzlePowerUpNotice,
  createPuzzleState,
  getValidPlacements,
  placePuzzlePiece,
  restartPuzzle,
  selectPuzzlePiece,
  startPuzzle,
  togglePuzzlePause,
} from "./block-puzzle-core.20260716.js";

const BEST_SCORE_KEY = "ai-build-lab.block-puzzle-best-score.v1";
const POWER_NOTICE_MS = 2500;
const BOARD_EFFECT_MS = 220;
const POWER_MESSAGES = Object.freeze({
  [PUZZLE_POWER_UPS.LINE_SWEEP]: {
    title: "Line sweep activated",
    message: "The fullest row or column was cleared.",
  },
  [PUZZLE_POWER_UPS.TRAY_REFRESH]: {
    title: "Tray refresh activated",
    message: "Your remaining blocks were redrawn.",
  },
  [PUZZLE_POWER_UPS.AREA_BLAST]: {
    title: "Area blast activated",
    message: "The most crowded 3×3 area was cleared.",
  },
});

const app = document.querySelector("[data-block-puzzle]");

if (app) {
  const board = app.querySelector("[data-puzzle-board]");
  const boardFrame = app.querySelector("[data-board-frame]");
  const tray = app.querySelector("[data-puzzle-tray]");
  const overlayPrimary = app.querySelector("[data-overlay-primary]");
  const overlayRestart = app.querySelector("[data-overlay-restart]");
  const overlayExit = app.querySelector("[data-overlay-exit]");
  const pauseButton = app.querySelector('[data-action="pause"]');
  const exitButton = app.querySelector('[data-action="exit"]');
  const announcement = app.querySelector("[data-announcement]");
  const formatter = new Intl.NumberFormat("en-US");
  const cellButtons = [];
  let state = createPuzzleState();
  let bestScore = readBestScore();
  let savedScrollY = 0;
  let powerNoticeTimer = null;
  let boardEffectTimer = null;

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
      // The game remains fully playable if storage is unavailable.
    }
  }

  function announce(message) {
    announcement.textContent = "";
    window.setTimeout(() => {
      announcement.textContent = message;
    }, 20);
  }

  function buildBoard() {
    const fragment = document.createDocumentFragment();
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const button = document.createElement("button");
        button.className = "puzzle-cell";
        button.type = "button";
        button.dataset.row = String(row);
        button.dataset.column = String(column);
        button.setAttribute("role", "gridcell");
        button.addEventListener("click", () => placeAt(row, column));
        fragment.append(button);
        cellButtons.push(button);
      }
    }
    board.append(fragment);
  }

  function validPlacementKeys() {
    const selected = state.tray.find((piece) => piece.id === state.selectedPieceId);
    if (!selected) return new Set();
    return new Set(getValidPlacements(state.board, selected).map(({ row, column }) => `${row}:${column}`));
  }

  function renderBoard() {
    const valid = validPlacementKeys();
    cellButtons.forEach((button) => {
      const row = Number(button.dataset.row);
      const column = Number(button.dataset.column);
      const color = state.board[row][column];
      const isValid = valid.has(`${row}:${column}`);
      if (color) button.dataset.color = color;
      else delete button.dataset.color;
      button.classList.toggle("is-valid", isValid);
      button.disabled = state.status !== "running" || !isValid;
      const content = color ? `${color} block` : "empty";
      const action = isValid ? ", valid placement" : "";
      button.setAttribute("aria-label", `Row ${row + 1}, column ${column + 1}, ${content}${action}`);
    });
  }

  function piecePreview(piece) {
    const preview = document.createElement("span");
    preview.className = "piece-preview";
    preview.setAttribute("aria-hidden", "true");
    const maximumColumn = Math.max(...piece.cells.map((cell) => cell.column));
    const maximumRow = Math.max(...piece.cells.map((cell) => cell.row));
    const offsetColumn = Math.floor((3 - maximumColumn) / 2);
    const offsetRow = Math.floor((3 - maximumRow) / 2);
    const filled = new Map(piece.cells.map((cell) => [
      `${cell.row + offsetRow}:${cell.column + offsetColumn}`,
      piece.color,
    ]));
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const cell = document.createElement("span");
        const color = filled.get(`${row}:${column}`);
        if (color) cell.dataset.color = color;
        preview.append(cell);
      }
    }
    return preview;
  }

  function renderTray() {
    tray.replaceChildren();
    state.tray.forEach((piece, index) => {
      const button = document.createElement("button");
      button.className = "tray-piece";
      button.type = "button";
      button.dataset.pieceId = piece.id;
      button.setAttribute("aria-pressed", String(state.selectedPieceId === piece.id));
      button.setAttribute("aria-label", `Block ${index + 1}, ${piece.cells.length} cells`);
      button.disabled = state.status !== "running" || getValidPlacements(state.board, piece).length === 0;
      button.append(piecePreview(piece));
      button.addEventListener("click", () => {
        applyState(selectPuzzlePiece(state, piece.id));
        if (state.selectedPieceId === piece.id) announce(`Block ${index + 1} selected. Valid positions are highlighted.`);
      });
      tray.append(button);
    });
  }

  function overlayContent() {
    if (state.status === "paused") {
      return {
        kicker: "Paused",
        title: "Take your time",
        message: "Your puzzle is safe. Resume whenever you are ready.",
        primary: "Resume game",
        restart: "Restart game",
        exit: "Exit game",
      };
    }
    if (state.status === "gameover") {
      return {
        kicker: "No moves left",
        title: "Puzzle complete",
        message: `Final score ${formatter.format(state.score)}. Try a new board and beat your best.`,
        primary: "Play again",
        restart: null,
        exit: "Exit game",
      };
    }
    return {
      kicker: "Mobile-first",
      title: "Ready to play?",
      message: "Select a block, then tap a highlighted space on the grid.",
      primary: "Start game",
      restart: null,
      exit: null,
    };
  }

  function renderOverlay() {
    const content = overlayContent();
    app.querySelector("[data-overlay-kicker]").textContent = content.kicker;
    app.querySelector("[data-overlay-title]").textContent = content.title;
    app.querySelector("[data-overlay-message]").textContent = content.message;
    overlayPrimary.textContent = content.primary;
    overlayRestart.hidden = !content.restart;
    overlayRestart.textContent = content.restart || "";
    overlayExit.hidden = !content.exit;
    overlayExit.textContent = content.exit || "";
  }

  function renderPowerStatus() {
    const message = state.lastPowerUp ? POWER_MESSAGES[state.lastPowerUp] : null;
    const status = app.querySelector("[data-power-status]");
    status.toggleAttribute("data-effect", Boolean(message));
    app.querySelector("[data-power-kicker]").textContent = message ? "Using power-up" : "Automatic rescue";
    app.querySelector("[data-power-title]").textContent = message ? message.title : "Charging power-up";
    app.querySelector("[data-power-message]").textContent = message
      ? message.message
      : "Clear four rows or columns to trigger one.";
    app.querySelector("[data-charge-label]").textContent = `${state.chargeProgress} / ${PUZZLE_CHARGE_CLEARS}`;
    app.querySelector(".power-charge").setAttribute(
      "aria-label",
      `Power-up charge: ${state.chargeProgress} of ${PUZZLE_CHARGE_CLEARS}`,
    );
    app.querySelectorAll("[data-charge-segment]").forEach((segment, index) => {
      segment.classList.toggle("is-filled", index < state.chargeProgress);
    });
  }

  function render() {
    app.dataset.state = state.status;
    app.querySelector("[data-score]").textContent = formatter.format(state.score);
    app.querySelector("[data-best-score]").textContent = formatter.format(bestScore);
    app.querySelector("[data-combo]").textContent = `×${state.combo}`;
    app.querySelector("[data-status-label]").textContent = {
      ready: "Ready",
      running: "Playing",
      paused: "Paused",
      gameover: "Game over",
    }[state.status];
    pauseButton.disabled = !["running", "paused"].includes(state.status);
    pauseButton.setAttribute("aria-label", state.status === "paused" ? "Resume game" : "Pause game");
    exitButton.disabled = state.status === "ready";
    renderBoard();
    renderTray();
    renderOverlay();
    renderPowerStatus();
  }

  function showPowerEffect(powerUpType) {
    window.clearTimeout(boardEffectTimer);
    boardFrame.dataset.powerEffect = powerUpType;
    boardEffectTimer = window.setTimeout(() => {
      delete boardFrame.dataset.powerEffect;
    }, BOARD_EFFECT_MS);

    window.clearTimeout(powerNoticeTimer);
    powerNoticeTimer = window.setTimeout(() => {
      applyState(clearPuzzlePowerUpNotice(state));
    }, POWER_NOTICE_MS);
  }

  function applyState(next, message) {
    if (next === state) return false;
    const previousPowerUp = state.lastPowerUp;
    state = next;
    if (state.score > bestScore) {
      bestScore = state.score;
      writeBestScore(bestScore);
    }
    render();
    if (state.lastPowerUp && state.lastPowerUp !== previousPowerUp) {
      const power = POWER_MESSAGES[state.lastPowerUp];
      showPowerEffect(state.lastPowerUp);
      announce(`${power.title}. ${power.message}`);
    } else if (message) announce(message);
    return true;
  }

  function placeAt(row, column) {
    const previousScore = state.score;
    const previousClears = state.clearedLines;
    const next = placePuzzlePiece(state, row, column);
    if (next === state) return;
    const cleared = next.clearedLines - previousClears;
    const gained = next.score - previousScore;
    applyState(next, cleared > 0
      ? `${cleared} ${cleared === 1 ? "line" : "lines"} cleared. ${gained} points gained.`
      : `${gained} points gained.`);
  }

  function enterImmersive() {
    if (document.body.classList.contains("is-puzzle-immersive")) return;
    savedScrollY = window.scrollY;
    window.scrollTo(0, 0);
    document.body.classList.add("is-puzzle-immersive");
  }

  function leaveImmersive() {
    if (!document.body.classList.contains("is-puzzle-immersive")) return;
    document.body.classList.remove("is-puzzle-immersive");
    window.scrollTo(0, savedScrollY);
  }

  function startOrResume() {
    if (state.status === "ready") applyState(startPuzzle(state), "Game started. Choose a block.");
    else if (state.status === "paused") applyState(togglePuzzlePause(state), "Game resumed.");
    else if (state.status === "gameover") applyState(restartPuzzle(), "New game started.");
    enterImmersive();
  }

  function pauseOrResume() {
    if (!["running", "paused"].includes(state.status)) return;
    const message = state.status === "running" ? "Game paused." : "Game resumed.";
    applyState(togglePuzzlePause(state), message);
  }

  function restartGame() {
    applyState(restartPuzzle(), "New game started.");
    enterImmersive();
  }

  function exitGame() {
    if (state.status === "running") applyState(togglePuzzlePause(state), "Game paused.");
    leaveImmersive();
  }

  buildBoard();
  render();

  overlayPrimary.addEventListener("click", startOrResume);
  overlayRestart.addEventListener("click", restartGame);
  overlayExit.addEventListener("click", exitGame);
  pauseButton.addEventListener("click", pauseOrResume);
  exitButton.addEventListener("click", exitGame);

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Escape") return;
    if (state.status === "running" || state.status === "paused") {
      event.preventDefault();
      pauseOrResume();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.status === "running") applyState(togglePuzzlePause(state), "Game paused while hidden.");
  });

  window.addEventListener("pagehide", () => {
    window.clearTimeout(powerNoticeTimer);
    window.clearTimeout(boardEffectTimer);
  });

}

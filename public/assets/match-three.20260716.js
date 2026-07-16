import {
  MATCH_THREE_BOARD_SIZE,
  MATCH_THREE_POWER_UPS,
  clearMatchPowerNotice,
  createMatchThreeState,
  restartMatchThree,
  selectMatchGem,
  startMatchThree,
  swapMatchGems,
  toggleMatchThreePause,
} from "./match-three-core.20260716.js";

const BEST_SCORE_KEY = "ai-build-lab.match-three-best-score.v1";
const POWER_NOTICE_MS = 2500;
const BOARD_FEEDBACK_MS = 220;
const SWIPE_THRESHOLD_PX = 18;

const GEM_LABELS = Object.freeze({
  rose: "Rose circle",
  violet: "Violet diamond",
  amber: "Amber hexagon",
  cyan: "Cyan square",
  mint: "Mint leaf",
  coral: "Coral star",
});

const POWER_MESSAGES = Object.freeze({
  [MATCH_THREE_POWER_UPS.ROW_ROCKET]: {
    created: ["Row rocket ready", "Match it or swap it to clear a full row."],
    triggered: ["Row rocket fired", "A full row was cleared."],
  },
  [MATCH_THREE_POWER_UPS.COLUMN_ROCKET]: {
    created: ["Column rocket ready", "Match it or swap it to clear a full column."],
    triggered: ["Column rocket fired", "A full column was cleared."],
  },
  [MATCH_THREE_POWER_UPS.RAINBOW]: {
    created: ["Rainbow gem ready", "Swap it with a gem to clear that color."],
    triggered: ["Rainbow burst", "Every matching color was cleared."],
  },
  [MATCH_THREE_POWER_UPS.BOMB]: {
    created: ["Blast gem ready", "Match it or swap it for a 3 by 3 blast."],
    triggered: ["Blast gem fired", "The surrounding area was cleared."],
  },
});

function readBestScore() {
  try {
    const value = Number(window.localStorage.getItem(BEST_SCORE_KEY));
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function writeBestScore(score) {
  try {
    window.localStorage.setItem(BEST_SCORE_KEY, String(score));
  } catch {
    // The game remains fully playable when storage is unavailable.
  }
}

function inside(row, column) {
  return row >= 0 && row < MATCH_THREE_BOARD_SIZE && column >= 0 && column < MATCH_THREE_BOARD_SIZE;
}

for (const app of document.querySelectorAll("[data-match-three]")) {
  let state = createMatchThreeState();
  let bestScore = readBestScore();
  let savedScrollY = 0;
  let pointerStart = null;
  let suppressClick = false;
  let powerNoticeTimer = 0;
  let boardFeedbackTimer = 0;

  const board = app.querySelector("[data-match-board]");
  const boardFrame = app.querySelector("[data-board-frame]");
  const announcement = app.querySelector("[data-announcement]");
  const pauseButton = app.querySelector('[data-action="pause"]');
  const exitButton = app.querySelector('[data-action="exit"]');
  const overlayPrimary = app.querySelector("[data-overlay-primary]");
  const overlayRestart = app.querySelector("[data-overlay-restart]");
  const overlayExit = app.querySelector("[data-overlay-exit]");
  const formatter = new Intl.NumberFormat("en-US");

  function announce(message) {
    announcement.textContent = "";
    window.requestAnimationFrame(() => {
      announcement.textContent = message;
    });
  }

  function buildBoard() {
    const fragment = document.createDocumentFragment();
    for (let row = 0; row < MATCH_THREE_BOARD_SIZE; row += 1) {
      for (let column = 0; column < MATCH_THREE_BOARD_SIZE; column += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "match-cell";
        button.dataset.row = String(row);
        button.dataset.column = String(column);
        button.setAttribute("role", "gridcell");
        button.innerHTML = '<span class="gem-token" aria-hidden="true"><span class="gem-shine"></span></span>';
        fragment.append(button);
      }
    }
    board.append(fragment);
  }

  function powerLabel(powerUp) {
    return {
      [MATCH_THREE_POWER_UPS.ROW_ROCKET]: "row rocket",
      [MATCH_THREE_POWER_UPS.COLUMN_ROCKET]: "column rocket",
      [MATCH_THREE_POWER_UPS.RAINBOW]: "rainbow gem",
      [MATCH_THREE_POWER_UPS.BOMB]: "blast gem",
    }[powerUp] || "";
  }

  function renderBoard(previousBoard = null) {
    board.querySelectorAll(".match-cell").forEach((button, index) => {
      const row = Math.floor(index / MATCH_THREE_BOARD_SIZE);
      const column = index % MATCH_THREE_BOARD_SIZE;
      const cell = state.board[row][column];
      const previousCell = previousBoard?.[row]?.[column];
      const selected = state.selectedGem?.row === row && state.selectedGem?.column === column;
      button.dataset.gem = cell.type;
      if (cell.powerUp) button.dataset.powerUp = cell.powerUp;
      else delete button.dataset.powerUp;
      button.classList.toggle("is-selected", selected);
      button.classList.remove("is-settling");
      if (previousBoard && previousCell?.id !== cell.id) {
        void button.offsetWidth;
        button.classList.add("is-settling");
      }
      button.setAttribute("aria-selected", String(selected));
      button.setAttribute(
        "aria-label",
        `${GEM_LABELS[cell.type]} gem, row ${row + 1}, column ${column + 1}${cell.powerUp ? `, ${powerLabel(cell.powerUp)}` : ""}`,
      );
      button.tabIndex = selected || (!state.selectedGem && row === 0 && column === 0) ? 0 : -1;
      button.disabled = state.status !== "running";
    });
  }

  function overlayContent() {
    if (state.status === "paused") {
      return {
        kicker: "Paused",
        title: "Board saved",
        message: "Resume when you are ready. Your moves and score are safe.",
        primary: "Resume game",
        restart: "Restart game",
        exit: "Exit game",
      };
    }
    if (state.status === "won") {
      return {
        kicker: "Goal reached",
        title: "Brilliant match!",
        message: `${formatter.format(state.score)} points with ${state.movesRemaining} moves left.`,
        primary: "Play again",
        restart: null,
        exit: "Exit game",
      };
    }
    if (state.status === "gameover") {
      return {
        kicker: "Out of moves",
        title: "Almost there",
        message: `${formatter.format(state.score)} of ${formatter.format(state.targetScore)} points. Try a fresh board.`,
        primary: "Try again",
        restart: null,
        exit: "Exit game",
      };
    }
    return {
      kicker: "30 move challenge",
      title: "Ready to match?",
      message: "Tap two neighbors or swipe a gem. Match three or more to clear them.",
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
    const event = state.lastPowerEvent;
    const status = app.querySelector("[data-power-status]");
    if (event) {
      const [title, message] = POWER_MESSAGES[event.type][event.action];
      status.dataset.effect = event.type;
      status.dataset.action = event.action;
      app.querySelector("[data-power-kicker]").textContent = event.action === "triggered" ? "Power-up active" : "Power-up created";
      app.querySelector("[data-power-title]").textContent = title;
      app.querySelector("[data-power-message]").textContent = message;
    } else {
      delete status.dataset.effect;
      delete status.dataset.action;
      app.querySelector("[data-power-kicker]").textContent = "Automatic power-ups";
      app.querySelector("[data-power-title]").textContent = "Make a special match";
      app.querySelector("[data-power-message]").textContent = "Match 4, 5, or an L/T shape.";
    }
    app.querySelector("[data-combo]").textContent = state.combo > 1 ? `×${state.combo}` : "×1";
  }

  function render(previousBoard = null) {
    app.dataset.state = state.status;
    app.querySelector("[data-score]").textContent = formatter.format(state.score);
    app.querySelector("[data-best-score]").textContent = formatter.format(bestScore);
    app.querySelector("[data-moves]").textContent = String(state.movesRemaining);
    app.querySelector("[data-status-label]").textContent = {
      ready: "Ready",
      running: "Playing",
      paused: "Paused",
      won: "Goal reached",
      gameover: "Game over",
    }[state.status];
    const goalText = `${formatter.format(Math.min(state.score, state.targetScore))} / ${formatter.format(state.targetScore)}`;
    app.querySelector("[data-goal-score]").textContent = goalText;
    const progress = Math.min(100, (state.score / state.targetScore) * 100);
    app.querySelector("[data-goal-progress]").style.setProperty("--goal-progress", `${progress}%`);
    app.querySelector("[data-goal-progress]").setAttribute("aria-valuenow", String(Math.floor(progress)));
    pauseButton.disabled = !["running", "paused"].includes(state.status);
    pauseButton.setAttribute("aria-label", state.status === "paused" ? "Resume game" : "Pause game");
    exitButton.disabled = state.status === "ready";
    renderBoard(previousBoard);
    renderOverlay();
    renderPowerStatus();
  }

  function showBoardFeedback(effect) {
    window.clearTimeout(boardFeedbackTimer);
    boardFrame.dataset.feedback = effect;
    boardFeedbackTimer = window.setTimeout(() => {
      delete boardFrame.dataset.feedback;
    }, BOARD_FEEDBACK_MS);
  }

  function showPowerNotice(event) {
    showBoardFeedback(event.type);
    window.clearTimeout(powerNoticeTimer);
    powerNoticeTimer = window.setTimeout(() => {
      applyState(clearMatchPowerNotice(state));
    }, POWER_NOTICE_MS);
  }

  function applyState(next, message = "") {
    if (next === state) return false;
    const previousBoard = state.board;
    const previousPowerEvent = state.lastPowerEvent;
    state = next;
    if (state.score > bestScore) {
      bestScore = state.score;
      writeBestScore(bestScore);
    }
    render(previousBoard);
    if (state.lastMove?.valid === false) showBoardFeedback("invalid");
    if (state.lastPowerEvent && state.lastPowerEvent !== previousPowerEvent) {
      const [title, detail] = POWER_MESSAGES[state.lastPowerEvent.type][state.lastPowerEvent.action];
      showPowerNotice(state.lastPowerEvent);
      announce(`${title}. ${detail}`);
    } else if (state.wasReshuffled && state.lastMove?.valid) {
      announce(`${message} No matches were available, so the board was reshuffled.`);
    } else if (message) {
      announce(message);
    }
    return true;
  }

  function performSwap(first, second) {
    const next = swapMatchGems(state, first, second);
    if (next === state) return;
    if (next.lastMove?.valid === false) {
      applyState(next, "That swap makes no match. Try another pair.");
      return;
    }
    const comboMessage = next.lastMove.cascades > 1 ? ` ${next.lastMove.cascades} cascade combo.` : "";
    applyState(
      next,
      `${next.lastMove.cleared} gems cleared for ${formatter.format(next.lastMove.scoreGained)} points.${comboMessage}`,
    );
  }

  function handleTap(row, column) {
    const next = selectMatchGem(state, row, column);
    if (next === state) return;
    if (next.lastMove?.valid === false) {
      applyState(next, "That swap makes no match. Try another pair.");
    } else if (next.lastMove?.valid) {
      const comboMessage = next.lastMove.cascades > 1 ? ` ${next.lastMove.cascades} cascade combo.` : "";
      applyState(next, `${next.lastMove.cleared} gems cleared.${comboMessage}`);
    } else {
      applyState(next, next.selectedGem ? "Gem selected. Choose a neighboring gem." : "Selection cleared.");
    }
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
    if (state.status === "ready") applyState(startMatchThree(state), "Game started. Tap or swipe a gem.");
    else if (state.status === "paused") applyState(toggleMatchThreePause(state), "Game resumed.");
    else if (["won", "gameover"].includes(state.status)) applyState(restartMatchThree(), "New game started.");
    enterImmersive();
  }

  function pauseOrResume() {
    if (!["running", "paused"].includes(state.status)) return;
    const message = state.status === "running" ? "Game paused." : "Game resumed.";
    applyState(toggleMatchThreePause(state), message);
  }

  function restartGame() {
    applyState(restartMatchThree(), "New game started.");
    enterImmersive();
  }

  function exitGame() {
    if (state.status === "running") applyState(toggleMatchThreePause(state), "Game paused.");
    leaveImmersive();
  }

  buildBoard();
  render();

  board.addEventListener("click", (event) => {
    const button = event.target.closest(".match-cell");
    if (!button) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    handleTap(Number(button.dataset.row), Number(button.dataset.column));
  });

  board.addEventListener("pointerdown", (event) => {
    const button = event.target.closest(".match-cell");
    if (!button || state.status !== "running") return;
    pointerStart = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      row: Number(button.dataset.row),
      column: Number(button.dataset.column),
    };
    button.setPointerCapture?.(event.pointerId);
  });

  board.addEventListener("pointerup", (event) => {
    if (!pointerStart || pointerStart.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pointerStart.x;
    const deltaY = event.clientY - pointerStart.y;
    const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    if (distance >= SWIPE_THRESHOLD_PX) {
      const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
      const target = {
        row: pointerStart.row + (horizontal ? 0 : Math.sign(deltaY)),
        column: pointerStart.column + (horizontal ? Math.sign(deltaX) : 0),
      };
      if (inside(target.row, target.column)) performSwap(pointerStart, target);
      suppressClick = true;
    }
    pointerStart = null;
  });

  board.addEventListener("pointercancel", () => {
    pointerStart = null;
  });

  board.addEventListener("keydown", (event) => {
    const button = event.target.closest(".match-cell");
    if (!button) return;
    const directions = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const row = Number(button.dataset.row) + direction[0];
    const column = Number(button.dataset.column) + direction[1];
    if (!inside(row, column)) return;
    const target = board.querySelector(`[data-row="${row}"][data-column="${column}"]`);
    target?.focus();
  });

  overlayPrimary.addEventListener("click", startOrResume);
  overlayRestart.addEventListener("click", restartGame);
  overlayExit.addEventListener("click", exitGame);
  pauseButton.addEventListener("click", pauseOrResume);
  exitButton.addEventListener("click", exitGame);

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Escape") return;
    if (["running", "paused"].includes(state.status)) {
      event.preventDefault();
      pauseOrResume();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.status === "running") {
      applyState(toggleMatchThreePause(state), "Game paused while hidden.");
    }
  });

  window.addEventListener("pagehide", () => {
    window.clearTimeout(powerNoticeTimer);
    window.clearTimeout(boardFeedbackTimer);
  });
}

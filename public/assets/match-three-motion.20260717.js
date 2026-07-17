const MOTION_GHOST_LIFETIME_MS = 420;
const CLEAR_BURST_LIFETIME_MS = 480;
const POWER_EFFECT_LIFETIME_MS = 520;
const BOARD_SIZE = 8;
const SWIPE_THRESHOLD_PX = 18;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const POWER_EFFECTS = new Set(["rowRocket", "columnRocket", "rainbow", "bomb"]);

function removeGhost(ghost) {
  if (ghost.isConnected) ghost.remove();
}

function removeTransient(element) {
  if (element.isConnected) element.remove();
}

function createClearBurst(cell, gemType) {
  if (!gemType || reducedMotion.matches) return;

  cell.querySelector(".match-clear-burst")?.remove();
  const burst = document.createElement("span");
  burst.className = "match-clear-burst";
  burst.dataset.burstGem = gemType;
  burst.setAttribute("aria-hidden", "true");
  burst.innerHTML = "<i></i><i></i><i></i><i></i><i></i><i></i>";
  cell.append(burst);

  burst.addEventListener("animationend", (event) => {
    if (event.target === burst && !event.pseudoElement) removeTransient(burst);
  });
  window.setTimeout(() => removeTransient(burst), CLEAR_BURST_LIFETIME_MS);
}

function createGhost(cell, gemType) {
  if (!gemType || reducedMotion.matches) return;

  cell.querySelector(".match-motion-ghost")?.remove();

  const ghost = document.createElement("span");
  ghost.className = "match-motion-ghost";
  ghost.dataset.ghostGem = gemType;
  ghost.setAttribute("aria-hidden", "true");
  cell.append(ghost);

  ghost.addEventListener("animationend", () => removeGhost(ghost), { once: true });
  window.setTimeout(() => removeGhost(ghost), MOTION_GHOST_LIFETIME_MS);
}

function cellIndex(cell) {
  return Number(cell.dataset.row) * BOARD_SIZE + Number(cell.dataset.column);
}

function collectMatchedIndices(types) {
  const matches = new Set();

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    let start = 0;
    while (start < BOARD_SIZE) {
      let end = start + 1;
      while (end < BOARD_SIZE && types[row * BOARD_SIZE + end] === types[row * BOARD_SIZE + start]) end += 1;
      if (end - start >= 3) {
        for (let column = start; column < end; column += 1) matches.add(row * BOARD_SIZE + column);
      }
      start = end;
    }
  }

  for (let column = 0; column < BOARD_SIZE; column += 1) {
    let start = 0;
    while (start < BOARD_SIZE) {
      let end = start + 1;
      while (end < BOARD_SIZE && types[end * BOARD_SIZE + column] === types[start * BOARD_SIZE + column]) end += 1;
      if (end - start >= 3) {
        for (let row = start; row < end; row += 1) matches.add(row * BOARD_SIZE + column);
      }
      start = end;
    }
  }

  return matches;
}

function createPowerEffect(frame, effect) {
  if (!POWER_EFFECTS.has(effect) || reducedMotion.matches) return;

  frame.querySelector(".match-power-fx")?.remove();
  const powerEffect = document.createElement("span");
  powerEffect.className = "match-power-fx";
  powerEffect.dataset.effect = effect;
  powerEffect.setAttribute("aria-hidden", "true");
  frame.append(powerEffect);

  powerEffect.addEventListener("animationend", (event) => {
    if (event.target === powerEffect && !event.pseudoElement) removeTransient(powerEffect);
  });
  window.setTimeout(() => removeTransient(powerEffect), POWER_EFFECT_LIFETIME_MS);
}

function prepareMotion(app) {
  const board = app.querySelector("[data-match-board]");
  const frame = app.querySelector("[data-board-frame]");
  const powerStatus = app.querySelector("[data-power-status]");
  if (!board || !frame || !powerStatus) return;
  let pendingSwap = null;
  let pointerStart = null;
  let ignoreNextClick = false;

  function rememberSelectedSwap(cell) {
    const selected = board.querySelector(".match-cell.is-selected");
    if (selected && selected !== cell) pendingSwap = [cellIndex(selected), cellIndex(cell)];
  }

  board.addEventListener("click", (event) => {
    const cell = event.target.closest(".match-cell");
    if (!cell) return;
    if (ignoreNextClick) {
      ignoreNextClick = false;
      return;
    }
    rememberSelectedSwap(cell);
  }, true);

  board.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const cell = event.target.closest(".match-cell");
    if (cell) rememberSelectedSwap(cell);
  }, true);

  board.addEventListener("pointerdown", (event) => {
    const cell = event.target.closest(".match-cell");
    if (!cell) return;
    pointerStart = { cell, x: event.clientX, y: event.clientY };
  }, true);

  board.addEventListener("pointerup", (event) => {
    if (!pointerStart) return;
    const { cell, x, y } = pointerStart;
    pointerStart = null;
    const deltaX = event.clientX - x;
    const deltaY = event.clientY - y;
    if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < SWIPE_THRESHOLD_PX) return;

    const row = Number(cell.dataset.row) + (Math.abs(deltaY) > Math.abs(deltaX) ? Math.sign(deltaY) : 0);
    const column = Number(cell.dataset.column) + (Math.abs(deltaX) >= Math.abs(deltaY) ? Math.sign(deltaX) : 0);
    if (row < 0 || row >= BOARD_SIZE || column < 0 || column >= BOARD_SIZE) return;
    pendingSwap = [cellIndex(cell), row * BOARD_SIZE + column];
    ignoreNextClick = true;
  }, true);

  const observer = new MutationObserver((records) => {
    const cells = Array.from(board.querySelectorAll(".match-cell"));
    const previousTypes = cells.map((cell) => cell.dataset.gem);
    const changedCells = new Map();

    for (const record of records) {
      if (record.type !== "attributes" || record.attributeName !== "data-gem") continue;
      const cell = record.target;
      if (!(cell instanceof HTMLElement) || !cell.classList.contains("match-cell")) continue;
      if (!record.oldValue || record.oldValue === cell.dataset.gem || changedCells.has(cell)) continue;
      const index = cellIndex(cell);
      changedCells.set(cell, index);
      previousTypes[index] = record.oldValue;
      createGhost(cell, record.oldValue);
    }

    if (pendingSwap && changedCells.size > 0) {
      const swappedTypes = previousTypes.slice();
      const [firstIndex, secondIndex] = pendingSwap;
      [swappedTypes[firstIndex], swappedTypes[secondIndex]] = [swappedTypes[secondIndex], swappedTypes[firstIndex]];
      for (const index of collectMatchedIndices(swappedTypes)) {
        createClearBurst(cells[index], swappedTypes[index]);
      }
    }
    pendingSwap = null;
  });

  observer.observe(board, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-gem"],
  });

  const powerObserver = new MutationObserver(() => {
    const effect = frame.dataset.feedback;
    if (powerStatus.dataset.action === "triggered" && POWER_EFFECTS.has(effect)) {
      createPowerEffect(frame, effect);
    }
  });

  powerObserver.observe(frame, {
    attributes: true,
    attributeFilter: ["data-feedback"],
  });

  app.classList.add("has-fluid-match-motion");
}

for (const app of document.querySelectorAll("[data-match-three]")) {
  prepareMotion(app);
}

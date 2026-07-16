export const MATCH_THREE_MODE = "matchthree";
export const MATCH_THREE_BOARD_SIZE = 8;
export const MATCH_THREE_STARTING_MOVES = 30;
export const MATCH_THREE_TARGET_SCORE = 4500;
export const MATCH_THREE_POINTS_PER_GEM = 60;

export const MATCH_THREE_GEM_TYPES = Object.freeze([
  "rose",
  "violet",
  "amber",
  "cyan",
  "mint",
  "coral",
]);

export const MATCH_THREE_POWER_UPS = Object.freeze({
  ROW_ROCKET: "rowRocket",
  COLUMN_ROCKET: "columnRocket",
  RAINBOW: "rainbow",
  BOMB: "bomb",
});

const MAX_BOARD_ATTEMPTS = 60;
const MAX_CASCADES = 20;

function randomIndex(length, random = Math.random) {
  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
  return Math.floor(normalized * length);
}

function keyOf(row, column) {
  return `${row}:${column}`;
}

function parseKey(key) {
  const [row, column] = key.split(":").map(Number);
  return { row, column };
}

function insideBoard(row, column) {
  return row >= 0
    && row < MATCH_THREE_BOARD_SIZE
    && column >= 0
    && column < MATCH_THREE_BOARD_SIZE;
}

function cloneCell(cell) {
  return cell ? { ...cell } : null;
}

export function cloneMatchBoard(board) {
  return board.map((row) => row.map(cloneCell));
}

export function createEmptyMatchBoard() {
  return Array.from(
    { length: MATCH_THREE_BOARD_SIZE },
    () => Array(MATCH_THREE_BOARD_SIZE).fill(null),
  );
}

function createGem(type, id, powerUp = null) {
  return { id: `gem-${id}`, type, powerUp };
}

function createCandidateBoard(random, firstGemId) {
  const board = createEmptyMatchBoard();
  let nextGemId = firstGemId;

  for (let row = 0; row < MATCH_THREE_BOARD_SIZE; row += 1) {
    for (let column = 0; column < MATCH_THREE_BOARD_SIZE; column += 1) {
      const blocked = new Set();
      if (column >= 2 && board[row][column - 1]?.type === board[row][column - 2]?.type) {
        blocked.add(board[row][column - 1].type);
      }
      if (row >= 2 && board[row - 1][column]?.type === board[row - 2][column]?.type) {
        blocked.add(board[row - 1][column].type);
      }
      const choices = MATCH_THREE_GEM_TYPES.filter((type) => !blocked.has(type));
      board[row][column] = createGem(choices[randomIndex(choices.length, random)], nextGemId);
      nextGemId += 1;
    }
  }

  return { board, nextGemId };
}

const FALLBACK_TYPES = Object.freeze([
  ["rose", "violet", "rose", "amber", "cyan", "mint", "coral", "violet"],
  ["violet", "rose", "violet", "cyan", "mint", "coral", "amber", "cyan"],
  ["amber", "cyan", "mint", "coral", "rose", "violet", "cyan", "mint"],
  ["cyan", "mint", "coral", "rose", "violet", "amber", "mint", "coral"],
  ["mint", "coral", "rose", "violet", "amber", "cyan", "coral", "rose"],
  ["coral", "amber", "violet", "cyan", "mint", "rose", "amber", "violet"],
  ["rose", "violet", "cyan", "mint", "coral", "amber", "violet", "cyan"],
  ["violet", "cyan", "mint", "coral", "amber", "rose", "cyan", "mint"],
]);

function createFallbackBoard(firstGemId) {
  let nextGemId = firstGemId;
  const board = FALLBACK_TYPES.map((row) => row.map((type) => {
    const gem = createGem(type, nextGemId);
    nextGemId += 1;
    return gem;
  }));
  return { board, nextGemId };
}

export function findMatchRuns(board) {
  const runs = [];

  for (let row = 0; row < MATCH_THREE_BOARD_SIZE; row += 1) {
    let start = 0;
    while (start < MATCH_THREE_BOARD_SIZE) {
      const type = board[row][start]?.type;
      let end = start + 1;
      while (type && end < MATCH_THREE_BOARD_SIZE && board[row][end]?.type === type) end += 1;
      if (type && end - start >= 3) {
        runs.push({
          orientation: "row",
          type,
          cells: Array.from({ length: end - start }, (_, offset) => ({ row, column: start + offset })),
        });
      }
      start = end;
    }
  }

  for (let column = 0; column < MATCH_THREE_BOARD_SIZE; column += 1) {
    let start = 0;
    while (start < MATCH_THREE_BOARD_SIZE) {
      const type = board[start][column]?.type;
      let end = start + 1;
      while (type && end < MATCH_THREE_BOARD_SIZE && board[end][column]?.type === type) end += 1;
      if (type && end - start >= 3) {
        runs.push({
          orientation: "column",
          type,
          cells: Array.from({ length: end - start }, (_, offset) => ({ row: start + offset, column })),
        });
      }
      start = end;
    }
  }

  return runs;
}

export function findMatchedCells(board) {
  const keys = new Set();
  findMatchRuns(board).forEach((run) => run.cells.forEach(({ row, column }) => keys.add(keyOf(row, column))));
  return [...keys].map(parseKey);
}

function swapBoardCells(board, first, second) {
  const next = cloneMatchBoard(board);
  [next[first.row][first.column], next[second.row][second.column]] = [
    next[second.row][second.column],
    next[first.row][first.column],
  ];
  return next;
}

export function areAdjacentMatchCells(first, second) {
  return Math.abs(first.row - second.row) + Math.abs(first.column - second.column) === 1;
}

export function hasAvailableMatch(board) {
  for (let row = 0; row < MATCH_THREE_BOARD_SIZE; row += 1) {
    for (let column = 0; column < MATCH_THREE_BOARD_SIZE; column += 1) {
      const cell = board[row][column];
      if (!cell) continue;
      const candidates = [
        { row, column: column + 1 },
        { row: row + 1, column },
      ];
      for (const target of candidates) {
        if (!insideBoard(target.row, target.column) || !board[target.row][target.column]) continue;
        if (cell.powerUp || board[target.row][target.column].powerUp) return true;
        if (findMatchRuns(swapBoardCells(board, { row, column }, target)).length > 0) return true;
      }
    }
  }
  return false;
}

export function generateStableMatchBoard(random = Math.random, firstGemId = 1) {
  for (let attempt = 0; attempt < MAX_BOARD_ATTEMPTS; attempt += 1) {
    const candidate = createCandidateBoard(random, firstGemId);
    if (findMatchRuns(candidate.board).length === 0 && hasAvailableMatch(candidate.board)) return candidate;
  }
  return createFallbackBoard(firstGemId);
}

export function ensurePlayableMatchBoard(board, random = Math.random, firstGemId = deriveNextGemId(board)) {
  if (findMatchRuns(board).length === 0 && hasAvailableMatch(board)) {
    return { board: cloneMatchBoard(board), nextGemId: firstGemId, reshuffled: false };
  }
  const generated = generateStableMatchBoard(random, firstGemId);
  return { ...generated, reshuffled: true };
}

function coordinateInRun(coordinate, run) {
  return run.cells.some((cell) => cell.row === coordinate.row && cell.column === coordinate.column);
}

function chooseCreationCell(board, cells, preferred) {
  const eligible = cells.filter(({ row, column }) => !board[row][column]?.powerUp);
  if (eligible.length === 0) return null;
  if (preferred && eligible.some((cell) => cell.row === preferred.row && cell.column === preferred.column)) {
    return { row: preferred.row, column: preferred.column };
  }
  return eligible[Math.floor(eligible.length / 2)];
}

export function detectMatchPowerUp(board, runs = findMatchRuns(board), preferred = null) {
  const horizontalRuns = runs.filter((run) => run.orientation === "row");
  const verticalRuns = runs.filter((run) => run.orientation === "column");
  const intersections = [];
  horizontalRuns.forEach((horizontal) => {
    verticalRuns.forEach((vertical) => {
      horizontal.cells.forEach((cell) => {
        if (coordinateInRun(cell, vertical)) intersections.push(cell);
      });
    });
  });

  if (intersections.length > 0) {
    const coordinate = chooseCreationCell(board, intersections, preferred);
    return coordinate ? { ...coordinate, type: MATCH_THREE_POWER_UPS.BOMB } : null;
  }

  const longest = [...runs].sort((first, second) => second.cells.length - first.cells.length)[0];
  if (!longest || longest.cells.length < 4) return null;
  const coordinate = chooseCreationCell(board, longest.cells, preferred);
  if (!coordinate) return null;
  if (longest.cells.length >= 5) return { ...coordinate, type: MATCH_THREE_POWER_UPS.RAINBOW };
  return {
    ...coordinate,
    type: longest.orientation === "row"
      ? MATCH_THREE_POWER_UPS.ROW_ROCKET
      : MATCH_THREE_POWER_UPS.COLUMN_ROCKET,
  };
}

function addTarget(targets, queue, row, column) {
  if (!insideBoard(row, column)) return;
  const key = keyOf(row, column);
  if (targets.has(key)) return;
  targets.add(key);
  queue.push({ row, column });
}

function expandPowerTargets(board, seeds, rainbowTypes = new Map()) {
  const targets = new Set();
  const queue = [];
  const activated = new Set();
  const powerEvents = [];
  seeds.forEach(({ row, column }) => addTarget(targets, queue, row, column));

  while (queue.length > 0) {
    const coordinate = queue.shift();
    const cell = board[coordinate.row][coordinate.column];
    const coordinateKey = keyOf(coordinate.row, coordinate.column);
    if (!cell?.powerUp || activated.has(coordinateKey)) continue;
    activated.add(coordinateKey);
    powerEvents.push({ type: cell.powerUp, action: "triggered" });

    if (cell.powerUp === MATCH_THREE_POWER_UPS.ROW_ROCKET) {
      for (let column = 0; column < MATCH_THREE_BOARD_SIZE; column += 1) {
        addTarget(targets, queue, coordinate.row, column);
      }
    } else if (cell.powerUp === MATCH_THREE_POWER_UPS.COLUMN_ROCKET) {
      for (let row = 0; row < MATCH_THREE_BOARD_SIZE; row += 1) {
        addTarget(targets, queue, row, coordinate.column);
      }
    } else if (cell.powerUp === MATCH_THREE_POWER_UPS.BOMB) {
      for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
          addTarget(targets, queue, coordinate.row + rowOffset, coordinate.column + columnOffset);
        }
      }
    } else if (cell.powerUp === MATCH_THREE_POWER_UPS.RAINBOW) {
      const targetType = rainbowTypes.get(coordinateKey) || cell.type;
      for (let row = 0; row < MATCH_THREE_BOARD_SIZE; row += 1) {
        for (let column = 0; column < MATCH_THREE_BOARD_SIZE; column += 1) {
          if (board[row][column]?.type === targetType) addTarget(targets, queue, row, column);
        }
      }
    }
  }

  return { targets, powerEvents };
}

function clearTargets(board, targets, creation = null) {
  const next = cloneMatchBoard(board);
  const creationKey = creation ? keyOf(creation.row, creation.column) : null;
  let cleared = 0;
  targets.forEach((targetKey) => {
    if (targetKey === creationKey) return;
    const { row, column } = parseKey(targetKey);
    if (next[row][column]) cleared += 1;
    next[row][column] = null;
  });
  if (creation) {
    const source = next[creation.row][creation.column] || board[creation.row][creation.column];
    if (source) next[creation.row][creation.column] = { ...source, powerUp: creation.type };
  }
  return { board: next, cleared };
}

function collapseAndFill(board, random, firstGemId) {
  const next = createEmptyMatchBoard();
  let nextGemId = firstGemId;

  for (let column = 0; column < MATCH_THREE_BOARD_SIZE; column += 1) {
    const existing = [];
    for (let row = MATCH_THREE_BOARD_SIZE - 1; row >= 0; row -= 1) {
      if (board[row][column]) existing.push(cloneCell(board[row][column]));
    }
    let targetRow = MATCH_THREE_BOARD_SIZE - 1;
    existing.forEach((cell) => {
      next[targetRow][column] = cell;
      targetRow -= 1;
    });
    while (targetRow >= 0) {
      const type = MATCH_THREE_GEM_TYPES[randomIndex(MATCH_THREE_GEM_TYPES.length, random)];
      next[targetRow][column] = createGem(type, nextGemId);
      nextGemId += 1;
      targetRow -= 1;
    }
  }

  return { board: next, nextGemId };
}

function directPowerSeeds(board, first, second, firstCell, secondCell) {
  const seeds = [];
  const rainbowTypes = new Map();
  if (firstCell.powerUp) {
    seeds.push(second);
    if (firstCell.powerUp === MATCH_THREE_POWER_UPS.RAINBOW) {
      rainbowTypes.set(keyOf(second.row, second.column), secondCell.type);
    }
  }
  if (secondCell.powerUp) {
    seeds.push(first);
    if (secondCell.powerUp === MATCH_THREE_POWER_UPS.RAINBOW) {
      rainbowTypes.set(keyOf(first.row, first.column), firstCell.type);
    }
  }
  return { seeds, rainbowTypes };
}

function resolveBoard(initialBoard, random, firstGemId, preferred, directPower) {
  let board = initialBoard;
  let nextGemId = firstGemId;
  let totalCleared = 0;
  let scoreGained = 0;
  let cascades = 0;
  let powerEvents = [];
  let forcedSeeds = directPower?.seeds || null;
  let forcedRainbowTypes = directPower?.rainbowTypes || new Map();
  let exceededCascadeLimit = false;

  while (cascades < MAX_CASCADES) {
    const runs = forcedSeeds ? [] : findMatchRuns(board);
    if (!forcedSeeds && runs.length === 0) break;
    cascades += 1;

    let creation = null;
    let expansion;
    if (forcedSeeds) {
      expansion = expandPowerTargets(board, forcedSeeds, forcedRainbowTypes);
    } else {
      const matched = [];
      const matchedKeys = new Set();
      runs.forEach((run) => run.cells.forEach((cell) => {
        const matchKey = keyOf(cell.row, cell.column);
        if (!matchedKeys.has(matchKey)) matched.push(cell);
        matchedKeys.add(matchKey);
      }));
      creation = detectMatchPowerUp(board, runs, cascades === 1 ? preferred : null);
      expansion = expandPowerTargets(board, matched);
    }

    const clearedResult = clearTargets(board, expansion.targets, creation);
    const creationEvents = creation ? [{ type: creation.type, action: "created" }] : [];
    const roundEvents = [...expansion.powerEvents, ...creationEvents];
    powerEvents = [...powerEvents, ...roundEvents];
    totalCleared += clearedResult.cleared;
    scoreGained += (clearedResult.cleared * MATCH_THREE_POINTS_PER_GEM * cascades)
      + (expansion.powerEvents.length * 200)
      + (creation ? 100 : 0);

    const filled = collapseAndFill(clearedResult.board, random, nextGemId);
    board = filled.board;
    nextGemId = filled.nextGemId;
    forcedSeeds = null;
    forcedRainbowTypes = new Map();
  }

  if (cascades === MAX_CASCADES && findMatchRuns(board).length > 0) exceededCascadeLimit = true;
  return {
    board,
    nextGemId,
    totalCleared,
    scoreGained,
    cascades,
    powerEvents,
    exceededCascadeLimit,
  };
}

function deriveNextGemId(board) {
  return board.flat().reduce((maximum, cell) => {
    const value = Number(cell?.id?.split("-")[1]);
    return Number.isFinite(value) ? Math.max(maximum, value + 1) : maximum;
  }, 1);
}

export function createMatchThreeState(options = {}) {
  const random = options.random || Math.random;
  const generated = options.board
    ? { board: cloneMatchBoard(options.board), nextGemId: options.nextGemId ?? deriveNextGemId(options.board) }
    : generateStableMatchBoard(random, options.nextGemId ?? 1);

  return {
    mode: MATCH_THREE_MODE,
    board: generated.board,
    selectedGem: options.selectedGem ? { ...options.selectedGem } : null,
    score: options.score ?? 0,
    movesRemaining: options.movesRemaining ?? MATCH_THREE_STARTING_MOVES,
    targetScore: options.targetScore ?? MATCH_THREE_TARGET_SCORE,
    combo: options.combo ?? 0,
    lastMove: options.lastMove ?? null,
    lastPowerEvent: options.lastPowerEvent ?? null,
    wasReshuffled: options.wasReshuffled ?? false,
    status: options.status ?? "ready",
    nextGemId: generated.nextGemId,
  };
}

export function startMatchThree(state) {
  return state.status === "ready" ? { ...state, status: "running" } : state;
}

export function toggleMatchThreePause(state) {
  if (state.status === "running") return { ...state, status: "paused", selectedGem: null };
  if (state.status === "paused") return { ...state, status: "running" };
  return state;
}

export function restartMatchThree(random = Math.random) {
  return { ...createMatchThreeState({ random }), status: "running" };
}

export function clearMatchPowerNotice(state) {
  return state.lastPowerEvent ? { ...state, lastPowerEvent: null } : state;
}

export function swapMatchGems(state, first, second, random = Math.random) {
  if (state.status !== "running" || !areAdjacentMatchCells(first, second)) return state;
  const firstCell = state.board[first.row]?.[first.column];
  const secondCell = state.board[second.row]?.[second.column];
  if (!firstCell || !secondCell) return state;

  const swapped = swapBoardCells(state.board, first, second);
  const hasDirectPower = Boolean(firstCell.powerUp || secondCell.powerUp);
  const runs = findMatchRuns(swapped);
  if (!hasDirectPower && runs.length === 0) {
    return {
      ...state,
      selectedGem: null,
      lastPowerEvent: null,
      wasReshuffled: false,
      lastMove: { valid: false, from: { ...first }, to: { ...second }, cleared: 0, cascades: 0, scoreGained: 0, powerEvents: [] },
    };
  }

  const directPower = hasDirectPower
    ? directPowerSeeds(swapped, first, second, firstCell, secondCell)
    : null;
  let resolution = resolveBoard(swapped, random, state.nextGemId, second, directPower);
  let wasReshuffled = false;
  if (resolution.exceededCascadeLimit || !hasAvailableMatch(resolution.board)) {
    const playable = ensurePlayableMatchBoard(resolution.board, random, resolution.nextGemId);
    resolution = { ...resolution, board: playable.board, nextGemId: playable.nextGemId };
    wasReshuffled = playable.reshuffled;
  }

  const movesRemaining = state.movesRemaining - 1;
  const score = state.score + resolution.scoreGained;
  const status = score >= state.targetScore
    ? "won"
    : movesRemaining <= 0
      ? "gameover"
      : "running";
  const lastPowerEvent = resolution.powerEvents.at(-1) || null;

  return {
    ...state,
    board: resolution.board,
    selectedGem: null,
    score,
    movesRemaining,
    combo: resolution.cascades,
    lastPowerEvent,
    wasReshuffled,
    status,
    nextGemId: resolution.nextGemId,
    lastMove: {
      valid: true,
      from: { ...first },
      to: { ...second },
      cleared: resolution.totalCleared,
      cascades: resolution.cascades,
      scoreGained: resolution.scoreGained,
      powerEvents: resolution.powerEvents,
    },
  };
}

export function selectMatchGem(state, row, column, random = Math.random) {
  if (state.status !== "running" || !insideBoard(row, column) || !state.board[row][column]) return state;
  const selected = { row, column };
  if (!state.selectedGem) return { ...state, selectedGem: selected, lastMove: null };
  if (state.selectedGem.row === row && state.selectedGem.column === column) {
    return { ...state, selectedGem: null };
  }
  if (!areAdjacentMatchCells(state.selectedGem, selected)) {
    return { ...state, selectedGem: selected, lastMove: null };
  }
  return swapMatchGems(state, state.selectedGem, selected, random);
}

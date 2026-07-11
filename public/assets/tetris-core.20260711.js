export const BOARD_WIDTH = 10;
export const VISIBLE_BOARD_HEIGHT = 20;
export const HIDDEN_ROWS = 2;
export const BOARD_HEIGHT = VISIBLE_BOARD_HEIGHT + HIDDEN_ROWS;

export const TETROMINO_TYPES = Object.freeze(["I", "J", "L", "O", "S", "T", "Z"]);

const LINE_CLEAR_SCORES = Object.freeze([0, 100, 300, 500, 800]);

const PIECE_CELLS = Object.freeze({
  I: Object.freeze([
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ]),
  J: Object.freeze([
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ]),
  L: Object.freeze([
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ]),
  O: Object.freeze([
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
  ]),
  S: Object.freeze([
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ]),
  T: Object.freeze([
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ]),
  Z: Object.freeze([
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]],
  ]),
});

const JLSTZ_KICKS = Object.freeze({
  "0>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "1>0": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "1>2": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "2>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "2>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "3>2": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "3>0": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "0>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
});

const I_KICKS = Object.freeze({
  "0>1": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  "1>0": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  "1>2": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  "2>1": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  "2>3": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  "3>2": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  "3>0": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  "0>3": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
});

export function createEmptyBoard() {
  return Array.from({ length: BOARD_HEIGHT }, () => Array(BOARD_WIDTH).fill(null));
}

export function createSevenBag(random = Math.random) {
  const bag = [...TETROMINO_TYPES];
  for (let index = bag.length - 1; index > 0; index -= 1) {
    const value = Number(random());
    const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
    const target = Math.floor(normalized * (index + 1));
    [bag[index], bag[target]] = [bag[target], bag[index]];
  }
  return bag;
}

export function spawnPiece(type) {
  if (!TETROMINO_TYPES.includes(type)) {
    throw new Error(`未知方块类型：${type}`);
  }
  return { type, rotation: 0, x: 3, y: 0 };
}

export function getPieceCells(piece) {
  return PIECE_CELLS[piece.type][piece.rotation].map(([x, y]) => ({
    x: piece.x + x,
    y: piece.y + y,
  }));
}

export function isValidPosition(board, piece) {
  return getPieceCells(piece).every(({ x, y }) => (
    x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT && board[y][x] === null
  ));
}

function refillQueue(queue, bag, random) {
  const nextQueue = [...queue];
  let nextBag = [...bag];
  while (nextQueue.length < 5) {
    if (nextBag.length === 0) nextBag = createSevenBag(random);
    nextQueue.push(nextBag.shift());
  }
  return { queue: nextQueue, bag: nextBag };
}

export function createGameState(options = {}) {
  const random = options.random || Math.random;
  const board = options.board ? options.board.map((row) => [...row]) : createEmptyBoard();
  const seeded = refillQueue([], [], random);
  const type = seeded.queue.shift();
  const refilled = refillQueue(seeded.queue, seeded.bag, random);

  return {
    board,
    active: spawnPiece(type),
    queue: refilled.queue,
    bag: refilled.bag,
    score: 0,
    lines: 0,
    level: 1,
    status: options.status || "ready",
    dropAccumulator: 0,
  };
}

export function startGame(state) {
  return state.status === "ready" ? { ...state, status: "running", dropAccumulator: 0 } : state;
}

export function restartGame(random = Math.random) {
  return { ...createGameState({ random }), status: "running" };
}

export function togglePause(state) {
  if (state.status === "running") return { ...state, status: "paused", dropAccumulator: 0 };
  if (state.status === "paused") return { ...state, status: "running", dropAccumulator: 0 };
  return state;
}

export function movePiece(state, deltaX, deltaY = 0) {
  if (state.status !== "running") return state;
  const candidate = { ...state.active, x: state.active.x + deltaX, y: state.active.y + deltaY };
  return isValidPosition(state.board, candidate) ? { ...state, active: candidate } : state;
}

function rotationKicks(type, from, to) {
  if (type === "O") return [[0, 0]];
  const table = type === "I" ? I_KICKS : JLSTZ_KICKS;
  return table[`${from}>${to}`] || [[0, 0]];
}

export function rotatePiece(state, direction = 1) {
  if (state.status !== "running") return state;
  const from = state.active.rotation;
  const to = (from + (direction < 0 ? 3 : 1)) % 4;

  for (const [deltaX, deltaY] of rotationKicks(state.active.type, from, to)) {
    const candidate = {
      ...state.active,
      rotation: to,
      x: state.active.x + deltaX,
      y: state.active.y + deltaY,
    };
    if (isValidPosition(state.board, candidate)) return { ...state, active: candidate };
  }

  return state;
}

export function getGhostPosition(state) {
  let ghost = { ...state.active };
  while (isValidPosition(state.board, { ...ghost, y: ghost.y + 1 })) {
    ghost = { ...ghost, y: ghost.y + 1 };
  }
  return ghost;
}

function clearCompletedLines(board) {
  const remaining = board.filter((row) => row.some((cell) => cell === null));
  const cleared = BOARD_HEIGHT - remaining.length;
  const emptyRows = Array.from({ length: cleared }, () => Array(BOARD_WIDTH).fill(null));
  return { board: [...emptyRows, ...remaining], cleared };
}

function spawnNextPiece(state, random) {
  const queue = [...state.queue];
  const type = queue.shift();
  const refilled = refillQueue(queue, state.bag, random);
  const active = spawnPiece(type);
  const status = isValidPosition(state.board, active) ? state.status : "gameover";
  return { ...state, active, queue: refilled.queue, bag: refilled.bag, status };
}

function lockActivePiece(state, random) {
  const board = state.board.map((row) => [...row]);
  const cells = getPieceCells(state.active);
  cells.forEach(({ x, y }) => {
    board[y][x] = state.active.type;
  });

  const lockedInHiddenRows = cells.some(({ y }) => y < HIDDEN_ROWS);
  const result = clearCompletedLines(board);
  const clearedScore = LINE_CLEAR_SCORES[result.cleared] * state.level;
  const lines = state.lines + result.cleared;
  const level = Math.floor(lines / 10) + 1;
  const next = {
    ...state,
    board: result.board,
    score: state.score + clearedScore,
    lines,
    level,
    dropAccumulator: 0,
  };

  if (lockedInHiddenRows) return { ...next, status: "gameover" };
  return spawnNextPiece(next, random);
}

export function softDrop(state) {
  if (state.status !== "running") return state;
  const moved = movePiece(state, 0, 1);
  return moved === state ? state : { ...moved, score: moved.score + 1, dropAccumulator: 0 };
}

export function hardDrop(state, random = Math.random) {
  if (state.status !== "running") return state;
  const ghost = getGhostPosition(state);
  const distance = ghost.y - state.active.y;
  return lockActivePiece({ ...state, active: ghost, score: state.score + (distance * 2) }, random);
}

export function advanceGravity(state, random = Math.random) {
  if (state.status !== "running") return state;
  const moved = movePiece(state, 0, 1);
  return moved === state ? lockActivePiece(state, random) : moved;
}

export function getGravityInterval(level) {
  return Math.max(100, 1000 - ((Math.max(1, level) - 1) * 80));
}

export function tick(state, elapsedMs, random = Math.random) {
  if (state.status !== "running" || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return state;
  let next = { ...state, dropAccumulator: state.dropAccumulator + elapsedMs };
  let interval = getGravityInterval(next.level);

  while (next.status === "running" && next.dropAccumulator >= interval) {
    next = advanceGravity({ ...next, dropAccumulator: next.dropAccumulator - interval }, random);
    interval = getGravityInterval(next.level);
  }

  return next;
}

export const PUZZLE_MODE = "blockpuzzle";
export const PUZZLE_BOARD_SIZE = 8;
export const PUZZLE_CHARGE_CLEARS = 4;

export const PUZZLE_POWER_UPS = Object.freeze({
  LINE_SWEEP: "lineSweep",
  TRAY_REFRESH: "trayRefresh",
  AREA_BLAST: "areaBlast",
});

export const PUZZLE_SHAPES = Object.freeze([
  Object.freeze({ key: "single", cells: Object.freeze([[0, 0]]) }),
  Object.freeze({ key: "domino-h", cells: Object.freeze([[0, 0], [1, 0]]) }),
  Object.freeze({ key: "domino-v", cells: Object.freeze([[0, 0], [0, 1]]) }),
  Object.freeze({ key: "line-3-h", cells: Object.freeze([[0, 0], [1, 0], [2, 0]]) }),
  Object.freeze({ key: "line-3-v", cells: Object.freeze([[0, 0], [0, 1], [0, 2]]) }),
  Object.freeze({ key: "line-4-h", cells: Object.freeze([[0, 0], [1, 0], [2, 0], [3, 0]]) }),
  Object.freeze({ key: "line-4-v", cells: Object.freeze([[0, 0], [0, 1], [0, 2], [0, 3]]) }),
  Object.freeze({ key: "square-2", cells: Object.freeze([[0, 0], [1, 0], [0, 1], [1, 1]]) }),
  Object.freeze({ key: "corner-3", cells: Object.freeze([[0, 0], [0, 1], [1, 1]]) }),
  Object.freeze({ key: "corner-5", cells: Object.freeze([[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]]) }),
  Object.freeze({ key: "tee-4", cells: Object.freeze([[0, 0], [1, 0], [2, 0], [1, 1]]) }),
  Object.freeze({ key: "zig-4", cells: Object.freeze([[0, 0], [1, 0], [1, 1], [2, 1]]) }),
]);

const PIECE_COLORS = Object.freeze(["cyan", "blue", "orange", "yellow", "green", "violet", "coral"]);
const POWER_UP_TYPES = Object.freeze(Object.values(PUZZLE_POWER_UPS));

function randomIndex(length, random = Math.random) {
  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
  return Math.floor(normalized * length);
}

function pickRandom(items, random) {
  return items[randomIndex(items.length, random)];
}

export function createEmptyPuzzleBoard() {
  return Array.from({ length: PUZZLE_BOARD_SIZE }, () => Array(PUZZLE_BOARD_SIZE).fill(null));
}

function cloneBoard(board) {
  return board.map((row) => [...row]);
}

function createPiece(shape, id) {
  return {
    id: `piece-${id}`,
    shape: shape.key,
    color: PIECE_COLORS[(id - 1) % PIECE_COLORS.length],
    cells: shape.cells.map(([column, row]) => ({ column, row })),
  };
}

function findShape(key) {
  return PUZZLE_SHAPES.find((shape) => shape.key === key);
}

export function canPlacePuzzlePiece(board, piece, row, column) {
  return piece.cells.every((cell) => {
    const targetRow = row + cell.row;
    const targetColumn = column + cell.column;
    return targetRow >= 0
      && targetRow < PUZZLE_BOARD_SIZE
      && targetColumn >= 0
      && targetColumn < PUZZLE_BOARD_SIZE
      && board[targetRow][targetColumn] === null;
  });
}

export function getValidPlacements(board, piece) {
  const placements = [];
  for (let row = 0; row < PUZZLE_BOARD_SIZE; row += 1) {
    for (let column = 0; column < PUZZLE_BOARD_SIZE; column += 1) {
      if (canPlacePuzzlePiece(board, piece, row, column)) placements.push({ row, column });
    }
  }
  return placements;
}

export function canPlaceAnyPiece(board, tray) {
  return tray.some((piece) => getValidPlacements(board, piece).length > 0);
}

function generateTray(board, count, random, nextPieceId) {
  const tray = [];
  let id = nextPieceId;
  for (let index = 0; index < count; index += 1) {
    tray.push(createPiece(pickRandom(PUZZLE_SHAPES, random), id));
    id += 1;
  }

  if (count > 0 && !canPlaceAnyPiece(board, tray)) {
    tray[0] = createPiece(findShape("single"), tray[0] ? Number(tray[0].id.split("-")[1]) : id);
  }

  return { tray, nextPieceId: id };
}

export function createPuzzleState(options = {}) {
  const board = options.board ? cloneBoard(options.board) : createEmptyPuzzleBoard();
  const nextPieceId = options.nextPieceId || 1;
  const generated = options.tray
    ? { tray: options.tray.map((piece) => ({ ...piece, cells: piece.cells.map((cell) => ({ ...cell })) })), nextPieceId }
    : generateTray(board, 3, options.random || Math.random, nextPieceId);

  return {
    board,
    tray: generated.tray,
    selectedPieceId: null,
    score: options.score || 0,
    clearedLines: options.clearedLines || 0,
    combo: options.combo || 0,
    chargeProgress: options.chargeProgress || 0,
    lastPowerUp: null,
    status: options.status || "ready",
    nextPieceId: generated.nextPieceId,
  };
}

export function startPuzzle(state) {
  return state.status === "ready" ? { ...state, status: "running" } : state;
}

export function togglePuzzlePause(state) {
  if (state.status === "running") return { ...state, status: "paused", selectedPieceId: null };
  if (state.status === "paused") return { ...state, status: "running" };
  return state;
}

export function restartPuzzle(random = Math.random) {
  return { ...createPuzzleState({ random }), status: "running" };
}

export function selectPuzzlePiece(state, pieceId) {
  if (state.status !== "running") return state;
  if (!state.tray.some((piece) => piece.id === pieceId)) return state;
  return { ...state, selectedPieceId: state.selectedPieceId === pieceId ? null : pieceId };
}

function completedAxes(board) {
  const rows = [];
  const columns = [];
  for (let index = 0; index < PUZZLE_BOARD_SIZE; index += 1) {
    if (board[index].every(Boolean)) rows.push(index);
    if (board.every((row) => Boolean(row[index]))) columns.push(index);
  }
  return { rows, columns };
}

function clearCompletedAxes(board) {
  const axes = completedAxes(board);
  if (axes.rows.length === 0 && axes.columns.length === 0) return { board, cleared: 0 };
  const next = cloneBoard(board);
  axes.rows.forEach((row) => next[row].fill(null));
  axes.columns.forEach((column) => {
    for (let row = 0; row < PUZZLE_BOARD_SIZE; row += 1) next[row][column] = null;
  });
  return { board: next, cleared: axes.rows.length + axes.columns.length };
}

function occupiedAxes(board) {
  const candidates = [];
  for (let index = 0; index < PUZZLE_BOARD_SIZE; index += 1) {
    const rowCount = board[index].filter(Boolean).length;
    const columnCount = board.reduce((total, row) => total + (row[index] ? 1 : 0), 0);
    if (rowCount > 0) candidates.push({ axis: "row", index, count: rowCount });
    if (columnCount > 0) candidates.push({ axis: "column", index, count: columnCount });
  }
  const maximum = Math.max(0, ...candidates.map((candidate) => candidate.count));
  return candidates.filter((candidate) => candidate.count === maximum);
}

function denseAreas(board) {
  const candidates = [];
  for (let row = 0; row <= PUZZLE_BOARD_SIZE - 3; row += 1) {
    for (let column = 0; column <= PUZZLE_BOARD_SIZE - 3; column += 1) {
      let count = 0;
      for (let offsetRow = 0; offsetRow < 3; offsetRow += 1) {
        for (let offsetColumn = 0; offsetColumn < 3; offsetColumn += 1) {
          if (board[row + offsetRow][column + offsetColumn]) count += 1;
        }
      }
      if (count > 0) candidates.push({ row, column, count });
    }
  }
  const maximum = Math.max(0, ...candidates.map((candidate) => candidate.count));
  return candidates.filter((candidate) => candidate.count === maximum);
}

export function getAvailablePuzzlePowerUps(state) {
  const available = [];
  if (occupiedAxes(state.board).length > 0) available.push(PUZZLE_POWER_UPS.LINE_SWEEP);
  if (state.tray.length > 0) available.push(PUZZLE_POWER_UPS.TRAY_REFRESH);
  if (denseAreas(state.board).length > 0) available.push(PUZZLE_POWER_UPS.AREA_BLAST);
  return available;
}

export function applyPuzzlePowerUp(state, powerUpType, random = Math.random) {
  if (!POWER_UP_TYPES.includes(powerUpType)) return state;
  if (!getAvailablePuzzlePowerUps(state).includes(powerUpType)) return state;

  if (powerUpType === PUZZLE_POWER_UPS.TRAY_REFRESH) {
    const generated = generateTray(state.board, state.tray.length, random, state.nextPieceId);
    return {
      ...state,
      tray: generated.tray,
      nextPieceId: generated.nextPieceId,
      selectedPieceId: null,
      lastPowerUp: powerUpType,
    };
  }

  const board = cloneBoard(state.board);
  if (powerUpType === PUZZLE_POWER_UPS.LINE_SWEEP) {
    const target = pickRandom(occupiedAxes(board), random);
    if (target.axis === "row") board[target.index].fill(null);
    else for (let row = 0; row < PUZZLE_BOARD_SIZE; row += 1) board[row][target.index] = null;
  } else {
    const target = pickRandom(denseAreas(board), random);
    for (let offsetRow = 0; offsetRow < 3; offsetRow += 1) {
      for (let offsetColumn = 0; offsetColumn < 3; offsetColumn += 1) {
        board[target.row + offsetRow][target.column + offsetColumn] = null;
      }
    }
  }

  return { ...state, board, lastPowerUp: powerUpType };
}

export function clearPuzzlePowerUpNotice(state) {
  return state.lastPowerUp ? { ...state, lastPowerUp: null } : state;
}

export function placePuzzlePiece(state, row, column, random = Math.random) {
  if (state.status !== "running" || !state.selectedPieceId) return state;
  const piece = state.tray.find((candidate) => candidate.id === state.selectedPieceId);
  if (!piece || !canPlacePuzzlePiece(state.board, piece, row, column)) return state;

  const placedBoard = cloneBoard(state.board);
  piece.cells.forEach((cell) => {
    placedBoard[row + cell.row][column + cell.column] = piece.color;
  });

  const clearedResult = clearCompletedAxes(placedBoard);
  const combo = clearedResult.cleared > 0 ? state.combo + 1 : 0;
  const score = state.score
    + piece.cells.length
    + (10 * clearedResult.cleared * clearedResult.cleared)
    + (clearedResult.cleared > 0 ? 5 * Math.max(0, combo - 1) : 0);
  let tray = state.tray.filter((candidate) => candidate.id !== piece.id);
  let nextPieceId = state.nextPieceId;
  if (tray.length === 0) {
    const generated = generateTray(clearedResult.board, 3, random, nextPieceId);
    tray = generated.tray;
    nextPieceId = generated.nextPieceId;
  }

  let next = {
    ...state,
    board: clearedResult.board,
    tray,
    nextPieceId,
    selectedPieceId: null,
    score,
    clearedLines: state.clearedLines + clearedResult.cleared,
    combo,
    chargeProgress: state.chargeProgress + clearedResult.cleared,
    lastPowerUp: null,
  };

  if (next.chargeProgress >= PUZZLE_CHARGE_CLEARS) {
    const available = getAvailablePuzzlePowerUps(next);
    if (available.length > 0) {
      const powerUpType = pickRandom(available, random);
      next = applyPuzzlePowerUp(next, powerUpType, random);
      next = { ...next, chargeProgress: next.chargeProgress - PUZZLE_CHARGE_CLEARS };
    }
  }

  if (!canPlaceAnyPiece(next.board, next.tray)) next = { ...next, status: "gameover" };
  return next;
}

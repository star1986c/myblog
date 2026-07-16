import assert from "node:assert/strict";
import test from "node:test";

import {
  PUZZLE_BOARD_SIZE,
  PUZZLE_POWER_UPS,
  applyPuzzlePowerUp,
  canPlaceAnyPiece,
  canPlacePuzzlePiece,
  createEmptyPuzzleBoard,
  createPuzzleState,
  getValidPlacements,
  placePuzzlePiece,
  restartPuzzle,
  selectPuzzlePiece,
  startPuzzle,
  togglePuzzlePause,
} from "../public/assets/block-puzzle-core.20260716.js";

function fixedRandom(value = 0) {
  return () => value;
}

function piece(id, cells, color = "cyan") {
  return { id, shape: id, color, cells: cells.map(([column, row]) => ({ column, row })) };
}

function runningState(options = {}) {
  return createPuzzleState({
    random: fixedRandom(),
    status: "running",
    ...options,
  });
}

test("block puzzle initializes an 8x8 board and three-piece tray", () => {
  const state = createPuzzleState({ random: fixedRandom() });
  assert.equal(state.board.length, PUZZLE_BOARD_SIZE);
  assert.ok(state.board.every((row) => row.length === PUZZLE_BOARD_SIZE));
  assert.equal(state.tray.length, 3);
  assert.equal(state.status, "ready");
});

test("valid placements stay inside the board and avoid occupied cells", () => {
  const board = createEmptyPuzzleBoard();
  const domino = piece("domino", [[0, 0], [1, 0]]);
  board[0][0] = "blue";
  assert.equal(canPlacePuzzlePiece(board, domino, 0, 0), false);
  assert.equal(canPlacePuzzlePiece(board, domino, 0, 1), true);
  assert.equal(canPlacePuzzlePiece(board, domino, 0, 7), false);
  assert.equal(getValidPlacements(board, domino).length, 55);
});

test("piece selection toggles only while the game is running", () => {
  const ready = createPuzzleState({ random: fixedRandom() });
  assert.equal(selectPuzzlePiece(ready, ready.tray[0].id), ready);
  const running = startPuzzle(ready);
  const selected = selectPuzzlePiece(running, running.tray[0].id);
  assert.equal(selected.selectedPieceId, running.tray[0].id);
  assert.equal(selectPuzzlePiece(selected, running.tray[0].id).selectedPieceId, null);
});

test("invalid placement returns the original state", () => {
  const board = createEmptyPuzzleBoard();
  board[0][0] = "green";
  const state = runningState({ board, tray: [piece("single", [[0, 0]])] });
  const selected = selectPuzzlePiece(state, "single");
  assert.equal(placePuzzlePiece(selected, 0, 0, fixedRandom()), selected);
});

test("using the final tray piece refills the tray", () => {
  const state = runningState({ tray: [piece("single", [[0, 0]])], nextPieceId: 10 });
  const selected = selectPuzzlePiece(state, "single");
  const next = placePuzzlePiece(selected, 0, 0, fixedRandom());
  assert.equal(next.tray.length, 3);
  assert.equal(next.nextPieceId, 13);
  assert.equal(next.score, 1);
  assert.equal(next.board[0][0], "cyan");
});

test("one placement clears a completed row and column simultaneously", () => {
  const board = createEmptyPuzzleBoard();
  for (let index = 0; index < PUZZLE_BOARD_SIZE - 1; index += 1) {
    board[7][index] = "blue";
    board[index][7] = "green";
  }
  const state = runningState({ board, tray: [piece("single", [[0, 0]])] });
  const next = placePuzzlePiece(selectPuzzlePiece(state, "single"), 7, 7, fixedRandom());
  assert.equal(next.clearedLines, 2);
  assert.equal(next.score, 41);
  assert.equal(next.combo, 1);
  assert.ok(next.board[7].every((cell) => cell === null));
  assert.ok(next.board.every((row) => row[7] === null));
});

test("consecutive clearing placements award combo points and misses reset combo", () => {
  const board = createEmptyPuzzleBoard();
  for (let column = 0; column < 7; column += 1) board[0][column] = "blue";
  const firstState = runningState({ board, tray: [piece("first", [[0, 0]]), piece("second", [[0, 0]]), piece("third", [[0, 0]])] });
  const first = placePuzzlePiece(selectPuzzlePiece(firstState, "first"), 0, 7, fixedRandom());
  const nextBoard = first.board.map((row) => [...row]);
  for (let column = 0; column < 7; column += 1) nextBoard[1][column] = "violet";
  const prepared = { ...first, board: nextBoard };
  const second = placePuzzlePiece(selectPuzzlePiece(prepared, "second"), 1, 7, fixedRandom());
  assert.equal(second.score - first.score, 16);
  assert.equal(second.combo, 2);
  const missed = placePuzzlePiece(selectPuzzlePiece(second, "third"), 2, 0, fixedRandom());
  assert.equal(missed.combo, 0);
});

test("line sweep removes the fullest occupied axis without changing scoring", () => {
  const board = createEmptyPuzzleBoard();
  board[7].fill("coral", 0, 6);
  board[6].fill("blue", 0, 3);
  const state = runningState({ board, score: 25, clearedLines: 3, chargeProgress: 3 });
  const next = applyPuzzlePowerUp(state, PUZZLE_POWER_UPS.LINE_SWEEP, fixedRandom());
  assert.ok(next.board[7].every((cell) => cell === null));
  assert.equal(next.score, 25);
  assert.equal(next.clearedLines, 3);
  assert.equal(next.chargeProgress, 3);
});

test("tray refresh replaces all remaining pieces and preserves tray length", () => {
  const state = runningState({ tray: [piece("one", [[0, 0]]), piece("two", [[0, 0]])], nextPieceId: 20 });
  const next = applyPuzzlePowerUp(state, PUZZLE_POWER_UPS.TRAY_REFRESH, fixedRandom());
  assert.equal(next.tray.length, 2);
  assert.deepEqual(next.tray.map((item) => item.id), ["piece-20", "piece-21"]);
  assert.equal(next.selectedPieceId, null);
});

test("area blast clears the densest 3x3 region", () => {
  const board = createEmptyPuzzleBoard();
  for (let row = 4; row < 7; row += 1) {
    for (let column = 3; column < 6; column += 1) board[row][column] = "yellow";
  }
  const state = runningState({ board });
  const next = applyPuzzlePowerUp(state, PUZZLE_POWER_UPS.AREA_BLAST, fixedRandom());
  for (let row = 4; row < 7; row += 1) {
    for (let column = 3; column < 6; column += 1) assert.equal(next.board[row][column], null);
  }
});

test("four natural clears trigger at most one automatic power-up and retain overflow", () => {
  const board = createEmptyPuzzleBoard();
  for (let index = 0; index < PUZZLE_BOARD_SIZE - 1; index += 1) {
    board[7][index] = "blue";
    board[index][7] = "green";
  }
  const state = runningState({
    board,
    tray: [piece("single", [[0, 0]]), piece("spare", [[0, 0]])],
    chargeProgress: 3,
  });
  const next = placePuzzlePiece(selectPuzzlePiece(state, "single"), 7, 7, fixedRandom());
  assert.equal(next.chargeProgress, 1);
  assert.ok(Object.values(PUZZLE_POWER_UPS).includes(next.lastPowerUp));
  assert.equal(next.clearedLines, 2);
});

test("game over occurs only when no remaining tray piece fits", () => {
  const fullBoard = Array.from({ length: PUZZLE_BOARD_SIZE }, () => Array(PUZZLE_BOARD_SIZE).fill("blue"));
  const oversized = piece("square", [[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.equal(canPlaceAnyPiece(fullBoard, [oversized]), false);

  const board = Array.from({ length: PUZZLE_BOARD_SIZE }, () => Array(PUZZLE_BOARD_SIZE).fill("blue"));
  for (let index = 0; index < PUZZLE_BOARD_SIZE; index += 1) board[index][index] = null;
  board[7][0] = null;
  const state = runningState({ board, tray: [piece("single", [[0, 0]]), oversized] });
  const next = placePuzzlePiece(selectPuzzlePiece(state, "single"), 0, 0, fixedRandom());
  assert.equal(next.status, "gameover");
});

test("pause and restart preserve predictable status transitions", () => {
  const state = startPuzzle(createPuzzleState({ random: fixedRandom() }));
  const paused = togglePuzzlePause(state);
  assert.equal(paused.status, "paused");
  assert.equal(togglePuzzlePause(paused).status, "running");
  const restarted = restartPuzzle(fixedRandom());
  assert.equal(restarted.status, "running");
  assert.equal(restarted.score, 0);
});

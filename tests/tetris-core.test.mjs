import assert from "node:assert/strict";
import test from "node:test";

import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  HIDDEN_ROWS,
  TETROMINO_TYPES,
  advanceGravity,
  createEmptyBoard,
  createGameState,
  createSevenBag,
  getGhostPosition,
  getGravityInterval,
  getPieceCells,
  hardDrop,
  movePiece,
  rotatePiece,
  softDrop,
  startGame,
  tick,
} from "../public/assets/tetris-core.20260711.js";

function fixedRandom(value = 0) {
  return () => value;
}

function runningState(overrides = {}) {
  return {
    ...createGameState({ random: fixedRandom(), status: "running" }),
    ...overrides,
  };
}

test("seven-bag contains every tetromino exactly once", () => {
  const bag = createSevenBag(fixedRandom(0.42));
  assert.equal(bag.length, 7);
  assert.deepEqual([...bag].sort(), [...TETROMINO_TYPES].sort());
});

test("new games use a centered spawn position inside the hidden rows", () => {
  const state = createGameState({ random: fixedRandom() });
  assert.equal(state.active.x, 3);
  assert.equal(state.active.y, 0);
  assert.ok(getPieceCells(state.active).some(({ y }) => y < HIDDEN_ROWS));
  assert.equal(state.queue.length, 5);
});

test("movement stops at the board boundary", () => {
  let state = runningState();
  for (let index = 0; index < BOARD_WIDTH; index += 1) state = movePiece(state, -1);
  const leftmost = Math.min(...getPieceCells(state.active).map(({ x }) => x));
  assert.equal(leftmost, 0);
  assert.equal(movePiece(state, -1), state);
});

test("I piece uses an SRS wall kick when rotating beside the left wall", () => {
  const state = runningState({
    active: { type: "I", rotation: 1, x: -2, y: 4 },
  });
  const rotated = rotatePiece(state, 1);
  assert.equal(rotated.active.rotation, 2);
  assert.equal(rotated.active.x, 0);
});

test("soft drop moves one cell and awards one point", () => {
  const state = runningState();
  const dropped = softDrop(state);
  assert.equal(dropped.active.y, state.active.y + 1);
  assert.equal(dropped.score, 1);
});

test("ghost position and hard drop reach the same landing row", () => {
  const state = runningState({ active: { type: "T", rotation: 0, x: 3, y: 0 } });
  const ghost = getGhostPosition(state);
  const dropped = hardDrop(state, fixedRandom());
  const occupiedRows = dropped.board
    .map((row, index) => (row.includes("T") ? index : -1))
    .filter((index) => index >= 0);

  assert.equal(Math.max(...getPieceCells(ghost).map(({ y }) => y)), BOARD_HEIGHT - 1);
  assert.equal(Math.max(...occupiedRows), BOARD_HEIGHT - 1);
  assert.equal(dropped.score, (ghost.y - state.active.y) * 2);
});

test("clearing a line awards score and advances the level every ten lines", () => {
  const board = createEmptyBoard();
  for (let x = 0; x < 6; x += 1) board[BOARD_HEIGHT - 1][x] = "J";
  const state = runningState({
    board,
    active: { type: "I", rotation: 0, x: 6, y: BOARD_HEIGHT - 2 },
    lines: 9,
  });
  const dropped = hardDrop(state, fixedRandom());

  assert.equal(dropped.lines, 10);
  assert.equal(dropped.level, 2);
  assert.equal(dropped.score, 100);
});

test("gravity interval accelerates by level and never falls below 100ms", () => {
  assert.equal(getGravityInterval(1), 1000);
  assert.equal(getGravityInterval(2), 920);
  assert.equal(getGravityInterval(100), 100);
});

test("tick accumulates time and advances only after the gravity interval", () => {
  const state = startGame(createGameState({ random: fixedRandom() }));
  const waiting = tick(state, 999, fixedRandom());
  const advanced = tick(waiting, 1, fixedRandom());
  assert.equal(waiting.active.y, state.active.y);
  assert.equal(advanced.active.y, state.active.y + 1);
});

test("locking a piece in hidden rows ends the game", () => {
  const board = createEmptyBoard();
  board[2][4] = "J";
  board[2][5] = "J";
  const state = runningState({
    board,
    active: { type: "O", rotation: 0, x: 3, y: 0 },
  });
  const ended = advanceGravity(state, fixedRandom());
  assert.equal(ended.status, "gameover");
});

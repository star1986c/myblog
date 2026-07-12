import assert from "node:assert/strict";
import test from "node:test";

import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  GAME_MODES,
  HIDDEN_ROWS,
  POWER_UPS,
  TETROMINO_TYPES,
  advanceGravity,
  canUsePowerUp,
  createEmptyBoard,
  createGameState,
  createSevenBag,
  getGhostPosition,
  getGravityInterval,
  getPieceCells,
  hardDrop,
  movePiece,
  restartGame,
  rotatePiece,
  setGameMode,
  softDrop,
  startGame,
  tick,
  togglePause,
  usePowerUp,
} from "../public/assets/tetris-core.20260712.js";

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

test("classic and power-up games initialize and restart with separate modes", () => {
  const classic = createGameState({ random: fixedRandom() });
  const selected = setGameMode(classic, GAME_MODES.POWER_UP, fixedRandom());
  const restarted = restartGame(fixedRandom(), selected.mode);

  assert.equal(classic.mode, GAME_MODES.CLASSIC);
  assert.equal(selected.mode, GAME_MODES.POWER_UP);
  assert.equal(selected.status, "ready");
  assert.equal(restarted.mode, GAME_MODES.POWER_UP);
  assert.equal(restarted.status, "running");
});

test("mode changes are blocked while a game is running", () => {
  const state = runningState();
  assert.equal(setGameMode(state, GAME_MODES.POWER_UP, fixedRandom()), state);
});

test("natural line clears charge one energy for every four lines", () => {
  const board = createEmptyBoard();
  for (let x = 0; x < 6; x += 1) board[BOARD_HEIGHT - 1][x] = "J";
  const state = runningState({
    board,
    active: { type: "I", rotation: 0, x: 6, y: BOARD_HEIGHT - 2 },
    mode: GAME_MODES.POWER_UP,
    chargeProgress: 3,
  });
  const dropped = hardDrop(state, fixedRandom());

  assert.equal(dropped.lines, 1);
  assert.equal(dropped.energy, 1);
  assert.equal(dropped.chargeProgress, 0);
});

test("power-up charge caps at three energy without hidden progress", () => {
  const board = createEmptyBoard();
  for (let x = 0; x < 6; x += 1) board[BOARD_HEIGHT - 1][x] = "J";
  const state = runningState({
    board,
    active: { type: "I", rotation: 0, x: 6, y: BOARD_HEIGHT - 2 },
    mode: GAME_MODES.POWER_UP,
    energy: 3,
    chargeProgress: 2,
  });
  const dropped = hardDrop(state, fixedRandom());

  assert.equal(dropped.energy, 3);
  assert.equal(dropped.chargeProgress, 0);
});

test("row blast removes the bottom occupied row without score, lines, or charge", () => {
  const board = createEmptyBoard();
  board[BOARD_HEIGHT - 1][0] = "T";
  board[BOARD_HEIGHT - 2][1] = "J";
  const state = runningState({
    board,
    mode: GAME_MODES.POWER_UP,
    energy: 1,
    chargeProgress: 3,
  });
  const used = usePowerUp(state, POWER_UPS.ROW_BLAST);

  assert.equal(used.board.length, BOARD_HEIGHT);
  assert.equal(used.board[BOARD_HEIGHT - 1][1], "J");
  assert.equal(used.energy, 0);
  assert.equal(used.score, 0);
  assert.equal(used.lines, 0);
  assert.equal(used.chargeProgress, 3);
});

test("row blast is unavailable without an occupied row and does not spend energy", () => {
  const state = runningState({ mode: GAME_MODES.POWER_UP, energy: 1 });
  assert.equal(canUsePowerUp(state, POWER_UPS.ROW_BLAST), false);
  assert.equal(usePowerUp(state, POWER_UPS.ROW_BLAST), state);
});

test("queue shift moves only the next piece to the back", () => {
  const state = runningState({
    mode: GAME_MODES.POWER_UP,
    energy: 1,
    queue: ["I", "J", "L", "O", "S"],
  });
  const used = usePowerUp(state, POWER_UPS.QUEUE_SHIFT);

  assert.deepEqual(used.queue, ["J", "L", "O", "S", "I"]);
  assert.deepEqual([...used.queue].sort(), [...state.queue].sort());
  assert.equal(used.energy, 0);
});

test("slow time halves effective gravity for ten running seconds", () => {
  const state = runningState({ mode: GAME_MODES.POWER_UP, energy: 1 });
  const slowed = usePowerUp(state, POWER_UPS.SLOW_TIME);
  const firstSecond = tick(slowed, 1000, fixedRandom());
  const secondSecond = tick(firstSecond, 1000, fixedRandom());

  assert.equal(slowed.slowRemainingMs, 10_000);
  assert.equal(firstSecond.active.y, state.active.y);
  assert.equal(firstSecond.slowRemainingMs, 9000);
  assert.equal(secondSecond.active.y, state.active.y + 1);
});

test("slow time handles its expiry boundary and freezes while paused", () => {
  const state = runningState({
    mode: GAME_MODES.POWER_UP,
    energy: 0,
    slowRemainingMs: 500,
  });
  const boundary = tick(state, 1000, fixedRandom());
  const advanced = tick(boundary, 250, fixedRandom());
  const paused = togglePause({ ...state, slowRemainingMs: 4000 });

  assert.equal(boundary.slowRemainingMs, 0);
  assert.equal(boundary.active.y, state.active.y);
  assert.equal(advanced.active.y, state.active.y + 1);
  assert.equal(tick(paused, 2000, fixedRandom()), paused);
  assert.equal(paused.slowRemainingMs, 4000);
});

test("power-ups require power-up mode, a running game, and available energy", () => {
  const classic = runningState({ energy: 1 });
  const ready = createGameState({ random: fixedRandom(), mode: GAME_MODES.POWER_UP });
  const empty = runningState({ mode: GAME_MODES.POWER_UP, energy: 0 });
  const activeSlow = runningState({ mode: GAME_MODES.POWER_UP, energy: 1, slowRemainingMs: 1000 });

  assert.equal(usePowerUp(classic, POWER_UPS.QUEUE_SHIFT), classic);
  assert.equal(usePowerUp({ ...ready, energy: 1 }, POWER_UPS.QUEUE_SHIFT).status, "ready");
  assert.equal(usePowerUp(empty, POWER_UPS.QUEUE_SHIFT), empty);
  assert.equal(usePowerUp(activeSlow, POWER_UPS.SLOW_TIME), activeSlow);
});

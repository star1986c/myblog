import assert from "node:assert/strict";
import test from "node:test";

import {
  MATCH_THREE_BOARD_SIZE,
  MATCH_THREE_POWER_UPS,
  MATCH_THREE_STARTING_MOVES,
  MATCH_THREE_TARGET_SCORE,
  createMatchThreeState,
  detectMatchPowerUp,
  ensurePlayableMatchBoard,
  findMatchRuns,
  generateStableMatchBoard,
  hasAvailableMatch,
  restartMatchThree,
  selectMatchGem,
  startMatchThree,
  swapMatchGems,
  toggleMatchThreePause,
} from "../public/assets/match-three-core.20260716.js";

const TYPES = ["rose", "violet", "amber", "cyan", "mint", "coral"];

function seededRandom(seed = 17) {
  let value = seed >>> 0;
  return () => {
    value = ((value * 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function boardFromTypes(rows, specials = {}) {
  let id = 1;
  return rows.map((row, rowIndex) => row.map((type, columnIndex) => ({
    id: `gem-${id++}`,
    type,
    powerUp: specials[`${rowIndex}:${columnIndex}`] || null,
  })));
}

function baseRows() {
  return [
    ["rose", "violet", "rose", "amber", "cyan", "mint", "coral", "violet"],
    ["violet", "rose", "violet", "cyan", "mint", "coral", "amber", "cyan"],
    ["amber", "cyan", "mint", "coral", "rose", "violet", "cyan", "mint"],
    ["cyan", "mint", "coral", "rose", "violet", "amber", "mint", "coral"],
    ["mint", "coral", "rose", "violet", "amber", "cyan", "coral", "rose"],
    ["coral", "amber", "violet", "cyan", "mint", "rose", "amber", "violet"],
    ["rose", "violet", "cyan", "mint", "coral", "amber", "violet", "cyan"],
    ["violet", "cyan", "mint", "coral", "amber", "rose", "cyan", "mint"],
  ];
}

function runningState(board, options = {}) {
  return createMatchThreeState({ board, status: "running", ...options });
}

test("match-three initializes a stable 8x8 board with a legal move", () => {
  const state = createMatchThreeState({ random: seededRandom() });
  assert.equal(state.board.length, MATCH_THREE_BOARD_SIZE);
  assert.ok(state.board.every((row) => row.length === MATCH_THREE_BOARD_SIZE));
  assert.equal(findMatchRuns(state.board).length, 0);
  assert.equal(hasAvailableMatch(state.board), true);
  assert.equal(state.movesRemaining, MATCH_THREE_STARTING_MOVES);
  assert.equal(state.targetScore, MATCH_THREE_TARGET_SCORE);
  assert.equal(state.status, "ready");
});

test("stable generation remains playable with a constant random source", () => {
  const generated = generateStableMatchBoard(() => 0);
  assert.equal(findMatchRuns(generated.board).length, 0);
  assert.equal(hasAvailableMatch(generated.board), true);
});

test("a deadlocked stable board is automatically reshuffled", () => {
  let id = 1;
  const deadlocked = Array.from({ length: MATCH_THREE_BOARD_SIZE }, (_, row) => (
    Array.from({ length: MATCH_THREE_BOARD_SIZE }, (_, column) => ({
      id: `gem-${id++}`,
      type: TYPES[(row + column) % TYPES.length],
      powerUp: null,
    }))
  ));
  assert.equal(findMatchRuns(deadlocked).length, 0);
  assert.equal(hasAvailableMatch(deadlocked), false);
  const result = ensurePlayableMatchBoard(deadlocked, seededRandom());
  assert.equal(result.reshuffled, true);
  assert.equal(findMatchRuns(result.board).length, 0);
  assert.equal(hasAvailableMatch(result.board), true);
});

test("tap selection changes focus and adjacent taps attempt a swap", () => {
  const state = runningState(boardFromTypes(baseRows()));
  const selected = selectMatchGem(state, 0, 0, seededRandom());
  assert.deepEqual(selected.selectedGem, { row: 0, column: 0 });
  assert.equal(selectMatchGem(selected, 0, 0, seededRandom()).selectedGem, null);
  const moved = selectMatchGem(selectMatchGem(state, 0, 1), 1, 1, seededRandom());
  assert.equal(moved.lastMove.valid, true);
});

test("a swap without a match is rejected without spending a move", () => {
  const state = runningState(boardFromTypes(baseRows()));
  const next = swapMatchGems(state, { row: 7, column: 6 }, { row: 7, column: 7 }, seededRandom());
  assert.equal(next.lastMove.valid, false);
  assert.equal(next.movesRemaining, MATCH_THREE_STARTING_MOVES);
  assert.equal(next.score, 0);
  assert.deepEqual(next.board, state.board);
});

test("a legal swap clears matches, scores, cascades, and spends one move", () => {
  const state = runningState(boardFromTypes(baseRows()));
  const next = swapMatchGems(state, { row: 0, column: 1 }, { row: 1, column: 1 }, seededRandom(4));
  assert.equal(next.lastMove.valid, true);
  assert.ok(next.lastMove.cleared >= 6);
  assert.ok(next.lastMove.scoreGained > 0);
  assert.equal(next.movesRemaining, MATCH_THREE_STARTING_MOVES - 1);
  assert.equal(findMatchRuns(next.board).length, 0);
  assert.equal(hasAvailableMatch(next.board), true);
});

test("four in a row creates a row rocket at the preferred cell", () => {
  const rows = baseRows();
  rows[0] = ["rose", "rose", "rose", "rose", ...TYPES.slice(2, 6)];
  const board = boardFromTypes(rows);
  const creation = detectMatchPowerUp(board, findMatchRuns(board), { row: 0, column: 1 });
  assert.deepEqual(creation, { row: 0, column: 1, type: MATCH_THREE_POWER_UPS.ROW_ROCKET });
});

test("a four-match swap keeps the created rocket on the resolved board and exposes its event", () => {
  const rows = baseRows();
  rows[0] = ["rose", "violet", "rose", "rose", "cyan", "mint", "coral", "amber"];
  const state = runningState(boardFromTypes(rows));
  const next = swapMatchGems(state, { row: 0, column: 1 }, { row: 1, column: 1 }, seededRandom(21));
  assert.equal(next.lastMove.valid, true);
  assert.ok(next.lastMove.powerEvents.some((event) => (
    event.type === MATCH_THREE_POWER_UPS.ROW_ROCKET && event.action === "created"
  )));
  assert.ok(next.board.flat().some((cell) => cell.powerUp === MATCH_THREE_POWER_UPS.ROW_ROCKET));
});

test("five in a row creates a rainbow gem", () => {
  const rows = baseRows();
  rows[2] = ["mint", "mint", "mint", "mint", "mint", "rose", "violet", "amber"];
  const board = boardFromTypes(rows);
  const creation = detectMatchPowerUp(board, findMatchRuns(board), { row: 2, column: 3 });
  assert.deepEqual(creation, { row: 2, column: 3, type: MATCH_THREE_POWER_UPS.RAINBOW });
});

test("intersecting row and column matches create a bomb", () => {
  const rows = baseRows();
  rows[2][3] = "coral";
  rows[3][2] = "coral";
  rows[3][3] = "coral";
  rows[3][4] = "coral";
  rows[4][3] = "coral";
  const board = boardFromTypes(rows);
  const creation = detectMatchPowerUp(board, findMatchRuns(board), { row: 3, column: 3 });
  assert.deepEqual(creation, { row: 3, column: 3, type: MATCH_THREE_POWER_UPS.BOMB });
});

test("swapping a row rocket triggers a whole-row clear", () => {
  const board = boardFromTypes(baseRows(), { "4:3": MATCH_THREE_POWER_UPS.ROW_ROCKET });
  const state = runningState(board);
  const next = swapMatchGems(state, { row: 4, column: 3 }, { row: 4, column: 4 }, seededRandom(9));
  assert.equal(next.lastMove.valid, true);
  assert.ok(next.lastMove.cleared >= MATCH_THREE_BOARD_SIZE);
  assert.ok(next.lastMove.powerEvents.some((event) => event.type === MATCH_THREE_POWER_UPS.ROW_ROCKET && event.action === "triggered"));
});

test("swapping a rainbow clears every gem matching its neighbor", () => {
  const board = boardFromTypes(baseRows(), { "5:4": MATCH_THREE_POWER_UPS.RAINBOW });
  const targetType = board[5][5].type;
  const expected = board.flat().filter((cell) => cell.type === targetType).length;
  const state = runningState(board);
  const next = swapMatchGems(state, { row: 5, column: 4 }, { row: 5, column: 5 }, seededRandom(11));
  assert.ok(next.lastMove.cleared >= expected);
  assert.ok(next.lastMove.powerEvents.some((event) => event.type === MATCH_THREE_POWER_UPS.RAINBOW));
});

test("reaching the target wins while using the last move without it ends the game", () => {
  const board = boardFromTypes(baseRows());
  const almostWon = runningState(board, { score: MATCH_THREE_TARGET_SCORE - 1, movesRemaining: 1 });
  const won = swapMatchGems(almostWon, { row: 0, column: 1 }, { row: 1, column: 1 }, seededRandom(3));
  assert.equal(won.status, "won");

  const lastMove = runningState(board, { targetScore: 999999, movesRemaining: 1 });
  const lost = swapMatchGems(lastMove, { row: 0, column: 1 }, { row: 1, column: 1 }, seededRandom(3));
  assert.equal(lost.status, "gameover");
});

test("pause and restart keep predictable lifecycle state", () => {
  const running = startMatchThree(createMatchThreeState({ random: seededRandom() }));
  const paused = toggleMatchThreePause(running);
  assert.equal(paused.status, "paused");
  assert.equal(toggleMatchThreePause(paused).status, "running");
  const restarted = restartMatchThree(seededRandom());
  assert.equal(restarted.status, "running");
  assert.equal(restarted.score, 0);
  assert.equal(restarted.movesRemaining, MATCH_THREE_STARTING_MOVES);
});

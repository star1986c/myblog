import assert from "node:assert/strict";
import test from "node:test";

import {
  PASSWORD_CHARSETS,
  buildPasswordPools,
  estimatePasswordStrength,
  generatePasswords,
  secureRandomIndex,
} from "../public/assets/password-tool-core.20260710.js";

function sequenceRandom(values = [0, 1, 2, 3, 4, 5, 6, 7]) {
  let index = 0;
  return () => values[index++ % values.length];
}

test("password generator uses every selected character category", () => {
  const [password] = generatePasswords({
    length: 16,
    count: 1,
    lowercase: true,
    uppercase: true,
    numbers: true,
    symbols: true,
    excludeEnabled: false,
  }, sequenceRandom());

  assert.equal(password.length, 16);
  assert.match(password, /[a-z]/);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[0-9]/);
  assert.match(password, /[!@#$%^&*()\-_=+\[\]{};:,.?]/);
});

test("password generator honors excluded characters and requested count", () => {
  const passwords = generatePasswords({
    length: 24,
    count: 5,
    lowercase: true,
    uppercase: true,
    numbers: true,
    symbols: false,
    excludeEnabled: true,
    excluded: "il1oO0",
  }, sequenceRandom([0, 9, 18, 27, 36, 45, 54, 63]));

  assert.equal(passwords.length, 5);
  assert.ok(passwords.every((password) => password.length === 24));
  assert.ok(passwords.every((password) => !/[il1oO0]/.test(password)));
});

test("password pool validation rejects missing and emptied categories", () => {
  assert.throws(() => buildPasswordPools({
    lowercase: false,
    uppercase: false,
    numbers: false,
    symbols: false,
  }), /至少选择一种字符类型/);

  assert.throws(() => buildPasswordPools({
    lowercase: false,
    uppercase: false,
    numbers: true,
    symbols: false,
    excluded: PASSWORD_CHARSETS.numbers,
  }), /移除全部数字/);
});

test("password generator validates length against selected categories", () => {
  assert.throws(() => generatePasswords({
    length: 3,
    count: 1,
  }, sequenceRandom()), /4 到 128/);
});

test("secure random index retries samples outside the unbiased range", () => {
  let calls = 0;
  const value = secureRandomIndex(10, () => {
    calls += 1;
    return calls === 1 ? 0xffffffff : 17;
  });

  assert.equal(value, 7);
  assert.equal(calls, 2);
});

test("strength estimate grows with password length", () => {
  const short = estimatePasswordStrength({ length: 8 });
  const long = estimatePasswordStrength({ length: 32 });

  assert.ok(long.bits > short.bits);
  assert.equal(long.level, "excellent");
});

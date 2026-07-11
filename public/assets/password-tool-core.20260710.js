export const PASSWORD_CHARSETS = Object.freeze({
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  numbers: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?",
});

const UINT32_RANGE = 0x1_0000_0000;

function uniqueCharacters(value) {
  return [...new Set(value)].join("");
}

function defaultRandomUint32() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("This browser does not support secure random number generation.");
  }

  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0];
}

export function secureRandomIndex(max, randomUint32 = defaultRandomUint32) {
  if (!Number.isInteger(max) || max <= 0 || max > UINT32_RANGE) {
    throw new RangeError("The random range must be a valid positive integer.");
  }

  const limit = Math.floor(UINT32_RANGE / max) * max;
  let value = randomUint32();
  while (!Number.isInteger(value) || value < 0 || value >= limit) {
    value = randomUint32();
  }

  return value % max;
}

export function buildPasswordPools(options = {}) {
  const enabled = {
    lowercase: options.lowercase !== false,
    uppercase: options.uppercase !== false,
    numbers: options.numbers !== false,
    symbols: options.symbols === true,
  };
  const excluded = new Set(options.excludeEnabled === false ? "" : String(options.excluded || ""));
  const pools = Object.entries(PASSWORD_CHARSETS)
    .filter(([name]) => enabled[name])
    .map(([name, characters]) => ({
      name,
      characters: [...characters].filter((character) => !excluded.has(character)).join(""),
    }));

  if (pools.length === 0) {
    throw new Error("Select at least one character type.");
  }

  const emptyPool = pools.find((pool) => pool.characters.length === 0);
  if (emptyPool) {
    const labels = {
      lowercase: "lowercase letters",
      uppercase: "uppercase letters",
      numbers: "numbers",
      symbols: "symbols",
    };
    throw new Error(`The exclusion list removes all ${labels[emptyPool.name]}. Adjust your settings.`);
  }

  return pools;
}

export function generatePasswords(options = {}, randomUint32 = defaultRandomUint32) {
  const length = Number(options.length ?? 16);
  const count = Number(options.count ?? 1);

  if (!Number.isInteger(length) || length < 4 || length > 128) {
    throw new Error("Password length must be between 4 and 128 characters.");
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Password quantity must be between 1 and 20.");
  }

  const pools = buildPasswordPools(options);
  if (length < pools.length) {
    throw new Error(`Password length cannot be shorter than the ${pools.length} selected character types.`);
  }

  const combined = uniqueCharacters(pools.map((pool) => pool.characters).join(""));
  return Array.from({ length: count }, () => {
    const password = pools.map((pool) => (
      pool.characters[secureRandomIndex(pool.characters.length, randomUint32)]
    ));

    while (password.length < length) {
      password.push(combined[secureRandomIndex(combined.length, randomUint32)]);
    }

    for (let index = password.length - 1; index > 0; index -= 1) {
      const target = secureRandomIndex(index + 1, randomUint32);
      [password[index], password[target]] = [password[target], password[index]];
    }

    return password.join("");
  });
}

export function estimatePasswordStrength(options = {}) {
  const pools = buildPasswordPools(options);
  const alphabetSize = uniqueCharacters(pools.map((pool) => pool.characters).join("")).length;
  const bits = Math.round(Number(options.length ?? 16) * Math.log2(alphabetSize));

  if (bits >= 100) return { bits, label: "Excellent", level: "excellent" };
  if (bits >= 70) return { bits, label: "Strong", level: "strong" };
  if (bits >= 50) return { bits, label: "Moderate", level: "medium" };
  return { bits, label: "Weak", level: "weak" };
}

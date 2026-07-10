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
    throw new Error("当前浏览器不支持安全随机数生成。");
  }

  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0];
}

export function secureRandomIndex(max, randomUint32 = defaultRandomUint32) {
  if (!Number.isInteger(max) || max <= 0 || max > UINT32_RANGE) {
    throw new RangeError("随机范围必须是有效的正整数。");
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
    throw new Error("请至少选择一种字符类型。");
  }

  const emptyPool = pools.find((pool) => pool.characters.length === 0);
  if (emptyPool) {
    const labels = {
      lowercase: "小写字母",
      uppercase: "大写字母",
      numbers: "数字",
      symbols: "特殊字符",
    };
    throw new Error(`排除字符已移除全部${labels[emptyPool.name]}，请调整设置。`);
  }

  return pools;
}

export function generatePasswords(options = {}, randomUint32 = defaultRandomUint32) {
  const length = Number(options.length ?? 16);
  const count = Number(options.count ?? 1);

  if (!Number.isInteger(length) || length < 4 || length > 128) {
    throw new Error("密码长度必须在 4 到 128 位之间。");
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("密码数量必须在 1 到 20 个之间。");
  }

  const pools = buildPasswordPools(options);
  if (length < pools.length) {
    throw new Error(`密码长度不能小于已选择的 ${pools.length} 种字符类型。`);
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

  if (bits >= 100) return { bits, label: "很强", level: "excellent" };
  if (bits >= 70) return { bits, label: "强", level: "strong" };
  if (bits >= 50) return { bits, label: "中等", level: "medium" };
  return { bits, label: "较弱", level: "weak" };
}

import { createPasswordHash } from "../src/auth.js";

const password = process.argv[2];

if (!password) {
  console.error("Usage: node scripts/hash-password.mjs '<admin-password>'");
  process.exit(1);
}

console.log(await createPasswordHash(password));

import assert from "node:assert/strict";
import test from "node:test";
import {
  KDF_ITERATIONS,
  KDF_NAME,
  MIN_MASTER_PASSWORD_LENGTH,
  changePasswordVaultMasterPassword,
  createPasswordVault,
  decryptPasswordVaultEntry,
  encryptPasswordVaultEntry,
  unlockPasswordVault,
  validateMasterPassword,
} from "../public/assets/password-vault-core.20260713.js";

const MASTER_PASSWORD = "correct horse battery staple";
const NEXT_MASTER_PASSWORD = "new correct horse battery staple";

test("creates a versioned vault whose master password and data key are not stored as plaintext", async () => {
  const { vault } = await createPasswordVault(MASTER_PASSWORD);

  assert.equal(vault.kdf, KDF_NAME);
  assert.equal(vault.iterations, KDF_ITERATIONS);
  assert.equal(vault.version, 1);
  assert.equal(vault.id, "default");
  assert.doesNotMatch(JSON.stringify(vault), /correct horse|battery staple/);
  assert.notEqual(vault.wrappedKey, "");
  assert.notEqual(vault.salt, "");
  assert.notEqual(vault.wrapNonce, "");
});

test("encrypts and decrypts a complete password entry with record-bound authenticated data", async () => {
  const { vault, dataKey } = await createPasswordVault(MASTER_PASSWORD);
  const entry = {
    title: "Example account",
    username: "star@example.com",
    password: "sensitive-secret-123!",
    url: "https://example.com/login",
    notes: "Recovery codes are offline.",
  };
  const encrypted = await encryptPasswordVaultEntry(dataKey, "entry_12345678", entry);

  assert.doesNotMatch(JSON.stringify(encrypted), /Example account|star@example|sensitive-secret/);
  assert.deepEqual(await decryptPasswordVaultEntry(dataKey, encrypted), entry);

  const unlockedKey = await unlockPasswordVault(MASTER_PASSWORD, vault);
  assert.deepEqual(await decryptPasswordVaultEntry(unlockedKey, encrypted), entry);

  await assert.rejects(
    decryptPasswordVaultEntry(unlockedKey, { ...encrypted, id: "entry_87654321" }),
  );
});

test("rejects an incorrect master password", async () => {
  const { vault } = await createPasswordVault(MASTER_PASSWORD);
  await assert.rejects(unlockPasswordVault("this password is definitely wrong", vault));
});

test("supports multi-byte Unicode content within the documented field limits", async () => {
  const { dataKey } = await createPasswordVault(MASTER_PASSWORD);
  const notes = "密".repeat(5_000);
  const encrypted = await encryptPasswordVaultEntry(dataKey, "entry_unicode_1", {
    title: "账".repeat(200),
    username: "用".repeat(300),
    password: "🔑".repeat(500),
    url: `https://example.com/${"路".repeat(2_000)}`,
    notes,
  });

  assert.equal((await decryptPasswordVaultEntry(dataKey, encrypted)).notes, notes);
});

test("changes the master password by rewrapping the same data key", async () => {
  const { vault, dataKey } = await createPasswordVault(MASTER_PASSWORD);
  const encrypted = await encryptPasswordVaultEntry(dataKey, "entry_change_1", {
    title: "SSH server",
    username: "root",
    password: "ssh-secret-value",
    url: "ssh://example.com",
    notes: "",
  });
  const changedVault = await changePasswordVaultMasterPassword(
    MASTER_PASSWORD,
    NEXT_MASTER_PASSWORD,
    vault,
  );

  await assert.rejects(unlockPasswordVault(MASTER_PASSWORD, changedVault));
  const unlockedKey = await unlockPasswordVault(NEXT_MASTER_PASSWORD, changedVault);
  assert.equal((await decryptPasswordVaultEntry(unlockedKey, encrypted)).password, "ssh-secret-value");
});

test("requires a strong master password when creating or changing a vault", () => {
  assert.throws(
    () => validateMasterPassword("short"),
    new RegExp(`at least ${MIN_MASTER_PASSWORD_LENGTH}`),
  );
  assert.equal(validateMasterPassword(MASTER_PASSWORD), MASTER_PASSWORD);
});

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { FileTokenStore, type StoredTokens } from "./token-store.ts";

test("FileTokenStore writes, reads, and clears tokens securely", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-token-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "nested", "auth.json");
  const store = new FileTokenStore(filePath);
  const tokens: StoredTokens = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 123456,
  };

  assert.equal(await store.read(), null);
  await store.write(tokens);
  assert.deepEqual(await store.read(), tokens);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(filePath, "utf8"), /undefined/);
  await store.clear();
  assert.equal(await store.read(), null);
});

test("FileTokenStore rejects malformed authentication data", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoto-token-store-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "auth.json");
  await writeFile(filePath, "{}");
  const store = new FileTokenStore(filePath);
  await assert.rejects(store.read(), /stored authentication data is invalid/);
});

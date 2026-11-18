import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, appendFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LoglineStore, LogIntegrityError } from "../src/logline-store.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "logline-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file: path.join(directory, "store.log") };
}

test("persists values and recovers them after reopening", async (t) => {
  const { file } = await fixture(t);
  let store = await LoglineStore.open(file);
  assert.equal(await store.put("profile:1", { name: "Ari", tags: ["systems", "math"] }), 1);
  await store.put("counter", 42);
  await store.close();

  store = await LoglineStore.open(file);
  assert.deepEqual(await store.get("profile:1"), { name: "Ari", tags: ["systems", "math"] });
  assert.equal(await store.get("counter"), 42);
  assert.deepEqual(await store.keys(), ["counter", "profile:1"]);
  await store.close();
});

test("serializes concurrent mutations into a monotonic log sequence", async (t) => {
  const { file } = await fixture(t);
  const store = await LoglineStore.open(file);
  const sequences = await Promise.all(
    Array.from({ length: 30 }, (_, index) => store.put(`key-${index}`, { index })),
  );
  assert.deepEqual(sequences, Array.from({ length: 30 }, (_, index) => index + 1));
  assert.equal((await store.stats()).entries, 30);
  await store.close();
});

test("deletes create durable tombstones and return whether a key existed", async (t) => {
  const { file } = await fixture(t);
  let store = await LoglineStore.open(file);
  await store.put("temporary", "value");
  assert.equal(await store.delete("temporary"), true);
  assert.equal(await store.delete("temporary"), false);
  assert.equal(await store.has("temporary"), false);
  await store.close();

  store = await LoglineStore.open(file);
  assert.equal(await store.has("temporary"), false);
  assert.equal((await store.stats()).sequence, 3);
  await store.close();
});

test("recovery drops an incomplete final frame and preserves committed records", async (t) => {
  const { file } = await fixture(t);
  let store = await LoglineStore.open(file);
  await store.put("durable", "yes");
  await store.close();
  await appendFile(file, "00000000\t{partial-frame");
  store = await LoglineStore.open(file);
  assert.equal(await store.get("durable"), "yes");
  await store.put("after-recovery", true);
  await store.close();
  store = await LoglineStore.open(file);
  assert.equal(await store.get("after-recovery"), true);
  await store.close();
});

test("complete checksum corruption is rejected instead of silently skipped", async (t) => {
  const { file } = await fixture(t);
  let store = await LoglineStore.open(file);
  await store.put("key", "value");
  await store.close();
  const original = await readFile(file, "utf8");
  const corrupted = (original[0] === "0" ? "1" : "0") + original.slice(1);
  await (await import("node:fs/promises")).writeFile(file, corrupted);
  await assert.rejects(() => LoglineStore.open(file), LogIntegrityError);
});

test("compaction preserves live values and removes historical tombstones", async (t) => {
  const { file } = await fixture(t);
  const store = await LoglineStore.open(file);
  await store.put("keep", { v: 1 });
  await store.put("remove", "old");
  await store.delete("remove");
  await store.put("keep", { v: 2 });
  const before = (await stat(file)).size;
  const compacted = await store.compact();
  const after = (await stat(file)).size;
  assert.equal(compacted.entries, 1);
  assert.ok(after < before);
  assert.deepEqual(await store.get("keep"), { v: 2 });
  await store.close();

  const reopened = await LoglineStore.open(file);
  assert.deepEqual(await reopened.entries(), [["keep", { v: 2 }]]);
  assert.equal((await reopened.stats()).sequence, 1);
  await reopened.close();
});

test("rejects multiple active writers for the same path and allows reopen after close", async (t) => {
  const { file } = await fixture(t);
  const store = await LoglineStore.open(file);
  await assert.rejects(() => LoglineStore.open(file), /already has an open writer/);
  await store.close();
  const reopened = await LoglineStore.open(file);
  await reopened.close();
});

test("validates keys and JSON values before writing", async (t) => {
  const { file } = await fixture(t);
  const store = await LoglineStore.open(file);
  await assert.rejects(() => store.put("", "x"), /non-empty/);
  await assert.rejects(() => store.put("x", Number.NaN), /non-finite/);
  const circular = {};
  circular.self = circular;
  await assert.rejects(() => store.put("circular", circular), /circular/);
  await assert.rejects(() => store.put("undefined", undefined), /JSON-compatible/);
  await store.close();
});

test("read values are detached copies, not mutable internal references", async (t) => {
  const { file } = await fixture(t);
  const store = await LoglineStore.open(file);
  await store.put("nested", { items: [1, 2] });
  const value = await store.get("nested");
  value.items.push(3);
  assert.deepEqual(await store.get("nested"), { items: [1, 2] });
  await store.close();
});

test("rejects operations after close", async (t) => {
  const { file } = await fixture(t);
  const store = await LoglineStore.open(file);
  await store.close();
  await assert.rejects(() => store.put("x", 1), /closed/);
});

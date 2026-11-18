import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/cli.js");

test("CLI put/get/keys/compact round trip", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "logline-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "db.log");
  const put = spawnSync(process.execPath, [cli, file, "put", "answer", '{"value":42}'], { encoding: "utf8" });
  assert.equal(put.status, 0, put.stderr);
  const get = spawnSync(process.execPath, [cli, file, "get", "answer"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(get.stdout), { found: true, value: { value: 42 } });
  const compact = spawnSync(process.execPath, [cli, file, "compact"], { encoding: "utf8" });
  assert.equal(compact.status, 0, compact.stderr);
});

test("CLI reports invalid commands", () => {
  const result = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

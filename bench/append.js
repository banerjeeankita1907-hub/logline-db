import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { LoglineStore } from "../src/logline-store.js";

const count = Number(process.argv[2] || 250);
if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
  process.stderr.write("Usage: node bench/append.js [records: 1..100000]\n");
  process.exitCode = 2;
} else {
  const directory = await mkdtemp(path.join(os.tmpdir(), "logline-bench-"));
  const file = path.join(directory, "bench.log");
  let store;
  try {
    store = await LoglineStore.open(file);
    const started = performance.now();
    for (let index = 0; index < count; index += 1) {
      await store.put(`record:${index}`, { index, payload: "x".repeat(128) });
    }
    const elapsedMs = performance.now() - started;
    const stats = await store.stats();
    process.stdout.write(JSON.stringify({
      records: count,
      elapsed_ms: Number(elapsedMs.toFixed(2)),
      appends_per_second: Number((count / (elapsedMs / 1000)).toFixed(2)),
      log_bytes: stats.logBytes,
      note: "Single-process local-filesystem microbenchmark; results depend on storage hardware and fsync policy.",
    }, null, 2) + "\n");
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

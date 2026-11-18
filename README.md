# LoglineDB

[![CI](https://github.com/banerjeeankita1907-hub/threadcounty-hackathon/actions/workflows/ci.yml/badge.svg)](https://github.com/banerjeeankita1907-hub/threadcounty-hackathon/actions/workflows/ci.yml)

A small append-only key/value store designed to make persistence mechanics visible: framed records, checksums, monotonic sequence numbers, crash-tail recovery, tombstones, and atomic compaction.

## What it demonstrates

- **Write-ahead log:** each mutation is appended before the in-memory index is updated.
- **Durability boundary:** a mutation resolves only after the file handle is synced.
- **Recovery:** records are validated and replayed on open; incomplete trailing frames are truncated.
- **Integrity checking:** CRC32 detects accidental corruption; complete corrupt frames fail closed.
- **Compaction:** live entries are rewritten to a same-directory temporary file and atomically renamed.
- **Serialized mutations:** a per-instance queue orders concurrent asynchronous callers.
- **Detached reads:** callers cannot mutate the store's in-memory values through returned objects.

This is a teaching storage engine, not a production database or distributed system.

## Quick start

Requires Node.js 20+ and no external dependencies.

```bash
npm test
npm run check
npm run bench
```

## CLI

```bash
node src/cli.js ./data/store.log put user:1 '{"name":"Ari","active":true}'
node src/cli.js ./data/store.log get user:1
node src/cli.js ./data/store.log keys
node src/cli.js ./data/store.log stats
node src/cli.js ./data/store.log delete user:1
node src/cli.js ./data/store.log compact
```

## Storage model

The log is UTF-8 framed as `<CRC32><TAB><JSON record><LF>`. Version 1 records contain an increasing sequence, operation, key, and (for puts) a JSON-compatible value. See [docs/storage-format.md](docs/storage-format.md) and [the storage design decision](docs/adr/0001-log-and-durability-boundary.md).

## Failure model and limits

- A partial final frame is discarded during recovery.
- A complete frame with a checksum or schema error stops recovery with an integrity error.
- Writes are serialized within one store instance.
- Only one writer per path in the same process is permitted.
- There is no cross-process lock, replication, multi-key transaction, isolation, query planner, or network protocol.
- CRC32 is for accidental error detection, not adversarial tamper resistance.
- Atomic rename and directory sync behavior depends on the filesystem.

## Tests and benchmark

```bash
npm test
npm run bench
```

The tests cover recovery, corruption detection, tombstones, concurrency ordering, compaction, detached reads, and CLI behavior. The benchmark is a local append+sync microbenchmark, not a comparative performance claim.

## Project layout

```text
src/logline-store.js    Framing, CRC32, replay, mutation queue, compaction
src/cli.js              Command-line interface
tests/                  Recovery, integrity, concurrency, CLI tests
bench/                  Append benchmark
docs/                   Storage format and failure model
```

## License

MIT.

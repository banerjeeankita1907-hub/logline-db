# ADR 0001: Append-only log and durability boundary

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

The project is a teaching implementation intended to make persistence, recovery, and integrity tradeoffs visible in a small codebase. It should have a deterministic recovery path and tests that can inject partial writes and corruption without requiring external services.

## Decision

Use a versioned append-only sequence of framed JSON records, with an in-memory Map rebuilt during recovery.

For each mutation:

1. Validate key and value before scheduling the operation.
2. Assign the next sequence number inside a per-instance promise queue.
3. Append one record frame with CRC32.
4. Sync the log file.
5. Update the in-memory index.
6. Resolve the caller's promise.

Deletes append tombstones. Compaction writes only live entries to a same-directory temporary file, syncs it, and atomically renames it over the previous log.

## Why this design

- Sequential append makes the write and replay path easy to inspect.
- A complete record has a checksum and schema that can be validated independently.
- The in-memory index makes point lookup simple and fast after recovery.
- A torn final frame can be distinguished from a complete frame with invalid integrity metadata.
- Compaction bounds the growth caused by overwritten keys and tombstones.

## Costs and alternatives

- **Per-mutation sync:** improves the durability boundary but reduces write throughput. Group commit could improve throughput at the cost of a more complex acknowledgement contract.
- **In-memory index:** requires memory proportional to the number of live keys. A disk-backed B-tree or LSM tree would be more appropriate for large datasets.
- **JSON framing:** human-inspectable but larger and slower to parse than a binary format.
- **CRC32:** detects accidental corruption but is not an adversarial integrity mechanism. A keyed MAC or authenticated storage layer would be required against tampering.
- **Single writer:** the process-local guard avoids concurrent writers in one process but does not coordinate multiple processes or hosts. A lock protocol or transactional storage service would be needed.
- **No multi-key transactions:** each operation is atomic only at the single-record API level; there is no transaction isolation or rollback.

## Consequences

The project can demonstrate append, replay, torn-tail handling, corruption rejection, tombstones, and compaction with a small test suite. It intentionally does not claim to be a production database.

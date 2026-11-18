# LoglineDB storage format

## Frame layout

Each record is a single UTF-8 line:

```text
<8 lowercase hex CRC32><TAB><JSON payload><LF>
```

The CRC32 is computed over the UTF-8 bytes of the JSON payload, not the checksum prefix or line terminator.

Version 1 records have these fields:

- `version`: integer format version, currently 1
- `seq`: strictly increasing positive safe integer
- `op`: `put` or `delete`
- `key`: non-empty UTF-8 key, at most 1024 bytes
- `value`: JSON-compatible value for a `put`

The format is append-only between compactions. A delete is represented as a tombstone.

## Durability path

A mutation is serialized through a per-instance promise queue. The store appends one complete frame and calls `fsync` on the file handle before changing its in-memory map or resolving the mutation promise. Concurrent calls through the same instance therefore receive a total sequence order.

This is a small teaching implementation, not a transaction manager. It provides no multi-key transaction or inter-process consensus.

## Recovery

Opening a store scans frames from the beginning, verifies checksum, JSON, version, operation, key, and sequence order, then replays them into an in-memory map.

A non-newline-terminated final suffix is treated as an incomplete tail and truncated to the last complete newline. A complete frame with a bad checksum or invalid contents raises `LogIntegrityError`. The implementation does not silently skip interior corruption.

## Compaction

Compaction writes the live key/value set to a uniquely named temporary file in the same directory, fsyncs it, closes the old handle, and atomically renames the temporary file over the log. The new log contains only live `put` records with a fresh sequence range.

The operation is intended for local filesystems with atomic same-directory rename semantics. Directory fsync is attempted where supported.

## Concurrency contract

One `LoglineStore` writer per resolved path is enforced within a single Node.js process. There is no cross-process file lock. Do not open the same store from multiple processes or hosts.

## Integrity limits

CRC32 detects accidental corruption; it is not a cryptographic integrity guarantee and is not designed to resist malicious tampering. Use authenticated storage and cryptographic hashes or signatures where an adversarial threat model applies.

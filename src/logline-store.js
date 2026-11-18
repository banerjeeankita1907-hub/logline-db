import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const FORMAT_VERSION = 1;
const MAX_KEY_BYTES = 1024;
const MAX_VALUE_BYTES = 1024 * 1024;
const ACTIVE_PATHS = new Set();

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export class LogIntegrityError extends Error {
  constructor(message, lineNumber) {
    super(`log integrity error at line ${lineNumber}: ${message}`);
    this.name = "LogIntegrityError";
    this.lineNumber = lineNumber;
  }
}

function crc32(text) {
  const bytes = Buffer.from(text, "utf8");
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function encodeFrame(record) {
  const payload = JSON.stringify(record);
  const checksum = crc32(payload).toString(16).padStart(8, "0");
  return `${checksum}\t${payload}\n`;
}

function normalizeKey(key) {
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("key must be a non-empty string");
  }
  const normalized = key.trim();
  if (Buffer.byteLength(normalized, "utf8") > MAX_KEY_BYTES) {
    throw new RangeError(`key must be at most ${MAX_KEY_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

function normalizeValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("value cannot contain non-finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("value must contain only JSON-compatible data");
  }
  if (ancestors.has(value)) throw new TypeError("value cannot contain circular references");
  ancestors.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((item) => normalizeValue(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("value must use plain objects and arrays");
    }
    normalized = {};
    for (const [key, item] of Object.entries(value)) {
      normalized[key] = normalizeValue(item, ancestors);
    }
  }
  ancestors.delete(value);
  return normalized;
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function decodeFrame(line, lineNumber) {
  if (line.length > MAX_VALUE_BYTES * 2) {
    throw new LogIntegrityError("frame exceeds the maximum supported size", lineNumber);
  }
  const separator = line.indexOf("\t");
  if (separator !== 8 || !/^[0-9a-f]{8}$/.test(line.slice(0, separator))) {
    throw new LogIntegrityError("invalid checksum header", lineNumber);
  }
  const payload = line.slice(separator + 1);
  const expected = crc32(payload).toString(16).padStart(8, "0");
  if (line.slice(0, separator) !== expected) {
    throw new LogIntegrityError("checksum mismatch", lineNumber);
  }

  let record;
  try {
    record = JSON.parse(payload);
  } catch {
    throw new LogIntegrityError("payload is not valid JSON", lineNumber);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new LogIntegrityError("record must be a JSON object", lineNumber);
  }
  if (record.version !== FORMAT_VERSION) {
    throw new LogIntegrityError("unsupported format version", lineNumber);
  }
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) {
    throw new LogIntegrityError("sequence number must be a positive safe integer", lineNumber);
  }
  if (record.op !== "put" && record.op !== "delete") {
    throw new LogIntegrityError("operation must be put or delete", lineNumber);
  }
  try {
    normalizeKey(record.key);
  } catch (error) {
    throw new LogIntegrityError(error.message, lineNumber);
  }
  if (record.op === "put") {
    if (!Object.hasOwn(record, "value")) {
      throw new LogIntegrityError("put record is missing its value", lineNumber);
    }
    try {
      record.value = normalizeValue(record.value);
    } catch (error) {
      throw new LogIntegrityError(error.message, lineNumber);
    }
  }
  return record;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Some platforms/filesystems do not support syncing directory handles.
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class LoglineStore {
  constructor(filePath, handle, data, sequence) {
    this.filePath = filePath;
    this.handle = handle;
    this.data = data;
    this.sequence = sequence;
    this.pending = Promise.resolve();
    this.closing = false;
    this.closed = false;
    this.failed = null;
  }

  static async open(filePath) {
    const resolved = path.resolve(filePath);
    if (ACTIVE_PATHS.has(resolved)) {
      throw new Error("this log file already has an open writer in this process");
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    const handle = await open(resolved, "a+");
    try {
      let bytes = await handle.readFile();
      if (bytes.length && bytes[bytes.length - 1] !== 0x0a) {
        const lastNewline = bytes.lastIndexOf(0x0a);
        const safeLength = lastNewline + 1;
        await handle.truncate(safeLength);
        bytes = bytes.subarray(0, safeLength);
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const lines = text ? text.slice(0, -1).split("\n") : [];
      const data = new Map();
      let sequence = 0;

      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index]) throw new LogIntegrityError("blank frame", index + 1);
        const record = decodeFrame(lines[index], index + 1);
        if (record.seq <= sequence) {
          throw new LogIntegrityError("sequence numbers must increase strictly", index + 1);
        }
        sequence = record.seq;
        if (record.op === "put") data.set(record.key, record.value);
        else data.delete(record.key);
      }

      ACTIVE_PATHS.add(resolved);
      return new LoglineStore(resolved, handle, data, sequence);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  _enqueue(operation) {
    if (this.closing || this.closed) {
      return Promise.reject(new Error("store is closed"));
    }
    const result = this.pending.then(async () => {
      if (this.closed) throw new Error("store is closed");
      if (this.failed) throw new Error("store is unavailable after a previous write failure", { cause: this.failed });
      return operation();
    });
    this.pending = result.catch((error) => {
      if (error && !(error instanceof RangeError) && !(error instanceof TypeError)) {
        this.failed = this.failed || error;
      }
    });
    return result;
  }

  async _append(record) {
    try {
      await this.handle.writeFile(encodeFrame(record), { encoding: "utf8" });
      await this.handle.sync();
    } catch (error) {
      this.failed = error;
      throw error;
    }
  }

  async put(key, value) {
    const normalizedKey = normalizeKey(key);
    const normalizedValue = normalizeValue(value);
    const valueSize = Buffer.byteLength(JSON.stringify(normalizedValue), "utf8");
    if (valueSize > MAX_VALUE_BYTES) {
      throw new RangeError(`serialized value must be at most ${MAX_VALUE_BYTES} bytes`);
    }
    return this._enqueue(async () => {
      const nextSequence = this.sequence + 1;
      await this._append({
        version: FORMAT_VERSION,
        seq: nextSequence,
        op: "put",
        key: normalizedKey,
        value: normalizedValue,
      });
      this.data.set(normalizedKey, normalizedValue);
      this.sequence = nextSequence;
      return nextSequence;
    });
  }

  async get(key) {
    const normalizedKey = normalizeKey(key);
    return this._enqueue(() => cloneValue(this.data.get(normalizedKey)));
  }

  async has(key) {
    const normalizedKey = normalizeKey(key);
    return this._enqueue(() => this.data.has(normalizedKey));
  }

  async delete(key) {
    const normalizedKey = normalizeKey(key);
    return this._enqueue(async () => {
      const existed = this.data.has(normalizedKey);
      const nextSequence = this.sequence + 1;
      await this._append({
        version: FORMAT_VERSION,
        seq: nextSequence,
        op: "delete",
        key: normalizedKey,
      });
      this.data.delete(normalizedKey);
      this.sequence = nextSequence;
      return existed;
    });
  }

  async keys() {
    return this._enqueue(() => [...this.data.keys()].sort());
  }

  async entries() {
    return this._enqueue(() =>
      [...this.data.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, cloneValue(value)]),
    );
  }

  async stats() {
    return this._enqueue(async () => {
      const stat = await this.handle.stat();
      return {
        file: this.filePath,
        entries: this.data.size,
        sequence: this.sequence,
        logBytes: stat.size,
      };
    });
  }

  async compact() {
    return this._enqueue(async () => {
      const directory = path.dirname(this.filePath);
      const temporary = `${this.filePath}.compact-${process.pid}-${randomUUID()}`;
      let temporaryHandle;
      let nextSequence = 0;
      try {
        temporaryHandle = await open(temporary, "wx");
        for (const [key, value] of [...this.data.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          nextSequence += 1;
          await temporaryHandle.writeFile(encodeFrame({
            version: FORMAT_VERSION,
            seq: nextSequence,
            op: "put",
            key,
            value,
          }));
        }
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = null;

        await this.handle.close();
        this.handle = null;
        try {
          await rename(temporary, this.filePath);
          this.handle = await open(this.filePath, "a+");
        } catch (error) {
          this.handle = await open(this.filePath, "a+").catch(() => null);
          throw error;
        }
        this.sequence = nextSequence;
        await syncDirectory(directory);
        return { entries: this.data.size, sequence: this.sequence };
      } catch (error) {
        await temporaryHandle?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    });
  }

  async close() {
    if (this.closed) return;
    if (this.closing) return this.pending;
    this.closing = true;
    await this.pending;
    await this.handle?.close();
    this.handle = null;
    this.closed = true;
    ACTIVE_PATHS.delete(this.filePath);
  }
}

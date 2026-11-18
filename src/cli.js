#!/usr/bin/env node

import { LoglineStore } from "./logline-store.js";

function usage() {
  return [
    "Usage:",
    "  logline <file> put <key> <json-value>",
    "  logline <file> get <key>",
    "  logline <file> delete <key>",
    "  logline <file> keys",
    "  logline <file> stats",
    "  logline <file> compact",
  ].join("\n");
}

async function main(args) {
  const [file, command, key, rawValue] = args;
  if (!file || !command) {
    process.stderr.write(usage() + "\n");
    return 2;
  }
  let store;
  try {
    store = await LoglineStore.open(file);
    switch (command) {
      case "put": {
        if (key === undefined || rawValue === undefined) throw new Error("put needs a key and JSON value");
        const value = JSON.parse(rawValue);
        const sequence = await store.put(key, value);
        process.stdout.write(JSON.stringify({ ok: true, sequence }) + "\n");
        break;
      }
      case "get": {
        if (key === undefined) throw new Error("get needs a key");
        const value = await store.get(key);
        process.stdout.write(JSON.stringify({ found: value !== undefined, value: value ?? null }) + "\n");
        break;
      }
      case "delete": {
        if (key === undefined) throw new Error("delete needs a key");
        process.stdout.write(JSON.stringify({ deleted: await store.delete(key) }) + "\n");
        break;
      }
      case "keys":
        process.stdout.write(JSON.stringify(await store.keys(), null, 2) + "\n");
        break;
      case "stats":
        process.stdout.write(JSON.stringify(await store.stats(), null, 2) + "\n");
        break;
      case "compact":
        process.stdout.write(JSON.stringify(await store.compact()) + "\n");
        break;
      default:
        process.stderr.write(usage() + "\n");
        return 2;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`logline: ${error.message}\n`);
    return 2;
  } finally {
    await store?.close().catch(() => {});
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});

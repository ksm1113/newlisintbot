const path = require("node:path");
const fs = require("node:fs/promises");

function pathsFor(root = path.resolve(__dirname, "..")) {
  return {
    root,
    data: path.join(root, "data"),
    state: path.join(root, "state"),
    listings: path.join(root, "data", "listings.jsonl"),
    results: path.join(root, "data", "info-results.jsonl"),
    cursor: path.join(root, "state", "info-consumer.json"),
    watcherLock: path.join(root, "state", "watcher.lock"),
    consumerLock: path.join(root, "state", "info-consumer.lock"),
  };
}

async function ensureDirectories(paths) {
  await fs.mkdir(paths.data, { recursive: true });
  await fs.mkdir(paths.state, { recursive: true });
}

module.exports = { pathsFor, ensureDirectories };

const fs = require("node:fs/promises");
const { watch, createReadStream } = require("node:fs");
const { createInterface } = require("node:readline");
const { pathsFor, ensureDirectories } = require("./paths.cjs");
const { acquireLock } = require("./lock.cjs");
const { JsonlWriter, writeJsonAtomic, MAX_RECORD_BYTES } = require("./jsonl.cjs");
const { pendingLookup } = require("./listing-event.cjs");

function fileIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtime_ms: stat.birthtimeMs };
}

class InfoConsumer {
  static async open({ root, onRecord = () => {}, onRecovery = console.warn } = {}) {
    const consumer = new InfoConsumer(pathsFor(root), onRecord);
    await ensureDirectories(consumer.paths);
    consumer.releaseLock = await acquireLock(consumer.paths.consumerLock);
    try {
      consumer.writer = await JsonlWriter.open(consumer.paths.results, { onRecovery });
      const lines = createInterface({ input: createReadStream(consumer.paths.results), crlfDelay: Infinity });
      let lineNumber = 0;
      for await (const line of lines) {
        lineNumber++;
        let result;
        try { result = JSON.parse(line); }
        catch { throw new Error(`Invalid result JSON at line ${lineNumber}; existing results were not skipped.`); }
        if (typeof result.event_id !== "string") throw new Error(`Missing event_id in result line ${lineNumber}.`);
        consumer.seen.add(result.event_id);
      }
      try {
        consumer.state = JSON.parse(await fs.readFile(consumer.paths.cursor, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await writeJsonAtomic(consumer.paths.cursor, consumer.state);
      }
      if (consumer.state.schema_version !== 1 || !Number.isSafeInteger(consumer.state.offset) || consumer.state.offset < 0) {
        throw new Error("Invalid info-consumer checkpoint. It was not reset automatically.");
      }
      if (consumer.state.offset > 0 && !consumer.seen.has(consumer.state.last_event_id)) {
        throw new Error("Checkpoint has no matching durable result. Keep data and state together; processing stopped.");
      }
      return consumer;
    } catch (error) {
      await consumer.close().catch(() => {});
      throw error;
    }
  }

  constructor(paths, onRecord) {
    this.paths = paths;
    this.onRecord = onRecord;
    this.seen = new Set();
    this.state = { schema_version: 1, offset: 0, input_identity: null, last_event_id: null };
    this.active = null;
    this.closed = false;
    this.stopped = false;
  }

  drain() {
    if (this.closed) return Promise.reject(new Error("Info consumer is closed."));
    if (!this.active) this.active = this.readAvailable().finally(() => { this.active = null; });
    return this.active;
  }

  async readAvailable() {
    let handle;
    try { handle = await fs.open(this.paths.listings, "r"); }
    catch (error) {
      if (error.code === "ENOENT" && this.state.offset === 0 && !this.state.input_identity) return;
      throw error;
    }
    try {
      const stat = await handle.stat();
      const identity = fileIdentity(stat);
      if (this.state.input_identity && JSON.stringify(this.state.input_identity) !== JSON.stringify(identity)) {
        throw new Error("listings.jsonl was replaced. Append-only input is required; checkpoint was preserved.");
      }
      if (stat.size < this.state.offset) {
        throw new Error("listings.jsonl was truncated. Checkpoint was preserved; input was not skipped.");
      }
      if (!this.state.input_identity) {
        this.state = { ...this.state, input_identity: identity };
        await writeJsonAtomic(this.paths.cursor, this.state);
      }
      let position = this.state.offset;
      let bufferStart = position;
      let pending = Buffer.alloc(0);
      while (position < stat.size) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) throw new Error("Input changed during reading; checkpoint was preserved.");
        position += bytesRead;
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let newline;
        while ((newline = pending.indexOf(10)) >= 0) {
          if (newline + 1 > MAX_RECORD_BYTES) throw new Error(`Listing record exceeds 2 MiB at byte ${bufferStart}.`);
          let event;
          try { event = JSON.parse(pending.subarray(0, newline).toString("utf8")); }
          catch { throw new Error(`Invalid listing JSON at byte ${bufferStart}; processing stopped without skipping it.`); }
          if (event?.schema_version !== 1 || event.event !== "listing" ||
              typeof event.event_id !== "string" || !/^[a-f0-9]{64}$/.test(event.event_id) || !Array.isArray(event.assets)) {
            throw new Error(`Invalid listing record at byte ${bufferStart}.`);
          }
          const nextOffset = bufferStart + newline + 1;
          const duplicate = this.seen.has(event.event_id);
          if (!duplicate) {
            await this.writer.append(pendingLookup(event));
            this.seen.add(event.event_id);
          }
          // Flush the result first; replay after a crash can find it by event_id.
          const nextState = { ...this.state, offset: nextOffset, last_event_id: event.event_id };
          await writeJsonAtomic(this.paths.cursor, nextState);
          this.state = nextState;
          if (!duplicate) this.onRecord(event);
          pending = pending.subarray(newline + 1);
          bufferStart = nextOffset;
        }
        if (pending.length > MAX_RECORD_BYTES) throw new Error(`Unfinished listing record exceeds 2 MiB at byte ${bufferStart}.`);
      }
      // Wait for a newline; reread the unfinished bytes on the next wake-up.
    } finally {
      await handle.close();
    }
  }

  start({ pollMs = 1000, onError = console.error, onWatchWarning = console.warn } = {}) {
    if (this.timer || this.closed) throw new Error("Info consumer is already started or closed.");
    const wake = () => {
      if (this.stopped || this.closed) return;
      this.drain().catch(error => {
        if (this.stopped) return;
        this.stopWatching();
        onError(error);
      });
    };
    try {
      const watcher = watch(this.paths.data, () => wake());
      this.watcher = watcher;
      watcher.on("error", error => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
        onWatchWarning(`File watch unavailable; polling continues: ${error.message}`);
      });
    } catch (error) {
      onWatchWarning(`File watch unavailable; polling continues: ${error.message}`);
    }
    this.timer = setInterval(wake, pollMs);
    wake();
  }

  stopWatching() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  async close() {
    if (this.closed) return;
    this.stopWatching();
    this.closed = true;
    try { await this.active; }
    finally {
      try { await this.writer?.close(); }
      finally { await this.releaseLock?.(); }
    }
  }
}

module.exports = { InfoConsumer };

const fs = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { TextDecoder } = require("node:util");
const { main: startClient } = require("../client.cjs");
const { InfoConsumer } = require("./info-consumer.cjs");
const { normalizeListing } = require("./listing-event.cjs");
const { MAX_RECORD_BYTES, writeJsonAtomic } = require("./jsonl.cjs");
const { pathsFor } = require("./paths.cjs");

const DEFAULT_FIXTURE = path.resolve(__dirname, "../fixtures/replay-feed.jsonl");
const DOCUMENTATION_FIXTURE = path.resolve(__dirname, "../fixtures/official-full-example.jsonl");
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGES = 20000;
const decoder = new TextDecoder("utf-8", { fatal: true });

function checkAbort(signal) {
  if (signal?.aborted) throw new Error("Replay was cancelled.");
}

async function readBounded(file, maxBytes, signal) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Replay input must be a regular file.");
    if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes.`);
    const chunks = [];
    let total = 0;
    while (true) {
      checkAbort(signal);
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes.`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function jsonlValues(buffer) {
  const values = [];
  let start = 0;
  let lineNumber = 0;
  while (start < buffer.length) {
    lineNumber++;
    const newline = buffer.indexOf(10, start);
    const end = newline < 0 ? buffer.length : newline;
    if (end - start > MAX_RECORD_BYTES) throw new Error(`Line ${lineNumber} exceeds 2 MiB.`);
    let line;
    try { line = decoder.decode(buffer.subarray(start, end)); }
    catch { throw new Error(`Invalid UTF-8 at line ${lineNumber}.`); }
    if (lineNumber === 1) line = line.replace(/^\uFEFF/, "");
    if (line.trim()) {
      let value;
      try { value = JSON.parse(line); }
      catch { throw new Error(`Invalid JSON at line ${lineNumber}.`); }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Expected a message object at line ${lineNumber}.`);
      }
      values.push({ value, lineNumber });
      if (values.length > MAX_MESSAGES) throw new Error(`Replay exceeds ${MAX_MESSAGES} messages.`);
    }
    start = end + 1;
  }
  return values;
}

async function readReplayInput(file, { signal } = {}) {
  const buffer = await readBounded(file, MAX_INPUT_BYTES, signal);
  const messages = [];
  let normalizedWrappers = 0;
  for (const { value, lineNumber } of jsonlValues(buffer)) {
    let message = value;
    if (value.schema_version === 1 && value.event === "listing") {
      if (!value.raw || typeof value.raw !== "object" || Array.isArray(value.raw)) {
        throw new Error(`Normalized listing at line ${lineNumber} must contain its raw message.`);
      }
      message = value.raw;
      normalizedWrappers++;
    }
    if (typeof message.type !== "string") throw new Error(`Missing message type at line ${lineNumber}.`);
    // Error controls intentionally exercise the client's stop behavior; they are
    // reported as a failed replay rather than interpreted as listing records.
    const listing = normalizeListing(message);
    if (listing && Buffer.byteLength(JSON.stringify(listing)) + 1 > MAX_RECORD_BYTES) {
      throw new Error(`Normalized listing at line ${lineNumber} exceeds 2 MiB.`);
    }
    messages.push({ message, listing });
  }
  if (!messages.length) throw new Error("Replay input is empty.");
  if (!messages.some(item => item.listing)) throw new Error("Replay input contains no listing message to verify.");
  const normalizedBytes = messages.reduce((sum, item) => sum + (item.listing ? Buffer.byteLength(JSON.stringify(item.listing)) + 1 : 0), 0);
  if (normalizedBytes > MAX_OUTPUT_BYTES) throw new Error("Normalized replay output would exceed 32 MiB.");
  return { messages, normalizedWrappers, inputBytes: buffer.length };
}

function roundMs(value) { return Math.round(value * 1000) / 1000; }

function latencySummary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    scope: "Local fake-socket receive to durable LOOKUP_PENDING result and checkpoint; excludes provider and network delay.",
    sample_count: sorted.length,
    p50_ms: sorted.length ? roundMs(sorted[Math.ceil(sorted.length * 0.5) - 1]) : null,
    max_ms: sorted.length ? roundMs(sorted[sorted.length - 1]) : null,
  };
}

async function waitForAutomaticIntake(consumer, expectedIds, expectedBytes, { waitMs, failure, signal }) {
  const deadline = performance.now() + waitMs;
  while (true) {
    checkAbort(signal);
    if (failure()) throw failure();
    if (consumer.state.offset === expectedBytes && expectedIds.every(id => consumer.seen.has(id))) return;
    if (performance.now() >= deadline) throw new Error(`Automatic file detection did not finish within ${waitMs} ms.`);
    await delay(20);
  }
}

async function runReplay({ file, projectRoot = path.resolve(__dirname, ".."), waitMs = 10000, signal } = {}) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 30000) throw new Error("waitMs must be between 1 and 30000.");
  const sourceFile = file ? path.resolve(file) : DEFAULT_FIXTURE;
  const sourceKind = !file ? "SYNTHETIC" : sourceFile === DOCUMENTATION_FIXTURE ? "DOCUMENTATION_EXAMPLE" : "USER_PROVIDED_UNVERIFIED";
  const checksRoot = path.join(path.resolve(projectRoot), "data", "checks");
  await fs.mkdir(checksRoot, { recursive: true });
  const runRoot = await fs.mkdtemp(path.join(checksRoot, "replay-"));
  const reportPath = path.join(runRoot, "report.json");
  const paths = pathsFor(runRoot);
  const report = {
    schema_version: 1,
    check: "offline_listing_handoff_replay",
    started_at: new Date().toISOString(),
    status: "RUNNING",
    source: {
      kind: sourceKind,
      path: sourceFile,
      authenticity: sourceKind === "SYNTHETIC" ? "Synthetic test messages, not captured or historical feed data."
        : sourceKind === "DOCUMENTATION_EXAMPLE" ? "Bundled official documentation example; not received by this client's API key and not a validation of current trading data or free-plan fields."
          : "User-provided data; not certified as a captured or historical feed.",
      ...(sourceKind === "DOCUMENTATION_EXAMPLE" ? { documentation: "https://newlistings.pro/docs/v2/full#alpha-live", provenance_file: path.join(path.dirname(sourceFile), "official-full-example.md") } : {}),
    },
    run_root: runRoot,
    artifacts: { listings: paths.listings, pending_results: paths.results, checkpoint: paths.cursor },
    trading_allowed: false,
    detection: { mode: "fs.watch with 1000 ms polling fallback", post_replay_manual_drain: false, warnings: [] },
  };
  let client;
  let consumer;
  let error;
  let asynchronousError;
  let socket;
  const receiveTimes = new Map();
  const latencySamples = [];
  const detectedIds = new Set();
  class ReplaySocket extends EventEmitter {
    constructor() { super(); socket = this; this.closed = false; }
    terminate() { if (!this.closed) { this.closed = true; this.emit("close", 1000); } }
    close() { this.terminate(); }
  }
  try {
    checkAbort(signal);
    const input = await readReplayInput(sourceFile, { signal });
    const listingCount = input.messages.filter(item => item.listing).length;
    const expectedIds = [...new Set(input.messages.filter(item => item.listing).map(item => item.listing.event_id))];
    report.counts = {
      input_messages: input.messages.length,
      input_listing_messages: listingCount,
      unique_listing_events: expectedIds.length,
      duplicate_listing_messages: listingCount - expectedIds.length,
      filtered_messages: input.messages.length - listingCount,
      normalized_wrappers_extracted: input.normalizedWrappers,
    };
    report.source.input_bytes = input.inputBytes;
    client = await startClient({
      root: runRoot,
      key: "offline-replay-only",
      WebSocketImpl: ReplaySocket,
      installSignalHandlers: false,
      logger: { log() {}, error() { asynchronousError ||= new Error("Watcher reported an error during replay."); } },
    });
    consumer = await InfoConsumer.open({
      root: runRoot,
      onRecord(event) {
        detectedIds.add(event.event_id);
        const started = receiveTimes.get(event.event_id);
        if (started !== undefined) latencySamples.push(performance.now() - started);
      },
      onRecovery: () => {},
    });
    consumer.start({
      onError: failure => { asynchronousError ||= failure; },
      onWatchWarning: warning => report.detection.warnings.push(warning),
    });
    report.detection.watch_available_at_start = Boolean(consumer.watcher);
    // Complete the empty startup scan before sending. Once replay starts, only
    // start()'s file watcher/polling may trigger reads; no forced drain is used.
    await consumer.drain();
    for (const { message, listing } of input.messages) {
      checkAbort(signal);
      if (asynchronousError) throw asynchronousError;
      if (socket.closed) throw new Error("Watcher stopped before all replay messages were sent.");
      if (listing && !receiveTimes.has(listing.event_id)) receiveTimes.set(listing.event_id, performance.now());
      socket.emit("message", Buffer.from(JSON.stringify(message)));
      // Pace offline messages by the actual durable writer to avoid fabricating
      // a burst larger than its queue; this is not a throughput benchmark.
      await client.flush();
    }
    const listingStat = await fs.stat(paths.listings);
    await waitForAutomaticIntake(consumer, expectedIds, listingStat.size, {
      waitMs, failure: () => asynchronousError, signal,
    });
    await consumer.close();
    await client.shutdown();
    const listings = jsonlValues(await readBounded(paths.listings, MAX_OUTPUT_BYTES)).map(item => item.value);
    const results = jsonlValues(await readBounded(paths.results, MAX_OUTPUT_BYTES)).map(item => item.value);
    const checkpoint = JSON.parse(await fs.readFile(paths.cursor, "utf8"));
    report.counts.written_listing_records = listings.length;
    report.counts.pending_result_records = results.length;
    report.counts.automatic_intake_callbacks = detectedIds.size;
    report.cursor = { offset_bytes: checkpoint.offset, listing_file_bytes: listingStat.size, matches_end: checkpoint.offset === listingStat.size };
    report.local_latency = latencySummary(latencySamples);
    const actualIds = new Set(results.map(result => result.event_id));
    if (listings.length !== listingCount || results.length !== expectedIds.length || actualIds.size !== expectedIds.length ||
        expectedIds.some(id => !actualIds.has(id) || !detectedIds.has(id)) || !report.cursor.matches_end ||
        results.some(result => result.status !== "LOOKUP_PENDING" || result.trading_allowed !== false)) {
      throw new Error("Replay counts, pending states, deduplication, or byte checkpoint did not match.");
    }
  } catch (failure) {
    error = failure;
  } finally {
    for (const close of [() => consumer?.close(), () => client?.shutdown()]) {
      try { await close(); }
      catch (failure) { error ||= failure; }
    }
  }
  // The production client reports some shutdown failures through its logger
  // instead of rejecting shutdown(); include those before declaring success.
  error ||= asynchronousError;
  report.status = error ? "FAILED" : "PASSED";
  report.finished_at = new Date().toISOString();
  if (error) report.error = error.message.slice(0, 500);
  await writeJsonAtomic(reportPath, report);
  if (error) {
    error.reportPath = reportPath;
    error.runRoot = runRoot;
    throw error;
  }
  return { report, reportPath, runRoot };
}

module.exports = { runReplay, readReplayInput, DEFAULT_FIXTURE };

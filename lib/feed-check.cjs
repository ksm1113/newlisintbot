const fs = require("node:fs/promises");
const path = require("node:path");
const WebSocket = require("ws");
const { main: startClient } = require("../client.cjs");
const { pathsFor, ensureDirectories } = require("./paths.cjs");
const { acquireLock } = require("./lock.cjs");
const { JsonlWriter, writeJsonAtomic } = require("./jsonl.cjs");

function redact(value, key) {
  if (typeof value === "string") return value.split(key).join("[REDACTED]");
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name, key), redact(item, key)]));
  }
  return value;
}

async function checkFeed({
  baseRoot = path.resolve(__dirname, ".."), key = process.env.NLF_KEY,
  WebSocketImpl = WebSocket, readyTimeoutMs = 15000, observeMs = 3000,
} = {}) {
  if (typeof key !== "string" || !key) throw new Error("NLF_KEY is missing; load .env with --env-file=.env.");
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 60000 ||
      !Number.isInteger(observeMs) || observeMs < 0 || observeMs > 30000) {
    throw new Error("Invalid connection-check timeout.");
  }
  const projectPaths = pathsFor(baseRoot);
  await ensureDirectories(projectPaths);
  // Reserve the real watcher's lock too, so this check cannot overlap a live watcher.
  const releaseProjectLock = await acquireLock(projectPaths.watcherLock);
  let root, rawWriter, client, readyTimer, observeTimer;
  let finish;
  let ready = false;
  let checkStopping = false;
  let failure = null;
  const ended = new Promise(resolve => { finish = resolve; });
  const started = new Date().toISOString();
  const report = {
    schema_version: 1, mode: "LIVE_CONNECTION_CHECK", started_at: started,
    endpoint: "wss://ws.newlistings.pro/v2/full", status: "FAILED",
    ready_received: false, ready_at: null, subscription: null,
    messages_received: 0, message_types: Object.create(null), listing_messages: 0,
    captured_source_messages: 0, unexpected_close_codes: [], errors: [],
    scope: "Authentication/admission and short observation only; no listing event is required.",
    historical_feed_verified: false,
  };
  const fail = error => {
    if (!failure) failure = redact(error instanceof Error ? error.message : String(error), key);
    finish();
  };
  class CheckSocket extends WebSocketImpl {
    emit(event, ...args) {
      if (event === "message") {
        try {
          // Apply the same secret masking before both the probe and the normal
          // client see a frame, including the client's normalized/raw copy.
          const message = JSON.parse(args[0].toString());
          args[0] = Buffer.from(JSON.stringify(redact(message, key)));
        } catch { /* The normal client reports malformed JSON. */ }
      }
      if (event === "close" && !checkStopping) {
        const code = typeof args[0] === "number" ? args[0] : null;
        report.unexpected_close_codes.push(code);
        fail(`Connection closed during the check (code ${code ?? "unknown"}).`);
      }
      return super.emit(event, ...args);
    }
  }
  try {
    const checks = path.join(projectPaths.data, "checks");
    await fs.mkdir(checks, { recursive: true });
    root = await fs.mkdtemp(path.join(checks, "live-"));
    rawWriter = await JsonlWriter.open(path.join(root, "raw-feed.jsonl"));
    readyTimer = setTimeout(() => fail("READY was not received before the timeout."), readyTimeoutMs);
    client = await startClient({
      root, key, WebSocketImpl: CheckSocket, installSignalHandlers: false,
      logger: {
        log() {},
        error(...values) {
          const message = redact(values.map(String).join(" "), key);
          report.errors.push(message);
          fail(message);
        },
      },
      onMessage(message) {
        report.messages_received++;
        const type = typeof message?.type === "string" ? message.type : "unknown";
        report.message_types[type] = (report.message_types[type] || 0) + 1;
        if (message?.type === "error") fail(`Feed error: ${String(message.code || "unknown")}`);
        if (!ready && message?.type === "success" && message.code === "READY") {
          ready = true;
          report.ready_received = true;
          report.ready_at = new Date().toISOString();
          const subscription = message.subscription;
          report.subscription = subscription && typeof subscription === "object" ? {
            plan: typeof subscription.plan === "string" ? redact(subscription.plan, key) : null,
            delay_ms: typeof subscription.delay_ms === "number" ? subscription.delay_ms : null,
          } : null;
          clearTimeout(readyTimer);
          observeTimer = setTimeout(finish, observeMs);
        }
        if (["announcement", "tweet"].includes(message?.type)) {
          report.captured_source_messages++;
          if (message.parser?.classification?.event === "listing") report.listing_messages++;
          // Retain real source messages for later replay; never store authentication/control payloads.
          rawWriter.append(redact(message, key)).catch(fail);
        }
      },
    });
    await ended;
  } catch (error) {
    fail(error);
  } finally {
    checkStopping = true;
    clearTimeout(readyTimer);
    clearTimeout(observeTimer);
    try { await client?.shutdown(); } catch (error) { fail(error); }
    try { await rawWriter?.close(); } catch (error) { fail(error); }
    try { await releaseProjectLock(); } catch (error) { fail(error); }
  }
  report.finished_at = new Date().toISOString();
  report.status = ready && !failure ? "PASSED" : "FAILED";
  report.failure = failure;
  if (root) {
    report.root = root;
    report.raw_file = path.join(root, "raw-feed.jsonl");
    await writeJsonAtomic(path.join(root, "report.json"), redact(report, key));
  }
  return redact(report, key);
}

module.exports = { checkFeed };

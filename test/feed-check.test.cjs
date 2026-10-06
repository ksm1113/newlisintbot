const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { checkFeed } = require("../lib/feed-check.cjs");

async function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, "newlisting-feed-check-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), base);
    assert.ok(path.basename(root).startsWith("newlisting-feed-check-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("connection check requires READY; captures source samples without polluting live files", async t => {
  const root = await fixture(t);
  class ReadySocket extends EventEmitter {
    constructor() {
      super();
      setImmediate(() => {
        this.emit("message", Buffer.from(JSON.stringify({ type: "success", code: "READY", subscription: { plan: "free", delay_ms: 3000 } })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "tweet", content: { text: "sample" }, parser: { classification: { event: "none" } } })));
      });
    }
    terminate() { this.emit("close", 1000); }
  }
  const report = await checkFeed({ baseRoot: root, key: "offline-test-key", WebSocketImpl: ReadySocket, readyTimeoutMs: 500, observeMs: 10 });
  assert.equal(report.status, "PASSED");
  assert.equal(report.ready_received, true);
  assert.equal(report.captured_source_messages, 1);
  assert.equal(report.listing_messages, 0);
  assert.equal(JSON.parse(await fs.readFile(report.raw_file, "utf8")).type, "tweet");
  await assert.rejects(fs.stat(path.join(root, "data", "listings.jsonl")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(root, "state", "watcher.lock")), { code: "ENOENT" });
});

test("socket open alone times out and is not reported as authenticated", async t => {
  const root = await fixture(t);
  class OpenOnlySocket extends EventEmitter {
    constructor() { super(); setImmediate(() => this.emit("open")); }
    terminate() { this.emit("close", 1000); }
  }
  const report = await checkFeed({ baseRoot: root, key: "offline-test-key", WebSocketImpl: OpenOnlySocket, readyTimeoutMs: 20, observeMs: 0 });
  assert.equal(report.status, "FAILED");
  assert.equal(report.ready_received, false);
  assert.match(report.failure, /READY/);
});

test("connection diagnostics redact a key returned in an error", async t => {
  const root = await fixture(t);
  const key = "offline-secret-key";
  class ErrorSocket extends EventEmitter {
    constructor() { super(); setImmediate(() => this.emit("error", new Error(`Network rejected ${key}`))); }
    terminate() { this.emit("close", 1000); }
  }
  const report = await checkFeed({ baseRoot: root, key, WebSocketImpl: ErrorSocket, readyTimeoutMs: 100, observeMs: 0 });
  assert.equal(report.status, "FAILED");
  const saved = await fs.readFile(path.join(report.root, "report.json"), "utf8");
  assert.ok(!saved.includes(key));
  assert.match(saved, /REDACTED/);
});

test("READY followed by an unexpected close fails the observation", async t => {
  const root = await fixture(t);
  class ClosingSocket extends EventEmitter {
    constructor() {
      super();
      setImmediate(() => {
        this.emit("message", Buffer.from(JSON.stringify({ type: "success", code: "READY" })));
        this.emit("close", 1006);
      });
    }
    terminate() { this.emit("close", 1000); }
  }
  const report = await checkFeed({ baseRoot: root, key: "offline-test-key", WebSocketImpl: ClosingSocket, readyTimeoutMs: 100, observeMs: 20 });
  assert.equal(report.ready_received, true);
  assert.equal(report.status, "FAILED");
  assert.deepEqual(report.unexpected_close_codes, [1006]);
  assert.match(report.failure, /closed/);
});

test("a secret echoed in source data is masked in both captured and normalized copies", async t => {
  const root = await fixture(t);
  const key = "offline-secret-key";
  class SourceSocket extends EventEmitter {
    constructor() {
      super();
      setImmediate(() => {
        this.emit("message", Buffer.from(JSON.stringify({ type: "success", code: "READY" })));
        this.emit("message", Buffer.from(JSON.stringify({
          type: "announcement", url: "https://test.example.invalid/notice",
          content: { title: `Listing ${key}` },
          parser: { exchange: "test", classification: { event: "listing", type: "spot" }, assets: [{ symbol: "TEST" }] },
        })));
      });
    }
    terminate() { this.emit("close", 1000); }
  }
  const report = await checkFeed({ baseRoot: root, key, WebSocketImpl: SourceSocket, readyTimeoutMs: 200, observeMs: 10 });
  assert.equal(report.status, "PASSED");
  assert.equal(report.listing_messages, 1);
  for (const file of [report.raw_file, path.join(report.root, "data", "listings.jsonl"), path.join(report.root, "report.json")]) {
    const saved = await fs.readFile(file, "utf8");
    assert.ok(!saved.includes(key));
  }
});

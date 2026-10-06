const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { LookupWorker } = require("../lib/markets/lookup-worker.cjs");
const { Catalog } = require("../lib/markets/catalog.cjs");
const { market } = require("../lib/markets/model.cjs");

const ID = "a".repeat(64);
const SECOND_ID = "b".repeat(64);

function pending(eventId = ID, symbol = "TEST") {
  return {
    schema_version: 1, event_id: eventId, status: "LOOKUP_PENDING",
    assets: [{ symbol, name: "테스트 🚀", contracts: [] }],
    identity_status: "UNVERIFIED", trading_allowed: false,
    exchange: "bithumb", market_type: "spot", source_url: "https://example.invalid/notice",
  };
}

class FakeCatalog {
  constructor({ status = "FRESH", maxAttempts = 2 } = {}) {
    this.config = { lookup_retry_ms: 1000, lookup_max_attempts: maxAttempts };
    this.active = null; this.listeners = new Set();
    this.current = [{
      venue: "binance", venue_kind: "CEX", segment: "spot", market_type: "spot",
      status, fetched_at: "2026-10-06T00:00:00.000Z", valid_until: "2026-10-06T00:10:00.000Z",
      error: status === "ERROR" ? { code: "HTTP_503", at: "2026-10-06T00:00:00.000Z" } : null,
      markets: [market({ venue: "binance", venue_kind: "CEX", segment: "spot", market_id: "TESTUSDT", market_type: "spot", base_symbol: "TEST", quote_symbol: "USDT", market_status: "ACTIVE", source: "https://example.invalid/catalog" })],
    }];
  }
  views() { return this.current; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }
  setStatus(status, revision = "2026-10-06T00:01:00.000Z") {
    this.current = this.current.map(view => ({ ...view, status, fetched_at: revision, error: status === "ERROR" ? { code: "HTTP_503", at: revision } : null }));
    this.emit();
  }
}

async function fixture(t) {
  const temporary = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "newlisting-market-worker-test-"));
  const workers = [];
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.close().catch(() => {})));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), temporary);
    assert.ok(path.basename(target).startsWith("newlisting-market-worker-test-"));
    await fs.rm(target, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  const input = path.join(root, "data", "info-results.jsonl");
  const jobFile = (id = ID) => path.join(root, "state", "market-jobs", `${id}.json`);
  const resultFile = (id = ID) => path.join(root, "data", "market-results", `${id}.json`);
  const cursorFile = path.join(root, "state", "market-lookup-consumer.json");
  const json = async file => JSON.parse(await fs.readFile(file, "utf8"));
  const open = async options => {
    const worker = await LookupWorker.open({ root, catalog: new FakeCatalog(), ...options });
    workers.push(worker);
    return worker;
  };
  const append = async event => fs.appendFile(input, `${JSON.stringify(event)}\n`);
  return { root, input, jobFile, resultFile, cursorFile, json, open, append };
}

test("Lookup durable intake resumes after cursor lag and publishes one latest result per event", async t => {
  const f = await fixture(t);
  await f.append(pending());
  let publications = 0;
  const first = await f.open({ onResult: () => publications++ });
  await first.drain();
  const job = await f.json(f.jobFile());
  const originalResult = await fs.readFile(f.resultFile(), "utf8");
  assert.equal(job.status, "COMPLETE");
  assert.equal(publications, 1);
  await first.close();
  const state = await f.json(f.cursorFile);
  await fs.writeFile(f.cursorFile, JSON.stringify({ ...state, offset: 0, last_event_id: null }));
  await f.append(pending());
  const second = await f.open({ onResult: () => publications++ });
  await second.drain();
  assert.equal(second.jobs.size, 1);
  assert.equal(publications, 1);
  assert.equal(await fs.readFile(f.resultFile(), "utf8"), originalResult);
  assert.equal((await f.json(f.cursorFile)).offset, Buffer.byteLength(`${JSON.stringify(pending())}\n`) * 2);
  assert.equal((await f.json(f.resultFile())).trading_allowed, false);
});

test("Lookup startup completes a result published before job completion and resumes unfinished RUNNING jobs", async t => {
  const f = await fixture(t);
  await f.append(pending());
  await f.append(pending(SECOND_ID));
  const first = await f.open();
  await first.readAvailable();
  await first.processJobs(false);
  await first.close();
  const done = await f.json(f.jobFile());
  await fs.writeFile(f.jobFile(), JSON.stringify({ ...done, status: "RUNNING" }));
  const unfinished = await f.json(f.jobFile(SECOND_ID));
  await fs.writeFile(f.jobFile(SECOND_ID), JSON.stringify({ ...unfinished, status: "RUNNING", attempts: 0 }));
  await fs.unlink(f.resultFile(SECOND_ID));
  const calls = [];
  const second = await f.open({ onResult: result => calls.push(result.event_id) });
  assert.equal(second.jobs.get(ID).status, "COMPLETE");
  assert.equal(second.jobs.get(SECOND_ID).status, "QUEUED");
  await second.drain();
  assert.deepEqual(calls, [SECOND_ID]);
  assert.equal((await f.json(f.jobFile(SECOND_ID))).status, "COMPLETE");
});

test("Lookup partial UTF-8 waits for a newline and advances a byte cursor only after registration", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from(`${JSON.stringify(pending())}\n`, "utf8");
  const split = bytes.indexOf(Buffer.from("🚀")) + 1;
  await fs.writeFile(f.input, bytes.subarray(0, split));
  const worker = await f.open();
  await worker.drain();
  assert.equal(worker.jobs.size, 0);
  assert.equal((await f.json(f.cursorFile)).offset, 0);
  await fs.appendFile(f.input, bytes.subarray(split));
  await worker.drain();
  assert.equal((await f.json(f.cursorFile)).offset, bytes.length);
  assert.equal((await f.json(f.jobFile())).event.assets[0].name, "테스트 🚀");
  assert.equal((await f.json(f.jobFile())).status, "COMPLETE");
});

test("Catalog refresh progress never burns retry attempts, and completion wakes the waiting lookup", async t => {
  const f = await fixture(t);
  await f.append(pending());
  const catalog = new FakeCatalog({ status: "ERROR" });
  let finishRefresh;
  catalog.active = new Promise(resolve => { finishRefresh = resolve; });
  const errors = [];
  const worker = await f.open({ catalog });
  worker.start({ pollMs: 10000, onError: error => errors.push(error) });
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "WAITING_CATALOG");
  assert.equal(worker.jobs.get(ID).attempts, 0);
  for (let revision = 1; revision <= 8; revision++) {
    catalog.setStatus("ERROR", `2026-10-06T00:00:0${revision}.000Z`);
    await worker.drain();
  }
  assert.equal(worker.jobs.get(ID).attempts, 0);
  assert.equal(worker.jobs.get(ID).status, "WAITING_CATALOG");
  catalog.setStatus("FRESH");
  catalog.active = null;
  finishRefresh();
  for (let attempts = 0; attempts < 50 && worker.jobs.get(ID).status !== "COMPLETE"; attempts++) await delay(10);
  assert.equal(worker.jobs.get(ID).status, "COMPLETE");
  assert.equal(worker.jobs.get(ID).attempts, 1);
  assert.deepEqual(errors, []);
  assert.equal(catalog.listeners.size, 1);
  await worker.close();
  assert.equal(catalog.listeners.size, 0);
});

test("Catalog failure retries respect deadlines, exhaust visibly, and require explicit retryFailed after recovery", async t => {
  const f = await fixture(t);
  await f.append(pending());
  const catalog = new FakeCatalog({ status: "ERROR" });
  // This failure's API cooldown has already elapsed; matcher retry budgeting applies.
  let now = Date.parse("2026-10-06T00:01:00Z");
  const worker = await f.open({ catalog, now: () => now });
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "RETRY");
  assert.equal(worker.jobs.get(ID).attempts, 1);
  await worker.drain();
  assert.equal(worker.jobs.get(ID).attempts, 1);
  now += 1000;
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "FAILED");
  assert.equal(worker.jobs.get(ID).attempts, 2);
  assert.equal((await f.json(f.resultFile())).status, "CATALOG_PARTIAL");
  catalog.setStatus("FRESH");
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "FAILED");
  await worker.drain({ retryFailed: true });
  assert.equal(worker.jobs.get(ID).status, "COMPLETE");
  assert.equal(worker.jobs.get(ID).attempts, 1);
  assert.equal(worker.jobs.get(ID).retry_generation, 1);
});

test("Changed catalog revision retries early once, while unchanged polling cannot consume the next attempt", async t => {
  const f = await fixture(t);
  await f.append(pending());
  const catalog = new FakeCatalog({ status: "ERROR", maxAttempts: 4 });
  const worker = await f.open({ catalog, now: () => Date.parse("2026-10-06T00:01:00Z") });
  await worker.drain();
  catalog.setStatus("ERROR", "2026-10-06T00:00:01.000Z");
  await worker.drain();
  assert.equal(worker.jobs.get(ID).attempts, 2);
  for (let i = 0; i < 5; i++) await worker.drain();
  assert.equal(worker.jobs.get(ID).attempts, 2);
  catalog.setStatus("FRESH");
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "COMPLETE");
});

test("Missing symbol waits for identity and a full empty catalog remains scope-only COMPLETE", async t => {
  const f = await fixture(t);
  await f.append(pending(ID, null));
  await f.append(pending(SECOND_ID, "UNKNOWN"));
  const worker = await f.open();
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "WAITING_IDENTITY");
  assert.equal(worker.jobs.get(SECOND_ID).status, "COMPLETE");
  assert.equal((await f.json(f.resultFile(SECOND_ID))).status, "CATALOG_SEARCH_EMPTY");
  assert.equal((await f.json(f.resultFile(SECOND_ID))).identity_status, "UNVERIFIED");
  const firstAttempts = worker.jobs.get(ID).attempts;
  await worker.drain({ retryFailed: true });
  assert.equal(worker.jobs.get(ID).attempts, firstAttempts);
});

test("Completed result loss and intake checkpoint without its last job stop startup", async t => {
  const f = await fixture(t);
  await f.append(pending());
  const worker = await f.open();
  await worker.drain();
  await worker.close();
  await fs.unlink(f.resultFile());
  await assert.rejects(f.open(), /matching durable result/);
  await fs.unlink(f.jobFile());
  await assert.rejects(f.open(), /missing durable job/);
});

test("Malformed complete input and truncation stop without skipping or resetting the cursor", async t => {
  const f = await fixture(t);
  const line = `${JSON.stringify(pending())}\n`;
  await fs.writeFile(f.input, `${line}{bad}\n`);
  const worker = await f.open();
  await assert.rejects(worker.drain(), /record was not skipped/);
  assert.equal((await f.json(f.cursorFile)).offset, Buffer.byteLength(line));
  assert.equal((await f.json(f.jobFile())).status, "QUEUED");
  await fs.truncate(f.input, 0);
  await assert.rejects(worker.drain(), /truncated/);
  assert.equal((await f.json(f.cursorFile)).offset, Buffer.byteLength(line));
});

test("Wake coalescing catches input appended during an active pass, and parallel worker execution is rejected", async t => {
  const f = await fixture(t);
  await f.append(pending());
  let nextWrite;
  let worker;
  worker = await f.open({ onResult: result => {
    if (result.event_id === ID) nextWrite = f.append(pending(SECOND_ID)).then(() => worker.wake());
  } });
  await assert.rejects(f.open(), /Already running/);
  await worker.drain();
  await nextWrite;
  if (worker.active) await worker.active;
  assert.equal(worker.jobs.get(SECOND_ID).status, "COMPLETE");
  assert.equal((await f.json(f.resultFile(SECOND_ID))).event_id, SECOND_ID);
  assert.equal((await fs.readdir(path.dirname(f.resultFile()))).filter(file => file.endsWith(".json")).length, 2);
});

test("Refresh-completion wake reports fatal input once without an unhandled derived promise rejection", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.input, "");
  const catalog = new FakeCatalog({ status: "ERROR" });
  let finishRefresh;
  catalog.active = new Promise(resolve => { finishRefresh = resolve; });
  const errors = [];
  const worker = await f.open({ catalog });
  worker.start({ pollMs: 10000, onError: error => errors.push(error) });
  await worker.drain();
  await fs.appendFile(f.input, "{bad}\n");
  catalog.active = null;
  finishRefresh();
  for (let attempt = 0; attempt < 50 && !errors.length; attempt++) await delay(10);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /record was not skipped/);
  assert.equal(worker.stopped, true);
  assert.equal(catalog.listeners.size, 0);
  assert.equal((await f.json(f.cursorFile)).offset, 0);
  await delay(10);
  assert.equal(errors.length, 1);
});

test("A 600-second provider cooldown survives restart without exhausting matcher retries, then fresh recovery runs immediately", async t => {
  const f = await fixture(t);
  await f.append(pending());
  const catalog = new FakeCatalog({ status: "ERROR" });
  catalog.config.lookup_retry_ms = 30000;
  catalog.current[0].error.retry_after_ms = 600000;
  let now = Date.parse("2026-10-06T00:00:00Z");
  const expectedDeadline = new Date(now + 600000).toISOString();
  let publications = 0;
  let worker = await f.open({ catalog, now: () => now, onResult: () => publications++ });
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "WAITING_CATALOG");
  assert.equal(worker.jobs.get(ID).wait_reason, "CATALOG_COOLDOWN");
  assert.equal(worker.jobs.get(ID).next_retry_at, expectedDeadline);
  assert.equal(worker.jobs.get(ID).attempts, 0);
  for (let tick = 0; tick < 6; tick++) { now += 30000; await worker.drain(); }
  assert.equal(worker.jobs.get(ID).attempts, 0);
  assert.equal(publications, 1);
  await worker.close();
  worker = await f.open({ catalog, now: () => now, onResult: () => publications++ });
  await worker.drain();
  assert.equal(worker.jobs.get(ID).next_retry_at, expectedDeadline);
  assert.equal(worker.jobs.get(ID).attempts, 0);
  assert.equal(publications, 1);
  catalog.setStatus("FRESH", "2026-10-06T00:03:01.000Z");
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "COMPLETE");
  assert.equal(worker.jobs.get(ID).attempts, 1);
  assert.equal(publications, 2);
});

test("Ordinary catalog errors consume one matcher attempt and retain the normal 30-second retry deadline", async t => {
  const f = await fixture(t);
  await f.append(pending());
  const catalog = new FakeCatalog({ status: "ERROR", maxAttempts: 5 });
  catalog.config.lookup_retry_ms = 30000;
  let now = Date.parse("2026-10-06T00:00:00Z");
  const worker = await f.open({ catalog, now: () => now });
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "RETRY");
  assert.equal(worker.jobs.get(ID).attempts, 1);
  assert.equal(worker.jobs.get(ID).next_retry_at, "2026-10-06T00:00:30.000Z");
  now += 29999;
  await worker.drain();
  assert.equal(worker.jobs.get(ID).attempts, 1);
  now++;
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "RETRY");
  assert.equal(worker.jobs.get(ID).attempts, 2);
});

test("Ten real catalog refresh batches with ordinary network/schema failures exhaust the five-attempt matcher budget", async t => {
  const f = await fixture(t);
  await f.append(pending());
  let now = Date.parse("2026-10-06T00:00:00Z");
  let apiAttempts = 0;
  const adapter = {
    id: "synthetic", kind: "CEX", segments: [{ id: "spot", market_type: "spot", description: "Synthetic failed API" }],
    async fetchSegment() {
      apiAttempts++;
      throw Object.assign(new Error("Synthetic ordinary failure"), { code: apiAttempts % 2 ? "NETWORK_ERROR" : "SCHEMA_ERROR" });
    },
  };
  const catalog = await Catalog.open({
    root: f.root, adapters: [adapter], now: () => now,
    requestJson: async () => { throw new Error("Unexpected HTTP call in offline failure test"); },
    config: { lookup_retry_ms: 30000, lookup_max_attempts: 5, concurrency: 1 },
  });
  try {
    const worker = await f.open({ catalog, now: () => now });
    for (let batch = 0; batch < 10; batch++) {
      await catalog.refresh();
      await worker.drain();
      assert.equal(worker.jobs.get(ID).attempts, Math.min(batch + 1, 5));
      assert.equal(worker.jobs.get(ID).status, batch < 4 ? "RETRY" : "FAILED");
      now += 30000;
    }
    assert.equal(apiAttempts, 10);
    assert.equal((await f.json(f.jobFile())).status, "FAILED");
    assert.equal((await f.json(f.resultFile())).lookup_attempt, 5);
    assert.equal((await f.json(f.resultFile())).trading_allowed, false);
  } finally { await catalog.close(); }
});

test("Unclassified entries in fully fresh catalogs wait without spending retries or republishing unchanged results", async t => {
  const f = await fixture(t);
  await f.append(pending());
  const catalog = new FakeCatalog();
  catalog.current[0].exclusions = [{ market_id: "TEST-UNCLASSIFIED", base_symbol: "TEST", native_status: "PENDING_TRADING", reason: "UNCLASSIFIED_PENDING_CONTRACT" }];
  let now = Date.parse("2026-10-06T00:00:00Z");
  let publications = 0;
  const worker = await f.open({ catalog, now: () => now, onResult: () => publications++ });
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "WAITING_CATALOG");
  assert.equal(worker.jobs.get(ID).wait_reason, "UNCLASSIFIED_CATALOG_ENTRY");
  assert.equal(worker.jobs.get(ID).next_retry_at, null);
  assert.equal(worker.jobs.get(ID).attempts, 0);
  for (let tick = 0; tick < 20; tick++) { now += 30000; await worker.drain(); }
  assert.equal(worker.jobs.get(ID).status, "WAITING_CATALOG");
  assert.equal(worker.jobs.get(ID).attempts, 0);
  assert.equal(publications, 1);
  // Only the exclusion list changes; a fingerprint must notice this metadata.
  catalog.current = catalog.current.map(view => ({ ...view, exclusions: [] }));
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "COMPLETE");
  assert.equal(worker.jobs.get(ID).attempts, 1);
  assert.equal(publications, 2);
});

test("An unclassified asset alongside an expired API failure still follows the bounded network retry policy", async t => {
  const f = await fixture(t);
  await f.append(pending());
  const catalog = new FakeCatalog({ status: "ERROR" });
  catalog.current[0].exclusions = [{ market_id: "TEST-UNCLASSIFIED", base_symbol: "TEST", native_status: "PENDING_TRADING", reason: "UNCLASSIFIED_PENDING_CONTRACT" }];
  let now = Date.parse("2026-10-06T00:01:00Z");
  const worker = await f.open({ catalog, now: () => now });
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "RETRY");
  assert.equal(worker.jobs.get(ID).attempts, 1);
  now += 1000;
  await worker.drain();
  assert.equal(worker.jobs.get(ID).status, "FAILED");
  assert.equal(worker.jobs.get(ID).attempts, 2);
});

test("A lookup backlog crossing a cache TTL boundary rebuilds remaining jobs with STALE coverage", async t => {
  const f = await fixture(t);
  await f.append(pending());
  await f.append(pending(SECOND_ID));
  const catalog = new FakeCatalog();
  let now = Date.parse("2026-10-06T00:00:00Z");
  catalog.current[0].valid_until = new Date(now + 1000).toISOString();
  let viewCalls = 0;
  catalog.views = () => {
    viewCalls++;
    return catalog.current.map(view => ({ ...view, status: Date.parse(view.valid_until) > now ? "FRESH" : "STALE" }));
  };
  const worker = await f.open({ catalog, now: () => now, onResult: result => { if (result.event_id === ID) now += 2000; } });
  await worker.drain();
  assert.equal((await f.json(f.resultFile())).status, "CATALOG_CANDIDATES_READY");
  const delayed = await f.json(f.resultFile(SECOND_ID));
  assert.equal(delayed.coverage[0].status, "STALE");
  assert.equal(delayed.status, "CATALOG_PARTIAL");
  assert.equal(worker.jobs.get(SECOND_ID).status, "RETRY");
  assert.equal(viewCalls, 2, "one snapshot plus one TTL-boundary rebuild, not a per-job rehash");
});

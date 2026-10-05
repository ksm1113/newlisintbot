const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { normalizeListing } = require("../lib/listing-event.cjs");
const { JsonlWriter, writeJsonAtomic } = require("../lib/jsonl.cjs");
const { InfoConsumer } = require("../lib/info-consumer.cjs");
const { pathsFor, ensureDirectories } = require("../lib/paths.cjs");
const { main: startClient } = require("../client.cjs");

function message(overrides = {}) {
  return {
    id: 123,
    type: "announcement",
    url: "https://example.invalid/notice?id=42",
    content: { title: "테스트 코인 🚀 신규상장" },
    parser: {
      exchange: "test-exchange",
      classification: { event: "listing", type: "spot", category: "crypto", markets: ["krw"] },
      assets: [{ symbol: "TEST", name: "코인 🚀", contracts: [] }, { symbol: "SECOND" }],
    },
    detected_time_us: 1000000,
    sent_time_us: 2000000,
    ...overrides,
  };
}

async function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, "newlisting-handoff-test-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith("newlisting-handoff-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const paths = pathsFor(root);
  await ensureDirectories(paths);
  await fs.writeFile(paths.listings, "");
  return { root, paths };
}

async function records(file) {
  const text = (await fs.readFile(file, "utf8")).trim();
  return text ? text.split("\n").map(line => JSON.parse(line)) : [];
}

test("classifications are preserved; controls/non-listings are excluded; optional fields are safe", () => {
  assert.equal(normalizeListing({ type: "success", code: "READY" }), null);
  assert.equal(normalizeListing(message({ parser: { classification: { event: "delisting" } } })), null);
  assert.equal(normalizeListing(message({ parser: { classification: { event: "none" } } })), null);
  const input = message();
  const event = normalizeListing(input);
  assert.deepEqual(event.assets.map(asset => asset.symbol), ["TEST", "SECOND"]);
  assert.deepEqual(event.raw, input);
  const unknown = normalizeListing(message({ parser: { classification: { event: "listing", type: "roadmap" } } }));
  assert.equal(unknown.market_type, "roadmap");
  assert.deepEqual(unknown.assets, []);
});

test("dedup uses source identity, keeps spot/futures/exchange/notice updates separate", () => {
  const input = message();
  const event = normalizeListing(input);
  const replay = message({ id: 987, detected_time_us: 9999999, sent_time_us: 9999999, url: `${input.url}&utm_source=tg` });
  assert.equal(normalizeListing(replay).event_id, event.event_id);
  for (const changed of [
    message({ parser: { ...input.parser, exchange: "other-exchange" } }),
    message({ parser: { ...input.parser, classification: { ...input.parser.classification, type: "futures" } } }),
    message({ content: { title: "추가 코인 신규상장" } }),
  ]) assert.notEqual(normalizeListing(changed).event_id, event.event_id);
});

test("watcher to file to consumer works offline through a fake socket", async t => {
  const { root, paths } = await fixture(t);
  let socket;
  class FakeSocket extends EventEmitter {
    constructor() { super(); socket = this; }
    terminate() { this.emit("close", 1000); }
    close() { this.emit("close", 1000); }
  }
  const client = await startClient({ root, key: "offline-test-only", WebSocketImpl: FakeSocket, installSignalHandlers: false });
  t.after(() => client.shutdown());
  socket.emit("message", Buffer.from(JSON.stringify({ type: "success", code: "READY" })));
  socket.emit("message", Buffer.from(JSON.stringify(message())));
  socket.emit("message", Buffer.from(JSON.stringify(message({ id: 999 }))));
  socket.emit("message", Buffer.from(JSON.stringify(message({ parser: { classification: { event: "none" } } }))));
  await client.flush();
  assert.equal((await records(paths.listings)).length, 2);
  const consumer = await InfoConsumer.open({ root });
  try {
    await consumer.drain();
    const results = await records(paths.results);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "LOOKUP_PENDING");
    assert.equal(results[0].cex.status, "NOT_QUERIED");
    assert.equal(results[0].trading_allowed, false);
    assert.equal(consumer.state.offset, (await fs.stat(paths.listings)).size);
  } finally { await consumer.close(); }
  await client.shutdown();
});

test("partial UTF-8 line waits for completion and checkpoint counts bytes", async t => {
  const { root, paths } = await fixture(t);
  const line = Buffer.from(`${JSON.stringify(normalizeListing(message()))}\n`);
  const split = line.indexOf(Buffer.from("코인")) + 1;
  assert.ok(split > 0);
  await fs.appendFile(paths.listings, line.subarray(0, split));
  const consumer = await InfoConsumer.open({ root });
  try {
    await consumer.drain();
    assert.equal(consumer.state.offset, 0);
    assert.equal((await records(paths.results)).length, 0);
    await fs.appendFile(paths.listings, line.subarray(split));
    await consumer.drain();
    assert.equal(consumer.state.offset, line.length);
    assert.equal((await records(paths.results))[0].assets[0].name, "코인 🚀");
  } finally { await consumer.close(); }
});

test("restart resumes; crash between durable result and checkpoint does not duplicate", async t => {
  const { root, paths } = await fixture(t);
  await fs.appendFile(paths.listings, `${JSON.stringify(normalizeListing(message()))}\n`);
  let consumer = await InfoConsumer.open({ root });
  await consumer.drain();
  const committed = { ...consumer.state };
  await consumer.close();
  consumer = await InfoConsumer.open({ root });
  await consumer.drain();
  assert.equal((await records(paths.results)).length, 1);
  await consumer.close();
  // Simulate a crash after result sync but before the first cursor update.
  await writeJsonAtomic(paths.cursor, { ...committed, offset: 0, last_event_id: null });
  consumer = await InfoConsumer.open({ root });
  try {
    await consumer.drain();
    assert.equal((await records(paths.results)).length, 1);
    assert.equal(consumer.state.offset, committed.offset);
  } finally { await consumer.close(); }
});

test("polling discovers a new line even when file-watch notifications are disabled", async t => {
  const { root, paths } = await fixture(t);
  let processed;
  const completed = new Promise(resolve => { processed = resolve; });
  const consumer = await InfoConsumer.open({ root, onRecord: processed });
  try {
    consumer.start({ pollMs: 20, onError: error => { throw error; } });
    consumer.watcher?.close();
    consumer.watcher = null;
    await consumer.drain();
    await fs.appendFile(paths.listings, `${JSON.stringify(normalizeListing(message()))}\n`);
    await Promise.race([completed, delay(2000).then(() => { throw new Error("Polling failed to catch the new line."); })]);
    assert.equal((await records(paths.results)).length, 1);
  } finally { await consumer.close(); }
});

test("malformed completed input fails visibly and does not advance past it", async t => {
  const { root, paths } = await fixture(t);
  const valid = `${JSON.stringify(normalizeListing(message()))}\n`;
  await fs.appendFile(paths.listings, `${valid}{broken}\n`);
  const consumer = await InfoConsumer.open({ root });
  try {
    await assert.rejects(consumer.drain(), /Invalid listing JSON/);
    assert.equal(consumer.state.offset, Buffer.byteLength(valid));
    assert.equal((await records(paths.results)).length, 1);
  } finally { await consumer.close(); }
});

test("input truncation and replacement do not silently reset the cursor", async t => {
  const { root, paths } = await fixture(t);
  await fs.appendFile(paths.listings, `${JSON.stringify(normalizeListing(message()))}\n`);
  const consumer = await InfoConsumer.open({ root });
  try {
    await consumer.drain();
    const offset = consumer.state.offset;
    await fs.truncate(paths.listings, 0);
    await assert.rejects(consumer.drain(), /truncated/);
    await fs.rename(paths.listings, `${paths.listings}.old`);
    await fs.writeFile(paths.listings, "");
    await assert.rejects(consumer.drain(), /replaced/);
    assert.equal(consumer.state.offset, offset);
  } finally { await consumer.close(); }
});

test("writer recovers complete missing newline and preserves interrupted fragments", async t => {
  const { paths } = await fixture(t);
  const recovered = [];
  await fs.writeFile(paths.listings, '{"value":1}');
  let writer = await JsonlWriter.open(paths.listings, { onRecovery: text => recovered.push(text) });
  await writer.append({ value: 2 });
  await writer.close();
  assert.deepEqual(await records(paths.listings), [{ value: 1 }, { value: 2 }]);
  await fs.appendFile(paths.listings, '{"unfinished":');
  writer = await JsonlWriter.open(paths.listings, { onRecovery: text => recovered.push(text) });
  await writer.append({ value: 3 });
  await writer.close();
  const backup = (await fs.readdir(paths.data)).find(name => name.startsWith("listings.jsonl.partial-"));
  assert.equal(await fs.readFile(path.join(paths.data, backup), "utf8"), '{"unfinished":');
  assert.equal((await records(paths.listings)).length, 3);
  assert.equal(recovered.length, 2);
});

test("partial result after a crash is repaired and replayed once", async t => {
  const { root, paths } = await fixture(t);
  await fs.appendFile(paths.listings, `${JSON.stringify(normalizeListing(message()))}\n`);
  await fs.writeFile(paths.results, '{"schema_version":1,"event_id":');
  const consumer = await InfoConsumer.open({ root, onRecovery: () => {} });
  try {
    await consumer.drain();
    assert.equal((await records(paths.results)).length, 1);
    assert.ok((await fs.readdir(paths.data)).some(name => name.startsWith("info-results.jsonl.partial-")));
  } finally { await consumer.close(); }
});

test("a second consumer is rejected and missing results do not silently skip input", async t => {
  const { root, paths } = await fixture(t);
  await fs.appendFile(paths.listings, `${JSON.stringify(normalizeListing(message()))}\n`);
  const first = await InfoConsumer.open({ root });
  try {
    await assert.rejects(InfoConsumer.open({ root }), /Already running/);
    await first.drain();
  } finally { await first.close(); }
  await fs.writeFile(paths.results, "");
  await assert.rejects(InfoConsumer.open({ root }), /no matching durable result/);
});

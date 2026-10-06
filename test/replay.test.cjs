const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { runReplay } = require("../lib/replay.cjs");
const { normalizeListing } = require("../lib/listing-event.cjs");

async function tempProject(t) {
  const base = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, "newlisting-replay-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), base);
    assert.ok(path.basename(root).startsWith("newlisting-replay-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function jsonl(file) {
  const text = (await fs.readFile(file, "utf8")).trim();
  return text ? text.split("\n").map(line => JSON.parse(line)) : [];
}

test("synthetic replay uses automatic intake, preserves classification, deduplicates, and isolates operational files", async t => {
  const root = await tempProject(t);
  await fs.mkdir(path.join(root, "data"));
  await fs.mkdir(path.join(root, "state"));
  const originals = ["data/listings.jsonl", "data/info-results.jsonl", "state/info-consumer.json"];
  for (const name of originals) await fs.writeFile(path.join(root, name), `operational sentinel: ${name}`);
  const { report, reportPath, runRoot } = await runReplay({ projectRoot: root, waitMs: 5000 });
  assert.equal(report.status, "PASSED");
  assert.equal(report.source.kind, "SYNTHETIC");
  assert.equal(report.counts.input_messages, 9);
  assert.equal(report.counts.input_listing_messages, 7);
  assert.equal(report.counts.unique_listing_events, 6);
  assert.equal(report.counts.pending_result_records, 6);
  assert.equal(report.counts.automatic_intake_callbacks, 6);
  assert.equal(report.detection.post_replay_manual_drain, false);
  assert.equal(report.cursor.matches_end, true);
  assert.equal(report.local_latency.sample_count, 6);
  assert.ok(report.local_latency.max_ms >= report.local_latency.p50_ms);
  assert.equal(path.dirname(runRoot), path.join(root, "data", "checks"));
  assert.equal(JSON.parse(await fs.readFile(reportPath, "utf8")).status, "PASSED");
  const listings = await jsonl(report.artifacts.listings);
  assert.ok(listings.some(item => item.market_type === "roadmap"));
  assert.ok(listings.some(item => item.market_type === "futures"));
  assert.ok(listings.some(item => item.assets.length === 2));
  assert.ok(listings.some(item => item.assets.length === 0));
  assert.ok((await jsonl(report.artifacts.pending_results)).every(item => item.trading_allowed === false && item.cex.status === "NOT_QUERIED"));
  for (const name of originals) assert.equal(await fs.readFile(path.join(root, name), "utf8"), `operational sentinel: ${name}`);
  assert.ok(!(await fs.readdir(path.join(runRoot, "state"))).some(name => name.endsWith(".lock")));
});

test("user-provided raw messages and normalized raw wrappers replay without claiming feed authenticity", async t => {
  const root = await tempProject(t);
  const message = {
    type: "announcement", id: "user-test", url: "https://user.example.invalid/notice",
    content: { title: "사용자 제공 테스트" },
    parser: { exchange: "user-test-exchange", classification: { event: "listing", type: "spot" }, assets: [{ symbol: "USER" }] },
  };
  const file = path.join(root, "input.jsonl");
  await fs.writeFile(file, `${JSON.stringify(message)}\n${JSON.stringify(normalizeListing({ ...message, id: "duplicate" }))}`);
  const { report } = await runReplay({ projectRoot: root, file, waitMs: 5000 });
  assert.equal(report.source.kind, "USER_PROVIDED_UNVERIFIED");
  assert.equal(report.counts.normalized_wrappers_extracted, 1);
  assert.equal(report.counts.written_listing_records, 2);
  assert.equal(report.counts.pending_result_records, 1);
  assert.deepEqual((await jsonl(report.artifacts.listings)).map(item => item.raw.id), ["user-test", "duplicate"]);
  assert.equal(report.cursor.offset_bytes, (await fs.stat(report.artifacts.listings)).size);
});

test("malformed replay input fails before watcher startup and saves a failure report", async t => {
  const root = await tempProject(t);
  const file = path.join(root, "bad.jsonl");
  await fs.writeFile(file, '{"type":"success","code":"READY"}\n{broken}\n');
  let failure;
  await assert.rejects(runReplay({ projectRoot: root, file }), error => {
    failure = error;
    return /Invalid JSON at line 2/.test(error.message);
  });
  const report = JSON.parse(await fs.readFile(failure.reportPath, "utf8"));
  assert.equal(report.status, "FAILED");
  assert.match(report.error, /line 2/);
  assert.equal(report.source.kind, "USER_PROVIDED_UNVERIFIED");
  assert.deepEqual(await fs.readdir(failure.runRoot), ["report.json"]);
});

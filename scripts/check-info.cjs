const fs = require("node:fs/promises");
const path = require("node:path");
const { Catalog } = require("../lib/markets/catalog.cjs");
const { VENUE_IDS, adaptersFor } = require("../lib/markets/registry.cjs");
const { market } = require("../lib/markets/model.cjs");
const { LookupWorker } = require("../lib/markets/lookup-worker.cjs");
const { InfoConsumer } = require("../lib/info-consumer.cjs");
const { main: startClient } = require("../client.cjs");
const { writeJsonAtomic } = require("../lib/jsonl.cjs");
const { EventEmitter } = require("node:events");
const { createRequester } = require("../lib/markets/http.cjs");
const { createHash } = require("node:crypto");

async function main(args = process.argv.slice(2)) {
  const live = args.includes("--live");
  const selected = args.length === 3 && args[0] === "--live" && args[1] === "--venue" && VENUE_IDS.includes(args[2]) ? args[2] : null;
  if (args.length && !(args.length === 1 && live) && !selected) throw new Error("Usage: node scripts/check-info.cjs [--live [--venue <id>]]");
  const checks = path.resolve(__dirname, "../data/checks");
  await fs.mkdir(checks, { recursive: true });
  const root = await fs.mkdtemp(path.join(checks, live ? "catalog-live-" : "info-offline-"));
  let catalog, worker, consumer, client, socket, failure;
  const report = { schema_version: 1, mode: live ? "LIVE_PUBLIC_CATALOGS" : "SYNTHETIC_INFO_PIPELINE", started_at: new Date().toISOString(), root, status: "FAILED", trading_allowed: false };
  try {
    const adapters = live ? adaptersFor(selected ? [selected] : undefined) : VENUE_IDS.map((id, index) => ({
      id, kind: index < 5 ? "CEX" : "PERP_DEX",
      segments: [{ id: "test", market_type: index < 5 ? "spot" : "perpetual", description: "SYNTHETIC TEST ONLY" }],
      async fetchSegment() {
        return [market({ venue: id, venue_kind: this.kind, segment: "test", market_id: "TEST-USDT", market_type: index < 5 ? "spot" : "perpetual",
          base_symbol: "TEST", quote_symbol: "USDT", native_status: "test", market_status: "ACTIVE", source: "https://example.invalid/synthetic", raw: { test: true } })];
      },
    }));
    let requestJson;
    if (selected) {
      const requester = createRequester();
      const directory = path.join(root, "responses");
      await fs.mkdir(directory);
      requestJson = async (url, options) => {
        const response = await requester(url, options);
        const id = createHash("sha256").update(url + JSON.stringify(options?.body ?? null)).digest("hex").slice(0, 16);
        await writeJsonAtomic(path.join(directory, `${id}.json`), { source: url, received_at: new Date().toISOString(), response });
        return response;
      };
    }
    catalog = await Catalog.open({ root, adapters, requestJson });
    report.catalog = await catalog.refresh();
    if (live) {
      report.status = report.catalog.fresh_segments === report.catalog.total_segments ? "PASSED" : "PARTIAL";
    } else {
      let result;
      worker = await LookupWorker.open({ root, catalog, onResult: value => { result = value; } });
      consumer = await InfoConsumer.open({ root, onRecord: () => worker.wake() });
      worker.start({ onError: error => { failure ||= error; } });
      consumer.start({ onError: error => { failure ||= error; } });
      class FakeSocket extends EventEmitter {
        constructor() { super(); socket = this; }
        terminate() { this.emit("close", 1000); }
        close() { this.terminate(); }
      }
      client = await startClient({ root, key: "offline-only", WebSocketImpl: FakeSocket, installSignalHandlers: false, logger: { log() {}, error(text) { failure ||= new Error(text); } } });
      socket.emit("message", Buffer.from(JSON.stringify({
        type: "announcement", id: "synthetic-info-check", url: "https://example.invalid/info-listing",
        content: { title: "Synthetic TEST listing" },
        parser: { exchange: "test", classification: { event: "listing", type: "spot" }, assets: [{ symbol: "TEST" }] },
      })));
      await client.flush();
      const deadline = Date.now() + 10000;
      while (!result && !failure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (failure) throw failure;
      if (!result || result.status !== "CATALOG_CANDIDATES_READY" || result.candidate_count !== 9 || result.trading_allowed !== false) throw new Error("Information pipeline did not produce nine unverified candidates.");
      report.result = result;
      report.status = "PASSED";
    }
  } catch (error) { failure = error; report.error = error.message; }
  finally {
    const outcomes = await Promise.allSettled([client?.shutdown(), consumer?.close(), worker?.close(), catalog?.close()]);
    for (const outcome of outcomes) if (outcome.status === "rejected") { failure ||= outcome.reason; report.error ||= outcome.reason.message; }
  }
  if (failure) report.status = "FAILED";
  report.finished_at = new Date().toISOString();
  await writeJsonAtomic(path.join(root, "report.json"), report);
  console.log(`[정보부 검사] ${report.status} / ${report.mode}`);
  if (report.catalog) {
    console.log(`목록 정상 ${report.catalog.fresh_segments}/${report.catalog.total_segments}개 상품군`);
    for (const item of report.catalog.segments) console.log(`${item.venue}/${item.segment}: ${item.status} / ${item.market_count}개${item.error ? ` / ${item.error.message}` : ""}`);
  }
  if (report.result) console.log(`시장 후보 ${report.result.candidate_count}개 / 미검증 / trading_allowed=false`);
  if (report.error) console.error(report.error);
  console.log(`보고서: ${path.join(root, "report.json")}`);
  if (report.status !== "PASSED") process.exitCode = 1;
  return report;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };

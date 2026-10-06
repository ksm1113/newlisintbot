"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { main } = require("../info.cjs");
const { normalizeListing } = require("../lib/listing-event.cjs");
const { market } = require("../lib/markets/model.cjs");

function listing(label = "runtime-1") {
  return normalizeListing({
    type: "announcement", id: label, url: `https://example.invalid/runtime/${label}`,
    content: { title: "테스트 🚀 신규상장" },
    parser: { exchange: "synthetic", classification: { event: "listing", type: "spot" }, assets: [{ symbol: "TEST", contracts: [] }] },
  });
}

async function fixture(t) {
  const temporary = path.resolve(os.tmpdir());
  const prefix = "newlisting-info-runtime-test-";
  const root = await fs.mkdtemp(path.join(temporary, prefix));
  const runtimes = [];
  const messages = [];
  const errors = [];
  const calls = [];
  const timeline = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.shutdown();
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), temporary);
    assert.ok(path.basename(absolute).startsWith(prefix));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const input = path.join(root, "data", "listings.jsonl");
  await fs.mkdir(path.dirname(input), { recursive: true });
  await fs.writeFile(input, "");
  const source = "https://catalog.invalid/spot";
  const adapter = {
    id: "synthetic", kind: "CEX", segments: [{ id: "spot", market_type: "spot", description: "Synthetic runtime test scope" }],
    async fetchSegment(segment, { requestJson, signal }) {
      assert.equal(segment, "spot");
      const response = await requestJson(source, { signal });
      return response.symbols.map(symbol => market({
        venue: "synthetic", venue_kind: "CEX", segment: "spot", market_type: "spot",
        market_id: `${symbol}_USDT`, base_symbol: symbol, quote_symbol: "USDT",
        market_status: "ACTIVE", source, raw: { symbol },
      }));
    },
  };
  const baseOptions = {
    root, adapters: [adapter], args: [], installSignalHandlers: false, enableEnrichment:false,
    config: { refresh_interval_ms: 60000, cache_ttl_ms: 120000, lookup_retry_ms: 5000, request_timeout_ms: 1000, segment_timeout_ms: 5000 },
    requestJson: async (url, { signal }) => {
      assert.equal(url, source);
      assert.equal(signal.aborted, false);
      calls.push(url); timeline.push("catalog");
      return { symbols: ["TEST"] };
    },
    logger: {
      log(text) {
        messages.push(text);
        if (text.includes("접수:")) timeline.push("intake");
        if (text.includes("시장 후보 1개")) timeline.push("result");
      },
      error(text) { errors.push(text); },
    },
  };
  const start = async changes => {
    const runtime = await main({ ...baseOptions, ...changes });
    if (runtime) runtimes.push(runtime);
    return runtime;
  };
  const append = async event => fs.appendFile(input, `${JSON.stringify(event)}\n`);
  const json = async file => JSON.parse(await fs.readFile(file, "utf8"));
  const resultFile = event => path.join(root, "data", "market-results", `${event.event_id}.json`);
  const jobFile = event => path.join(root, "state", "market-jobs", `${event.event_id}.json`);
  return { root, input, baseOptions, calls, messages, errors, timeline, start, append, json, resultFile, jobFile };
}

async function intakeRecords(root) {
  const input = (await fs.readFile(path.join(root, "data", "info-results.jsonl"), "utf8")).trim();
  return input ? input.split("\n").map(line => JSON.parse(line)) : [];
}

async function assertLocksReleased(root) {
  for (const name of ["info-consumer.lock", "catalog.lock", "market-lookup.lock"]) {
    await assert.rejects(fs.stat(path.join(root, "state", name)), { code: "ENOENT" });
  }
}

async function waitForComplete(f, event) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    assert.deepEqual(f.errors, [], "runtime must not report a background failure");
    // The runtime announces the result only after the result and job are durable.
    // Wait through that public boundary instead of opening a job file while it is being replaced.
    if (f.messages.some(message => message.includes("CATALOG_CANDIDATES_READY"))) {
      assert.equal((await f.json(f.jobFile(event))).status, "COMPLETE");
      return await f.json(f.resultFile(event));
    }
    await delay(20);
  }
  throw new Error("Runtime did not automatically publish a complete market result.");
}

test("info --once only registers pending intake and never calls market adapters or HTTP", async t => {
  const f = await fixture(t);
  const event = listing();
  await f.append(event);
  let adapterCalls = 0;
  let httpCalls = 0;
  await f.start({
    args: ["--once"],
    adapters: [{ id: "forbidden", kind: "CEX", segments: [], fetchSegment: async () => { adapterCalls++; throw new Error("Unexpected adapter call"); } }],
    requestJson: async () => { httpCalls++; throw new Error("Unexpected HTTP call"); },
  });
  assert.equal(adapterCalls, 0);
  assert.equal(httpCalls, 0);
  const intake = await intakeRecords(f.root);
  assert.equal(intake.length, 1);
  assert.equal(intake[0].event_id, event.event_id);
  assert.equal(intake[0].status, "LOOKUP_PENDING");
  assert.equal(intake[0].trading_allowed, false);
  await assert.rejects(fs.stat(path.join(f.root, "data", "catalogs")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.root, "state", "market-jobs")), { code: "ENOENT" });
  const cursor = await f.json(path.join(f.root, "state", "info-consumer.json"));
  assert.equal(cursor.offset, (await fs.stat(f.input)).size);
  assert.deepEqual(f.errors, []);
  await assertLocksReleased(f.root);
});

test("info --lookup-once wires intake, catalog and result in order and releases every lock", async t => {
  const f = await fixture(t);
  const event = listing();
  await f.append(event);
  await f.start({ args: ["--lookup-once"] });
  assert.deepEqual(f.timeline, ["intake", "catalog", "result"]);
  assert.equal(f.calls.length, 1);
  const result = await f.json(f.resultFile(event));
  assert.equal(result.event_id, event.event_id);
  assert.equal(result.status, "CATALOG_CANDIDATES_READY");
  assert.equal(result.candidate_count, 1);
  assert.equal(result.identity_status, "UNVERIFIED");
  assert.equal(result.trading_allowed, false);
  assert.equal((await f.json(f.jobFile(event))).status, "COMPLETE");
  assert.equal((await intakeRecords(f.root))[0].status, "LOOKUP_PENDING");
  assert.deepEqual(f.errors, []);
  await assertLocksReleased(f.root);
});

test("default info runtime automatically observes a new listing and shutdown stops all components", async t => {
  const f = await fixture(t);
  const runtime = await f.start();
  assert.ok(runtime.catalog.timer);
  assert.ok(runtime.consumer.timer);
  assert.ok(runtime.worker.timer);
  const event = listing("automatic");
  await f.append(event);
  // Do not invoke consumer.drain or worker.drain: exercise the actual runtime wake-up wiring.
  const result = await waitForComplete(f, event);
  assert.equal(result.status, "CATALOG_CANDIDATES_READY");
  assert.equal(result.candidate_count, 1);
  assert.equal(result.trading_allowed, false);
  assert.equal((await intakeRecords(f.root)).length, 1);
  assert.equal(f.calls.length, 1);
  await runtime.shutdown();
  await runtime.shutdown();
  assert.equal(runtime.catalog.closed, true);
  assert.equal(runtime.consumer.closed, true);
  assert.equal(runtime.worker.closed, true);
  assert.equal(runtime.consumer.timer, null);
  assert.equal(runtime.worker.timer, null);
  assert.deepEqual(f.errors, []);
  await assertLocksReleased(f.root);
});

test("duplicate info runtime is rejected without disturbing the original runtime's locks or processing", async t => {
  const f = await fixture(t);
  const runtime = await f.start();
  const names = ["info-consumer.lock", "catalog.lock", "market-lookup.lock"];
  const before = await Promise.all(names.map(name => fs.readFile(path.join(f.root, "state", name), "utf8")));
  await assert.rejects(f.start(), /Already running/);
  const after = await Promise.all(names.map(name => fs.readFile(path.join(f.root, "state", name), "utf8")));
  assert.deepEqual(after, before);
  assert.equal(runtime.consumer.closed, false);
  assert.equal(runtime.worker.closed, false);
  assert.equal(runtime.catalog.closed, false);
  const event = listing("after-duplicate-rejection");
  await f.append(event);
  assert.equal((await waitForComplete(f, event)).candidate_count, 1);
  await runtime.shutdown();
  await assertLocksReleased(f.root);
  assert.deepEqual(f.errors, []);
});

test('default enrichment lane cannot delay market output while network metadata HTTP is pending',async t=>{
  const f=await fixture(t);let networkStarted=false;
  const networkAdapter={id:'synthetic',fetchCoins:async({signal})=>{
    networkStarted=true;
    await new Promise((resolve,reject)=>{
      if(signal.aborted)return reject(new Error('cancelled'));
      signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
    });
    return [];
  }};
  const runtime=await f.start({enableEnrichment:true,networkAdapters:[networkAdapter],networkCredentials:{},
    networkRequestJson:async()=>{throw new Error('No network request allowed in runtime fixture');},
    identityRequester:async()=>{throw new Error('No identity request allowed for unsupported fixture source');}});
  const event=listing('independent-enrichment');await f.append(event);
  assert.equal((await waitForComplete(f,event)).candidate_count,1);assert.equal(networkStarted,true);
  const output=path.join(f.root,'data','enrichment-results',`${event.event_id}.json`);
  const deadline=Date.now()+3000;let enriched;
  while(Date.now()<deadline){try{enriched=await f.json(output);break;}catch(error){if(error.code !== 'ENOENT')throw error;}await delay(20);}
  assert.equal(enriched?.status,'ROUTE_FILTER_EVALUATED');assert.equal(enriched?.eligible_spot_count,0);
  await runtime.shutdown();assert.equal(runtime.networks.closed,true);assert.equal(runtime.enrichment.closed,true);
  for(const name of ['networks.lock','enrichment.lock'])await assert.rejects(fs.stat(path.join(f.root,'state',name)),{code:'ENOENT'});
});

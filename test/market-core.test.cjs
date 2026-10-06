"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Catalog } = require("../lib/markets/catalog.cjs");
const { createRequester } = require("../lib/markets/http.cjs");
const { market } = require("../lib/markets/model.cjs");
const { buildResult } = require("../lib/markets/matcher.cjs");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function temporary(t) {
  const prefix = "newlisting-market-core-test-";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
    const absolute = path.resolve(directory);
    const relative = path.relative(path.resolve(os.tmpdir()), absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(absolute).startsWith(prefix)) {
      throw new Error("Refusing to remove a path outside this test's temporary directory.");
    }
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return { root: directory, dispose: action => disposers.push(action) };
}

function entry(venue, symbol = "TEST") {
  return market({
    venue, venue_kind: "CEX", segment: "spot", market_id: `${symbol}_USDT`,
    market_type: "spot", base_symbol: symbol, quote_symbol: "USDT",
    market_status: "ACTIVE", source: `https://${venue}.invalid/catalog`, raw: { symbol },
  });
}
function adapter(id, fetchSegment = async () => [entry(id)]) {
  return { id, kind: "CEX", segments: [{ id: "spot", market_type: "spot", description: `${id} test spot scope` }], fetchSegment };
}
function options(root, adapters, now = () => Date.now()) {
  return { root, adapters, requestJson: async () => { throw new Error("Unexpected HTTP call in catalog test"); }, now,
    config: { concurrency: 2, cache_ttl_ms: 10000, lookup_retry_ms: 1000, request_timeout_ms: 1000, segment_timeout_ms: 10000 } };
}

test("catalog keeps a failed venue's last good markets STALE across restart while another venue refreshes", async t => {
  const temp = await temporary(t);
  let clock = Date.parse("2026-10-06T00:00:00Z");
  let failAlpha = false;
  let betaVersion = "FIRST";
  let calls = 0;
  const adapters = [adapter("alpha", async () => {
    calls++;
    if (failAlpha) throw Object.assign(new Error("synthetic upstream unavailable"), { code: "UPSTREAM_TEST" });
    return [entry("alpha", "1000TEST")];
  }), adapter("beta", async () => { calls++; return [entry("beta", betaVersion)]; })];
  let catalog = await Catalog.open(options(temp.root, adapters, () => clock));
  temp.dispose(async () => { await catalog.close().catch(() => {}); });
  assert.deepEqual(catalog.views().map(view => view.status), ["NOT_FETCHED", "NOT_FETCHED"]);
  await catalog.refresh();
  assert.deepEqual(catalog.views().map(view => view.status), ["FRESH", "FRESH"]);
  clock += 100;
  failAlpha = true;
  betaVersion = "SECOND";
  await catalog.refresh();
  assert.deepEqual(catalog.views().map(view => view.status), ["STALE", "FRESH"]);
  assert.equal(catalog.views()[0].markets[0].base_symbol, "1000TEST");
  assert.equal(catalog.views()[0].error.code, "UPSTREAM_TEST");
  assert.equal(catalog.views()[1].markets[0].base_symbol, "SECOND");
  await catalog.close();
  catalog = await Catalog.open(options(temp.root, adapters, () => clock));
  assert.deepEqual(catalog.views().map(view => view.status), ["STALE", "FRESH"]);
  assert.equal(catalog.views()[0].markets.length, 1);
  assert.equal(catalog.views()[0].markets[0].trading_allowed, false);
  const priorCalls = calls;
  await catalog.refresh({ dueOnly: true });
  assert.equal(calls, priorCalls, "persisted failure backoff must survive restart");
});

test("cold catalog failure is persisted as ERROR rather than a successful empty catalog", async t => {
  const temp = await temporary(t);
  const adapters = [adapter("alpha", async () => { throw new Error("cold upstream unavailable"); }), adapter("beta")];
  let catalog = await Catalog.open(options(temp.root, adapters));
  temp.dispose(async () => { await catalog.close().catch(() => {}); });
  await catalog.refresh();
  assert.deepEqual(catalog.views().map(view => view.status), ["ERROR", "FRESH"]);
  await catalog.close();
  catalog = await Catalog.open(options(temp.root, adapters));
  assert.equal(catalog.views()[0].status, "ERROR");
  assert.equal(catalog.views()[0].markets.length, 0);
  assert.match(catalog.views()[0].error.message, /cold upstream unavailable/);
});

test("catalog preserves excluded unclassified contracts across restart and matcher holds matching assets", async t => {
  const temp = await temporary(t);
  const excluded = { market_id: "PENDING_USDT", base_symbol: "PENDING", native_contract_type: "",
    native_status: "PENDING_TRADING", reason: "UNCLASSIFIED_PENDING_CONTRACT", source: "https://alpha.invalid/catalog" };
  const markets = [entry("alpha")];
  markets.exclusions = [excluded];
  const adapters = [adapter("alpha", async () => markets)];
  let catalog = await Catalog.open(options(temp.root, adapters));
  temp.dispose(async () => { await catalog.close().catch(() => {}); });
  await catalog.refresh();
  assert.equal(catalog.summary().segments[0].excluded_count, 1);
  assert.equal(catalog.views()[0].markets.length, 1);
  await catalog.close();
  catalog = await Catalog.open(options(temp.root, adapters));
  assert.deepEqual(catalog.views()[0].exclusions, [excluded]);
  const result = buildResult({ event_id: "pending-1", assets: [{ symbol: "PENDING" }] }, catalog);
  assert.equal(result.coverage[0].status, "FRESH");
  assert.equal(result.status, "CATALOG_PARTIAL");
  assert.equal(result.assets[0].status, "UNCLASSIFIED_CATALOG_ENTRY");
  assert.equal(result.assets[0].unclassified[0].market_id, "PENDING_USDT");
  assert.equal(result.candidate_count, 0);
  assert.equal(result.trading_allowed, false);
});

async function fatalParallelCase(t, trigger) {
  const temp = await temporary(t);
  const slowResult = deferred();
  const fatalObserved = deferred();
  const adapters = [adapter("alpha"), adapter("beta", async (_segment, { signal }) => {
    signal.addEventListener("abort", () => fatalObserved.resolve(), { once: true });
    await slowResult.promise; // Deliberately stay in flight after cancellation to verify the ownership barrier.
    return [entry("beta")];
  })];
  const catalog = await Catalog.open(options(temp.root, adapters));
  temp.dispose(async () => { slowResult.resolve(); await catalog.close().catch(() => {}); });
  if (trigger === "storage") {
    // A directory occupying the snapshot filename causes a real atomic rename failure.
    await fs.mkdir(catalog.file(catalog.tasks[0]));
  } else {
    catalog.subscribe(view => { if (view.venue === "alpha") throw new Error("synthetic listener failure"); });
  }
  let refreshFinished = false;
  const refreshing = catalog.refresh().then(() => { refreshFinished = true; return null; }, error => { refreshFinished = true; return error; });
  await fatalObserved.promise;
  let closeFinished = false;
  const closingOne = catalog.close().then(() => { closeFinished = true; return null; }, error => { closeFinished = true; return error; });
  const closingTwo = catalog.close().catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshFinished, false);
  assert.equal(closeFinished, false);
  const lockFile = path.join(temp.root, "state", "catalog.lock");
  assert.equal(JSON.parse(await fs.readFile(lockFile, "utf8")).pid, process.pid);
  await assert.rejects(Catalog.open(options(temp.root, adapters)), /Already running/);
  slowResult.resolve();
  const [refreshError, closeErrorOne, closeErrorTwo] = await Promise.all([refreshing, closingOne, closingTwo]);
  assert.ok(refreshError instanceof Error, "fatal errors must reach the caller");
  assert.equal(closeErrorOne, refreshError);
  assert.equal(closeErrorTwo, refreshError);
  assert.equal(catalog.failures.size, 0, "storage/listener failure must not be relabeled as an upstream outage");
  await assert.rejects(fs.stat(lockFile), { code: "ENOENT" });
}

test("fatal storage failure retains the catalog lock until all parallel workers settle", async t => fatalParallelCase(t, "storage"));
test("fatal listener failure and concurrent close calls wait for all parallel workers", async t => fatalParallelCase(t, "listener"));

test("requester blocks queued requests after 429 and leaves another host usable", async () => {
  const calls = [];
  const request = createRequester({ minIntervalMs: 0, fetchImpl: async url => {
    calls.push(url);
    return url.includes("limited.invalid")
      ? new Response("limited", { status: 429, headers: { "retry-after": "60" } })
      : Response.json({ ok: true });
  } });
  const first = request("https://limited.invalid/first").catch(error => error);
  const queued = request("https://limited.invalid/second").catch(error => error);
  const [limitedError, cooldownError] = await Promise.all([first, queued]);
  assert.equal(limitedError.code, "HTTP_429");
  assert.equal(limitedError.retryAfterMs, 60000);
  assert.equal(cooldownError.code, "HOST_COOLDOWN");
  assert.ok(cooldownError.retryAfterMs > 0);
  assert.equal(calls.length, 1, "queued same-host request must not reach fetch during cooldown");
  assert.deepEqual(await request("https://other.invalid/catalog"), { ok: true });
  assert.equal(calls.length, 2);
});

test("requester uses a ban cooldown for HTTP 418 and rejects excessive or invalid JSON bodies", async () => {
  let banCalls = 0;
  const banned = createRequester({ minIntervalMs: 0, fetchImpl: async () => { banCalls++; return new Response("banned", { status: 418 }); } });
  await assert.rejects(banned("https://banned.invalid/first"), error => error.code === "HTTP_418" && error.retryAfterMs === 60000);
  await assert.rejects(banned("https://banned.invalid/second"), error => error.code === "HOST_COOLDOWN");
  assert.equal(banCalls, 1);
  const oversized = createRequester({ maxBytes: 8, fetchImpl: async () => new Response('{"message":"too large"}') });
  await assert.rejects(oversized("https://large.invalid/catalog"), /exceeds 8 bytes/);
  const invalid = createRequester({ fetchImpl: async () => new Response("not JSON") });
  await assert.rejects(invalid("https://bad.invalid/catalog"), /Invalid market JSON/);
});

test("requester timeout aborts an injected fetch and releases its queue for the next call", async () => {
  let calls = 0;
  let observedTimeout = false;
  const request = createRequester({ timeoutMs: 20, minIntervalMs: 0, fetchImpl: async (_url, { signal }) => {
    calls++;
    if (calls > 1) return Response.json({ recovered: true });
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      observedTimeout = signal.reason?.name === "TimeoutError";
      reject(signal.reason);
    }, { once: true }));
  } });
  // AbortSignal.timeout has an unref timer; keep the test alive until the injected fetch settles.
  const keeper = setInterval(() => {}, 1000);
  try {
    await assert.rejects(request("https://slow.invalid/catalog"), /Market request failed/);
    assert.equal(observedTimeout, true);
    assert.deepEqual(await request("https://slow.invalid/catalog"), { recovered: true });
    assert.equal(calls, 2);
  } finally { clearInterval(keeper); }
});

function catalogView(venue, symbols, status = "FRESH") {
  return {
    venue, venue_kind: "CEX", segment: "spot", market_type: "spot", scope: "test selected scope", status,
    fetched_at: "2026-10-06T00:00:00Z", valid_until: "2026-10-06T00:10:00Z",
    error: status === "STALE" ? { message: "failed refresh" } : null,
    markets: symbols.map(symbol => entry(venue, symbol)),
  };
}

test("matcher keeps multiplier labels strict and marks stale coverage partial with unverified candidates", () => {
  const views = [catalogView("alpha", ["1000TEST", "TEST"]), catalogView("beta", ["TEST"], "STALE")];
  const result = buildResult({ event_id: "listing-1", assets: [{ symbol: " test " }], exchange: "upbit" }, { views: () => views });
  assert.equal(result.status, "CATALOG_PARTIAL");
  assert.equal(result.candidate_count, 2);
  assert.equal(result.coverage[1].status, "STALE");
  assert.deepEqual(result.assets[0].candidates.map(candidate => candidate.base_symbol), ["TEST", "TEST"]);
  for (const candidate of result.assets[0].candidates) {
    assert.equal(candidate.identity_status, "UNVERIFIED");
    assert.equal(candidate.asset_id, null);
    assert.equal(candidate.trading_allowed, false);
    assert.equal(candidate.raw, undefined);
  }
  assert.equal(result.dex_spot.status, "NOT_QUERIED");
  assert.equal(result.deposit_network.status, "NOT_QUERIED");
  const multiplier = buildResult({ event_id: "listing-2", assets: [{ symbol: "1000TEST" }] }, { views: () => views });
  assert.equal(multiplier.candidate_count, 1);
  assert.equal(multiplier.assets[0].candidates[0].base_symbol, "1000TEST");
  const missing = buildResult({ event_id: "listing-3", assets: [{ symbol: "OTHER" }] }, { views: () => views });
  assert.equal(missing.assets[0].status, "INCOMPLETE_COVERAGE");
  assert.equal(missing.status, "CATALOG_PARTIAL");
});

test("matcher retains known-symbol candidates while missing symbols stay unresolved", () => {
  const views = [catalogView("alpha", ["TEST"]), catalogView("beta", [], "STALE")];
  const event = { event_id: "listing-mixed", assets: [{ symbol: "TEST" }, { symbol: null }] };
  const partial = buildResult(event, { views: () => views });
  assert.equal(partial.status, "CATALOG_PARTIAL");
  assert.equal(partial.assets[0].status, "CANDIDATES_FOUND");
  assert.equal(partial.assets[1].status, "SYMBOL_REQUIRED");
  assert.equal(partial.candidate_count, 1);
  views[1].status = "FRESH";
  views[1].error = null;
  const ready = buildResult(event, { views: () => views });
  assert.equal(ready.status, "SYMBOL_REQUIRED");
  assert.equal(ready.candidate_count, 1);
  assert.equal(ready.assets[0].candidates[0].market_id, "TEST_USDT");
  assert.equal(ready.trading_allowed, false);
  const empty = buildResult({ event_id: "empty", assets: [{ symbol: "OTHER" }] }, { views: () => views });
  assert.equal(empty.assets[0].status, "NO_CANDIDATE_IN_SCOPE");
  assert.equal(empty.status, "CATALOG_SEARCH_EMPTY");
});

test('matcher restricts spot and perpetual candidates to declared USDT/USDC quote pairs',()=>{
  const quotes=['USDT','USDC',' usdt ','USD','BTC','ETH','BUSD','TRY','EUR','USDe',null];
  const views=['spot','perpetual'].map(type=>({...catalogView('alpha',[]),segment:type,market_type:type,
    markets:quotes.map((quote,index)=>({...entry('alpha','NMR'),market_id:`${type}-${index}-USDT`,market_type:type,segment:type,
      quote_symbol:quote,settle_symbol:'USDC'}))}));
  const result=buildResult({event_id:'quote-filter',assets:[{symbol:'NMR'}]}, {views:()=>views});
  assert.deepEqual(result.quote_filter,['USDT','USDC']);
  assert.equal(result.candidate_count,6);
  assert.deepEqual(result.assets[0].candidates.map(c=>c.market_id),['spot-0-USDT','spot-1-USDT','spot-2-USDT','perpetual-0-USDT','perpetual-1-USDT','perpetual-2-USDT']);
  assert.equal(result.trading_allowed,false);
  assert.equal(views[0].markets.length,11,'full source catalog remains available');
});

test('matcher counts only active markets and keeps spot and derivative catalog classifications separate',()=>{
  const spot=catalogView('alpha',[]);
  spot.markets=['ACTIVE','INACTIVE','UNKNOWN'].map((status,index)=>({...entry('alpha','NMR'),market_id:`NMR-${index}`,market_status:status}));
  spot.markets.push({...entry('alpha','NMR'),market_id:'NMR-DERIVATIVE-IN-SPOT',market_type:'perpetual'});
  const perp={...catalogView('alpha',[]),segment:'perpetual',market_type:'perpetual',markets:[
    {...entry('alpha','NMR'),market_id:'NMR-PERP',segment:'perpetual',market_type:'perpetual'},
    {...entry('alpha','NMR'),market_id:'NMR-SPOT-IN-DERIVATIVES',segment:'perpetual'},
  ]};
  const result=buildResult({event_id:'active-spot-only',assets:[{symbol:'NMR'}]}, {views:()=>[spot,perp]});
  assert.equal(result.market_status_filter,'ACTIVE');
  assert.deepEqual(result.assets[0].candidates.map(c=>[c.market_id,c.market_type]),[['NMR-0','spot'],['NMR-PERP','perpetual']]);
});

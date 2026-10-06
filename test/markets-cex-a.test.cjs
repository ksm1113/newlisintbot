const test = require("node:test");
const assert = require("node:assert/strict");
const binance = require("../lib/markets/adapters/binance.cjs");
const bybit = require("../lib/markets/adapters/bybit.cjs");
const okx = require("../lib/markets/adapters/okx.cjs");
const { buildResult } = require("../lib/markets/matcher.cjs");

// Synthetic API-shaped samples. No keys, HTTP calls, or claims of live market data.
function binanceSymbol(overrides = {}) {
  return {
    symbol: "1000TESTUSDT", baseAsset: "1000TEST", quoteAsset: "USDT", marginAsset: "USDT",
    contractType: "PERPETUAL", status: "TRADING", pricePrecision: 8, quantityPrecision: 8,
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.00001000", minPrice: "0.00001000", maxPrice: "1000" },
      { filterType: "LOT_SIZE", stepSize: "0.010", minQty: "0.010", maxQty: "100000" },
      { filterType: "MIN_NOTIONAL", notional: "5.00" },
    ],
    ...overrides,
  };
}

function bybitInstrument(overrides = {}) {
  return {
    symbol: "1000TESTUSDT", baseCoin: "1000TEST", quoteCoin: "USDT", settleCoin: "USDT",
    contractType: "LinearPerpetual", status: "Trading", isPreListing: false,
    priceFilter: { tickSize: "0.00001000", minPrice: "0.00001000", maxPrice: "1000" },
    lotSizeFilter: { qtyStep: "0.01", minOrderQty: "0.01", maxOrderQty: "1000", minNotionalValue: "5" },
    ...overrides,
  };
}

function bybitPage(list, nextPageCursor = "", category = "linear") {
  return { retCode: 0, result: { category, list, nextPageCursor } };
}

function okxInstrument(overrides = {}) {
  return {
    instId: "TEST-USDT-SWAP", instType: "SWAP", uly: "TEST-USDT", instFamily: "TEST-USDT",
    baseCcy: "", quoteCcy: "", settleCcy: "USDT", ctType: "linear", ctVal: "0.0100", ctValCcy: "TEST", ctMult: "1",
    tickSz: "0.0001", lotSz: "1", minSz: "1", maxLmtSz: "1000", maxMktSz: "100", state: "live",
    ...overrides,
  };
}

test("Binance preserves distinct spot states and actual filters, without deriving increments or identity", async () => {
  const raw = binanceSymbol({ symbol: "TESTUSDT", baseAsset: "TEST", isSpotTradingAllowed: true });
  let called;
  const rows = await binance.fetchSegment("spot", { requestJson: async (url) => {
    called = new URL(url);
    return { symbols: [raw, binanceSymbol({ symbol: "PAUSEDUSDT", status: "HALT" }), binanceSymbol({ symbol: "BLOCKEDUSDT", isSpotTradingAllowed: false }), binanceSymbol({ symbol: "UNKNOWNUSDT", status: "NEW_STATUS", filters: [] })] };
  } });
  assert.equal(called.searchParams.get("permissions"), "SPOT");
  assert.deepEqual(rows.map((row) => row.market_status), ["ACTIVE", "INACTIVE", "INACTIVE", "UNKNOWN"]);
  assert.equal(rows[0].price_tick, "0.00001000");
  assert.equal(rows[0].quantity_step, "0.010");
  assert.equal(rows[3].quantity_step, null);
  assert.equal(rows[3].price_tick, null);
  assert.equal(rows[0].raw, raw);
  for (const row of rows) {
    assert.equal(row.trading_allowed, false);
    assert.equal(row.identity_status, "UNVERIFIED");
    assert.equal(row.asset_id, null);
  }
});

test('Binance TRADING without an explicit spot trading flag stays unverified as active spot',async()=>{
  const rows=await binance.fetchSegment('spot',{requestJson:async()=>({symbols:[binanceSymbol({symbol:'NMRUSDT',baseAsset:'NMR'})]})});
  assert.equal(rows[0].market_type,'spot');
  assert.equal(rows[0].market_status,'UNKNOWN');
});

test("Binance excludes delivery contracts and preserves inverse face-value denomination", async () => {
  const usdm = await binance.fetchSegment("usdm_perpetual", { requestJson: async () => ({ symbols: [binanceSymbol(), binanceSymbol({ symbol: "TESTUSDT_261225", contractType: "CURRENT_QUARTER" })] }) });
  assert.equal(usdm.length, 1);
  assert.equal(usdm[0].base_symbol, "1000TEST");
  assert.equal(usdm[0].market_id, "1000TESTUSDT");
  assert.equal(usdm[0].multiplier, null);
  assert.equal(usdm[0].linear, true);
  const coinm = await binance.fetchSegment("coinm_perpetual", { requestJson: async () => ({ symbols: [binanceSymbol({ symbol: "TESTUSD_PERP", baseAsset: "TEST", quoteAsset: "USD", marginAsset: "TEST", status: undefined, contractStatus: "TRADING", contractSize: 100 })] }) });
  assert.equal(coinm[0].native_status, "TRADING");
  assert.equal(coinm[0].market_status, "ACTIVE");
  assert.equal(coinm[0].inverse, true);
  assert.equal(coinm[0].settle_symbol, "TEST");
  assert.equal(coinm[0].contract_size, "100");
  assert.equal(coinm[0].limits.contract_size_unit, "USD");
  assert.equal(coinm[0].limits.quantity_unit, "contracts");
});

test("Binance business and malformed responses fail instead of becoming empty catalogs", async () => {
  for (const body of [
    { code: -1003, msg: "Too many requests" }, {},
    { symbols: [binanceSymbol({ baseAsset: "" })] },
    { symbols: [binanceSymbol({ filters: [{ filterType: "LOT_SIZE", stepSize: "not-a-number" }] })] },
    { symbols: [binanceSymbol(), binanceSymbol()] },
  ]) await assert.rejects(binance.fetchSegment("usdm_perpetual", { requestJson: async () => body }));
});

test('Binance rejects unknown contract schemas and retains settling perpetuals', async () => {
  for (const segment of ['usdm_perpetual', 'coinm_perpetual']) {
    await assert.rejects(binance.fetchSegment(segment, { requestJson: async () => ({
      symbols: [{ contractType: 'UNKNOWN_CHANGED_SCHEMA' }],
    }) }), /unsupported contractType/);
    const rows = await binance.fetchSegment(segment, { requestJson: async () => ({ symbols: [
      binanceSymbol({ contractType: 'PERPETUAL_DELIVERING', contractStatus: 'TRADING' }),
    ] }) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].market_type, 'perpetual');
    assert.equal(rows[0].native_contract_type, 'PERPETUAL_DELIVERING');
    assert.equal(rows[0].market_status, 'INACTIVE');
    assert.equal(rows[0].trading_allowed, false);
  }
  const usdmDated = ['CURRENT_MONTH', 'NEXT_MONTH', 'CURRENT_QUARTER', 'NEXT_QUARTER'];
  const coinmDated = ['CURRENT_QUARTER', 'NEXT_QUARTER', 'CURRENT_QUARTER_DELIVERING', 'NEXT_QUARTER_DELIVERING'];
  for (const [segment, types] of [['usdm_perpetual', usdmDated], ['coinm_perpetual', coinmDated]]) {
    const rows = await binance.fetchSegment(segment, { requestJson: async () => ({
      symbols: types.map(contractType => ({ contractType })),
    }) });
    assert.deepEqual(rows, []);
  }
});

test('Binance keeps documented USD-M TradFi perpetuals separate from crypto identity', async () => {
  const tradfi = binanceSymbol({
    symbol: 'XAUUSDT', baseAsset: 'XAU', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'COMMODITY',
  });
  const rows = await binance.fetchSegment('usdm_perpetual', { requestJson: async () => ({
    symbols: [binanceSymbol(), tradfi, binanceSymbol({ symbol: 'TESTUSDT_261225', contractType: 'CURRENT_QUARTER' })],
  }) });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].asset_class, null);
  assert.equal(rows[0].native_contract_type, 'PERPETUAL');
  assert.equal(rows[1].market_id, 'XAUUSDT');
  assert.equal(rows[1].base_symbol, 'XAU');
  assert.equal(rows[1].quote_symbol, 'USDT');
  assert.equal(rows[1].settle_symbol, 'USDT');
  assert.equal(rows[1].market_type, 'perpetual');
  assert.equal(rows[1].native_contract_type, 'TRADIFI_PERPETUAL');
  assert.equal(rows[1].asset_class, 'TRADFI');
  assert.equal(rows[1].native_underlying_type, 'COMMODITY');
  assert.equal(rows[1].market_status, 'ACTIVE');
  assert.equal(rows[1].linear, true);
  assert.equal(rows[1].raw, tradfi);
  assert.equal(rows[1].identity_status, 'UNVERIFIED');
  assert.equal(rows[1].asset_id, null);
  assert.equal(rows[1].trading_allowed, false);
  await assert.rejects(binance.fetchSegment('coinm_perpetual', { requestJson: async () => ({
    symbols: [tradfi],
  }) }), /unsupported contractType/);
  await assert.rejects(binance.fetchSegment('usdm_perpetual', { requestJson: async () => ({
    symbols: [{ ...tradfi, underlyingType: {} }],
  }) }), /invalid underlyingType/);
});

test("Bybit walks encoded cursors and retains future/prelisting restrictions while excluding dated futures", async () => {
  const calls = [];
  const cursor = "first=1000TESTUSDT&last=ABC/USDT";
  const rows = await bybit.fetchSegment("linear_perpetual", { requestJson: async (url) => {
    calls.push(new URL(url));
    if (calls.length === 1) return bybitPage([bybitInstrument(), bybitInstrument({ symbol: "TEST-261225", contractType: "LinearFutures" })], cursor);
    assert.equal(calls[1].searchParams.get("cursor"), cursor);
    return bybitPage([bybitInstrument({ symbol: "OPENINGUSDC", quoteCoin: "USDC", settleCoin: "USDC", status: "PendingOpen" }), bybitInstrument({ symbol: "PREUSDT", isPreListing: true })]);
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get("limit"), "1000");
  assert.deepEqual(rows.map((row) => row.market_status), ["ACTIVE", "INACTIVE", "UNKNOWN"]);
  assert.equal(rows[0].base_symbol, "1000TEST");
  assert.equal(rows[0].multiplier, null);
  assert.equal(rows[1].settle_symbol, "USDC");
  assert.equal(rows[2].trading_allowed, false);
});

test("Bybit spot uses base precision directly without pagination, and inverse stays separate", async () => {
  const spot = await bybit.fetchSegment("spot", { requestJson: async (url) => {
    const request = new URL(url);
    assert.equal(request.searchParams.get("limit"), null);
    assert.equal(request.searchParams.get("cursor"), null);
    return bybitPage([bybitInstrument({ lotSizeFilter: { basePrecision: "0.0000010", quotePrecision: "0.0000001", minOrderAmt: "5" }, symbolType: "xstocks", xstockMultiplier: "0.25" })], "", "spot");
  } });
  assert.equal(spot[0].quantity_step, "0.0000010");
  assert.equal(spot[0].multiplier, "0.25");
  assert.equal(spot[0].settle_symbol, null);
  const inverse = await bybit.fetchSegment("inverse_perpetual", { requestJson: async () => bybitPage([bybitInstrument({ symbol: "TESTUSD", contractType: "InversePerpetual", quoteCoin: "USD", settleCoin: "TEST" })], "", "inverse") });
  assert.equal(inverse[0].inverse, true);
  assert.equal(inverse[0].settle_symbol, "TEST");
  assert.equal(inverse[0].contract_size, null);
});

test("Bybit aborts incomplete, error, repeated, duplicate, and unbounded pagination", async () => {
  for (const body of [
    { retCode: 10006, result: { category: "linear", list: [] } },
    bybitPage([], "", "spot"),
    { retCode: 0, result: { category: "linear", list: [] } },
  ]) await assert.rejects(bybit.fetchSegment("linear_perpetual", { requestJson: async () => body }));
  await assert.rejects(bybit.fetchSegment("linear_perpetual", { requestJson: async () => bybitPage([], "same") }), /repeated/);
  let duplicateCalls = 0;
  await assert.rejects(bybit.fetchSegment("linear_perpetual", { requestJson: async () => bybitPage([bybitInstrument()], duplicateCalls++ === 0 ? "next" : "") }), /duplicate/);
  let calls = 0;
  await assert.rejects(bybit.fetchSegment("linear_perpetual", { requestJson: async () => bybitPage([], `cursor-${++calls}`) }), /maximum page count/);
  assert.equal(calls, 100);
});

test('Bybit rejects unknown/category-mismatched contracts and skips only declared dated types', async () => {
  for (const [segment, category, datedType, wrongPerpetual] of [
    ['linear_perpetual', 'linear', 'LinearFutures', 'InversePerpetual'],
    ['inverse_perpetual', 'inverse', 'InverseFutures', 'LinearPerpetual'],
  ]) {
    for (const contractType of ['UNKNOWN_CHANGED_SCHEMA', wrongPerpetual]) {
      await assert.rejects(bybit.fetchSegment(segment, { requestJson: async () =>
        bybitPage([{ contractType }], '', category),
      }), /contractType/);
    }
    const rows = await bybit.fetchSegment(segment, { requestJson: async () =>
      bybitPage([{ contractType: datedType }], '', category),
    });
    assert.deepEqual(rows, []);
  }
});

test("OKX swaps use declared underlying, preserve both contract denominations and restricted states", async () => {
  const rows = await okx.fetchSegment("swap", { requestJson: async (url) => {
    assert.equal(new URL(url).searchParams.get("instType"), "SWAP");
    return { code: "0", data: [okxInstrument(), okxInstrument({ instId: "TEST-USD-SWAP", uly: "", instFamily: "TEST-USD", ctType: "inverse", ctVal: "100", ctValCcy: "USD", settleCcy: "TEST", state: "post_only" }), okxInstrument({ instId: "OTHER-USDT-SWAP", uly: "OTHER-USDT", instFamily: "OTHER-USDT", ctType: "future-contract-model", state: "preopen" })] };
  } });
  assert.deepEqual(rows.map((row) => row.market_status), ["ACTIVE", "UNKNOWN", "INACTIVE"]);
  assert.equal(rows[0].base_symbol, "TEST");
  assert.equal(rows[0].contract_size, "0.0100");
  assert.equal(rows[0].limits.contract_size_unit, "TEST");
  assert.equal(rows[1].quote_symbol, "USD");
  assert.equal(rows[1].inverse, true);
  assert.equal(rows[1].limits.contract_size_unit, "USD");
  assert.equal(rows[1].limits.quantity_unit, "contracts");
  assert.equal(rows[2].linear, null);
  assert.equal(rows[2].inverse, null);
  assert.equal(rows[0].trading_allowed, false);
});

test("OKX spot units and invalid envelopes/ambiguous underlying are distinguished", async () => {
  const spot = okxInstrument({ instType: "SPOT", instId: "TEST-USDT", baseCcy: "TEST", quoteCcy: "USDT", ctVal: "", ctValCcy: "", ctMult: "", lotSz: "0.0001", maxMktSz: "1000" });
  const rows = await okx.fetchSegment("spot", { requestJson: async () => ({ code: "0", data: [spot] }) });
  assert.equal(rows[0].quantity_step, "0.0001");
  assert.equal(rows[0].contract_size, null);
  assert.equal(rows[0].limits.quantity_unit, "base_asset");
  assert.equal(rows[0].limits.maxMktSz_unit, "USDT");
  for (const body of [
    { code: "50011", data: [] }, { code: "0" },
    { code: "0", data: [okxInstrument({ uly: "", instFamily: "" })] },
    { code: "0", data: [okxInstrument({ instFamily: "OTHER-USDT" })] },
    { code: "0", data: [okxInstrument({ instType: "FUTURES" })] },
  ]) await assert.rejects(okx.fetchSegment("swap", { requestJson: async () => body }));
});

test('OKX live pre-market and unknown trading rules do not reach the ordinary spot/perpetual candidate matcher', async () => {
  const rules = ['normal', undefined, 'pre_market', 'rebase_contract', 'new_restricted_rule', ''];
  const views = [];
  for (const segment of okx.segments) {
    const spot = segment.id === 'spot';
    const inputs = rules.map((ruleType, index) => okxInstrument({
      instId: spot ? `TEST-USDT-${index}` : `TEST-USDT-SWAP-${index}`,
      instType: spot ? 'SPOT' : 'SWAP', baseCcy: spot ? 'TEST' : '', quoteCcy: spot ? 'USDT' : '',
      state: 'live', ruleType,
    }));
    inputs.push(okxInstrument({
      instId: `TEST-USDT-PAUSED-${segment.id}`, instType: spot ? 'SPOT' : 'SWAP',
      baseCcy: spot ? 'TEST' : '', quoteCcy: spot ? 'USDT' : '', state: 'suspend', ruleType: 'normal',
    }));
    const markets = await okx.fetchSegment(segment.id, { requestJson: async () => ({ code: '0', data: inputs }) });
    assert.deepEqual(markets.map(m => m.market_status), ['ACTIVE', 'ACTIVE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'INACTIVE']);
    assert.equal(markets[2].native_status, 'live');
    assert.equal(markets[2].limits.ruleType, 'pre_market');
    assert.equal(markets[5].limits.ruleType, '');
    assert.equal(markets[2].raw, inputs[2]);
    views.push({ venue: 'okx', segment: segment.id, market_type: segment.market_type, status: 'FRESH', markets });
  }
  const result = buildResult({ event_id: 'restricted-okx-rules', assets: [{ symbol: 'TEST' }] }, { views: () => views });
  assert.deepEqual(result.assets[0].candidates.map(m => [m.market_id, m.market_type]), [
    ['TEST-USDT-0', 'spot'], ['TEST-USDT-1', 'spot'],
    ['TEST-USDT-SWAP-0', 'perpetual'], ['TEST-USDT-SWAP-1', 'perpetual'],
  ]);
  assert.equal(result.candidate_count, 4);
  assert.equal(result.trading_allowed, false);
  assert.equal(views.reduce((sum, view) => sum + view.markets.length, 0), 14, 'catalog still retains restricted evidence');
  const retained = views.map(view => ({ ...view, markets: view.markets.slice(0, -1).map(m => ({ ...m, market_status: 'ACTIVE' })) }));
  const cachedResult = buildResult({ event_id: 'retained-okx-rules', assets: [{ symbol: 'TEST' }] }, { views: () => retained });
  assert.deepEqual(cachedResult.assets[0].candidates.map(m => m.market_id), result.assets[0].candidates.map(m => m.market_id),
    'old ACTIVE normalization cannot bypass retained non-normal rule metadata');
  await assert.rejects(okx.fetchSegment('swap', { requestJson: async () => ({ code: '0', data: [okxInstrument({ ruleType: true })] }) }), /invalid instrument ruleType/);
});

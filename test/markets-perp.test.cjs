"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const aster = require("../lib/markets/adapters/aster.cjs");
const variational = require("../lib/markets/adapters/variational.cjs");
const lighter = require("../lib/markets/adapters/lighter.cjs");

// Offline fixtures based on official schemas. The Aster pending-contract test
// additionally preserves selected fields from a separately captured public response.
// https://github.com/asterdex/api-docs/blob/master/V3(Recommended)/EN/aster-finance-futures-api-v3.md
// https://docs.variational.io/technical-documentation/api
// https://apidocs.lighter.xyz/reference/orderbookdetails
// https://github.com/elliottech/lighter-python/blob/main/docs/PerpsOrderBookDetail.md
const asterRow = () => ({
  symbol: "1000TESTUSDT", contractType: "PERPETUAL", status: "TRADING",
  baseAsset: "1000TEST", quoteAsset: "USDT", marginAsset: "USDT",
  pricePrecision: 2, quantityPrecision: 2,
  filters: [
    { filterType: "PRICE_FILTER", tickSize: "0.00001000", minPrice: "0.00001000", maxPrice: "100000" },
    { filterType: "LOT_SIZE", stepSize: "0.12500000", minQty: "0.25000000", maxQty: "10000" },
    { filterType: "MIN_NOTIONAL", notional: "5.00000000" },
    { filterType: "MARKET_LOT_SIZE", stepSize: "1", minQty: "1", maxQty: "100" },
  ],
});
const lighterRow = () => ({
  symbol: "1000TEST", market_id: 4095, market_type: "perp", status: "active",
  base_asset_id: 0, quote_asset_id: 3, multiplier: "1000.000000000000000000",
  supported_size_decimals: 8, supported_price_decimals: 12, supported_quote_decimals: 6,
  size_decimals: 18, price_decimals: 18, quote_multiplier: 1000000,
  min_base_amount: "0.00000010", min_quote_amount: "10.000000", order_quote_limit: "9999999.000000",
});

function context(payload, check = () => {}) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestJson: async (url, options) => {
      assert.equal(options.signal, controller.signal);
      check(url, options);
      return payload;
    },
  };
}
function assertUnverified(row) {
  assert.equal(row.identity_status, "UNVERIFIED");
  assert.equal(row.asset_id, null);
  assert.equal(row.trading_allowed, false);
}

test("Aster preserves source filters, multiplier symbol and margin asset", async () => {
  const input = asterRow();
  const rows = await aster.fetchSegment("perpetual", context({ futuresType: "U_MARGINED", symbols: [input] }, (url) => {
    assert.equal(url, "https://fapi.asterdex.com/fapi/v3/exchangeInfo");
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].base_symbol, "1000TEST");
  assert.equal(rows[0].market_id, "1000TESTUSDT");
  assert.equal(rows[0].multiplier, null);
  assert.equal(rows[0].contract_size, null);
  assert.equal(rows[0].settle_symbol, "USDT");
  assert.equal(rows[0].price_tick, "0.00001000");
  assert.equal(rows[0].quantity_step, "0.12500000");
  assert.equal(rows[0].limits.min_notional, "5.00000000");
  assert.deepEqual(rows[0].limits.filters, input.filters);
  assert.deepEqual(rows[0].raw, input);
  assert.equal(rows[0].market_status, "ACTIVE");
  assert.equal(rows[0].linear, true);
  assertUnverified(rows[0]);
});

test("Aster preserves inactive or unknown statuses", async () => {
  const inactive = { ...asterRow(), symbol: "PENDINGUSDT", status: "PENDING_TRADING" };
  const unknown = { ...asterRow(), symbol: "UNKNOWNUSDT", status: "NEW_VENDOR_STATUS" };
  const rows = await aster.fetchSegment("perpetual", context({ symbols: [inactive, unknown] }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].market_status, "INACTIVE");
  assert.equal(rows[1].market_status, "UNKNOWN");
  assert.equal(rows[0].linear, null);
});

test('Aster rejects every contract type outside its documented PERPETUAL enum', async () => {
  for (const contractType of ['UNKNOWN_CHANGED_SCHEMA', 'CURRENT_QUARTER', 'PERPETUAL_DELIVERING']) {
    await assert.rejects(aster.fetchSegment('perpetual', context({ symbols: [{ contractType }] })), /unsupported contractType/);
  }
});

test('Aster preserves evidence for the exact empty-type pending products seen in its public response', async () => {
  // Selected fields from the 2026-10-06 public response saved by catalog-live-WvJtDc.
  // The ordinary perpetual record is synthetic, and every request is injected offline.
  const pending = ['MBL', 'AFEE', 'PHAROS', 'SKHX', 'SMSN'].map(baseAsset => ({
    symbol: `${baseAsset}USDT`, baseAsset, contractType: '', status: 'PENDING_TRADING',
  }));
  const rows = await aster.fetchSegment('perpetual', context({ symbols: [asterRow(), ...pending] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].market_type, 'perpetual');
  assert.equal(rows.exclusions.length, 5);
  assert.deepEqual(rows.exclusions.map(entry => entry.base_symbol), ['MBL', 'AFEE', 'PHAROS', 'SKHX', 'SMSN']);
  assert.deepEqual(rows.exclusions.map(entry => entry.market_id), pending.map(row => row.symbol));
  for (const excluded of rows.exclusions) {
    assert.equal(excluded.native_contract_type, '');
    assert.equal(excluded.native_status, 'PENDING_TRADING');
    assert.equal(excluded.reason, 'UNCLASSIFIED_PENDING_CONTRACT');
    assert.equal(excluded.source, 'https://fapi.asterdex.com/fapi/v3/exchangeInfo');
  }
  assertUnverified(rows[0]);
});

test('Aster refuses a catalog containing only unclassified pending products', async () => {
  await assert.rejects(aster.fetchSegment('perpetual', context({ symbols: [
    { symbol: 'TESTUSDT', baseAsset: 'TEST', contractType: '', status: 'PENDING_TRADING' },
  ] })), /only unclassified pending contracts/);
});

test('Aster blank active types, missing labels and unknown types remain failures', async () => {
  for (const row of [
    { ...asterRow(), contractType: '' },
    { ...asterRow(), contractType: ' ' },
    { ...asterRow(), contractType: null, status: 'PENDING_TRADING' },
    { ...asterRow(), contractType: undefined, status: 'PENDING_TRADING' },
    { ...asterRow(), contractType: 'NEW_UNKNOWN_TYPE', status: 'PENDING_TRADING' },
    { ...asterRow(), contractType: '', status: 'PENDING_TRADING', baseAsset: '' },
  ]) {
    await assert.rejects(aster.fetchSegment('perpetual', context({ symbols: [row] })), /Aster:/);
  }
  const pending = { symbol: 'TESTUSDT', baseAsset: 'TEST', contractType: '', status: 'PENDING_TRADING' };
  await assert.rejects(aster.fetchSegment('perpetual', context({ symbols: [pending, pending] })), /duplicate/);
});

test("Aster rejects errors, missing schema, duplicate IDs and corrupt filter fields", async () => {
  for (const payload of [
    { code: -1121, symbols: [] }, {}, { symbols: [asterRow(), asterRow()] },
    { symbols: [{ ...asterRow(), baseAsset: null }] },
    { symbols: [{ ...asterRow(), filters: [{ filterType: "PRICE_FILTER", tickSize: 0.00001 }] }] },
  ]) {
    await assert.rejects(aster.fetchSegment("perpetual", context(payload)), /Aster:/);
  }
  assert.deepEqual(await aster.fetchSegment("perpetual", context({ symbols: [] })), []);
});

test("Variational records labels with unknown status and unavailable order API", async () => {
  const input = { ticker: "1000TEST", name: "Synthetic Token", quotes: { updated_at: "2026-10-06T00:00:00Z", size_1k: { bid: "10.000", ask: "10.500" } } };
  const rows = await variational.fetchSegment("perpetual", context({ num_markets: 1, listings: [input] }, (url) => {
    assert.equal(url, "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats");
  }));
  assert.equal(rows[0].market_id, "1000TEST");
  assert.equal(rows[0].market_id_kind, "ticker_label");
  assert.equal(rows[0].base_symbol, "1000TEST");
  assert.equal(rows[0].market_status, "UNKNOWN");
  assert.equal(rows[0].order_api_status, "UNAVAILABLE");
  assert.equal(rows[0].price_tick, null);
  assert.equal(rows[0].settle_symbol, null);
  assert.deepEqual(rows[0].raw, input);
  assert.equal(rows[0].bid, undefined);
  assertUnverified(rows[0]);
});

test("Variational rejects incomplete counts and ambiguous labels instead of picking one", async () => {
  for (const payload of [
    { error: "maintenance", listings: [] }, {}, { num_markets: 2, listings: [{ ticker: "BTC" }] },
    { listings: [{ ticker: "BTC" }, { ticker: "BTC" }] }, { listings: [{ ticker: "" }] },
  ]) {
    await assert.rejects(variational.fetchSegment("perpetual", context(payload)), /Variational:/);
  }
  assert.deepEqual(await variational.fetchSegment("perpetual", context({ num_markets: 0, listings: [] })), []);
});

test("Lighter preserves numeric ID, multiplier and exact supported decimal increments", async () => {
  const input = lighterRow();
  const rows = await lighter.fetchSegment("perpetual", context({ code: 200, order_book_details: [input], spot_order_book_details: [{ symbol: "TEST/USDC", market_type: "spot" }] }, (url) => {
    assert.equal(url, "https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?filter=perp");
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].market_id, "4095");
  assert.equal(rows[0].market_type, "perpetual");
  assert.equal(rows[0].base_symbol, "1000TEST");
  assert.equal(rows[0].price_tick, "0.000000000001");
  assert.equal(rows[0].quantity_step, "0.00000001");
  assert.equal(rows[0].multiplier, "1000.000000000000000000");
  assert.equal(rows[0].limits.quote_multiplier, "1000000");
  assert.equal(rows[0].limits.min_quantity, "0.00000010");
  assert.equal(rows[0].quote_symbol, null);
  assert.equal(rows[0].settle_symbol, null);
  assert.deepEqual(rows[0].raw, input);
  assertUnverified(rows[0]);
});

test("Lighter string IDs remain exact and inactive / unknown status is not active", async () => {
  const rows = await lighter.fetchSegment("perpetual", context({ code: 200, order_book_details: [
    { ...lighterRow(), market_id: "9007199254740993", status: "inactive", supported_price_decimals: 0 },
    { ...lighterRow(), market_id: 1, status: "NEW_VENDOR_STATUS" },
  ] }));
  assert.equal(rows[0].market_id, "9007199254740993");
  assert.equal(rows[0].market_status, "INACTIVE");
  assert.equal(rows[0].price_tick, "1");
  assert.equal(rows[1].market_status, "UNKNOWN");
});

test("Lighter rejects business errors, missing arrays, spot contamination and unsafe IDs", async () => {
  for (const payload of [
    { code: 400, order_book_details: [] }, { code: 200 }, {},
    { code: 200, order_book_details: [{ ...lighterRow(), market_type: "spot" }] },
    { code: 200, order_book_details: [lighterRow(), lighterRow()] },
    { code: 200, order_book_details: [{ ...lighterRow(), market_id: 9007199254740992 }] },
    { code: 200, order_book_details: [{ ...lighterRow(), supported_price_decimals: -1 }] },
    { code: 200, order_book_details: [{ ...lighterRow(), multiplier: "bad" }] },
  ]) {
    await assert.rejects(lighter.fetchSegment("perpetual", context(payload)), /Lighter:/);
  }
  assert.deepEqual(await lighter.fetchSegment("perpetual", context({ code: 200, order_book_details: [] })), []);
});

test("Perp adapters propagate network rejection and reject unknown segments", async () => {
  const offline = { requestJson: async () => { throw new Error("network failure"); } };
  for (const adapter of [aster, variational, lighter]) {
    assert.equal(adapter.kind, "PERP_DEX");
    assert.equal(adapter.segments[0].id, "perpetual");
    await assert.rejects(adapter.fetchSegment("perpetual", offline), /network failure/);
    await assert.rejects(adapter.fetchSegment("spot", offline), /unsupported segment/);
  }
});

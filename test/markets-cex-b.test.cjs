'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bitget = require('../lib/markets/adapters/bitget.cjs');
const gate = require('../lib/markets/adapters/gate.cjs');
const hyperliquid = require('../lib/markets/adapters/hyperliquid.cjs');
const { buildResult } = require('../lib/markets/matcher.cjs');

// Synthetic response fixtures based on official schemas. No network/API keys.
const bitgetSpot = (overrides = {}) => ({
  symbol: '1000TESTUSDT', baseCoin: '1000TEST', quoteCoin: 'USDT', status: 'online',
  pricePrecision: '8', quantityPrecision: '3', minTradeUSDT: '1',
  maxLimitOrderValue: '500000', maxMarketOrderValue: '50000', ...overrides,
});
const bitgetPerp = (overrides = {}) => ({
  symbol: '1000TESTUSDT', baseCoin: '1000TEST', quoteCoin: 'USDT', symbolType: 'perpetual',
  symbolStatus: 'normal', supportMarginCoins: ['USDT'], priceEndStep: '5', pricePlace: '3',
  sizeMultiplier: '0.001', minTradeNum: '0.01', minTradeUSDT: '5',
  maxMarketOrderQty: '250', maxOrderQty: '500', ...overrides,
});
const gateSpot = (overrides = {}) => ({
  id: '1000TEST_USDT', base: '1000TEST', quote: 'USDT', trade_status: 'tradable', type: 'normal',
  trade_quotes: ['USDC', 'USD1'], amount_precision: 4, precision: 7,
  min_base_amount: '0.0001', min_quote_amount: '1.000000000000000001',
  ...overrides,
});
const gatePerp = (overrides = {}) => ({
  name: '1000TEST_USDT', type: 'direct', status: 'trading', in_delisting: false,
  quanto_multiplier: '0.000100000000000001', order_price_round: '0.00001',
  order_size_min: '10', order_size_max: '999999999999999999', enable_decimal: false,
  ...overrides,
});

function assertUnverified(rows) {
  for (const row of rows) {
    assert.equal(row.asset_id, null);
    assert.equal(row.identity_status, 'UNVERIFIED');
    assert.equal(row.trading_allowed, false);
  }
}

test('Bitget spot retains numeric ticker prefix, exact precision and unknown/offline status', async () => {
  const raw = bitgetSpot();
  const controller = new AbortController();
  const rows = await bitget.fetchSegment('spot', { signal: controller.signal, requestJson: async (url, options) => {
    assert.equal(url, 'https://api.bitget.com/api/v2/spot/public/symbols');
    assert.equal(options.signal, controller.signal);
    return { code: '00000', data: [raw, bitgetSpot({ symbol: 'OFFUSDT', baseCoin: 'OFF', status: 'offline' }),
      bitgetSpot({ symbol: 'NEWUSDT', baseCoin: 'NEW', status: 'new-unknown-status' })] };
  } });
  assert.equal(rows[0].market_id, '1000TESTUSDT');
  assert.equal(rows[0].base_symbol, '1000TEST');
  assert.equal(rows[0].price_tick, '0.00000001');
  assert.equal(rows[0].quantity_step, '0.001');
  assert.equal(rows[0].limits.quantity_unit, 'BASE_CURRENCY');
  assert.equal(rows[0].raw, raw);
  assert.deepEqual(rows.map(row => row.market_status), ['ACTIVE', 'INACTIVE', 'UNKNOWN']);
  assertUnverified(rows);
});

test('Bitget perpetual rejects ticker-based multiplier inference and excludes delivery', async () => {
  const raw = bitgetPerp();
  const rows = await bitget.fetchSegment('usdt_perpetual', { requestJson: async url => {
    assert.equal(new URL(url).searchParams.get('productType'), 'USDT-FUTURES');
    return { code: '00000', data: [raw,
      bitgetPerp({ symbol: 'RESTRICTUSDT', baseCoin: 'RESTRICT', symbolStatus: 'restrictedAPI' }),
      bitgetPerp({ symbol: 'LIMITUSDT', baseCoin: 'LIMIT', symbolStatus: 'limit_open' }),
      bitgetPerp({ symbol: 'BTCUSD_261225', baseCoin: 'BTC', quoteCoin: 'USD', symbolType: 'delivery' })] };
  } });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].base_symbol, '1000TEST');
  assert.equal(rows[0].price_tick, '0.005');
  assert.equal(rows[0].quantity_step, '0.001');
  assert.equal(rows[0].multiplier, null);
  assert.equal(rows[0].contract_size, null);
  assert.equal(rows[0].settle_symbol, 'USDT');
  assert.equal(rows[0].limits.min_quantity, '0.01');
  assert.equal(rows[1].order_api_status, 'UNAVAILABLE');
  assert.equal(rows[1].market_status, 'INACTIVE');
  assert.equal(rows[2].limits.opening_restricted, true);
  assertUnverified(rows);
});

test('Bitget keeps distinct USDC and coin collateral contracts', async () => {
  const usdc = await bitget.fetchSegment('usdc_perpetual', { requestJson: async url => {
    assert.equal(new URL(url).searchParams.get('productType'), 'USDC-FUTURES');
    return { code: '00000', data: [bitgetPerp({ quoteCoin: 'USDC', supportMarginCoins: ['USDC'] })] };
  } });
  const coin = await bitget.fetchSegment('coin_perpetual', { requestJson: async url => {
    assert.equal(new URL(url).searchParams.get('productType'), 'COIN-FUTURES');
    return { code: '00000', data: [bitgetPerp({ symbol: 'BTCUSD', baseCoin: 'BTC', quoteCoin: 'USD', supportMarginCoins: ['BTC'] })] };
  } });
  assert.equal(usdc[0].settle_symbol, 'USDC');
  assert.equal(usdc[0].linear, true);
  assert.equal(coin[0].settle_symbol, 'BTC');
  assert.equal(coin[0].quote_symbol, 'USD');
  assert.equal(coin[0].inverse, true);
});

test('Bitget business errors and malformed full catalogs fail rather than erase markets', async () => {
  for (const response of [
    { code: '40015', data: [] }, { data: [] }, { code: '00000', data: {} },
    { code: '00000', data: [bitgetSpot({ baseCoin: null })] },
    { code: '00000', data: [bitgetSpot(), bitgetSpot()] },
  ]) await assert.rejects(bitget.fetchSegment('spot', { requestJson: async () => response }), /Bitget/);
  await assert.rejects(bitget.fetchSegment('usdt_perpetual', {
    requestJson: async () => ({ code: '00000', data: [bitgetPerp({ symbolType: 'unknown' })] }),
  }), /symbolType/);
});

test('Gate spot preserves restricted order directions and unified quote metadata', async () => {
  const raw = gateSpot({ trade_status: 'sellable' });
  const rows = await gate.fetchSegment('spot', { requestJson: async url => {
    assert.equal(url, 'https://api.gateio.ws/api/v4/spot/currency_pairs');
    return [raw, gateSpot({ id: 'PRE_USDT', base: 'PRE', type: 'premarket' }),
      gateSpot({ id: 'OFF_USDT', base: 'OFF', trade_status: 'untradable' })];
  } });
  assert.equal(rows[0].base_symbol, '1000TEST');
  assert.equal(rows[0].price_tick, '0.0000001');
  assert.equal(rows[0].quantity_step, '0.0001');
  assert.equal(rows[0].limits.min_quote_amount, '1.000000000000000001');
  assert.equal(rows[0].limits.buy_enabled, false);
  assert.equal(rows[0].limits.sell_enabled, true);
  assert.deepEqual(rows[0].limits.supported_trade_quotes, ['USDC', 'USD1']);
  assert.equal(rows[0].raw, raw);
  assert.equal(rows[1].market_status, 'UNKNOWN');
  assert.equal(rows[2].market_status, 'INACTIVE');
  assertUnverified(rows);
});

test('Gate purchase candidates exclude sell-only, stopped and premarket spot pairs', async () => {
  const rows = await gate.fetchSegment('spot', { requestJson: async () => [
    gateSpot({ id: 'TRADABLE_USDT' }),
    gateSpot({ id: 'BUYABLE_USDT', trade_status: 'buyable' }),
    gateSpot({ id: 'SELLABLE_USDT', trade_status: 'sellable' }),
    gateSpot({ id: 'STOPPED_USDT', trade_status: 'untradable' }),
    gateSpot({ id: 'PREMARKET_USDT', type: 'premarket' }),
    gateSpot({ id: 'UNKNOWN_USDT', trade_status: 'new-unknown-status' }),
  ] });
  const result = buildResult({ event_id: 'synthetic-gate-directions', assets: [{ symbol: '1000TEST' }] }, {
    views: () => [{ venue: 'gate', segment: 'spot', market_type: 'spot', status: 'FRESH', markets: rows }],
  });
  assert.deepEqual(result.assets[0].candidates.map(row => row.market_id), ['TRADABLE_USDT', 'BUYABLE_USDT']);
  assert.equal(result.candidate_count, 2);
});

test('Gate futures traverses all offset pages and keeps native contract quantity units', async () => {
  const calls = [];
  const first = Array.from({ length: 100 }, (_, i) => gatePerp({ name: `COIN${i}_USDT` }));
  const final = gatePerp({ name: '1000TEST_USDT', enable_decimal: true, order_size_min: '0.01' });
  const rows = await gate.fetchSegment('usdt_perpetual', { requestJson: async url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('limit'), '100');
    const offset = Number(parsed.searchParams.get('offset'));
    calls.push(offset);
    return offset === 0 ? first : [final];
  } });
  assert.deepEqual(calls, [0, 100]);
  assert.equal(rows.length, 101);
  assert.equal(rows[100].base_symbol, '1000TEST');
  assert.equal(rows[100].market_id, '1000TEST_USDT');
  assert.equal(rows[0].contract_size, '0.000100000000000001');
  assert.equal(rows[0].quantity_step, '1');
  assert.equal(rows[0].limits.quantity_unit, 'CONTRACTS');
  assert.equal(rows[0].limits.min_quantity, '10');
  assert.equal(rows[100].quantity_step, null);
  assert.equal(rows[100].limits.decimal_lot_sizes, true);
  assertUnverified(rows);
});

test('Gate futures distinguishes inverse settlement, delisting and documented USD1', async () => {
  const btc = await gate.fetchSegment('btc_perpetual', { requestJson: async url => {
    assert.equal(new URL(url).pathname, '/api/v4/futures/btc/contracts');
    return [gatePerp({ name: 'BTC_USD', type: 'inverse', status: 'delisting', in_delisting: true })];
  } });
  const usd1 = await gate.fetchSegment('usd1_perpetual', { requestJson: async url => {
    assert.equal(new URL(url).pathname, '/api/v4/futures/usd1/contracts');
    return [gatePerp({ name: 'BTC_USD1' })];
  } });
  assert.equal(btc[0].quote_symbol, 'USD');
  assert.equal(btc[0].settle_symbol, 'BTC');
  assert.equal(btc[0].inverse, true);
  assert.equal(btc[0].market_status, 'INACTIVE');
  assert.equal(usd1[0].settle_symbol, 'USD1');
});

test('Gate pagination errors and repeated pages never produce partial success', async () => {
  const first = Array.from({ length: 100 }, (_, i) => gatePerp({ name: `COIN${i}_USDT` }));
  await assert.rejects(gate.fetchSegment('usdt_perpetual', { requestJson: async url =>
    new URL(url).searchParams.get('offset') === '0' ? first : { label: 'TOO_MANY_REQUESTS', message: 'rate limit' },
  }), /Gate API error: TOO_MANY_REQUESTS/);
  await assert.rejects(gate.fetchSegment('usdt_perpetual', { requestJson: async () => first }), /repeated\/duplicate/);
  await assert.rejects(gate.fetchSegment('spot', { requestJson: async () => [gateSpot({ trade_quotes: 'USDC' })] }), /trade_quotes/);
});

function hyperFixture() {
  const native = { universe: [
    { name: 'kPEPE', szDecimals: 2, maxLeverage: 10 },
    { name: 'LOOM', szDecimals: 0, maxLeverage: 3, isDelisted: true },
  ], collateralToken: 0, marginTables: [] };
  const hip3 = { universe: [{ name: 'abc:1000TEST', szDecimals: 4, maxLeverage: 20, onlyIsolated: true }],
    collateralToken: 2, marginTables: [[20, { marginTiers: [] }]] };
  return {
    perpDexs: [null, { name: 'abc', fullName: 'Builder ABC' }],
    allPerpMetas: [[native, [{ markPx: '0.015' }, { markPx: '0.001' }]], [hip3, [{ markPx: '1.1' }]]],
    spotMeta: { tokens: [{ index: 0, name: 'USDC' }, { index: 2, name: 'USDe' }], universe: [] },
  };
}

function hyperRequest(fixture, calls = []) {
  return async (url, options) => {
    assert.equal(url, 'https://api.hyperliquid.xyz/info');
    assert.equal(options.method, 'POST');
    calls.push(options.body.type);
    return fixture[options.body.type];
  };
}

test('Hyperliquid preserves HIP-3 namespace, numeric IDs and actual collateral token', async () => {
  const fixture = hyperFixture();
  const calls = [];
  const rows = await hyperliquid.fetchSegment('perpetual', { requestJson: hyperRequest(fixture, calls) });
  assert.deepEqual(calls.sort(), ['allPerpMetas', 'perpDexs', 'spotMeta']);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].base_symbol, 'kPEPE');
  assert.equal(rows[0].multiplier, null);
  assert.equal(rows[0].native_market_id, '0');
  assert.equal(rows[1].market_status, 'INACTIVE');
  assert.equal(rows[2].market_id, 'abc:1000TEST');
  assert.equal(rows[2].base_symbol, '1000TEST');
  assert.equal(rows[2].native_market_id, '110000');
  assert.equal(rows[2].dex_index, 1);
  assert.equal(rows[2].universe_index, 0);
  assert.equal(rows[2].settle_symbol, 'USDe');
  assert.equal(rows[2].quantity_step, '0.0001');
  assert.equal(rows[2].price_tick, null);
  assert.equal(rows[2].native_metadata.asset_context.markPx, '1.1');
  assert.equal(rows[2].raw, fixture.allPerpMetas[1][0].universe[0]);
  assertUnverified(rows);
});

test('Hyperliquid accepts explicit metadata objects without shifting native indexes', async () => {
  const fixture = hyperFixture();
  fixture.allPerpMetas = fixture.allPerpMetas.map(tuple => tuple[0]);
  delete fixture.allPerpMetas[0].collateralToken;
  const rows = await hyperliquid.fetchSegment('perpetual', { requestJson: hyperRequest(fixture) });
  assert.equal(rows[1].native_market_id, '1');
  assert.equal(rows[2].native_market_id, '110000');
  assert.equal(rows[0].settle_symbol, 'USDC');
  assert.equal(rows[2].native_metadata.asset_context, null);
});

test('Hyperliquid inconsistent schemas or dex namespaces fail instead of hiding markets', async () => {
  for (const mutate of [
    fixture => fixture.perpDexs.pop(),
    fixture => fixture.allPerpMetas[1][1].pop(),
    fixture => fixture.allPerpMetas[1][0].collateralToken = 99,
    fixture => fixture.allPerpMetas[1][0].universe[0].name = 'other:1000TEST',
    fixture => fixture.allPerpMetas[0][0].universe[0].szDecimals = -1,
    fixture => fixture.allPerpMetas[0][0].universe[1].isDelisted = 'true',
    fixture => fixture.allPerpMetas = { error: 'bad request' },
  ]) {
    const fixture = hyperFixture();
    mutate(fixture);
    await assert.rejects(hyperliquid.fetchSegment('perpetual', { requestJson: hyperRequest(fixture) }), /Hyperliquid/);
  }
});

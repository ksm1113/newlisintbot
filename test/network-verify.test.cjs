'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fresh, validateAnchor, selectAnchor, verifyCandidate, enrichResult } = require('../lib/networks/verify.cjs');

// Pure synthetic fixtures. No filesystem, website, API request, or actual order.
const now = Date.parse('2026-10-06T12:00:00.000Z');
const iso = offset => new Date(now + offset).toISOString();
const eth = 'eip155:1';
const sol = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ca = '0xE66747a101bFF2dBA3697199DCcE5b743b454759';
const otherCa = '0x1111111111111111111111111111111111111111';
const solCa = 'So11111111111111111111111111111111111111112';
const notice = 'https://www.gate.com/announcements/article/synthetic-token-listing';
const network = (overrides = {}) => ({
  network_code: 'ERC20', contract_address: ca, deposit_enabled: true, withdraw_enabled: true,
  withdraw_delayed: false, need_tag: false, min_withdraw: '1.000000000000000001',
  withdraw_fee: '0.000000000000000001', ...overrides,
});
const coin = (venue, overrides = {}) => ({
  venue, coin: 'TEST', source: venue === 'bitget' ? 'https://api.bitget.com/api/v2/spot/public/coins'
    : 'https://api.gateio.ws/api/v4/spot/currencies',
  status: 'OK', checked_at: iso(-1000), valid_until: iso(600000), currency_status: 'FOUND',
  networks: [network({ network_code: venue === 'bitget' ? 'ERC20' : 'ETH' })], ...overrides,
});
const candidate = (overrides = {}) => ({
  venue: 'bitget', venue_kind: 'CEX', segment: 'spot', market_id: 'TESTUSDT', market_type: 'spot',
  base_symbol: 'TEST', quote_symbol: 'USDT', catalog_status: 'FRESH', market_status: 'ACTIVE',
  fetched_at: iso(-5000), valid_until: iso(600000), identity_status: 'UNVERIFIED',
  asset_id: null, trading_allowed: false, ...overrides,
});
const anchor = (overrides = {}) => ({
  confirmed: true, symbol: 'TEST', exchange: 'gate', source_url: notice,
  confirmed_at: iso(-60000), valid_until: iso(600000),
  contracts: [{ chain_id: eth, contract_address: ca, token_kind: 'TOKEN' }],
  deposit_networks: [eth],
  evidence: [{ url: notice, purpose: 'LISTED_CURRENCY_CHAIN_AND_CONTRACT', authority: 'OFFICIAL' }],
  ...overrides,
});
const result = (overrides = {}) => ({
  event_id: 'synthetic-event', source_url: notice, listing_exchange: 'gate',
  prepared_at: iso(-100), candidate_count: 1,
  assets: [{ symbol: 'TEST', contracts: [], candidates: [candidate()] }], ...overrides,
});

function catalog(records = [coin('bitget'), coin('gate')]) {
  const calls = [];
  return {
    calls,
    coin(venue, symbol) {
      calls.push({ venue, symbol });
      const found = records.find(row => row.venue === venue && row.coin === symbol);
      return found || { venue, coin: symbol, status: 'NOT_FETCHED', checked_at: null,
        valid_until: null, currency_status: 'UNKNOWN', networks: [] };
    },
    views() { return records.map(row => ({ ...row, coins: [row] })); },
  };
}

function evaluate({ source = coin('bitget'), destination = coin('gate'), market = candidate(),
  proof = anchor(), listingExchange = 'gate', symbol = 'TEST' } = {}) {
  return verifyCandidate(market, proof, catalog([source, destination]), listingExchange, symbol, now);
}

function assertHeld(value, reason) {
  assert.equal(value.route_filter_passed, false);
  assert.equal(value.trading_allowed, false);
  const reasons = [...value.reasons, ...value.routes.flatMap(route => route.reasons)];
  assert.ok(reasons.includes(reason), `Expected ${reason}; received ${reasons.join(', ')}`);
}

test('The local official anchor and matching CA/chain produce an eligible cached route without trading permission', () => {
  const cache = catalog();
  const value = enrichResult(result(), cache, [anchor()], now);
  assert.equal(value.status, 'IDENTITY_AND_ROUTE_FILTER_EVALUATED');
  assert.equal(value.eligible_spot_count, 1);
  assert.equal(value.assets[0].identity_status, 'LISTED_ASSET_VERIFIED');
  const selected = value.assets[0].candidates[0];
  assert.equal(selected.identity_status, 'VERIFIED');
  assert.equal(selected.route_status, 'FILTER_PASSED');
  assert.equal(selected.route_filter_passed, true);
  assert.equal(selected.routes[0].contract_address, ca.toLowerCase());
  assert.equal(selected.routes[0].chain_id, eth);
  assert.equal(selected.routes[0].assurance, 'CACHED_METADATA_FILTER_ONLY');
  assert.equal(selected.routes[0].min_withdraw, '1.000000000000000001');
  assert.equal(selected.routes[0].withdraw_fee, '0.000000000000000001');
  assert.deepEqual(cache.calls, [{ venue: 'bitget', symbol: 'TEST' }, { venue: 'gate', symbol: 'TEST' }]);
  assert.equal(value.network_coverage[0].coin_count, 1);
  assert.equal(value.network_coverage[0].coins, undefined);
  assert.equal(value.trading_allowed, false);
  assert.equal(selected.trading_allowed, false);
  assert.equal(selected.routes[0].trading_allowed, false);
  assert.deepEqual(value.dex_spot, { status: 'NOT_QUERIED' });
});

test('Ticker collisions with a different CA cannot gain verified identity or pass the route filter', () => {
  const value = evaluate({ source: coin('bitget', { networks: [network({ contract_address: otherCa })] }) });
  assertHeld(value, 'CONTRACT_MISMATCH');
  assert.equal(value.identity_status, 'UNVERIFIED');
  assert.equal(value.asset_id, null);
  assert.equal(value.routes[0].network_compatible, false);
  assert.equal(value.routes[0].identity_status, 'UNVERIFIED');
});

test('Unknown chain aliases and native blank CA remain unverified even when both status flags are active', () => {
  const unknown = evaluate({ source: coin('bitget', { networks: [network({ network_code: 'Ethereum Other' })] }) });
  assertHeld(unknown, 'UNKNOWN_SOURCE_CHAIN');
  assert.equal(unknown.identity_status, 'UNVERIFIED');
  assert.equal(unknown.routes[0].chain_id, null);
  const blank = evaluate({ source: coin('bitget', { networks: [network({ contract_address: '' })] }) });
  assertHeld(blank, 'FULL_CONTRACT_REQUIRED');
  assert.equal(blank.identity_status, 'UNVERIFIED');
  assert.equal(blank.asset_id, null);
});

test('A matching CA on a different chain does not inherit the listing asset identity', () => {
  const value = evaluate({ source: coin('bitget', { networks: [network({ network_code: 'BEP20' })] }) });
  assertHeld(value, 'CONTRACT_MISMATCH');
  assertHeld(value, 'DESTINATION_NETWORK_UNSUPPORTED');
  assert.equal(value.identity_status, 'UNVERIFIED');
  assert.equal(value.routes[0].chain_id, 'eip155:56');
});

test('Withdrawal disabled, unknown, or delayed statuses hold compatible verified routes', () => {
  for (const [fields, reason] of [
    [{ withdraw_enabled: false }, 'WITHDRAWAL_DISABLED'],
    [{ withdraw_enabled: null }, 'WITHDRAWAL_STATUS_UNKNOWN'],
    [{ withdraw_delayed: true }, 'WITHDRAWAL_DELAYED'],
  ]) {
    const value = evaluate({ source: coin('bitget', { networks: [network(fields)] }) });
    assertHeld(value, reason);
    assert.equal(value.identity_status, 'VERIFIED');
    assert.equal(value.route_status, 'NETWORK_COMPATIBLE_HELD');
    assert.equal(value.routes[0].network_compatible, true);
  }
});

test('Destination deposit disabled or unknown holds a compatible route, while a wrong full CA is rejected', () => {
  for (const [fields, reason] of [
    [{ deposit_enabled: false }, 'DEPOSIT_DISABLED'],
    [{ deposit_enabled: null }, 'DEPOSIT_STATUS_UNKNOWN'],
    [{ contract_address: otherCa }, 'DESTINATION_CONTRACT_MISMATCH'],
    [{ contract_address: '0x1234' }, 'DESTINATION_CONTRACT_MISMATCH'],
  ]) {
    const value = evaluate({ destination: coin('gate', { networks: [network({ network_code: 'ETH', ...fields })] }) });
    assertHeld(value, reason);
    assert.equal(value.routes[0].route_filter_passed, false);
  }
});

test('Only officially supported destination chains are compatible, and duplicate aliases remain ambiguous', () => {
  const ethereumOnly = anchor({ contracts: [
    { chain_id: eth, contract_address: ca, token_kind: 'TOKEN' },
    { chain_id: sol, contract_address: solCa, token_kind: 'TOKEN' },
  ], deposit_networks: [eth] });
  const wrongNetwork = evaluate({ proof: ethereumOnly,
    source: coin('bitget', { networks: [network({ network_code: 'SOL', contract_address: solCa })] }) });
  assertHeld(wrongNetwork, 'DESTINATION_NETWORK_UNSUPPORTED');
  assert.equal(wrongNetwork.routes[0].network_compatible, false);
  const duplicate = evaluate({ destination: coin('gate', { networks: [network({ network_code: 'ETH' }), network()] }) });
  assertHeld(duplicate, 'AMBIGUOUS_DESTINATION_CHAIN');
});

test('A supported destination chain outside the current account scope is held separately from unsupported identity', () => {
  const value = evaluate({ destination: coin('gate', { networks: [], currency_status: 'NOT_IN_ACCOUNT_SCOPE' }) });
  assertHeld(value, 'DESTINATION_CHAIN_NOT_IN_ACCOUNT_SCOPE');
  assert.equal(value.routes[0].network_compatible, true);
  assert.equal(value.route_status, 'NETWORK_COMPATIBLE_HELD');
});

test('Upbit advisory wallet metadata with an unknown deposit status records compatibility and stays held', () => {
  const upbitNotice = 'https://upbit.com/service_center/notice?id=synthetic-test';
  const value = evaluate({ listingExchange: 'upbit', proof: anchor({ exchange: 'upbit', source_url: upbitNotice }),
    destination: coin('upbit', { source: 'https://api.upbit.com/v1/status/wallet',
      networks: [network({ network_code: 'ETH', contract_address: null, deposit_enabled: null,
        status_realtime: false, status_notice: 'SYNTHETIC_ADVISORY_METADATA' })] }) });
  assertHeld(value, 'DEPOSIT_STATUS_UNKNOWN');
  assertHeld(value, 'DESTINATION_STATUS_ADVISORY');
  assert.equal(value.route_status, 'NETWORK_COMPATIBLE_HELD');
  assert.equal(value.routes[0].network_compatible, true);
  assert.equal(value.routes[0].identity_status, 'VERIFIED');
});

test('Stale, unauthenticated, failed and unqueried network catalogs never pass even if they retain old flags', () => {
  for (const status of ['STALE', 'AUTH_REQUIRED', 'ERROR', 'NOT_FETCHED']) {
    const sourceValue = evaluate({ source: coin('bitget', { status }) });
    assertHeld(sourceValue, `SOURCE_${status}`);
    assert.equal(sourceValue.identity_status, 'UNVERIFIED');
    const destinationValue = evaluate({ destination: coin('gate', { status }) });
    assertHeld(destinationValue, `DESTINATION_${status}`);
  }
  const auth = evaluate({ source: coin('bitget', { status: 'AUTH_REQUIRED', networks: [] }) });
  assertHeld(auth, 'SOURCE_AUTH_REQUIRED');
  const absent = evaluate({ source: coin('bitget', { networks: [], currency_status: 'NOT_IN_ACCOUNT_SCOPE' }) });
  assertHeld(absent, 'SOURCE_CURRENCY_OR_NETWORK_NOT_IN_ACCOUNT_SCOPE');
  assert.ok(!absent.reasons.includes('SOURCE_AUTH_REQUIRED'));
});

test('Network freshness fails closed at expiry, with future checks, and with missing or invalid dates', () => {
  assert.equal(fresh(coin('bitget'), now), true);
  const badDates = [
    { checked_at: undefined }, { checked_at: null }, { checked_at: 'invalid' }, { checked_at: iso(1) },
    { valid_until: undefined }, { valid_until: null }, { valid_until: 'invalid' }, { valid_until: iso(0) },
  ];
  for (const fields of badDates) {
    assert.equal(fresh(coin('bitget', fields), now), false);
    const value = evaluate({ source: coin('bitget', fields) });
    assert.equal(value.route_filter_passed, false);
    assert.equal(value.identity_status, 'UNVERIFIED');
  }
});

test('Market freshness fails closed with non-fresh status, future checks, and missing or invalid dates', () => {
  for (const fields of [
    { catalog_status: 'STALE' }, { catalog_status: 'ERROR' }, { catalog_status: 'NOT_FETCHED' },
    { fetched_at: undefined }, { fetched_at: null }, { fetched_at: 'invalid' }, { fetched_at: iso(1) },
    { valid_until: undefined }, { valid_until: null }, { valid_until: 'invalid' }, { valid_until: iso(0) },
  ]) {
    const value = evaluate({ market: candidate(fields) });
    assertHeld(value, 'MARKET_CATALOG_NOT_FRESH');
  }
});

test('Inactive markets, disabled source currencies, and the listing venue itself cannot be eligible purchase sources', () => {
  for (const status of ['INACTIVE', 'UNKNOWN']) {
    assertHeld(evaluate({ market: candidate({ market_status: status }) }), 'MARKET_NOT_ACTIVE');
  }
  for (const fields of [{ delisted: true }, { trade_disabled: true }]) {
    assertHeld(evaluate({ source: coin('bitget', fields) }), 'SOURCE_CURRENCY_DISABLED');
  }
  const self = verifyCandidate(candidate({ venue: 'gate' }), anchor(), catalog([coin('gate')]), 'gate', 'TEST', now);
  assertHeld(self, 'SOURCE_IS_LISTING_DESTINATION');
});

test('A retained sell-only spot candidate stays held even with a matching verified transfer route', () => {
  const value = evaluate({ market: candidate({ limits: { buy_enabled: false, sell_enabled: true } }) });
  assertHeld(value, 'SPOT_BUY_DISABLED');
  assert.equal(value.identity_status, 'VERIFIED');
  assert.equal(value.routes[0].network_compatible, true);
  assert.equal(value.route_status, 'NETWORK_COMPATIBLE_HELD');
});

test('A retained OKX non-normal spot rule cannot pass a matching transfer route', () => {
  const value = verifyCandidate(candidate({ venue: 'okx', limits: { ruleType: 'pre_market' } }), anchor(),
    catalog([coin('okx', { networks: [network({ network_code: 'ERC20' })] }), coin('gate')]), 'gate', 'TEST', now);
  assertHeld(value, 'RESTRICTED_MARKET_RULE');
  assert.equal(value.identity_status, 'VERIFIED');
  assert.equal(value.routes[0].network_compatible, true);
});

test('Perpetual candidates remain unverified without derivative underlying evidence and need no wallet lookup', () => {
  const cache = catalog();
  const value = verifyCandidate(candidate({ market_type: 'perpetual', segment: 'usdt_perpetual' }),
    anchor(), cache, 'gate', 'TEST', now);
  assertHeld(value, 'DERIVATIVE_UNDERLYING_MAPPING_REQUIRED');
  assert.equal(value.identity_status, 'UNVERIFIED');
  assert.equal(value.asset_id, null);
  assert.equal(value.route_status, 'NOT_APPLICABLE');
  assert.deepEqual(value.routes, []);
  assert.deepEqual(cache.calls, []);
});

test('Missing official evidence stays pending without any wallet read or implied order permission', () => {
  const cache = catalog();
  const value = enrichResult(result(), cache, [], now);
  assert.equal(value.status, 'WAITING_OFFICIAL_IDENTITY');
  assert.equal(value.eligible_spot_count, 0);
  assert.equal(value.assets[0].identity_status, 'UNVERIFIED');
  assertHeld(value.assets[0].candidates[0], 'OFFICIAL_IDENTITY_ANCHOR_REQUIRED');
  assert.deepEqual(cache.calls, []);
  assert.equal(value.trading_allowed, false);
});

test('Official anchor validation rejects unconfirmed, native, unbound, duplicate and malformed evidence', () => {
  assert.doesNotThrow(() => validateAnchor(anchor()));
  const invalid = [
    { confirmed: false }, { symbol: '' }, { contracts: [] }, { deposit_networks: [] }, { evidence: [] },
    { confirmed_at: 'invalid' }, { confirmed_at: undefined }, { confirmed_at: null },
    { valid_until: 'invalid' }, { valid_until: undefined }, { valid_until: null },
    { confirmed_at: iso(0), valid_until: iso(-1) },
    { contracts: [{ chain_id: eth, contract_address: '', token_kind: 'NATIVE' }] },
    { contracts: [{ chain_id: eth, contract_address: '0x1234', token_kind: 'TOKEN' }] },
    { deposit_networks: [sol] },
    { contracts: [{ chain_id: eth, contract_address: ca, token_kind: 'TOKEN' },
      { chain_id: eth, contract_address: ca.toLowerCase(), token_kind: 'TOKEN' }] },
    { evidence: [{ url: notice, authority: 'UNOFFICIAL', purpose: 'CA' }] },
    { evidence: [{ url: 'http://www.gate.com/synthetic', authority: 'OFFICIAL', purpose: 'CA' }] },
    { evidence: [{ url: notice, authority: 'OFFICIAL', purpose: '' }] },
  ];
  for (const fields of invalid) assert.throws(() => validateAnchor(anchor(fields)));
});

test('Expired/future official anchors and conflicting feed contracts cannot verify a listing', () => {
  for (const fields of [{ confirmed_at: iso(1) }, { valid_until: iso(0) }, { valid_until: iso(-1) }]) {
    const value = enrichResult(result(), catalog(), [anchor(fields)], now);
    assert.equal(value.status, 'WAITING_OFFICIAL_IDENTITY');
    assert.equal(value.eligible_spot_count, 0);
    assert.equal(value.assets[0].anchor, null);
  }
  const conflicted = { symbol: 'TEST', contracts: [{ chain_id: eth, contract_address: otherCa }], candidates: [candidate()] };
  assert.equal(selectAnchor([anchor()], result(), conflicted, now), null);
});

test('Matching duplicate proofs are reusable; expired/future and conflicting proofs cannot obstruct or authorize identity', () => {
  const current = anchor();
  const duplicate = anchor({ contracts: [{ chain_id: eth, contract_address: ca.toLowerCase(), token_kind: 'TOKEN' }] });
  const asset = { symbol: 'TEST', contracts: [] };
  assert.equal(selectAnchor([current, duplicate], result(), asset, now), current);
  const expiredConflict = anchor({ valid_until: iso(-1), contracts: [{ chain_id: eth, contract_address: otherCa, token_kind: 'TOKEN' }] });
  const futureConflict = anchor({ confirmed_at: iso(1), contracts: [{ chain_id: eth, contract_address: otherCa, token_kind: 'TOKEN' }] });
  assert.equal(selectAnchor([expiredConflict, futureConflict, current], result(), asset, now), current);
  const currentConflict = anchor({ contracts: [{ chain_id: eth, contract_address: otherCa, token_kind: 'TOKEN' }] });
  assert.equal(selectAnchor([current, currentConflict], result(), asset, now), null);
  const held = enrichResult(result(), catalog(), [current, currentConflict], now);
  assert.equal(held.eligible_spot_count, 0);
  assert.equal(held.assets[0].anchor, null);
  assertHeld(held.assets[0].candidates[0], 'OFFICIAL_IDENTITY_ANCHOR_REQUIRED');
});

test('An exact notice proof takes precedence over a matching venue asset proof, while conflicting bindings stay held', () => {
  const noticeProof = anchor({ scope: 'NOTICE' });
  const venueProof = anchor({ scope: 'VENUE_ASSET', source_url: 'https://www.gate.com/trade/TEST_USDT' });
  const asset = { symbol: 'TEST', contracts: [] };
  for (const proofs of [[venueProof, noticeProof], [noticeProof, venueProof]]) {
    assert.equal(selectAnchor(proofs, result(), asset, now), noticeProof);
  }
  const venueConflict = { ...venueProof, contracts: [{ chain_id: eth, contract_address: otherCa, token_kind: 'TOKEN' }] };
  assert.equal(selectAnchor([venueConflict, noticeProof], result(), asset, now), null);
});

test('Direct candidate verification validates proof binding and dates before reading wallet metadata', () => {
  for (const fields of [{ valid_until: iso(0) }, { valid_until: iso(-1) }, { confirmed_at: iso(1) },
    { exchange: 'upbit' }, { symbol: 'OTHER' }]) {
    const cache = catalog();
    const value = verifyCandidate(candidate(), anchor(fields), cache, 'gate', 'TEST', now);
    assertHeld(value, 'OFFICIAL_IDENTITY_ANCHOR_INVALID_OR_EXPIRED');
    assert.equal(value.identity_status, 'UNVERIFIED');
    assert.deepEqual(cache.calls, []);
  }
  for (const fields of [{ confirmed: false }, { confirmed_at: 'invalid' }, { valid_until: 'invalid' }]) {
    const cache = catalog();
    assert.throws(() => verifyCandidate(candidate(), anchor(fields), cache, 'gate', 'TEST', now));
    assert.deepEqual(cache.calls, []);
  }
});

test('Known venue NMR identity can be reused across a future notice only with explicit VENUE_ASSET scope', () => {
  const earlier = 'https://www.gate.com/trade/NMR_USDT';
  const later = 'https://www.gate.com/announcements/article/synthetic-future-nmr-market';
  const nmr = anchor({ symbol: 'NMR', source_url: earlier,
    evidence: [{ url: earlier, authority: 'OFFICIAL', purpose: 'VENUE_CURRENCY_CHAIN_AND_CONTRACT' }] });
  const nmrResult = result({ source_url: later,
    assets: [{ symbol: 'NMR', contracts: [], candidates: [candidate({ base_symbol: 'NMR' })] }] });
  assert.equal(selectAnchor([nmr], nmrResult, nmrResult.assets[0], now), null);
  const scoped = { ...nmr, scope: 'VENUE_ASSET' };
  assert.equal(selectAnchor([scoped], nmrResult, nmrResult.assets[0], now), scoped);
  assert.equal(selectAnchor([scoped], { ...nmrResult, listing_exchange: 'upbit' }, nmrResult.assets[0], now), null);
  assert.equal(selectAnchor([scoped], nmrResult, { symbol: 'OTHER' }, now), null);
  const cache = catalog([coin('bitget', { coin: 'NMR' }), coin('gate', { coin: 'NMR' })]);
  const reused = enrichResult(nmrResult, cache, [scoped], now);
  assert.equal(reused.eligible_spot_count, 1);
  assert.equal(reused.assets[0].anchor.source_url, earlier);
  assert.equal(reused.source_url, later);
  assert.equal(reused.trading_allowed, false);
});

test('Exact notice scope keeps Upbit notice IDs distinct and ignores only benign URL tracking differences', () => {
  const proof = anchor({ exchange: 'upbit', scope: 'NOTICE', source_url: 'https://upbit.com/service_center/notice?id=1001' });
  const asset = { symbol: 'TEST', contracts: [] };
  const matched = result({ listing_exchange: 'upbit', source_url: 'https://www.upbit.com/service_center/notice?utm_source=synthetic&id=1001#top' });
  assert.equal(selectAnchor([proof], matched, asset, now), proof);
  for (const sourceUrl of ['https://upbit.com/service_center/notice?id=1002',
    'https://upbit.com/service_center/notice', null, 'invalid-url']) {
    assert.equal(selectAnchor([proof], { ...matched, source_url: sourceUrl }, asset, now), null, String(sourceUrl));
  }
});

test('Solana routes preserve the mint case and do not label the asset as ERC20', () => {
  const proof = anchor({ contracts: [{ chain_id: sol, contract_address: solCa, token_kind: 'TOKEN' }], deposit_networks: [sol] });
  const value = evaluate({ proof,
    source: coin('bitget', { networks: [network({ network_code: 'SOL', contract_address: solCa })] }),
    destination: coin('gate', { networks: [network({ network_code: 'SOL', contract_address: solCa })] }) });
  assert.equal(value.route_filter_passed, true);
  assert.equal(value.identity_status, 'VERIFIED');
  assert.equal(value.routes[0].contract_address, solCa);
  assert.equal(value.asset_id.startsWith(`${sol}/`), true);
  assert.equal(value.asset_id.includes('/erc20:'), false);
  assert.equal(value.trading_allowed, false);
});

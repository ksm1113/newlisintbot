'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bitget = require('../lib/networks/adapters/bitget.cjs');
const gate = require('../lib/networks/adapters/gate.cjs');

// Synthetic fixtures based on official public schemas; these tests make no API calls.
const address = '0xE66747a101bFF2dBA3697199DCcE5b743b454759';
const bitgetChain = (overrides = {}) => ({
  chain: 'ERC20', contractAddress: address, needTag: 'false', withdrawable: 'true', rechargeable: 'true',
  withdrawFee: '0.000000000000000001', extraWithdrawFee: '0', depositConfirm: '12', withdrawConfirm: '20',
  minDepositAmount: '0.100000000000000001', minWithdrawAmount: '1.000000000000000001',
  withdrawStep: '0.00000001', withdrawMinScale: '8', congestion: 'normal', ...overrides,
});
const bitgetCoin = (overrides = {}) => ({ coin: '1000TEST', coinId: '101', transfer: 'true', chains: [bitgetChain()], ...overrides });
const gateChain = (overrides = {}) => ({
  name: 'ETH', addr: address, withdraw_disabled: false, withdraw_delayed: false, deposit_disabled: false, ...overrides,
});
const gateCoin = (overrides = {}) => ({
  currency: '1000TEST', name: 'Synthetic Test Token', delisted: false, trade_disabled: false,
  withdraw_disabled: true, withdraw_delayed: true, deposit_disabled: true,
  fixed_rate: '0.002', chain: 'MISLEADING_TOP_LEVEL', chains: [gateChain()], ...overrides,
});
const fetchBitget = (data, fields = {}) => bitget.fetchCoins({ requestJson: async () => ({ code: '00000', data, ...fields }) });
const fetchGate = data => gate.fetchCoins({ requestJson: async () => data });

test('Bitget full coin query preserves exact network, contract and decimal metadata', async () => {
  const raw = bitgetCoin();
  const controller = new AbortController();
  const rows = await bitget.fetchCoins({ signal: controller.signal, requestJson: async (url, options) => {
    assert.equal(url, 'https://api.bitget.com/api/v2/spot/public/coins');
    assert.equal(new URL(url).search, '');
    assert.equal(options.signal, controller.signal);
    return { code: '00000', data: [raw] };
  } });
  assert.equal(bitget.id, 'bitget');
  assert.equal(rows[0].venue, 'bitget');
  assert.equal(rows[0].coin, '1000TEST');
  assert.equal(rows[0].raw, raw);
  assert.equal(rows[0].source, 'https://api.bitget.com/api/v2/spot/public/coins');
  const network = rows[0].networks[0];
  assert.equal(network.network_code, 'ERC20');
  assert.equal(network.contract_address, address);
  assert.equal(network.raw, raw.chains[0]);
  assert.equal(network.deposit_enabled, true);
  assert.equal(network.withdraw_enabled, true);
  assert.equal(network.withdraw_delayed, null);
  assert.equal(network.need_tag, false);
  assert.equal(network.min_withdraw, '1.000000000000000001');
  assert.equal(network.withdraw_fee, '0.000000000000000001');
  assert.equal(network.min_deposit, '0.100000000000000001');
  assert.equal(network.extra_withdraw_fee, '0');
  assert.equal(network.deposit_confirmations, '12');
  assert.equal(network.withdraw_confirmations, '20');
  assert.equal(network.withdraw_step, '0.00000001');
  assert.equal(network.withdraw_min_scale, '8');
});

test('Bitget missing flags and blank contract stay unknown; false never becomes true', async () => {
  const rows = await fetchBitget([bitgetCoin({ chains: [
    { chain: 'BTC', contractAddress: '' },
    bitgetChain({ chain: 'OTHER', withdrawable: 'false', rechargeable: false, needTag: 'true' }),
  ] })]);
  assert.equal(rows[0].networks[0].contract_address, null);
  assert.equal(rows[0].networks[0].deposit_enabled, null);
  assert.equal(rows[0].networks[0].withdraw_enabled, null);
  assert.equal(rows[0].networks[0].need_tag, null);
  assert.equal(rows[0].networks[1].withdraw_enabled, false);
  assert.equal(rows[0].networks[1].deposit_enabled, false);
  assert.equal(rows[0].networks[1].need_tag, true);
  assert.equal(rows[0].networks[0].asset_kind, undefined);
});

test('Bitget distinguishes successful empty lists from API errors and incomplete schemas', async () => {
  assert.deepEqual(await fetchBitget([]), []);
  assert.deepEqual((await fetchBitget([bitgetCoin({ chains: [] })]))[0].networks, []);
  await assert.rejects(fetchBitget([], { code: '40001' }), /API error/);
  for (const response of [undefined, null, '', [], {}, { code: '00000' }, { code: '00000', data: {} }]) {
    await assert.rejects(bitget.fetchCoins({ requestJson: async () => response }), /malformed|API error/);
  }
  for (const row of [null, {}, bitgetCoin({ coin: '' }), bitgetCoin({ chains: undefined }), bitgetCoin({ chains: null }),
    bitgetCoin({ chains: {} }), bitgetCoin({ chains: [null] }), bitgetCoin({ chains: [{}] })]) {
    await assert.rejects(fetchBitget([bitgetCoin({ coin: 'VALID' }), row]), /malformed|missing/);
  }
});

test('Bitget rejects duplicate coins/chains and malformed supplied status/amount/address values', async () => {
  await assert.rejects(fetchBitget([bitgetCoin(), bitgetCoin({ coin: ' 1000test ' })]), /duplicate.*coin/);
  await assert.rejects(fetchBitget([bitgetCoin({ chains: [bitgetChain(), bitgetChain({ chain: ' erc20 ' })] })]), /duplicate.*chain/);
  for (const field of ['withdrawable', 'rechargeable', 'needTag']) {
    for (const value of ['TRUE', '1', 1, {}, '']) {
      await assert.rejects(fetchBitget([bitgetCoin({ chains: [bitgetChain({ [field]: value })] })]), /malformed/);
    }
  }
  for (const value of [{}, '-1', 'NaN', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fetchBitget([bitgetCoin({ chains: [bitgetChain({ minWithdrawAmount: value })] })]), /malformed|imprecise/);
  }
  await assert.rejects(fetchBitget([bitgetCoin({ chains: [bitgetChain({ contractAddress: 123 })] })]), /malformed/);
});

test('Gate full coin query uses chain flags and preserves delayed withdrawals and full contract', async () => {
  const raw = gateCoin({ chains: [gateChain(), gateChain({ name: 'SOL', addr: 'SyntheticSolanaContract',
    withdraw_disabled: true, withdraw_delayed: true, deposit_disabled: false })] });
  const controller = new AbortController();
  const rows = await gate.fetchCoins({ signal: controller.signal, requestJson: async (url, options) => {
    assert.equal(url, 'https://api.gateio.ws/api/v4/spot/currencies');
    assert.equal(new URL(url).search, '');
    assert.equal(options.signal, controller.signal);
    return [raw];
  } });
  assert.equal(gate.id, 'gate');
  assert.equal(rows[0].venue, 'gate');
  assert.equal(rows[0].coin, '1000TEST');
  assert.equal(rows[0].source, 'https://api.gateio.ws/api/v4/spot/currencies');
  assert.equal(rows[0].raw, raw);
  const [ethereum, solana] = rows[0].networks;
  assert.equal(ethereum.network_code, 'ETH');
  assert.equal(ethereum.contract_address, address);
  assert.equal(ethereum.deposit_enabled, true);
  assert.equal(ethereum.withdraw_enabled, true);
  assert.equal(ethereum.withdraw_delayed, false);
  assert.equal(ethereum.raw, raw.chains[0]);
  assert.equal(solana.withdraw_enabled, false);
  assert.equal(solana.deposit_enabled, true);
  assert.equal(solana.withdraw_delayed, true);
  assert.equal(solana.contract_address, 'SyntheticSolanaContract');
  assert.equal(ethereum.need_tag, null);
  assert.equal(ethereum.min_withdraw, null);
  assert.equal(ethereum.withdraw_fee, null);
  assert.equal(rows[0].fixed_rate, '0.002');
});

test('Gate never falls back to deprecated flags or infers native identity from missing address', async () => {
  const rows = await fetchGate([gateCoin({ chains: [{ name: 'GT', addr: '' },
    gateChain({ name: 'SECOND', withdraw_disabled: 'false', deposit_disabled: 'true', withdraw_delayed: 'false' })] })]);
  const network = rows[0].networks[0];
  assert.equal(network.contract_address, null);
  assert.equal(network.withdraw_enabled, null);
  assert.equal(network.deposit_enabled, null);
  assert.equal(network.withdraw_delayed, null);
  assert.equal(network.asset_kind, undefined);
  assert.equal(rows[0].networks[1].withdraw_enabled, true);
  assert.equal(rows[0].networks[1].deposit_enabled, false);
  assert.equal(rows[0].networks[1].withdraw_delayed, false);
});

test('Gate distinguishes explicit empty lists from errors and rejects incomplete chain responses', async () => {
  assert.deepEqual(await fetchGate([]), []);
  assert.deepEqual((await fetchGate([gateCoin({ chains: [] })]))[0].networks, []);
  await assert.rejects(fetchGate({ label: 'SERVER_ERROR', message: 'synthetic error' }), /API error/);
  for (const response of [undefined, null, '', {}, { data: [] }]) {
    await assert.rejects(fetchGate(response), /malformed/);
  }
  for (const row of [null, {}, gateCoin({ currency: '' }), gateCoin({ chains: undefined }), gateCoin({ chains: null }),
    gateCoin({ chains: {} }), gateCoin({ chains: [null] }), gateCoin({ chains: [{}] })]) {
    await assert.rejects(fetchGate([gateCoin({ currency: 'VALID' }), row]), /malformed|missing/);
  }
});

test('Gate rejects duplicate coins/chains and unsupported supplied boolean/address values', async () => {
  await assert.rejects(fetchGate([gateCoin(), gateCoin({ currency: ' 1000test ' })]), /duplicate.*coin/);
  await assert.rejects(fetchGate([gateCoin({ chains: [gateChain(), gateChain({ name: ' eth ' })] })]), /duplicate.*chain/);
  for (const field of ['deposit_disabled', 'withdraw_disabled', 'withdraw_delayed']) {
    for (const value of ['FALSE', '0', 0, {}, '']) {
      await assert.rejects(fetchGate([gateCoin({ chains: [gateChain({ [field]: value })] })]), /malformed/);
    }
  }
  await assert.rejects(fetchGate([gateCoin({ chains: [gateChain({ addr: 123 })] })]), /malformed/);
});

test('Public network adapters propagate request failures instead of returning empty data', async () => {
  const failure = new Error('synthetic request failed');
  for (const adapter of [bitget, gate]) {
    await assert.rejects(adapter.fetchCoins({ requestJson: async () => { throw failure; } }), error => error === failure);
  }
});

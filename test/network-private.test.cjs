const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const binance = require('../lib/networks/adapters/binance.cjs');
const bybit = require('../lib/networks/adapters/bybit.cjs');
const okx = require('../lib/networks/adapters/okx.cjs');
const upbit = require('../lib/networks/adapters/upbit.cjs');

// Entirely synthetic, injected API-shaped responses. No network or real credentials.
const credentials = { apiKey: 'synthetic-api-key', apiSecret: 'synthetic-secret', passphrase: 'synthetic-passphrase' };
const address = '0x1776e1f26f98b1a5df9cd347953a26dd3cb46671';
function binanceCoin(overrides = {}) {
  return { coin: 'TEST', free: 'private-balance', locked: 'private-balance', networkList: [{
    network: 'ETH', coin: 'TEST', name: 'Ethereum (ERC20)', contractAddress: address,
    depositEnable: true, withdrawEnable: false, busy: false, withdrawTag: false,
    withdrawMin: '0.01000000', withdrawFee: '0.0001', withdrawMax: '10000',
    denomination: 1, withdrawIntegerMultiple: '0.00000001', minConfirm: 12,
  }], ...overrides };
}
function bybitCoin(overrides = {}) {
  return { coin: 'TEST', name: 'Test', remainAmount: 'private-balance', chains: [{
    chain: 'ETH', chainType: 'Ethereum', contractAddress: address,
    chainDeposit: '1', chainWithdraw: '0', withdrawMin: '0.01000000', withdrawFee: '0.0001',
    depositMin: '0', withdrawPercentageFee: '0.022', minAccuracy: '8', withdrawMax: '-1',
  }], ...overrides };
}
function okxChain(overrides = {}) {
  return { ccy: 'TEST', chain: 'TEST-ERC20', ctAddr: address,
    canDep: false, canWd: true, needTag: false, mainNet: true,
    minWd: '0.01000000', fee: '0.0001', minFee: 'not-current-fee', maxFee: 'not-current-fee',
    burningFeeRate: '0.05', wdTickSz: '8', wdQuota: 'private-quota', usedWdQuota: 'private-quota',
    ...overrides };
}
function upbitWallet(overrides = {}) {
  return { currency: 'TEST', net_type: 'ETH', network_name: 'Ethereum',
    wallet_state: 'working', block_state: 'normal', block_height: 12345,
    block_updated_at: '2026-10-06T00:00:00.000+00:00', block_elapsed_minutes: 6,
    ...overrides };
}
function validBody(adapter) {
  if (adapter === binance) return [binanceCoin()];
  if (adapter === bybit) return { retCode: 0, result: { rows: [bybitCoin()] } };
  if (adapter === okx) return { code: '0', data: [okxChain()] };
  return [upbitWallet()];
}

for (const adapter of [binance, bybit, okx, upbit]) {
  test(`${adapter.id} requires credentials before any request and does not expose supplied secrets`, async () => {
    let calls = 0;
    for (const input of [undefined, {}, { apiKey: credentials.apiKey }, { apiSecret: credentials.apiSecret }, { apiKey: ' ', apiSecret: credentials.apiSecret }]) {
      await assert.rejects(adapter.fetchCoins({ credentials: input, requestJson: async () => { calls++; } }), error => {
        assert.equal(error.code, 'AUTH_REQUIRED');
        assert.equal(error.message.includes(credentials.apiKey), false);
        assert.equal(error.message.includes(credentials.apiSecret), false);
        return true;
      });
    }
    assert.equal(calls, 0);
  });

  test(`${adapter.id} distinguishes a verified empty response from missing data and API errors`, async () => {
    const empty = adapter === binance || adapter === upbit ? [] : adapter === bybit ? { retCode: 0, result: { rows: [] } } : { code: '0', data: [] };
    assert.deepEqual(await adapter.fetchCoins({ credentials, requestJson: async () => empty }), []);
    for (const invalid of [null, {}, { error: { message: credentials.apiSecret } }, { code: -123, retCode: 123, msg: credentials.apiSecret }]) {
      await assert.rejects(adapter.fetchCoins({ credentials, requestJson: async () => invalid }), error => {
        assert.ok(['API_ERROR', 'INVALID_RESPONSE'].includes(error.code));
        assert.equal(error.message.includes(credentials.apiSecret), false);
        return true;
      });
    }
  });

  test(`${adapter.id} forwards read-only request options and masks injected transport failures`, async () => {
    const signal = new AbortController().signal;
    const result = await adapter.fetchCoins({ credentials, signal, requestJson: async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.signal, signal);
      assert.equal(options.body, undefined);
      assert.ok(url.startsWith('https://'));
      return validBody(adapter);
    } });
    assert.equal(result[0].source.includes('?'), false);
    assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
    assert.equal(JSON.stringify(result).includes(credentials.apiSecret), false);
    await assert.rejects(adapter.fetchCoins({ credentials, requestJson: async () => {
      const error = new Error(`https://private.invalid/?signature=${credentials.apiSecret}&key=${credentials.apiKey}`);
      error.code = 'HTTP_429'; error.retryAfterMs = 2345;
      throw error;
    } }), error => {
      assert.equal(error.code, 'HTTP_429');
      assert.equal(error.retryAfterMs, 2345);
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes(credentials.apiSecret), false);
      assert.equal(error.stack.includes(credentials.apiKey), false);
      return true;
    });
    await assert.rejects(adapter.fetchCoins({ credentials }), { code: 'REQUESTER_REQUIRED' });
  });
}

test('Binance signs the metadata GET and keeps only source network flags, CA and amount units', async () => {
  const original = binanceCoin();
  let queried;
  const rows = await binance.fetchCoins({ credentials: { key: credentials.apiKey, secret: credentials.apiSecret }, requestJson: async (url, options) => {
    queried = new URL(url);
    assert.equal(queried.pathname, '/sapi/v1/capital/config/getall');
    assert.equal(options.headers['X-MBX-APIKEY'], credentials.apiKey);
    const signature = queried.searchParams.get('signature');
    queried.searchParams.delete('signature');
    assert.equal(signature, createHmac('sha256', credentials.apiSecret).update(queried.searchParams.toString()).digest('hex'));
    assert.equal(queried.searchParams.get('recvWindow'), '5000');
    assert.ok(/^\d+$/.test(queried.searchParams.get('timestamp')));
    return [original];
  } });
  const network = rows[0].networks[0];
  assert.equal(network.network_code, 'ETH');
  assert.equal(network.contract_address, address);
  assert.equal(network.deposit_enabled, true);
  assert.equal(network.withdraw_enabled, false);
  assert.equal(network.withdraw_delayed, false);
  assert.equal(network.need_tag, false);
  assert.equal(network.min_withdraw, '0.01000000');
  assert.equal(network.withdraw_fee_unit, 'TEST');
  assert.equal(network.denomination, '1');
  assert.equal(JSON.stringify(rows).includes('private-balance'), false);
  assert.equal(original.networkList[0].contractAddress, address);
});

test('Binance preserves disabled/busy/unknown flags and rejects currency mismatches and duplicates', async () => {
  const coin = binanceCoin({ networkList: [{ network: 'UNMAPPED', depositEnable: false, withdrawEnable: true, busy: true }] });
  const rows = await binance.fetchCoins({ credentials, requestJson: async () => [coin] });
  assert.equal(rows[0].networks[0].network_code, 'UNMAPPED');
  assert.equal(rows[0].networks[0].contract_address, null);
  assert.equal(rows[0].networks[0].withdraw_delayed, true);
  assert.equal(rows[0].networks[0].need_tag, null);
  for (const invalid of [
    [binanceCoin(), binanceCoin()],
    [binanceCoin({ networkList: [{ network: 'ETH', coin: 'OTHER' }] })],
    [binanceCoin({ networkList: [{ network: 'ETH', withdrawEnable: 'false' }] })],
    [binanceCoin({ networkList: [{ network: 'ETH' }, { network: 'ETH' }] })],
    [binanceCoin({ networkList: null })],
  ]) await assert.rejects(binance.fetchCoins({ credentials, requestJson: async () => invalid }), { code: 'INVALID_RESPONSE' });
});

test('Bybit signs the documented unfiltered GET and preserves fractional fees and native unlimited marker', async () => {
  const rows = await bybit.fetchCoins({ credentials, requestJson: async (url, options) => {
    assert.equal(url, 'https://api.bybit.com/v5/asset/coin/query-info');
    const headers = options.headers;
    assert.equal(headers['X-BAPI-SIGN'], createHmac('sha256', credentials.apiSecret)
      .update(headers['X-BAPI-TIMESTAMP'] + credentials.apiKey + '5000').digest('hex'));
    assert.equal(headers['X-BAPI-RECV-WINDOW'], '5000');
    assert.equal(headers['X-BAPI-API-KEY'], credentials.apiKey);
    return { retCode: 0, result: { rows: [bybitCoin(), bybitCoin({ coin: 'OTHER', chains: [{ chain: 'OTHER', chainDeposit: '0', chainWithdraw: '0', withdrawFee: '', contractAddress: '' }] })] } };
  } });
  assert.equal(rows.length, 2);
  const network = rows[0].networks[0];
  assert.equal(network.network_code, 'ETH');
  assert.equal(network.contract_address, address);
  assert.equal(network.deposit_enabled, true);
  assert.equal(network.withdraw_enabled, false);
  assert.equal(network.withdraw_percentage_fee, '0.022');
  assert.equal(network.withdraw_percentage_fee_unit, 'fraction');
  assert.equal(network.max_withdraw, '-1');
  assert.equal(network.withdraw_delayed, null);
  assert.equal(rows[1].networks[0].contract_address, null);
  assert.equal(rows[1].networks[0].withdraw_enabled, false);
  assert.equal(JSON.stringify(rows).includes('private-balance'), false);
});

test('Bybit rejects unexpected pagination rather than storing an incomplete first page as successful', async () => {
  let calls = 0;
  await assert.rejects(bybit.fetchCoins({ credentials, requestJson: async () => {
    calls++; return { retCode: 0, result: { rows: [bybitCoin()], nextPageCursor: 'more' } };
  } }), { code: 'INCOMPLETE_RESPONSE' });
  assert.equal(calls, 1);
  for (const rows of [
    [bybitCoin(), bybitCoin()],
    [bybitCoin({ chains: [{ chain: 'ETH', chainDeposit: true }] })],
    [bybitCoin({ chains: [{ chain: 'ETH', chainWithdraw: '1', withdrawFee: '' }] })],
    [bybitCoin({ chains: [{ chain: 'ETH' }, { chain: 'ETH' }] })],
    [bybitCoin({ chains: null })],
  ]) await assert.rejects(bybit.fetchCoins({ credentials, requestJson: async () => ({ retCode: 0, result: { rows } }) }), { code: 'INVALID_RESPONSE' });
});

test('OKX signs using ISO UTC time and groups the account KYC entity currencies without quota details', async () => {
  const rows = await okx.fetchCoins({ credentials, requestJson: async (url, options) => {
    assert.equal(url, 'https://www.okx.com/api/v5/asset/currencies');
    const headers = options.headers;
    assert.equal(new Date(headers['OK-ACCESS-TIMESTAMP']).toISOString(), headers['OK-ACCESS-TIMESTAMP']);
    assert.equal(headers['OK-ACCESS-SIGN'], createHmac('sha256', credentials.apiSecret)
      .update(headers['OK-ACCESS-TIMESTAMP'] + 'GET/api/v5/asset/currencies').digest('base64'));
    assert.equal(headers['OK-ACCESS-KEY'], credentials.apiKey);
    assert.equal(headers['OK-ACCESS-PASSPHRASE'], credentials.passphrase);
    return { code: '0', data: [okxChain(), okxChain({ chain: 'TEST-Solana', ctAddr: 'f403fb', canDep: true, canWd: false, needTag: true })] };
  } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, 'ACCOUNT_KYC_ENTITY');
  const [first, second] = rows[0].networks;
  assert.equal(first.network_code, 'TEST-ERC20');
  assert.equal(first.contract_address, address);
  assert.equal(first.deposit_enabled, false);
  assert.equal(first.withdraw_enabled, true);
  assert.equal(first.withdraw_fee, '0.0001');
  assert.equal(first.withdraw_percentage_fee, '0.05');
  assert.equal(second.contract_address, null);
  assert.equal(second.contract_address_status, 'INCOMPLETE');
  assert.equal(second.need_tag, true);
  assert.equal(JSON.stringify(rows).includes('private-quota'), false);
  assert.equal(JSON.stringify(rows).includes('not-current-fee'), false);
});

test('OKX requires passphrase, rejects nonboolean toggles and duplicate network rows', async () => {
  await assert.rejects(okx.fetchCoins({ credentials: { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret } }), { code: 'AUTH_REQUIRED' });
  for (const data of [[okxChain(), okxChain()], [okxChain({ canWd: 'true' })], [okxChain({ chain: '' })]]) {
    await assert.rejects(okx.fetchCoins({ credentials, requestJson: async () => ({ code: '0', data }) }), { code: 'INVALID_RESPONSE' });
  }
});

test('Upbit uses a fresh HS512 JWT without query hash and returns service metadata with advisory status', async () => {
  const nonces = [];
  const requestJson = async (url, options) => {
    assert.equal(url, 'https://api.upbit.com/v1/status/wallet');
    const token = options.headers.Authorization.replace(/^Bearer /, '');
    const [header, payload, signature] = token.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'HS512', typ: 'JWT' });
    assert.equal(signature, createHmac('sha512', credentials.apiSecret).update(`${header}.${payload}`).digest('base64url'));
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(data.access_key, credentials.apiKey);
    assert.equal(data.query_hash, undefined);
    assert.ok(/^[0-9a-f-]{36}$/.test(data.nonce));
    nonces.push(data.nonce);
    return [upbitWallet({ contractAddress: address, depositAddress: 'private-address' })];
  };
  const rows = await upbit.fetchCoins({ credentials: { accessKey: credentials.apiKey, secretKey: credentials.apiSecret }, requestJson });
  await upbit.fetchCoins({ credentials, requestJson });
  assert.notEqual(nonces[0], nonces[1]);
  const network = rows[0].networks[0];
  assert.equal(network.contract_address, null);
  assert.equal(network.deposit_enabled, true);
  assert.equal(network.withdraw_enabled, true);
  assert.equal(network.status_realtime, false);
  assert.equal(network.status_notice, 'OFFICIAL_STATUS_MAY_LAG_MINUTES');
  assert.equal(network.native.block_elapsed_minutes, 6);
  assert.equal(network.need_tag, null);
  assert.equal(JSON.stringify(rows).includes('private-address'), false);
});

test('Upbit maps documented service states but preserves unknown state and delayed block uncertainty', async () => {
  const states = ['working', 'withdraw_only', 'deposit_only', 'paused', 'unsupported', 'future_state'];
  const rows = await upbit.fetchCoins({ credentials, requestJson: async () => states.map((wallet_state, index) => upbitWallet({ net_type: `CHAIN${index}`, wallet_state, block_state: index === 0 ? 'delayed' : index === 5 ? 'future_block_state' : 'normal' })) });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].networks.map(n => [n.deposit_enabled, n.withdraw_enabled]), [[true, true], [false, true], [true, false], [false, false], [false, false], [null, null]]);
  assert.equal(rows[0].networks[0].withdraw_delayed, true);
  assert.equal(rows[0].networks[5].withdraw_delayed, null);
  assert.equal(rows[0].networks[5].native.wallet_state, 'future_state');
  for (const data of [[upbitWallet(), upbitWallet()], [upbitWallet({ net_type: '' })], [upbitWallet({ block_height: '123' })]]) {
    await assert.rejects(upbit.fetchCoins({ credentials, requestJson: async () => data }), { code: 'INVALID_RESPONSE' });
  }
});

test('Incomplete and abbreviated contract addresses cannot become identity evidence', async () => {
  for (const bad of ['0x1776...6671', '1776e1', '0x1776e1', '0x1776e1f26f98b1a5df9cd347953a26dd3cb46671…']) {
    const binanceRows = await binance.fetchCoins({ credentials, requestJson: async () => [binanceCoin({ networkList: [{ network: 'ETH', contractAddress: bad }] })] });
    const bybitRows = await bybit.fetchCoins({ credentials, requestJson: async () => ({ retCode: 0, result: { rows: [bybitCoin({ chains: [{ chain: 'ETH', contractAddress: bad }] })] } }) });
    const okxRows = await okx.fetchCoins({ credentials, requestJson: async () => ({ code: '0', data: [okxChain({ ctAddr: bad })] }) });
    for (const rows of [binanceRows, bybitRows, okxRows]) {
      assert.equal(rows[0].networks[0].contract_address, null);
      assert.equal(rows[0].networks[0].contract_address_status, 'INCOMPLETE');
    }
  }
});

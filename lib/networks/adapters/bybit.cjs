const { createHmac } = require('node:crypto');

const id = 'bybit';
const source = 'https://api.bybit.com/v5/asset/coin/query-info';
// https://bybit-exchange.github.io/docs/v5/asset/coin-info
// Coin info has an optional coin query only, with no documented paging protocol.
function fail(code, message) { const error = new Error(`Bybit ${message}`); error.code = code; return error; }
function credentialsFor(input) {
  const key = input?.apiKey ?? input?.key;
  const secret = input?.apiSecret ?? input?.secret;
  if (typeof key !== 'string' || !key.trim() || typeof secret !== 'string' || !secret.trim()) throw fail('AUTH_REQUIRED', 'network metadata requires API credentials.');
  return { key, secret };
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_RESPONSE', 'invalid network metadata record.');
  return value;
}
function text(value, required = false) {
  if (value == null || value === '') { if (!required) return null; }
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw fail('INVALID_RESPONSE', 'invalid network metadata string.');
  return value;
}
function state(value) {
  if (value == null || value === '') return null;
  if (!['0', '1'].includes(value)) throw fail('INVALID_RESPONSE', 'invalid network metadata state.');
  return value === '1';
}
function decimal(value, unlimited = false) {
  if (value == null || value === '') return null;
  if (unlimited && value === '-1') return value;
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) throw fail('INVALID_RESPONSE', 'invalid network metadata amount.');
  return String(value);
}
function contract(value) {
  const address = text(value);
  if (!address) return { contract_address: null, contract_address_status: 'UNAVAILABLE' };
  const incomplete = address.length < 16 || /\.{2}|…|\*/.test(address) || (/^0x/i.test(address) && !/^0x[0-9a-fA-F]{40}$/.test(address));
  return { contract_address: incomplete ? null : address, contract_address_status: incomplete ? 'INCOMPLETE' : 'PROVIDED' };
}
async function request(requestJson, options) {
  if (typeof requestJson !== 'function') throw fail('REQUESTER_REQUIRED', 'network metadata requester missing.');
  try { return await requestJson(source, options); }
  catch (cause) {
    const code = /^HTTP_[1-5]\d\d$/.test(cause?.code || '') || cause?.code === 'HOST_COOLDOWN' ? cause.code : 'REQUEST_FAILED';
    const error = fail(options.signal?.aborted ? 'REQUEST_ABORTED' : code, 'network metadata request failed.');
    if (Number.isFinite(cause?.retryAfterMs) && cause.retryAfterMs >= 0) error.retryAfterMs = cause.retryAfterMs;
    throw error;
  }
}
async function fetchCoins({ requestJson, credentials, signal } = {}) {
  const { key, secret } = credentialsFor(credentials);
  const timestamp = String(Date.now());
  const recvWindow = '5000';
  const signature = createHmac('sha256', secret).update(timestamp + key + recvWindow).digest('hex');
  const body = await request(requestJson, {
    method: 'GET', headers: {
      'X-BAPI-API-KEY': key, 'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': recvWindow,
    }, signal,
  });
  object(body);
  if (body.retCode !== 0 && body.retCode !== '0') throw fail('API_ERROR', 'network API returned an error.');
  const result = object(body.result);
  // A new upstream pagination contract must be implemented explicitly; never silently truncate.
  for (const holder of [body, result]) {
    if (holder.nextPageCursor != null && holder.nextPageCursor !== '') throw fail('INCOMPLETE_RESPONSE', 'undocumented network metadata pagination.');
  }
  if (!Array.isArray(result.rows) || result.rows.length > 20000) throw fail('INVALID_RESPONSE', 'network metadata list missing or oversized.');
  const seen = new Set();
  return result.rows.map(value => {
    const coin = object(value);
    const symbol = text(coin.coin, true);
    if (seen.has(symbol)) throw fail('INVALID_RESPONSE', 'duplicate currency metadata.');
    seen.add(symbol);
    if (!Array.isArray(coin.chains) || coin.chains.length > 1000) throw fail('INVALID_RESPONSE', 'network list missing or oversized.');
    const codes = new Set();
    return { venue: id, coin: symbol, source, networks: coin.chains.map(value => {
      const chain = object(value);
      const networkCode = text(chain.chain, true);
      if (codes.has(networkCode)) throw fail('INVALID_RESPONSE', 'duplicate currency network.');
      codes.add(networkCode);
      const withdraw = state(chain.chainWithdraw);
      // Official docs define an empty withdrawFee as withdrawal unsupported.
      const unsupported = chain.withdrawFee === '';
      if (unsupported && withdraw === true) throw fail('INVALID_RESPONSE', 'inconsistent withdrawal metadata.');
      return {
        network_code: networkCode, network_name: text(chain.chainType), ...contract(chain.contractAddress),
        deposit_enabled: state(chain.chainDeposit), withdraw_enabled: unsupported ? false : withdraw,
        withdraw_delayed: null, need_tag: null,
        min_withdraw: decimal(chain.withdrawMin), withdraw_fee: decimal(chain.withdrawFee),
        min_withdraw_unit: symbol, withdraw_fee_unit: symbol,
        max_withdraw: decimal(chain.withdrawMax, true), min_deposit: decimal(chain.depositMin),
        withdraw_percentage_fee: decimal(chain.withdrawPercentageFee), withdraw_percentage_fee_unit: 'fraction',
        native: {
          chainDeposit: chain.chainDeposit ?? null, chainWithdraw: chain.chainWithdraw ?? null,
          minAccuracy: decimal(chain.minAccuracy), minAccuracy_unit: 'decimal_places',
          confirmation: decimal(chain.confirmation), safeConfirmNumber: decimal(chain.safeConfirmNumber),
          withdrawMax_unlimited_value: '-1',
        },
      };
    }) };
  });
}

module.exports = { id, fetchCoins };

const { createHmac } = require('node:crypto');

const id = 'okx';
const requestPath = '/api/v5/asset/currencies';
const source = `https://www.okx.com${requestPath}`;
// https://my.okx.com/docs-v5/en/#rest-api-funding-get-currencies
// Results are limited to the current account's KYC entity. No balances are retained.
function fail(code, message) { const error = new Error(`OKX ${message}`); error.code = code; return error; }
function credentialsFor(input) {
  const key = input?.apiKey ?? input?.key;
  const secret = input?.apiSecret ?? input?.secret;
  const passphrase = input?.passphrase;
  if ([key, secret, passphrase].some(value => typeof value !== 'string' || !value.trim())) throw fail('AUTH_REQUIRED', 'network metadata requires API credentials and passphrase.');
  return { key, secret, passphrase };
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
function bool(value) {
  if (value == null) return null;
  if (typeof value !== 'boolean') throw fail('INVALID_RESPONSE', 'invalid network metadata flag.');
  return value;
}
function decimal(value) {
  if (value == null || value === '') return null;
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
  const { key, secret, passphrase } = credentialsFor(credentials);
  const timestamp = new Date().toISOString();
  const signature = createHmac('sha256', secret).update(timestamp + 'GET' + requestPath).digest('base64');
  const body = await request(requestJson, {
    method: 'GET', headers: {
      'OK-ACCESS-KEY': key, 'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-PASSPHRASE': passphrase,
    }, signal,
  });
  object(body);
  if (body.code !== '0' && body.code !== 0) throw fail('API_ERROR', 'network API returned an error.');
  if (!Array.isArray(body.data) || body.data.length > 20000) throw fail('INVALID_RESPONSE', 'network metadata list missing or oversized.');
  const coins = new Map();
  const seen = new Set();
  for (const value of body.data) {
    const chain = object(value);
    const symbol = text(chain.ccy, true);
    const networkCode = text(chain.chain, true);
    const identity = JSON.stringify([symbol, networkCode]);
    if (seen.has(identity)) throw fail('INVALID_RESPONSE', 'duplicate currency network.');
    seen.add(identity);
    if (!coins.has(symbol)) coins.set(symbol, { venue: id, coin: symbol, source, scope: 'ACCOUNT_KYC_ENTITY', networks: [] });
    coins.get(symbol).networks.push({
      network_code: networkCode, network_name: networkCode, ...contract(chain.ctAddr),
      deposit_enabled: bool(chain.canDep), withdraw_enabled: bool(chain.canWd),
      withdraw_delayed: null, need_tag: bool(chain.needTag),
      min_withdraw: decimal(chain.minWd), withdraw_fee: decimal(chain.fee),
      min_withdraw_unit: symbol, withdraw_fee_unit: symbol,
      max_withdraw: decimal(chain.maxWd), min_deposit: decimal(chain.minDep),
      withdraw_percentage_fee: decimal(chain.burningFeeRate), withdraw_percentage_fee_unit: 'fraction',
      native: {
        canInternal: bool(chain.canInternal), mainNet: bool(chain.mainNet),
        depEstOpenTime: decimal(chain.depEstOpenTime), wdEstOpenTime: decimal(chain.wdEstOpenTime),
        estimated_open_time_unit: 'unix_milliseconds',
        wdTickSz: decimal(chain.wdTickSz), wdTickSz_unit: 'decimal_places',
        minDepArrivalConfirm: decimal(chain.minDepArrivalConfirm), minWdUnlockConfirm: decimal(chain.minWdUnlockConfirm),
      },
    });
  }
  return [...coins.values()];
}

module.exports = { id, fetchCoins };

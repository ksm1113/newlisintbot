const { createHmac } = require('node:crypto');

const id = 'binance';
const source = 'https://api.binance.com/sapi/v1/capital/config/getall';
// Official endpoint: https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/capital
// This endpoint includes account balances; only the network metadata below is retained.
function fail(code, message) { const error = new Error(`Binance ${message}`); error.code = code; return error; }
function credentialsFor(input) {
  const key = input?.apiKey ?? input?.key;
  const secret = input?.apiSecret ?? input?.secret;
  if (typeof key !== 'string' || !key.trim() || typeof secret !== 'string' || !secret.trim()) {
    throw fail('AUTH_REQUIRED', 'network metadata requires API credentials.');
  }
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
function bool(value) {
  if (value == null) return null;
  if (typeof value !== 'boolean') throw fail('INVALID_RESPONSE', 'invalid network metadata flag.');
  return value;
}
function decimal(value) {
  if (value == null || value === '') return null;
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) {
    throw fail('INVALID_RESPONSE', 'invalid network metadata amount.');
  }
  return String(value);
}
function contract(value) {
  const address = text(value);
  if (!address) return { contract_address: null, contract_address_status: 'UNAVAILABLE' };
  const incomplete = address.length < 16 || /\.{2}|…|\*/.test(address) || (/^0x/i.test(address) && !/^0x[0-9a-fA-F]{40}$/.test(address));
  return { contract_address: incomplete ? null : address, contract_address_status: incomplete ? 'INCOMPLETE' : 'PROVIDED' };
}
async function request(requestJson, url, options) {
  if (typeof requestJson !== 'function') throw fail('REQUESTER_REQUIRED', 'network metadata requester missing.');
  try { return await requestJson(url, options); }
  catch (cause) {
    // Never propagate a signed URL, response text, headers, or a credential-bearing cause.
    const code = /^HTTP_[1-5]\d\d$/.test(cause?.code || '') || cause?.code === 'HOST_COOLDOWN' ? cause.code : 'REQUEST_FAILED';
    const error = fail(options.signal?.aborted ? 'REQUEST_ABORTED' : code, 'network metadata request failed.');
    if (Number.isFinite(cause?.retryAfterMs) && cause.retryAfterMs >= 0) error.retryAfterMs = cause.retryAfterMs;
    throw error;
  }
}
async function fetchCoins({ requestJson, credentials, signal } = {}) {
  const { key, secret } = credentialsFor(credentials);
  const query = new URLSearchParams({ timestamp: String(Date.now()), recvWindow: '5000' }).toString();
  const signature = createHmac('sha256', secret).update(query).digest('hex');
  const body = await request(requestJson, `${source}?${query}&signature=${signature}`, {
    method: 'GET', headers: { 'X-MBX-APIKEY': key }, signal,
  });
  if (body && !Array.isArray(body) && body.code != null) throw fail('API_ERROR', 'network API returned an error.');
  if (!Array.isArray(body) || body.length > 20000) throw fail('INVALID_RESPONSE', 'network metadata list missing or oversized.');
  const seen = new Set();
  return body.map(value => {
    const coin = object(value);
    const symbol = text(coin.coin, true);
    if (seen.has(symbol)) throw fail('INVALID_RESPONSE', 'duplicate currency metadata.');
    seen.add(symbol);
    if (!Array.isArray(coin.networkList) || coin.networkList.length > 1000) throw fail('INVALID_RESPONSE', 'network list missing or oversized.');
    const codes = new Set();
    return {
      venue: id, coin: symbol, source,
      networks: coin.networkList.map(value => {
        const chain = object(value);
        const networkCode = text(chain.network, true);
        if (codes.has(networkCode)) throw fail('INVALID_RESPONSE', 'duplicate currency network.');
        codes.add(networkCode);
        if (chain.coin != null && chain.coin !== symbol) throw fail('INVALID_RESPONSE', 'network currency mismatch.');
        const busy = bool(chain.busy);
        return {
          network_code: networkCode, network_name: text(chain.name), ...contract(chain.contractAddress),
          deposit_enabled: bool(chain.depositEnable), withdraw_enabled: bool(chain.withdrawEnable),
          // Binance supplies a busy flag, retained as a conservative delay indicator.
          withdraw_delayed: busy, need_tag: bool(chain.withdrawTag),
          min_withdraw: decimal(chain.withdrawMin), withdraw_fee: decimal(chain.withdrawFee),
          min_withdraw_unit: symbol, withdraw_fee_unit: symbol,
          max_withdraw: decimal(chain.withdrawMax), min_deposit: decimal(chain.depositDust),
          withdraw_integer_multiple: decimal(chain.withdrawIntegerMultiple),
          denomination: decimal(chain.denomination), denomination_unit: 'underlying_tokens_per_coin',
          native: {
            busy, isDefault: bool(chain.isDefault), minConfirm: decimal(chain.minConfirm),
            unLockConfirm: decimal(chain.unLockConfirm), estimatedArrivalTime: decimal(chain.estimatedArrivalTime),
            estimatedArrivalTime_unit: 'minutes', resetAddressStatus: bool(chain.resetAddressStatus),
          },
        };
      }),
    };
  });
}

module.exports = { id, fetchCoins };

const { createHmac, randomUUID } = require('node:crypto');

const id = 'upbit';
const source = 'https://api.upbit.com/v1/status/wallet';
// https://docs.upbit.com/kr/reference/get-service-status
// https://docs.upbit.com/kr/reference/auth
// Official status can lag by several minutes, and is advisory rather than real-time.
function fail(code, message) { const error = new Error(`Upbit ${message}`); error.code = code; return error; }
function credentialsFor(input) {
  const key = input?.apiKey ?? input?.key ?? input?.accessKey;
  const secret = input?.apiSecret ?? input?.secret ?? input?.secretKey;
  if (typeof key !== 'string' || !key.trim() || typeof secret !== 'string' || !secret.trim()) throw fail('AUTH_REQUIRED', 'wallet service metadata requires API credentials.');
  return { key, secret };
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_RESPONSE', 'invalid wallet service metadata record.');
  return value;
}
function text(value, required = false) {
  if (value == null || value === '') { if (!required) return null; }
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw fail('INVALID_RESPONSE', 'invalid wallet service metadata string.');
  return value;
}
function integer(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw fail('INVALID_RESPONSE', 'invalid wallet block metadata.');
  return value;
}
async function request(requestJson, options) {
  if (typeof requestJson !== 'function') throw fail('REQUESTER_REQUIRED', 'wallet service metadata requester missing.');
  try { return await requestJson(source, options); }
  catch (cause) {
    const code = /^HTTP_[1-5]\d\d$/.test(cause?.code || '') || cause?.code === 'HOST_COOLDOWN' ? cause.code : 'REQUEST_FAILED';
    const error = fail(options.signal?.aborted ? 'REQUEST_ABORTED' : code, 'wallet service metadata request failed.');
    if (Number.isFinite(cause?.retryAfterMs) && cause.retryAfterMs >= 0) error.retryAfterMs = cause.retryAfterMs;
    throw error;
  }
}
async function fetchCoins({ requestJson, credentials, signal } = {}) {
  const { key, secret } = credentialsFor(credentials);
  const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ access_key: key, nonce: randomUUID() })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha512', secret).update(signingInput).digest('base64url');
  const body = await request(requestJson, {
    method: 'GET', headers: { Authorization: `Bearer ${signingInput}.${signature}` }, signal,
  });
  if (body && !Array.isArray(body) && body.error != null) throw fail('API_ERROR', 'wallet service API returned an error.');
  if (!Array.isArray(body) || body.length > 20000) throw fail('INVALID_RESPONSE', 'wallet service metadata list missing or oversized.');
  const coins = new Map();
  const seen = new Set();
  for (const value of body) {
    const item = object(value);
    const symbol = text(item.currency, true);
    const networkCode = text(item.net_type, true);
    const identity = JSON.stringify([symbol, networkCode]);
    if (seen.has(identity)) throw fail('INVALID_RESPONSE', 'duplicate currency network.');
    seen.add(identity);
    const walletState = text(item.wallet_state, true);
    const blockState = text(item.block_state);
    // Unknown vendor states remain unknown; they cannot enable a route.
    const known = ['working', 'withdraw_only', 'deposit_only', 'paused', 'unsupported'].includes(walletState);
    if (!coins.has(symbol)) coins.set(symbol, { venue: id, coin: symbol, source, networks: [] });
    coins.get(symbol).networks.push({
      network_code: networkCode, network_name: text(item.network_name),
      contract_address: null, contract_address_status: 'UNAVAILABLE',
      deposit_enabled: known ? ['working', 'deposit_only'].includes(walletState) : null,
      withdraw_enabled: known ? ['working', 'withdraw_only'].includes(walletState) : null,
      withdraw_delayed: blockState === 'delayed' ? true : blockState === 'normal' ? false : null,
      need_tag: null, min_withdraw: null, withdraw_fee: null,
      min_withdraw_unit: null, withdraw_fee_unit: null,
      status_realtime: false, status_notice: 'OFFICIAL_STATUS_MAY_LAG_MINUTES',
      status_documentation: 'https://docs.upbit.com/kr/reference/get-service-status',
      native: {
        wallet_state: walletState, block_state: blockState,
        block_height: integer(item.block_height), block_updated_at: text(item.block_updated_at),
        block_elapsed_minutes: integer(item.block_elapsed_minutes),
      },
    });
  }
  return [...coins.values()];
}

module.exports = { id, fetchCoins };

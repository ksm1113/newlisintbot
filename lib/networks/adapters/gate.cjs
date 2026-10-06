'use strict';

// https://www.gate.com/docs/developers/apiv4/en/spot/#query-all-currency-information
const id = 'gate';
const source = 'https://api.gateio.ws/api/v4/spot/currencies';

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Gate malformed network ${name}`);
  return value;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Gate missing network ${name}`);
  return value;
}

function optionalText(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`Gate malformed network ${name}`);
  return value.trim() === '' ? null : value;
}

function optionalBoolean(value, name) {
  if (value === undefined || value === null) return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`Gate malformed network ${name}`);
}

function enabled(disabled) { return disabled === null ? null : !disabled; }

function unique(seen, value, name) {
  const key = value.trim().toUpperCase();
  if (seen.has(key)) throw new Error(`Gate duplicate network ${name}: ${value}`);
  seen.add(key);
}

async function fetchCoins({ requestJson, signal }) {
  const response = await requestJson(source, { signal });
  if (!Array.isArray(response)) {
    if (response && typeof response.label === 'string') throw new Error('Gate network API error');
    throw new Error('Gate malformed network response');
  }

  const coins = new Set();
  return response.map(original => {
    const row = object(original, 'coin');
    const coin = requiredText(row.currency, 'currency');
    unique(coins, coin, 'coin');
    if (!Array.isArray(row.chains)) throw new Error('Gate malformed network chains');
    const chains = new Set();
    const networks = row.chains.map(originalChain => {
      const chain = object(originalChain, 'chain');
      const networkCode = requiredText(chain.name, 'name');
      unique(chains, networkCode, 'chain');
      return {
        network_code: networkCode,
        contract_address: optionalText(chain.addr, 'addr'),
        // The deprecated coin-level flags never substitute for chain-level status.
        deposit_enabled: enabled(optionalBoolean(chain.deposit_disabled, 'deposit_disabled')),
        withdraw_enabled: enabled(optionalBoolean(chain.withdraw_disabled, 'withdraw_disabled')),
        withdraw_delayed: optionalBoolean(chain.withdraw_delayed, 'withdraw_delayed'),
        need_tag: null,
        min_withdraw: null,
        withdraw_fee: null,
        raw: chain,
      };
    });
    return {
      venue: id,
      coin,
      name: optionalText(row.name, 'name'),
      delisted: optionalBoolean(row.delisted, 'delisted'),
      trade_disabled: optionalBoolean(row.trade_disabled, 'trade_disabled'),
      // fixed_rate describes a special trading fee, not a withdrawal fee.
      fixed_rate: optionalText(row.fixed_rate, 'fixed_rate'),
      source,
      networks,
      raw: row,
    };
  });
}

module.exports = { id, fetchCoins };

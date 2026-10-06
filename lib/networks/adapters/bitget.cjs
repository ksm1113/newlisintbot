'use strict';

// Official Classic Account public coin list (no coin query means the full list):
// https://www.bitget.com/zh-CN/docs/catalog/classic-spot-market/classic-spot-market
const id = 'bitget';
const source = 'https://api.bitget.com/api/v2/spot/public/coins';

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bitget malformed network ${name}`);
  }
  return value;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Bitget missing network ${name}`);
  return value;
}

function optionalText(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`Bitget malformed network ${name}`);
  return value.trim() === '' ? null : value;
}

function optionalNumberText(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Bitget malformed network ${name}`);
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error(`Bitget imprecise network ${name}`);
  }
  const result = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(result)) throw new Error(`Bitget malformed network ${name}`);
  return result;
}

function optionalBoolean(value, name) {
  if (value === undefined || value === null) return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`Bitget malformed network ${name}`);
}

function unique(seen, value, name) {
  const key = value.trim().toUpperCase();
  if (seen.has(key)) throw new Error(`Bitget duplicate network ${name}: ${value}`);
  seen.add(key);
}

async function fetchCoins({ requestJson, signal }) {
  const response = object(await requestJson(source, { signal }), 'response');
  if (response.code !== '00000') throw new Error('Bitget network API error');
  if (!Array.isArray(response.data)) throw new Error('Bitget malformed network data');

  const coins = new Set();
  return response.data.map(original => {
    const row = object(original, 'coin');
    const coin = requiredText(row.coin, 'coin');
    unique(coins, coin, 'coin');
    // A missing chains field is an incomplete response, not a successful empty list.
    if (!Array.isArray(row.chains)) throw new Error('Bitget malformed network chains');
    const chains = new Set();
    const networks = row.chains.map(originalChain => {
      const chain = object(originalChain, 'chain');
      const networkCode = requiredText(chain.chain, 'chain');
      unique(chains, networkCode, 'chain');
      return {
        network_code: networkCode,
        contract_address: optionalText(chain.contractAddress, 'contractAddress'),
        deposit_enabled: optionalBoolean(chain.rechargeable, 'rechargeable'),
        withdraw_enabled: optionalBoolean(chain.withdrawable, 'withdrawable'),
        // This public endpoint does not report withdrawal delay separately.
        withdraw_delayed: null,
        need_tag: optionalBoolean(chain.needTag, 'needTag'),
        min_withdraw: optionalNumberText(chain.minWithdrawAmount, 'minWithdrawAmount'),
        withdraw_fee: optionalNumberText(chain.withdrawFee, 'withdrawFee'),
        min_deposit: optionalNumberText(chain.minDepositAmount, 'minDepositAmount'),
        extra_withdraw_fee: optionalNumberText(chain.extraWithdrawFee, 'extraWithdrawFee'),
        deposit_confirmations: optionalNumberText(chain.depositConfirm, 'depositConfirm'),
        withdraw_confirmations: optionalNumberText(chain.withdrawConfirm, 'withdrawConfirm'),
        withdraw_step: optionalNumberText(chain.withdrawStep, 'withdrawStep'),
        withdraw_min_scale: optionalNumberText(chain.withdrawMinScale, 'withdrawMinScale'),
        congestion: optionalText(chain.congestion, 'congestion'),
        browser_url: optionalText(chain.browserUrl, 'browserUrl'),
        // Preserve the original decimal fields and any future unit metadata.
        raw: chain,
      };
    });
    return {
      venue: id,
      coin,
      coin_id: optionalText(row.coinId, 'coinId'),
      transfer_enabled: optionalBoolean(row.transfer, 'transfer'),
      source,
      networks,
      raw: row,
    };
  });
}

module.exports = { id, fetchCoins };

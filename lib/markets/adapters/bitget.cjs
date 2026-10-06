'use strict';

const { market } = require('../model.cjs');

// Official Classic Account catalog: /api/v2/spot/public/symbols and
// /api/v2/mix/market/contracts. Delivery contracts are outside these segments.
const id = 'bitget';
const kind = 'CEX';
const baseUrl = 'https://api.bitget.com';
const productTypes = {
  usdt_perpetual: 'USDT-FUTURES',
  usdc_perpetual: 'USDC-FUTURES',
  coin_perpetual: 'COIN-FUTURES',
};
const segments = [
  { id: 'spot', market_type: 'spot', description: 'Classic Account spot' },
  { id: 'usdt_perpetual', market_type: 'perpetual', description: 'USDT-M perpetuals' },
  { id: 'usdc_perpetual', market_type: 'perpetual', description: 'USDC-M perpetuals' },
  { id: 'coin_perpetual', market_type: 'perpetual', description: 'Coin-M perpetuals' },
];

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Bitget malformed ${name}`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Bitget missing ${name}`);
  return value;
}

function optionalText(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Bitget malformed numeric/string field');
  return String(value);
}

function decimalPlaces(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^\d+$/.test(String(value)) || Number(value) > 30) throw new Error('Bitget malformed precision');
  return Number(value);
}

function decimalStep(value, precision) {
  const places = decimalPlaces(precision);
  if (places === null || value === undefined || value === null || value === '') return null;
  const match = String(value).match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('Bitget malformed price step');
  const fractional = match[2] || '';
  let digits = `${match[1]}${fractional}`;
  const scale = places + fractional.length;
  digits = digits.padStart(scale + 1, '0');
  const integer = (scale ? digits.slice(0, -scale) : digits).replace(/^0+(?=\d)/, '');
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, '') : '';
  const result = fraction ? `${integer}.${fraction}` : integer;
  if (!/[1-9]/.test(result)) throw new Error('Bitget zero price step');
  return result;
}

function status(value, spot) {
  if (spot) {
    if (value === 'online') return 'ACTIVE';
    if (['offline', 'gray', 'halt'].includes(value)) return 'INACTIVE';
  } else {
    if (value === 'normal') return 'ACTIVE';
    if (['listed', 'maintain', 'limit_open', 'restrictedAPI', 'off'].includes(value)) return 'INACTIVE';
  }
  return 'UNKNOWN';
}

async function fetchSegment(segmentId, { requestJson, signal }) {
  if (!segments.some(segment => segment.id === segmentId)) throw new Error(`Unsupported Bitget segment: ${segmentId}`);
  const spot = segmentId === 'spot';
  const url = spot
    ? `${baseUrl}/api/v2/spot/public/symbols`
    : `${baseUrl}/api/v2/mix/market/contracts?productType=${productTypes[segmentId]}`;
  const response = object(await requestJson(url, { signal }), 'response');
  if (response.code !== '00000') throw new Error(`Bitget API error: ${optionalText(response.code) || 'missing code'}`);
  if (!Array.isArray(response.data)) throw new Error('Bitget malformed catalog data');

  const seen = new Set();
  const result = [];
  for (const original of response.data) {
    const row = object(original, 'market');
    const marketId = text(row.symbol, 'symbol');
    if (seen.has(marketId)) throw new Error(`Bitget duplicate market: ${marketId}`);
    seen.add(marketId);
    const baseSymbol = text(row.baseCoin, 'baseCoin');
    const quoteSymbol = text(row.quoteCoin, 'quoteCoin');
    if (!spot) {
      // Never classify a delivery or an unknown contract type as perpetual.
      if (row.symbolType === 'delivery') continue;
      if (row.symbolType !== 'perpetual') throw new Error(`Bitget unsupported symbolType: ${optionalText(row.symbolType)}`);
      if (row.supportMarginCoins !== undefined && (!Array.isArray(row.supportMarginCoins)
        || row.supportMarginCoins.some(coin => typeof coin !== 'string' || coin === ''))) {
        throw new Error('Bitget malformed supportMarginCoins');
      }
    }
    const nativeStatus = optionalText(spot ? row.status : row.symbolStatus);
    const marginCoins = spot ? [] : (row.supportMarginCoins || []);
    const settleSymbol = spot ? null : segmentId === 'usdt_perpetual' ? 'USDT'
      : segmentId === 'usdc_perpetual' ? 'USDC' : marginCoins.length === 1 ? marginCoins[0] : null;
    const quantityStep = spot ? decimalStep('1', row.quantityPrecision) : optionalText(row.sizeMultiplier);
    result.push(market({
      venue: id,
      venue_kind: kind,
      segment: segmentId,
      market_id: marketId,
      market_type: spot ? 'spot' : 'perpetual',
      base_symbol: baseSymbol,
      quote_symbol: quoteSymbol,
      settle_symbol: settleSymbol,
      native_status: nativeStatus,
      market_status: status(nativeStatus, spot),
      linear: spot ? null : segmentId !== 'coin_perpetual',
      inverse: spot ? null : segmentId === 'coin_perpetual',
      // sizeMultiplier is an order quantity increment, not a token multiplier.
      multiplier: null,
      contract_size: null,
      price_tick: spot ? decimalStep('1', row.pricePrecision) : decimalStep(row.priceEndStep, row.pricePlace),
      quantity_step: quantityStep,
      limits: spot ? {
        min_notional_usdt: optionalText(row.minTradeUSDT),
        max_limit_order_value_usdt: optionalText(row.maxLimitOrderValue),
        max_market_order_value_usdt: optionalText(row.maxMarketOrderValue),
        quantity_unit: 'BASE_CURRENCY',
      } : {
        min_quantity: optionalText(row.minTradeNum),
        min_notional_usdt: optionalText(row.minTradeUSDT),
        max_market_order_quantity: optionalText(row.maxMarketOrderQty),
        max_limit_order_quantity: optionalText(row.maxOrderQty),
        min_leverage: optionalText(row.minLever),
        max_leverage: optionalText(row.maxLever),
        supported_margin_coins: marginCoins,
        quantity_unit: 'BASE_CURRENCY',
        opening_restricted: ['listed', 'maintain', 'limit_open', 'restrictedAPI', 'off'].includes(nativeStatus),
      },
      order_api_status: nativeStatus === 'restrictedAPI' ? 'UNAVAILABLE' : 'AVAILABLE',
      raw: row,
      source: url,
    }));
  }
  return result;
}

module.exports = { id, kind, segments, fetchSegment };

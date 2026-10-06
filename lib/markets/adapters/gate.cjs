'use strict';

const { market } = require('../model.cjs');

// https://www.gate.com/docs/developers/apiv4/en/{spot,futures}/
const id = 'gate';
const kind = 'CEX';
const baseUrl = 'https://api.gateio.ws/api/v4';
const settlements = { usdt_perpetual: 'usdt', btc_perpetual: 'btc', usd1_perpetual: 'usd1' };
const segments = [
  { id: 'spot', market_type: 'spot', description: 'Spot currency pairs' },
  { id: 'usdt_perpetual', market_type: 'perpetual', description: 'USDT-settled perpetual contracts' },
  { id: 'btc_perpetual', market_type: 'perpetual', description: 'BTC-settled perpetual contracts' },
  { id: 'usd1_perpetual', market_type: 'perpetual', description: 'USD1-settled perpetual contracts' },
];
const pageSize = 100;
const maxPages = 1000;

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gate malformed market');
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Gate missing ${name}`);
  return value;
}

function optionalText(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Gate malformed numeric/string field');
  return String(value);
}

function precisionStep(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^\d+$/.test(String(value)) || Number(value) > 30) throw new Error('Gate malformed precision');
  const places = Number(value);
  return places === 0 ? '1' : `0.${'0'.repeat(places - 1)}1`;
}

function arrayResponse(response) {
  if (!Array.isArray(response)) {
    if (response && typeof response.label === 'string') throw new Error(`Gate API error: ${response.label}`);
    throw new Error('Gate malformed catalog response');
  }
  return response;
}

function spotMarket(row, source) {
  const nativeStatus = optionalText(row.trade_status);
  if (row.trade_quotes !== undefined && row.trade_quotes !== null && (!Array.isArray(row.trade_quotes)
    || row.trade_quotes.some(quote => typeof quote !== 'string' || quote === ''))) {
    throw new Error('Gate malformed unified trade_quotes');
  }
  return market({
    venue: id,
    venue_kind: kind,
    segment: 'spot',
    market_id: text(row.id, 'id'),
    market_type: 'spot',
    base_symbol: text(row.base, 'base'),
    quote_symbol: text(row.quote, 'quote'),
    settle_symbol: null,
    native_status: nativeStatus,
    native_market_type: row.type || null,
    market_status: row.type === 'premarket' ? 'UNKNOWN'
      : ['tradable', 'buyable', 'sellable'].includes(nativeStatus) ? 'ACTIVE'
        : nativeStatus === 'untradable' ? 'INACTIVE' : 'UNKNOWN',
    linear: null,
    inverse: null,
    multiplier: null,
    contract_size: null,
    price_tick: precisionStep(row.precision),
    quantity_step: precisionStep(row.amount_precision),
    limits: {
      min_quantity: optionalText(row.min_base_amount),
      max_quantity: optionalText(row.max_base_amount),
      min_quote_amount: optionalText(row.min_quote_amount),
      max_quote_amount: optionalText(row.max_quote_amount),
      max_market_order_quantity: optionalText(row.market_order_max_stock),
      max_market_order_quote_amount: optionalText(row.market_order_max_money),
      quantity_unit: 'BASE_CURRENCY',
      buy_enabled: ['tradable', 'buyable'].includes(nativeStatus),
      sell_enabled: ['tradable', 'sellable'].includes(nativeStatus),
      supported_trade_quotes: row.trade_quotes || [],
    },
    order_api_status: 'AVAILABLE',
    raw: row,
    source,
  });
}

function futuresMarket(row, segmentId, source) {
  const name = text(row.name, 'name');
  if (row.in_delisting !== undefined && typeof row.in_delisting !== 'boolean') throw new Error('Gate malformed in_delisting');
  if (row.enable_decimal !== undefined && typeof row.enable_decimal !== 'boolean') throw new Error('Gate malformed enable_decimal');
  const nativeStatus = optionalText(row.status);
  const separator = name.lastIndexOf('_');
  // The native name provides candidate labels only; no ticker identity is inferred.
  const baseSymbol = separator > 0 ? name.slice(0, separator) : name;
  const quoteSymbol = separator > 0 && separator < name.length - 1 ? name.slice(separator + 1) : null;
  return market({
    venue: id,
    venue_kind: kind,
    segment: segmentId,
    market_id: name,
    market_type: 'perpetual',
    base_symbol: baseSymbol,
    quote_symbol: quoteSymbol,
    settle_symbol: settlements[segmentId].toUpperCase(),
    symbol_provenance: 'NATIVE_CONTRACT_NAME',
    native_status: nativeStatus,
    market_status: row.in_delisting === true ? 'INACTIVE'
      : nativeStatus === 'trading' ? 'ACTIVE'
        : ['prelaunch', 'delisting', 'delisted', 'circuit_breaker'].includes(nativeStatus) ? 'INACTIVE' : 'UNKNOWN',
    linear: row.type === 'direct' ? true : row.type === 'inverse' ? false : null,
    inverse: row.type === 'inverse' ? true : row.type === 'direct' ? false : null,
    multiplier: optionalText(row.quanto_multiplier),
    contract_size: optionalText(row.quanto_multiplier),
    price_tick: optionalText(row.order_price_round),
    // Decimal lot size support does not provide the actual increment; do not guess.
    quantity_step: row.enable_decimal === false ? '1' : null,
    limits: {
      min_quantity: optionalText(row.order_size_min),
      max_quantity: optionalText(row.order_size_max),
      max_market_order_quantity: optionalText(row.market_order_size_max),
      min_leverage: optionalText(row.leverage_min),
      max_leverage: optionalText(row.leverage_max),
      quantity_unit: 'CONTRACTS',
      decimal_lot_sizes: row.enable_decimal ?? null,
      in_delisting: row.in_delisting ?? null,
      underlying_unit_per_contract: optionalText(row.quanto_multiplier),
    },
    order_api_status: 'AVAILABLE',
    raw: row,
    source,
  });
}

async function fetchSegment(segmentId, { requestJson, signal }) {
  if (!segments.some(segment => segment.id === segmentId)) throw new Error(`Unsupported Gate segment: ${segmentId}`);
  const result = [];
  const seen = new Set();
  if (segmentId === 'spot') {
    const source = `${baseUrl}/spot/currency_pairs`;
    for (const original of arrayResponse(await requestJson(source, { signal }))) {
      const row = object(original);
      const normalized = spotMarket(row, source);
      if (seen.has(normalized.market_id)) throw new Error(`Gate duplicate market: ${normalized.market_id}`);
      seen.add(normalized.market_id);
      result.push(normalized);
    }
    return result;
  }
  // Explicit limit/offset traversal avoids treating only the first page as complete.
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const source = `${baseUrl}/futures/${settlements[segmentId]}/contracts?limit=${pageSize}&offset=${offset}`;
    const rows = arrayResponse(await requestJson(source, { signal }));
    if (rows.length > pageSize) throw new Error('Gate catalog page exceeds requested limit');
    for (const original of rows) {
      const normalized = futuresMarket(object(original), segmentId, source);
      if (seen.has(normalized.market_id)) throw new Error(`Gate repeated/duplicate market page: ${normalized.market_id}`);
      seen.add(normalized.market_id);
      result.push(normalized);
    }
    if (rows.length < pageSize) return result;
    offset += rows.length;
  }
  throw new Error('Gate catalog exceeded pagination safety limit');
}

module.exports = { id, kind, segments, fetchSegment };

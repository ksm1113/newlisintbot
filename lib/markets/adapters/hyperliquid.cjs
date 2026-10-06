'use strict';

const { market } = require('../model.cjs');

const id = 'hyperliquid';
const kind = 'PERP_DEX';
const source = 'https://api.hyperliquid.xyz/info';
const segments = [{ id: 'perpetual', market_type: 'perpetual', description: 'Native and builder-deployed HIP-3 perpetuals' }];

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Hyperliquid malformed ${name}`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Hyperliquid missing ${name}`);
  return value;
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`Hyperliquid malformed ${name}`);
  return value;
}

function extractMeta(value) {
  // Support metadata objects and the current documentation's [meta, contexts]
  // tuples as explicit schemas, never skip unknown rows.
  if (Array.isArray(value)) {
    if (value.length !== 2 || !Array.isArray(value[1])) throw new Error('Hyperliquid malformed allPerpMetas tuple');
    const meta = object(value[0], 'meta');
    if (!Array.isArray(meta.universe) || meta.universe.length !== value[1].length) {
      throw new Error('Hyperliquid inconsistent metadata/context lengths');
    }
    for (const context of value[1]) object(context, 'asset context');
    return { meta, contexts: value[1] };
  }
  return { meta: object(value, 'meta'), contexts: null };
}

async function fetchSegment(segmentId, { requestJson, signal }) {
  if (segmentId !== 'perpetual') throw new Error(`Unsupported Hyperliquid segment: ${segmentId}`);
  const request = type => requestJson(source, { method: 'POST', body: { type }, signal });
  // spotMeta is used only to decode collateral token indices, not to catalog spot.
  const [dexs, metas, spot] = await Promise.all([request('perpDexs'), request('allPerpMetas'), request('spotMeta')]);
  if (!Array.isArray(dexs) || !Array.isArray(metas) || dexs.length === 0 || dexs.length !== metas.length) {
    throw new Error('Hyperliquid inconsistent perpetual dex/metadata lists');
  }
  if (dexs[0] !== null) throw new Error('Hyperliquid malformed native dex slot');
  const spotMeta = object(spot, 'collateral token metadata');
  if (!Array.isArray(spotMeta.tokens)) throw new Error('Hyperliquid malformed collateral tokens');
  const tokens = new Map();
  for (const original of spotMeta.tokens) {
    const token = object(original, 'collateral token');
    const tokenIndex = integer(token.index, 'token index');
    if (tokens.has(tokenIndex)) throw new Error('Hyperliquid duplicate collateral token index');
    tokens.set(tokenIndex, text(token.name, 'collateral token name'));
  }
  const result = [];
  const seen = new Set();
  const dexNames = new Set();
  for (let dexIndex = 0; dexIndex < dexs.length; dexIndex += 1) {
    const dex = dexIndex === 0 ? null : object(dexs[dexIndex], 'perpetual dex');
    const dexName = dexIndex === 0 ? '' : text(dex.name, 'dex name');
    if (dexNames.has(dexName)) throw new Error('Hyperliquid duplicate dex namespace');
    dexNames.add(dexName);
    const { meta, contexts } = extractMeta(metas[dexIndex]);
    if (!Array.isArray(meta.universe)) throw new Error('Hyperliquid malformed universe');
    if (dexIndex > 0 && meta.universe.length > 10000) throw new Error('Hyperliquid oversized HIP-3 namespace');
    // Legacy native metadata omits collateralToken. It represents USDC token 0.
    const collateralIndex = meta.collateralToken === undefined && dexIndex === 0
      ? 0 : integer(meta.collateralToken, 'collateralToken');
    if (!tokens.has(collateralIndex)) throw new Error('Hyperliquid unknown collateralToken');
    const collateral = tokens.get(collateralIndex);
    for (let universeIndex = 0; universeIndex < meta.universe.length; universeIndex += 1) {
      const row = object(meta.universe[universeIndex], 'market');
      const name = text(row.name, 'market name');
      const decimals = integer(row.szDecimals, 'szDecimals', 30);
      if (row.isDelisted !== undefined && typeof row.isDelisted !== 'boolean') throw new Error('Hyperliquid malformed isDelisted');
      if (row.onlyIsolated !== undefined && typeof row.onlyIsolated !== 'boolean') throw new Error('Hyperliquid malformed onlyIsolated');
      if (dexIndex === 0 ? name.includes(':') : !name.startsWith(`${dexName}:`) || name.length <= dexName.length + 1) {
        throw new Error('Hyperliquid dex namespace/metadata mismatch');
      }
      if (seen.has(name)) throw new Error(`Hyperliquid duplicate market: ${name}`);
      seen.add(name);
      const numericId = dexIndex === 0 ? universeIndex : 100000 + dexIndex * 10000 + universeIndex;
      integer(numericId, 'native asset id');
      result.push(market({
        venue: id,
        venue_kind: kind,
        segment: segmentId,
        market_id: name,
        market_type: 'perpetual',
        // HIP-3 {dex}:{coin} is a documented namespace; numeric ticker prefixes stay.
        base_symbol: dexIndex === 0 ? name : name.slice(dexName.length + 1),
        quote_symbol: collateral,
        settle_symbol: collateral,
        native_market_id: String(numericId),
        dex_name: dexName,
        dex_index: dexIndex,
        universe_index: universeIndex,
        symbol_provenance: dexIndex === 0 ? 'NATIVE_NAME' : 'DOCUMENTED_HIP3_NAMESPACE',
        native_status: row.isDelisted === true ? 'isDelisted:true' : 'listed',
        market_status: row.isDelisted === true ? 'INACTIVE' : 'ACTIVE',
        linear: null,
        inverse: null,
        multiplier: null,
        contract_size: null,
        // Price constraints include significant digits and depend on price; no fixed tick inferred.
        price_tick: null,
        quantity_step: decimals === 0 ? '1' : `0.${'0'.repeat(decimals - 1)}1`,
        limits: {
          size_decimals: decimals,
          max_leverage: row.maxLeverage === undefined ? null : String(integer(row.maxLeverage, 'maxLeverage')),
          only_isolated: row.onlyIsolated ?? null,
          quantity_unit: 'NATIVE_BASE_SIZE',
          collateral_token_index: collateralIndex,
        },
        order_api_status: 'AVAILABLE',
        raw: row,
        native_metadata: { dex, collateral_token_index: collateralIndex, margin_tables: meta.marginTables ?? null,
          asset_context: contexts ? contexts[universeIndex] : null },
        source,
      }));
    }
  }
  return result;
}

module.exports = { id, kind, segments, fetchSegment };

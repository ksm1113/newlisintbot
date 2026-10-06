const { market } = require("../model.cjs");

const id = "binance";
const kind = "CEX";
const segments = [
  { id: "spot", market_type: "spot", description: "Binance Spot" },
  { id: "usdm_perpetual", market_type: "perpetual", description: "Binance USDⓈ-M perpetuals" },
  { id: "coinm_perpetual", market_type: "perpetual", description: "Binance COIN-M perpetuals" },
];
const endpoints = {
  spot: "https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT",
  usdm_perpetual: "https://fapi.binance.com/fapi/v1/exchangeInfo",
  coinm_perpetual: "https://dapi.binance.com/dapi/v1/exchangeInfo",
};
// Official common-definition enums. A new vendor type must not turn a
// non-empty upstream response into a falsely complete empty perpetual catalog.
const datedTypes = {
  usdm_perpetual: new Set(['CURRENT_MONTH', 'NEXT_MONTH', 'CURRENT_QUARTER', 'NEXT_QUARTER']),
  coinm_perpetual: new Set(['CURRENT_QUARTER', 'NEXT_QUARTER', 'CURRENT_QUARTER_DELIVERING', 'NEXT_QUARTER_DELIVERING']),
};
const perpetualTypes = new Set(['PERPETUAL', 'PERPETUAL_DELIVERING']);
// USDⓈ-M market-data docs list TRADIFI_PERPETUAL; Binance's TradFi launch
// announcement identifies these as traditional-asset, USDT-settled perpetuals.
// This classification does not establish the identity of any crypto asset.
// https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
const tradfiType = 'TRADIFI_PERPETUAL';

function decimal(value, field) {
  if (value == null || value === "") return null;
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) {
    throw new Error(`Binance invalid ${field}`);
  }
  return String(value);
}

function status(value, spotAllowed) {
  if (spotAllowed === false) return "INACTIVE";
  if (value === "TRADING") return "ACTIVE";
  if (["HALT", "BREAK", "PRE_TRADING", "POST_TRADING", "END_OF_DAY", "PRE_DELIVERING", "DELIVERING", "DELIVERED"].includes(value)) return "INACTIVE";
  return "UNKNOWN";
}

async function fetchSegment(segmentId, { requestJson, signal }) {
  const source = endpoints[segmentId];
  if (!source) throw new Error(`Unsupported Binance segment: ${segmentId}`);
  const body = await requestJson(source, { signal });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Binance invalid exchangeInfo response");
  if (body.code !== undefined && body.code !== 0) throw new Error(`Binance business error: ${body.code}`);
  if (!Array.isArray(body.symbols)) throw new Error("Binance symbols array missing");
  const spot = segmentId === "spot";
  const coinm = segmentId === "coinm_perpetual";
  const seen = new Set();
  const result = [];
  for (const item of body.symbols) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Binance invalid symbol record");
    if (!spot && typeof item.contractType !== "string") throw new Error("Binance contractType missing");
    if (!spot && datedTypes[segmentId].has(item.contractType)) continue;
    const tradfi = segmentId === 'usdm_perpetual' && item.contractType === tradfiType;
    if (!spot && !perpetualTypes.has(item.contractType) && !tradfi) throw new Error(`Binance unsupported contractType: ${item.contractType}`);
    for (const field of ["symbol", "baseAsset", "quoteAsset"]) {
      if (typeof item[field] !== "string" || !item[field].trim()) throw new Error(`Binance ${field} missing`);
    }
    if (seen.has(item.symbol)) throw new Error("Binance duplicate symbol");
    seen.add(item.symbol);
    if (item.filters !== undefined && !Array.isArray(item.filters)) throw new Error("Binance invalid filters");
    const filters = item.filters || [];
    const byType = new Map();
    for (const filter of filters) {
      if (!filter || typeof filter !== "object" || typeof filter.filterType !== "string" || byType.has(filter.filterType)) throw new Error("Binance invalid/duplicate filter");
      byType.set(filter.filterType, filter);
    }
    const price = byType.get("PRICE_FILTER") || {};
    const lot = byType.get("LOT_SIZE") || {};
    const nativeStatus = (coinm ? item.contractStatus : item.status) ?? null;
    if (nativeStatus !== null && typeof nativeStatus !== "string") throw new Error("Binance invalid status");
    if (item.isSpotTradingAllowed !== undefined && typeof item.isSpotTradingAllowed !== "boolean") throw new Error("Binance invalid isSpotTradingAllowed");
    if (!spot && item.underlyingType != null && typeof item.underlyingType !== "string") throw new Error("Binance invalid underlyingType");
    result.push(market({
      venue: id, venue_kind: kind, segment: segmentId,
      market_id: item.symbol, market_type: spot ? "spot" : "perpetual",
      native_contract_type: spot ? null : item.contractType,
      asset_class: tradfi ? 'TRADFI' : null,
      native_underlying_type: spot ? null : (item.underlyingType ?? null),
      base_symbol: item.baseAsset, quote_symbol: item.quoteAsset,
      settle_symbol: spot ? null : (item.marginAsset || null),
      native_status: nativeStatus,
      // A settling perpetual remains identifiable but cannot be unrestricted active.
      market_status: !spot && item.contractType === 'PERPETUAL_DELIVERING' ? 'INACTIVE'
        : spot && nativeStatus === 'TRADING' && item.isSpotTradingAllowed === undefined ? 'UNKNOWN'
        : status(nativeStatus, spot ? item.isSpotTradingAllowed : undefined),
      linear: spot ? null : !coinm, inverse: spot ? null : coinm,
      // A 1000-prefixed symbol is retained verbatim; no contract multiplier is inferred.
      multiplier: null, contract_size: decimal(item.contractSize, "contractSize"),
      price_tick: decimal(price.tickSize, "tickSize"), quantity_step: decimal(lot.stepSize, "stepSize"),
      limits: {
        filters,
        quantity_unit: coinm ? "contracts" : "base_asset",
        contract_size_unit: coinm && item.contractSize != null ? item.quoteAsset : null,
        price_min: decimal(price.minPrice, "minPrice"), price_max: decimal(price.maxPrice, "maxPrice"),
        quantity_min: decimal(lot.minQty, "minQty"), quantity_max: decimal(lot.maxQty, "maxQty"),
      },
      order_api_status: "AVAILABLE", raw: item, source,
    }));
  }
  return result;
}

module.exports = { id, kind, segments, fetchSegment };

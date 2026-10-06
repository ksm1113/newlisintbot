const MARKET_TYPES = new Set(["spot", "perpetual"]);
function market(fields) {
  const value = {
    quote_symbol: null, settle_symbol: null, native_status: null,
    market_status: "UNKNOWN", linear: null, inverse: null,
    multiplier: null, contract_size: null, price_tick: null, quantity_step: null,
    limits: {}, order_api_status: "UNKNOWN", ...fields,
    asset_id: null, identity_status: "UNVERIFIED", trading_allowed: false,
  };
  for (const field of ["venue", "segment", "market_id", "source"]) {
    if (typeof value[field] !== "string" || !value[field]) throw new Error(`Invalid market ${field}.`);
  }
  if (!["CEX", "PERP_DEX"].includes(value.venue_kind) || !MARKET_TYPES.has(value.market_type)) throw new Error("Invalid market kind/type.");
  if (value.base_symbol != null && (typeof value.base_symbol !== "string" || !value.base_symbol)) throw new Error("Invalid market base_symbol.");
  if (!["ACTIVE", "INACTIVE", "UNKNOWN"].includes(value.market_status)) throw new Error("Invalid market status.");
  if (!["AVAILABLE", "UNAVAILABLE", "UNKNOWN"].includes(value.order_api_status)) throw new Error("Invalid order API status.");
  return value;
}

function validateMarkets(markets, adapter, segment) {
  if (!Array.isArray(markets) || markets.length > 20000) throw new Error("Invalid or oversized market list.");
  const ids = new Set();
  return markets.map(input => {
    const item = market(input);
    if (item.venue !== adapter.id || item.venue_kind !== adapter.kind || item.segment !== segment.id || item.market_type !== segment.market_type) {
      throw new Error("Market does not match its catalog segment.");
    }
    if (ids.has(item.market_id)) throw new Error(`Duplicate market ID in ${adapter.id}/${segment.id}.`);
    ids.add(item.market_id);
    return item;
  });
}

module.exports = { market, validateMarkets };

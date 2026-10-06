"use strict";

const { market } = require("../model.cjs");

// Public catalog only. V3 orders require a separate authenticated signer.
const SOURCE = "https://fapi.asterdex.com/fapi/v3/exchangeInfo";
const segments = [{ id: "perpetual", market_type: "perpetual", description: "Aster V3 perpetual contracts" }];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Aster: invalid ${label}`);
  return value;
}
function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Aster: invalid ${label}`);
  return value;
}
function decimal(value, label) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Aster: invalid ${label}`);
  return value;
}

async function fetchSegment(segmentId, { requestJson, signal }) {
  if (segmentId !== "perpetual") throw new Error(`Aster: unsupported segment ${segmentId}`);
  const response = object(await requestJson(SOURCE, { signal }), "response");
  if (response.code != null && ![0, 200].includes(Number(response.code))) throw new Error(`Aster: API error ${response.code}`);
  if (!Array.isArray(response.symbols)) throw new Error("Aster: missing symbols array");
  const ids = new Set();
  const result = [];
  const exclusions = [];
  for (const item of response.symbols) {
    const row = object(item, "symbol");
    // Observed public V3 response: a few not-yet-trading products have an empty
    // contractType. Record this exact exception without declaring them perpetual.
    if (row.contractType === '' && row.status === 'PENDING_TRADING') {
      const id = text(row.symbol, 'symbol ID');
      if (ids.has(id)) throw new Error(`Aster: duplicate symbol ${id}`);
      ids.add(id);
      exclusions.push({
        market_id: id,
        base_symbol: text(row.baseAsset, 'baseAsset'),
        native_contract_type: '',
        native_status: 'PENDING_TRADING',
        reason: 'UNCLASSIFIED_PENDING_CONTRACT',
        source: SOURCE,
      });
      continue;
    }
    const type = text(row.contractType, "contractType");
    // V3's official enum defines only PERPETUAL. Never borrow another venue's
    // dated type names and silently drop new or changed upstream schemas.
    if (type !== "PERPETUAL") throw new Error(`Aster: unsupported contractType ${type}`);
    const id = text(row.symbol, "symbol ID");
    if (ids.has(id)) throw new Error(`Aster: duplicate symbol ${id}`);
    ids.add(id);
    if (!Array.isArray(row.filters)) throw new Error(`Aster: missing filters for ${id}`);
    const filters = new Map();
    for (const filter of row.filters) {
      object(filter, "filter");
      const filterType = text(filter.filterType, "filterType");
      if (filters.has(filterType)) throw new Error(`Aster: duplicate ${filterType} filter for ${id}`);
      filters.set(filterType, filter);
    }
    const price = filters.get("PRICE_FILTER");
    const lot = filters.get("LOT_SIZE");
    const notional = filters.get("MIN_NOTIONAL");
    const nativeStatus = row.status == null ? null : text(row.status, "status");
    const marketStatus = nativeStatus === "TRADING" ? "ACTIVE"
      : ["PENDING_TRADING", "PRE_SETTLE", "SETTLING", "CLOSE"].includes(nativeStatus) ? "INACTIVE" : "UNKNOWN";
    result.push(market({
      venue: "aster", venue_kind: "PERP_DEX", segment: segmentId,
      market_id: id, market_type: "perpetual",
      base_symbol: text(row.baseAsset, "baseAsset"), quote_symbol: text(row.quoteAsset, "quoteAsset"),
      settle_symbol: text(row.marginAsset, "marginAsset"),
      native_status: nativeStatus, market_status: marketStatus,
      linear: response.futuresType === "U_MARGINED" ? true : null,
      inverse: response.futuresType === "U_MARGINED" ? false : null,
      multiplier: null, contract_size: null,
      // Precision metadata is not a substitute for PRICE_FILTER / LOT_SIZE.
      price_tick: decimal(price?.tickSize, "tickSize"), quantity_step: decimal(lot?.stepSize, "stepSize"),
      limits: {
        min_quantity: decimal(lot?.minQty, "minQty"), max_quantity: decimal(lot?.maxQty, "maxQty"),
        min_notional: decimal(notional?.notional, "minNotional"), filters: row.filters,
      },
      order_api_status: "AVAILABLE", raw: row, source: SOURCE,
    }));
  }
  if (result.length === 0 && exclusions.length > 0) {
    throw new Error('Aster: only unclassified pending contracts; perpetual coverage is unknown');
  }
  if (exclusions.length > 0) result.exclusions = exclusions;
  return result;
}

module.exports = { id: "aster", kind: "PERP_DEX", segments, fetchSegment };

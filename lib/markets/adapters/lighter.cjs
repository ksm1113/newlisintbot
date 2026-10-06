"use strict";

const { market } = require("../model.cjs");

const SOURCE = "https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?filter=perp";
const segments = [{ id: "perpetual", market_type: "perpetual", description: "Lighter mainnet perpetual order book details" }];

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Lighter: invalid ${label}`);
  return value;
}
function decimal(value, label) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Lighter: invalid ${label}`);
  return value;
}
function step(decimals, label) {
  if (decimals == null) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) throw new Error(`Lighter: invalid ${label}`);
  return decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
}
function marketId(value) {
  // New markets can use 64-bit IDs. Never accept an already-rounded JSON number.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  throw new Error("Lighter: invalid or unsafe market_id");
}

async function fetchSegment(segmentId, { requestJson, signal }) {
  if (segmentId !== "perpetual") throw new Error(`Lighter: unsupported segment ${segmentId}`);
  const response = await requestJson(SOURCE, { signal });
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Lighter: invalid response");
  if (response.code !== 200) throw new Error(`Lighter: API error ${response.code ?? "missing code"}`);
  if (!Array.isArray(response.order_book_details)) throw new Error("Lighter: missing order_book_details array");
  const ids = new Set();
  return response.order_book_details.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Lighter: invalid order book detail");
    if (row.market_type !== "perp") throw new Error("Lighter: non-perp row in perpetual details");
    const id = marketId(row.market_id);
    if (ids.has(id)) throw new Error(`Lighter: duplicate market_id ${id}`);
    ids.add(id);
    const nativeStatus = row.status == null ? null : text(row.status, "status");
    return market({
      venue: "lighter", venue_kind: "PERP_DEX", segment: segmentId,
      market_id: id, market_type: "perpetual", base_symbol: text(row.symbol, "symbol"),
      // This endpoint supplies asset IDs, not verified quote/collateral symbols.
      quote_symbol: null, settle_symbol: null,
      native_status: nativeStatus,
      market_status: nativeStatus === "active" ? "ACTIVE" : nativeStatus === "inactive" ? "INACTIVE" : "UNKNOWN",
      linear: null, inverse: null, multiplier: decimal(row.multiplier, "multiplier"), contract_size: null,
      price_tick: step(row.supported_price_decimals, "supported_price_decimals"),
      quantity_step: step(row.supported_size_decimals, "supported_size_decimals"),
      limits: {
        min_quantity: decimal(row.min_base_amount, "min_base_amount"),
        min_notional: decimal(row.min_quote_amount, "min_quote_amount"),
        order_quote_limit: decimal(row.order_quote_limit, "order_quote_limit"),
        supported_quote_decimals: row.supported_quote_decimals ?? null,
        quote_multiplier: row.quote_multiplier == null ? null : marketId(row.quote_multiplier),
      },
      order_api_status: "AVAILABLE", raw: row, source: SOURCE,
    });
  });
}

module.exports = { id: "lighter", kind: "PERP_DEX", segments, fetchSegment };

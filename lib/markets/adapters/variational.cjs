"use strict";

const { market } = require("../model.cjs");

const SOURCE = "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats";
const segments = [{ id: "perpetual", market_type: "perpetual", description: "Variational Omni public listing labels; read-only API" }];

async function fetchSegment(segmentId, { requestJson, signal }) {
  if (segmentId !== "perpetual") throw new Error(`Variational: unsupported segment ${segmentId}`);
  const response = await requestJson(SOURCE, { signal });
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Variational: invalid response");
  if (response.error != null || (response.code != null && ![0, 200].includes(Number(response.code)))) throw new Error("Variational: API error");
  if (!Array.isArray(response.listings)) throw new Error("Variational: missing listings array");
  if (response.num_markets != null && (!Number.isSafeInteger(response.num_markets) || response.num_markets !== response.listings.length)) {
    throw new Error("Variational: market count mismatch");
  }
  const labels = new Set();
  return response.listings.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.ticker !== "string" || !row.ticker.trim()) {
      throw new Error("Variational: invalid listing ticker");
    }
    if (labels.has(row.ticker)) throw new Error(`Variational: duplicate ticker label ${row.ticker}`);
    labels.add(row.ticker);
    // The public API gives a ticker label, not an execution product ID or status.
    // Published quotes can be cached for 600 seconds; raw is evidence, not a trade quote.
    return market({
      venue: "variational", venue_kind: "PERP_DEX", segment: segmentId,
      market_id: row.ticker, market_id_kind: "ticker_label", market_type: "perpetual",
      base_symbol: row.ticker, quote_symbol: "USDC", settle_symbol: null,
      native_status: null, market_status: "UNKNOWN", linear: null, inverse: null,
      multiplier: null, contract_size: null, price_tick: null, quantity_step: null,
      limits: {}, order_api_status: "UNAVAILABLE", raw: row, source: SOURCE,
    });
  });
}

module.exports = { id: "variational", kind: "PERP_DEX", segments, fetchSegment };

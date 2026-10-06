const { market } = require("../model.cjs");

const id = "okx";
const kind = "CEX";
const segments = [
  { id: "spot", market_type: "spot", description: "OKX Spot" },
  { id: "swap", market_type: "perpetual", description: "OKX linear/inverse swaps" },
];

function decimal(value, field) {
  if (value == null || value === "") return null;
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) throw new Error(`OKX invalid ${field}`);
  return String(value);
}

function status(value, ruleType) {
  // Official ruleType also distinguishes pre_market/rebase_contract trading.
  // A live restricted or unknown rule is not confirmed as ordinary trading.
  // https://my.okx.com/docs-v5/en/#public-data-rest-api-get-instruments
  if (value === "live") return ruleType == null || ruleType === "normal" ? "ACTIVE" : "UNKNOWN";
  if (["suspend", "rebase", "preopen", "test", "settling"].includes(value)) return "INACTIVE";
  // post_only still permits some orders, but is not unrestricted continuous trading.
  return "UNKNOWN";
}

async function fetchSegment(segmentId, { requestJson, signal }) {
  if (!segments.some((segment) => segment.id === segmentId)) throw new Error(`Unsupported OKX segment: ${segmentId}`);
  const spot = segmentId === "spot";
  const instType = spot ? "SPOT" : "SWAP";
  const source = `https://www.okx.com/api/v5/public/instruments?instType=${instType}`;
  const body = await requestJson(source, { signal });
  if (!body || (body.code !== "0" && body.code !== 0)) throw new Error(`OKX business error: ${body?.code ?? "missing code"}`);
  if (!Array.isArray(body.data)) throw new Error("OKX instruments array missing");
  const seen = new Set();
  return body.data.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.instType !== instType || typeof item.instId !== "string" || !item.instId.trim()) throw new Error("OKX invalid instrument/type");
    if (seen.has(item.instId)) throw new Error("OKX duplicate instrument");
    seen.add(item.instId);
    let base;
    let quote;
    if (spot) {
      base = item.baseCcy;
      quote = item.quoteCcy;
    } else {
      // Derivative baseCcy/quoteCcy are blank. Use the declared underlying/family,
      // not a generic symbol parser or a multiplier-stripped native market ID.
      const family = item.uly || item.instFamily;
      if (typeof family !== "string" || !/^[^-]+-[^-]+$/.test(family)) throw new Error("OKX swap underlying/family missing or ambiguous");
      [base, quote] = family.split("-");
      if (item.uly && item.instFamily && item.uly !== item.instFamily) throw new Error("OKX underlying/family mismatch");
    }
    if (typeof base !== "string" || !base.trim() || typeof quote !== "string" || !quote.trim()) throw new Error("OKX base/quote currency missing");
    if (item.state !== undefined && typeof item.state !== "string") throw new Error("OKX invalid instrument state");
    if (item.ruleType != null && typeof item.ruleType !== "string") throw new Error("OKX invalid instrument ruleType");
    const linear = spot ? null : (item.ctType === "linear" ? true : item.ctType === "inverse" ? false : null);
    return market({
      venue: id, venue_kind: kind, segment: segmentId,
      market_id: item.instId, market_type: spot ? "spot" : "perpetual",
      base_symbol: base, quote_symbol: quote, settle_symbol: spot ? null : (item.settleCcy || null),
      native_status: item.state ?? null, market_status: status(item.state, item.ruleType),
      linear, inverse: linear === null ? null : !linear,
      multiplier: decimal(item.ctMult, "ctMult"), contract_size: decimal(item.ctVal, "ctVal"),
      price_tick: decimal(item.tickSz, "tickSz"), quantity_step: decimal(item.lotSz, "lotSz"),
      limits: {
        quantity_unit: spot ? "base_asset" : "contracts", contract_size_unit: item.ctValCcy || null,
        minSz: decimal(item.minSz, "minSz"), maxLmtSz: decimal(item.maxLmtSz, "maxLmtSz"),
        maxMktSz: decimal(item.maxMktSz, "maxMktSz"), maxMktSz_unit: spot ? "USDT" : "contracts",
        maxLmtAmt: decimal(item.maxLmtAmt, "maxLmtAmt"), maxMktAmt: decimal(item.maxMktAmt, "maxMktAmt"),
        underlying: item.uly || null, instrument_family: item.instFamily || null,
        ruleType: item.ruleType ?? null, openType: item.openType || null,
      },
      order_api_status: "AVAILABLE", raw: item, source,
    });
  });
}

module.exports = { id, kind, segments, fetchSegment };

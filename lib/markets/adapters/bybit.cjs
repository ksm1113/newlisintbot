const { market } = require("../model.cjs");

const id = "bybit";
const kind = "CEX";
const segments = [
  { id: "spot", market_type: "spot", description: "Bybit Spot" },
  { id: "linear_perpetual", market_type: "perpetual", description: "Bybit USDT/USDC perpetuals" },
  { id: "inverse_perpetual", market_type: "perpetual", description: "Bybit inverse perpetuals" },
];
const categories = { spot: "spot", linear_perpetual: "linear", inverse_perpetual: "inverse" };
const MAX_PAGES = 100;

function decimal(value, field) {
  if (value == null || value === "") return null;
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) throw new Error(`Bybit invalid ${field}`);
  return String(value);
}

function object(value, field) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Bybit invalid ${field}`);
  return value;
}

function status(item) {
  if (item.isPreListing === true) return "UNKNOWN";
  if (item.status === "Trading") return "ACTIVE";
  if (["PreLaunch", "PendingOpen", "Settling", "Delivering", "Closed"].includes(item.status)) return "INACTIVE";
  return "UNKNOWN";
}

async function fetchSegment(segmentId, { requestJson, signal }) {
  const category = categories[segmentId];
  if (!category) throw new Error(`Unsupported Bybit segment: ${segmentId}`);
  const spot = category === "spot";
  const rows = [];
  const symbols = new Set();
  const cursors = new Set();
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://api.bybit.com/v5/market/instruments-info");
    url.searchParams.set("category", category);
    if (!spot) url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const source = url.href;
    const body = await requestJson(source, { signal });
    if (!body || (body.retCode !== 0 && body.retCode !== "0")) throw new Error(`Bybit business error: ${body?.retCode ?? "missing retCode"}`);
    const result = body.result;
    if (!result || result.category !== category || !Array.isArray(result.list)) throw new Error("Bybit invalid instruments response/category");
    for (const item of result.list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Bybit invalid instrument record");
      if (!spot && typeof item.contractType !== "string") throw new Error("Bybit contractType missing");
      if (!spot) {
        // Only the category's documented dated futures are outside this scope.
        const datedType = category === 'linear' ? 'LinearFutures' : 'InverseFutures';
        const perpetualType = category === 'linear' ? 'LinearPerpetual' : 'InversePerpetual';
        if (item.contractType === datedType) continue;
        if (item.contractType !== perpetualType) throw new Error(`Bybit unsupported/category-mismatched contractType: ${item.contractType}`);
      }
      for (const field of ["symbol", "baseCoin", "quoteCoin"]) {
        if (typeof item[field] !== "string" || !item[field].trim()) throw new Error(`Bybit ${field} missing`);
      }
      if (symbols.has(item.symbol)) throw new Error("Bybit duplicate instrument across pages");
      symbols.add(item.symbol);
      if (item.status !== undefined && typeof item.status !== "string") throw new Error("Bybit invalid status");
      if (item.isPreListing !== undefined && typeof item.isPreListing !== "boolean") throw new Error("Bybit invalid isPreListing");
      const price = object(item.priceFilter, "priceFilter");
      const lot = object(item.lotSizeFilter, "lotSizeFilter");
      rows.push(market({
        venue: id, venue_kind: kind, segment: segmentId,
        market_id: item.symbol, market_type: spot ? "spot" : "perpetual",
        base_symbol: item.baseCoin, quote_symbol: item.quoteCoin, settle_symbol: spot ? null : (item.settleCoin || null),
        native_status: item.status ?? null, market_status: status(item),
        linear: spot ? null : category === "linear", inverse: spot ? null : category === "inverse",
        multiplier: item.symbolType === "xstocks" ? decimal(item.xstockMultiplier, "xstockMultiplier") : null,
        contract_size: null,
        price_tick: decimal(price.tickSize, "tickSize"),
        quantity_step: decimal(spot ? lot.basePrecision : lot.qtyStep, "quantity step"),
        limits: {
          priceFilter: price, lotSizeFilter: lot, leverageFilter: item.leverageFilter ?? null,
          quantity_unit: spot || category === "linear" ? "base_asset" : "USD",
          multiplier_unit: item.symbolType === "xstocks" ? "stock_quantity_per_token" : null,
          isPreListing: item.isPreListing ?? null,
        },
        order_api_status: "AVAILABLE", raw: item, source,
      }));
    }
    const next = result.nextPageCursor;
    if (spot) {
      if (next != null && next !== "") throw new Error("Bybit spot unexpectedly requires pagination");
      return rows;
    }
    if (typeof next !== "string" || next.length > 8192) throw new Error("Bybit nextPageCursor missing/invalid");
    if (!next) return rows;
    if (cursors.has(next)) throw new Error("Bybit repeated pagination cursor");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("Bybit pagination exceeds maximum page count");
}

module.exports = { id, kind, segments, fetchSegment };

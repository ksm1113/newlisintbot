function symbolKey(symbol) { return typeof symbol === "string" && symbol.trim() ? symbol.trim().toUpperCase() : null; }
const ALLOWED_QUOTES = new Set(["USDT", "USDC"]);

function buildResult(event, catalog) {
  const views = catalog.views();
  const coverage = views.map(({ markets, ...view }) => ({ ...view, market_count: markets.length }));
  const fresh = coverage.every(item => item.status === "FRESH");
  const assets = event.assets.map(asset => {
    const symbol = typeof asset?.symbol === "string" ? asset.symbol : null;
    const key = symbolKey(symbol);
    const unclassified = key ? views.flatMap(view => (view.exclusions || []).filter(item => symbolKey(item.base_symbol) === key)
      .map(item => ({ ...item, venue: view.venue, segment: view.segment, catalog_status: view.status }))) : [];
    const candidates = [];
    if (key) {
      for (const view of views) {
        for (const market of view.markets) {
          if (symbolKey(market.base_symbol) !== key) continue;
          if (!ALLOWED_QUOTES.has(symbolKey(market.quote_symbol))) continue;
          if (market.market_status !== "ACTIVE") continue;
          if (market.market_type === "spot" && market.limits?.buy_enabled === false) continue;
          // Also enforce retained restriction metadata in catalogs saved before this policy.
          if (market.venue === "okx" && market.limits?.ruleType != null && market.limits.ruleType !== "normal") continue;
          if (market.market_type !== view.market_type || market.segment !== view.segment || market.venue !== view.venue) continue;
          const { raw, ...fields } = market;
          candidates.push({ ...fields, match_basis: "NATIVE_BASE_LABEL_CASE_INSENSITIVE", catalog_status: view.status,
            fetched_at: view.fetched_at, valid_until: view.valid_until,
            identity_status: "UNVERIFIED", asset_id: null, trading_allowed: false });
        }
      }
    }
    return { symbol, contracts: Array.isArray(asset?.contracts) ? asset.contracts : [],
      identity_status: "UNVERIFIED", status: !key ? "SYMBOL_REQUIRED" : unclassified.length ? "UNCLASSIFIED_CATALOG_ENTRY" : candidates.length ? "CANDIDATES_FOUND" : fresh ? "NO_CANDIDATE_IN_SCOPE" : "INCOMPLETE_COVERAGE", candidates, unclassified };
  });
  const hasSymbols = assets.some(asset => symbolKey(asset.symbol));
  const missingSymbols = !assets.length || assets.some(asset => !symbolKey(asset.symbol));
  const candidateCount = assets.reduce((sum, asset) => sum + asset.candidates.length, 0);
  const hasUnclassified = assets.some(asset => asset.unclassified.length);
  return {
    schema_version: 1, event_id: event.event_id, prepared_at: new Date().toISOString(),
    scope: "SELECTED_CEX_SPOT_PERPETUAL_AND_PERP_DEX_CATALOGS",
    quote_filter: [...ALLOWED_QUOTES],
    market_status_filter: "ACTIVE",
    status: !hasSymbols ? "SYMBOL_REQUIRED" : !fresh || hasUnclassified ? "CATALOG_PARTIAL" : missingSymbols ? "SYMBOL_REQUIRED" : candidateCount ? "CATALOG_CANDIDATES_READY" : "CATALOG_SEARCH_EMPTY",
    source_url: event.source_url || null, listing_exchange: event.exchange || null,
    listing_market_type: event.market_type || null, coverage, assets, candidate_count: candidateCount,
    identity_status: "UNVERIFIED", trading_allowed: false,
    dex_spot: { status: "NOT_QUERIED" }, deposit_network: { status: "NOT_QUERIED" },
  };
}

module.exports = { buildResult, symbolKey };

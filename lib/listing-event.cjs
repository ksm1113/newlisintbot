const { createHash } = require("node:crypto");

function normalizeUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch { return value; }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function normalizeListing(message, receivedAt = new Date().toISOString()) {
  if (!message || !["announcement", "tweet"].includes(message.type) ||
      message.parser?.classification?.event !== "listing") return null;
  const parser = message.parser;
  const classification = parser.classification;
  const assets = (Array.isArray(parser.assets) ? parser.assets : []).map(asset => ({
    symbol: typeof asset?.symbol === "string" ? asset.symbol : null,
    name: typeof asset?.name === "string" ? asset.name : null,
    contracts: (Array.isArray(asset?.contracts) ? asset.contracts : []).filter(contract =>
      typeof contract?.chain === "string" && typeof contract?.contract === "string"
    ).map(contract => ({ chain: contract.chain, contract: contract.contract })),
  }));
  const sourceUrl = normalizeUrl(message.url);
  const key = {
    source_type: message.type,
    source_url: sourceUrl,
    username: message.username || null,
    exchange: parser.exchange || null,
    event: classification.event,
    market_type: classification.type || null,
    category: classification.category || null,
    quote_markets: Array.isArray(classification.markets) ? [...classification.markets].sort() : [],
    symbols: assets.map(asset => asset.symbol).sort(),
    content: message.content || null,
  };
  // Feed IDs are local to an endpoint/edge. They are only a fallback without source identity.
  if (!sourceUrl && !message.content) {
    key.fallback = { source_id: message.id ?? null, detected_time_us: message.detected_time_us ?? null };
  }
  const eventId = createHash("sha256").update(JSON.stringify(stableValue(key))).digest("hex");
  return {
    schema_version: 1,
    event_id: eventId,
    received_at: receivedAt,
    source_id: message.id ?? null,
    source_type: message.type,
    source_url: sourceUrl,
    exchange: parser.exchange || null,
    event: "listing",
    market_type: classification.type || null,
    category: classification.category || null,
    quote_markets: key.quote_markets,
    detected_time_us: message.detected_time_us ?? null,
    sent_time_us: message.sent_time_us ?? null,
    assets,
    raw: message,
  };
}

function pendingLookup(event) {
  return {
    schema_version: 1,
    event_id: event.event_id,
    prepared_at: new Date().toISOString(),
    status: "LOOKUP_PENDING",
    exchange: event.exchange,
    market_type: event.market_type,
    source_url: event.source_url,
    assets: event.assets,
    identity_status: "UNVERIFIED",
    cex: { status: "NOT_QUERIED" },
    dex: { status: "NOT_QUERIED" },
    deposit_network: { status: "NOT_QUERIED" },
    trading_allowed: false,
  };
}

module.exports = { normalizeListing, pendingLookup };

const ids = ["binance", "bybit", "okx", "bitget", "gate", "hyperliquid", "aster", "variational", "lighter"];
function adaptersFor(selected = ids) {
  if (!Array.isArray(selected) || !selected.length || selected.some(id => !ids.includes(id)) || new Set(selected).size !== selected.length) throw new Error("Invalid selected market venues.");
  return selected.map(id => require(`./adapters/${id}.cjs`));
}
module.exports = { adaptersFor, VENUE_IDS: ids };

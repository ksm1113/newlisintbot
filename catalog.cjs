const path = require("node:path");
const { Catalog } = require("./lib/markets/catalog.cjs");

async function main(args = process.argv.slice(2)) {
  if (args.some(argument => argument !== "--once") || new Set(args).size !== args.length) throw new Error("Usage: node catalog.cjs [--once]");
  const catalog = await Catalog.open();
  const log = summary => {
    console.log(`[시장 목록] 정상 ${summary.fresh_segments}/${summary.total_segments}개 상품군`);
    for (const item of summary.segments) console.log(`${item.venue}/${item.segment}: ${item.status} / ${item.market_count}개${item.error ? ` / ${item.error.message}` : ""}`);
    console.log(`[시장 목록] 캐시: ${path.join(catalog.root, "data", "catalogs")}`);
  };
  if (args.includes("--once")) {
    try {
      const summary = await catalog.refresh(); log(summary);
      if (summary.fresh_segments !== summary.total_segments) process.exitCode = 1;
    } finally { await catalog.close(); }
    return;
  }
  let closing;
  const close = error => closing ||= (async () => {
    if (error) { console.error(`[시장 목록] ${error.message}`); process.exitCode = 1; }
    try { await catalog.close(); }
    catch (closeError) { console.error(`[시장 목록] 종료 오류: ${closeError.message}`); process.exitCode = 1; }
  })();
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  catalog.subscribe(view => console.log(`[시장 목록] ${view.venue}/${view.segment}: ${view.status} / ${view.markets.length}개`));
  catalog.start({ onError: error => { void close(error); } });
}

if (require.main === module) main().catch(error => { console.error(`[시장 목록] ${error.message}`); process.exitCode = 1; });
module.exports = { main };

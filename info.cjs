const path = require("node:path");
const { InfoConsumer } = require("./lib/info-consumer.cjs");
const { Catalog } = require("./lib/markets/catalog.cjs");
const { LookupWorker } = require("./lib/markets/lookup-worker.cjs");
const { NetworkCatalog } = require('./lib/networks/catalog.cjs');
const { EnrichmentWorker } = require('./lib/networks/enrichment-worker.cjs');

async function main({ root = __dirname, args = process.argv.slice(2), config, adapters, requestJson, logger = console, installSignalHandlers = true,
  enableEnrichment = true, networkAdapters, networkRequestJson, networkCredentials, identityRequester, resolveIdentity } = {}) {
  const allowed = ["--once", "--lookup-once", "--retry-failed"];
  if (args.some(argument => !allowed.includes(argument)) || new Set(args).size !== args.length ||
      (args.includes("--once") && args.length !== 1) || (args.includes("--retry-failed") && !args.includes("--lookup-once"))) {
    throw new Error("Usage: node info.cjs [--once | --lookup-once [--retry-failed]]");
  }
  let consumer, catalog, worker, networks, enrichment, closing;
  const onePass = args.includes("--lookup-once");
  const shutdown = error => closing ||= (async () => {
    if (error) { logger.error(`[정보부] 중단: ${error.message}`); process.exitCode = 1; }
    const outcomes = await Promise.allSettled([consumer?.close(), worker?.close(), catalog?.close(),networks?.close(),enrichment?.close()]);
    for (const outcome of outcomes) if (outcome.status === "rejected") {
      logger.error(`[정보부] 종료 오류: ${outcome.reason.message}`); process.exitCode = 1;
    }
  })();
  try {
    if (!args.includes("--once")) {
      catalog = await Catalog.open({ root, config, adapters, requestJson });
      if(enableEnrichment) {
        networks = await NetworkCatalog.open({root,adapters:networkAdapters,requestJson:networkRequestJson,credentials:networkCredentials});
        enrichment = await EnrichmentWorker.open({root,networkCatalog:networks,identityRequester,resolveIdentity,onResult:result=>{
          logger.log(`[검증] ${result.status} / 현물 경로 필터 통과 ${result.eligible_spot_count}개 / 거래 허가 전`);
        }});
      }
      worker = await LookupWorker.open({ root, catalog, onResult: result => {
        const symbols = result.assets.map(asset => asset.symbol || "?").join(", ") || "unknown";
        logger.log(`[정보부] ${symbols}: ${result.status} / 시장 후보 ${result.candidate_count}개 / 동일 코인 미검증`);
      } });
    }
    consumer = await InfoConsumer.open({ root, onRecord: event => {
      logger.log(`[정보부] 접수: ${event.exchange || "?"} / ${event.assets.map(asset => asset.symbol || "?").join(", ") || "unknown"}`);
      if (!onePass) worker?.wake();
    } });
    if (args.includes("--once")) {
      await consumer.drain();
      logger.log("[정보부] 오프라인 접수 완료. 시장 목록 API는 호출하지 않았습니다.");
      await shutdown(); return;
    }
    if (onePass) {
      await consumer.drain();
      const networkRefresh = networks?.refresh().then(value=>({value}),error=>({error}));
      const summary = await catalog.refresh();
      logger.log(`[정보부] 상품군 정상 ${summary.fresh_segments}/${summary.total_segments}`);
      for (const item of summary.segments) if (item.error) logger.error(`[정보부] ${item.venue}/${item.segment}: ${item.error.message}`);
      await worker.drain({ retryFailed: args.includes("--retry-failed") });
      await enrichment?.drain();
      const networkOutcome = await networkRefresh;
      if(networkOutcome?.error)throw networkOutcome.error;
      await enrichment?.resolveQueued();
      await enrichment?.drain();
      if (summary.fresh_segments !== summary.total_segments) process.exitCode = 1;
      await shutdown(); return;
    }
    if (installSignalHandlers) {
      process.once("SIGINT", () => { void shutdown(); });
      process.once("SIGTERM", () => { void shutdown(); });
    }
    catalog.subscribe(view => logger.log(`[목록] ${view.venue}/${view.segment}: ${view.status} / ${view.markets.length}개`));
    catalog.start({ onError: error => { void shutdown(error); } });
    networks?.start({onError:error=>{void shutdown(error);}});
    enrichment?.start({onError:error=>{void shutdown(error);}});
    worker.start({ onError: error => { void shutdown(error); } });
    consumer.start({ onError: error => { void shutdown(error); } });
    logger.log(`[정보부] ${catalog.adapters.length}곳 상품 목록 갱신·시장 후보 조회 시작. 결과: ${path.join(root, "data", "market-results")}`);
    return { shutdown, consumer, catalog, worker, networks, enrichment };
  } catch (error) { await shutdown(); throw error; }
}

if (require.main === module) {
  try {process.loadEnvFile(path.join(__dirname,'.env'));}catch(error){if(error.code !== 'ENOENT')throw new Error('Cannot load information worker environment.');}
  main().catch(error => { console.error(`[정보부] 시작 실패: ${error.message}`); process.exitCode = 1; });
}
module.exports = { main };

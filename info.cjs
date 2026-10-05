const { InfoConsumer } = require("./lib/info-consumer.cjs");

async function main() {
  if (process.argv.slice(2).some(argument => argument !== "--once")) throw new Error("Usage: node info.cjs [--once]");
  const consumer = await InfoConsumer.open({
    onRecord: event => {
      const symbols = event.assets.map(asset => asset.symbol || "?").join(", ") || "unknown";
      console.log(`[정보부] ${event.exchange || "?"} / ${event.market_type || "?"} / ${symbols} → 조회 대기`);
    },
  });
  if (process.argv.includes("--once")) {
    try { await consumer.drain(); }
    finally { await consumer.close(); }
    console.log("[정보부] 현재까지의 신규 기록 처리 완료. 실제 CEX·DEX 조회는 아직 연결되지 않았습니다.");
    return;
  }
  let shutdownPromise;
  function shutdown(error) {
    if (shutdownPromise) return shutdownPromise;
    if (error) {
      console.error(`[정보부] 중단: ${error.message}`);
      process.exitCode = 1;
    }
    shutdownPromise = consumer.close().catch(closeError => {
      console.error(`[정보부] 종료 오류: ${closeError.message}`);
      process.exitCode = 1;
    });
    return shutdownPromise;
  }
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  consumer.start({ onError: error => { void shutdown(error); } });
  console.log("[정보부] 신규 기록 감지 시작. CEX·DEX 조회는 현재 조회 대기 상태로 기록합니다.");
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[정보부] 시작 실패: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };

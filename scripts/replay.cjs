const { runReplay } = require("../lib/replay.cjs");

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: node scripts/replay.cjs [--file <feed.jsonl>]");
    console.log("기본값은 합성 메시지. --file은 피드 JSONL 또는 raw가 포함된 listings.jsonl.");
    return;
  }
  let file;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--file" || !args[1] || args[1].startsWith("--")) {
      throw new Error("Usage: node scripts/replay.cjs [--file <feed.jsonl>]");
    }
    file = args[1];
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const { report, reportPath } = await runReplay({ file, signal: controller.signal });
    const counts = report.counts;
    const labels = { SYNTHETIC: "합성 테스트 데이터", DOCUMENTATION_EXAMPLE: "공식 문서 예시 (직접 수신 원본 아님)", USER_PROVIDED_UNVERIFIED: "사용자 제공 데이터 (원본 여부 미검증)" };
    console.log(`[재생] 통과 / ${labels[report.source.kind]}`);
    console.log(`입력 ${counts.input_messages}개 · 상장 ${counts.input_listing_messages}개 · 고유 ${counts.unique_listing_events}개 · 접수 ${counts.pending_result_records}개`);
    console.log(`로컬 전달 p50 ${report.local_latency.p50_ms} ms / 최대 ${report.local_latency.max_ms} ms (외부 피드 지연 제외)`);
    console.log(`보고서: ${reportPath}`);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[재생] 실패: ${error.message}`);
    if (error.reportPath) console.error(`보고서: ${error.reportPath}`);
    process.exitCode = 1;
  });
}

module.exports = { main };

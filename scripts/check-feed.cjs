const { checkFeed } = require("../lib/feed-check.cjs");

async function main() {
  if (process.argv.length > 2) throw new Error("Usage: node --env-file=.env scripts/check-feed.cjs");
  const report = await checkFeed();
  console.log(`[연결 검사] ${report.status} / READY=${report.ready_received} / 메시지=${report.messages_received} / 상장=${report.listing_messages}`);
  if (report.failure) console.error(`[연결 검사] ${report.failure}`);
  if (report.root) console.log(`[연결 검사] 결과: ${report.root}`);
  if (report.status !== "PASSED") process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.error(`[연결 검사] ${error.message}`);
  process.exitCode = 1;
});

module.exports = { main };

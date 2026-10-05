const WebSocket = require("ws");
const { pathsFor, ensureDirectories } = require("./lib/paths.cjs");
const { acquireLock } = require("./lib/lock.cjs");
const { JsonlWriter } = require("./lib/jsonl.cjs");
const { normalizeListing } = require("./lib/listing-event.cjs");

async function main({ root, key = process.env.NLF_KEY, WebSocketImpl = WebSocket, installSignalHandlers = true } = {}) {
  if (!key) throw new Error("Set NLF_KEY before starting the client.");
  const paths = pathsFor(root);
  await ensureDirectories(paths);
  const releaseLock = await acquireLock(paths.watcherLock);
  let writer;
  try { writer = await JsonlWriter.open(paths.listings); }
  catch (error) { await releaseLock(); throw error; }

  const url = "wss://ws.newlistings.pro/v2/full";
  let retryMs = 1000;
  let reconnectTimer;
  let socket;
  let stopping = false;
  let shutdownPromise;

  function shutdown(error) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    clearTimeout(reconnectTimer);
    if (error) {
      console.error(`[감시부] 중단: ${error.message}`);
      process.exitCode = 1;
    }
    socket?.terminate();
    shutdownPromise = (async () => {
      try { await writer.close(); }
      finally { await releaseLock(); }
    })().catch(closeError => {
      console.error(`[감시부] 종료 오류: ${closeError.message}`);
      process.exitCode = 1;
    });
    return shutdownPromise;
  }

  function connect() {
    if (stopping) return;
    let stop = false;
    let minimumWaitMs = 0;
    const ws = new WebSocketImpl(url, {
      headers: { authorization: `Bearer ${key}` },
      handshakeTimeout: 10000,
    });
    socket = ws;
    ws.on("message", data => {
      if (stopping) return;
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { void shutdown(new Error("Invalid JSON response.")); return; }
      console.log(JSON.stringify(message, null, 2));
      if (message?.type === "success" && message.code === "READY") {
        retryMs = 1000;
      } else if (message?.type === "error") {
        stop = message.code !== "SERVER_UNAVAILABLE";
        ws.close();
      }
      const event = normalizeListing(message);
      if (event) {
        writer.append(event).then(() => {
          console.log(`[감시부] 상장 소식 저장: ${event.exchange || "?"} / ${event.assets.map(asset => asset.symbol || "?").join(", ") || "unknown"}`);
        }).catch(error => { void shutdown(error); });
      }
    });

    ws.on("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      console.error("Connection rejected: HTTP", status);
      stop = status < 500 && status !== 408 && status !== 429;
      const retryAfter = response.headers["retry-after"] || "";
      minimumWaitMs = /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
      response.resume();
      ws.terminate();
    });
    ws.on("error", error => console.error(error.message));
    ws.on("close", code => {
      if (stopping) return;
      if (stop || code === 1008) {
        void shutdown(new Error("Check your key, request, and connection limits."));
        return;
      }
      const waitMs = Math.max(retryMs, minimumWaitMs) + Math.random() * 250;
      console.log(`Disconnected. Reconnecting in ${Math.ceil(waitMs)} ms...`);
      retryMs = Math.min(retryMs * 2, 30000);
      reconnectTimer = setTimeout(connect, waitMs);
    });
  }

  if (installSignalHandlers) {
    process.once("SIGINT", () => { void shutdown(); });
    process.once("SIGTERM", () => { void shutdown(); });
  }
  console.log(`[감시부] 신규상장 저장 파일: ${paths.listings}`);
  try { connect(); }
  catch (error) { await shutdown(error); }
  return { shutdown, flush: () => writer.tail, paths };
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[감시부] 시작 실패: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };

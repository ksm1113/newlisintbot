const WebSocket = require("ws");

const key = process.env.NLF_KEY;
if (!key) throw new Error("Set NLF_KEY before starting the client.");
const url = "wss://ws.newlistings.pro/v2/full";
let retryMs = 1000;

function connect() {
  let stop = false;
  let minimumWaitMs = 0;
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${key}` },
    handshakeTimeout: 10000,
  });

  ws.on("message", (data) => {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch {
      console.error("Invalid JSON response. Stopping.");
      stop = true;
      return ws.close();
    }
    console.log(JSON.stringify(message, null, 2));
    if (message?.type === "success" && message.code === "READY") {
      retryMs = 1000;
    } else if (message?.type === "error") {
      stop = message.code !== "SERVER_UNAVAILABLE";
      ws.close();
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

  ws.on("error", (error) => console.error(error.message));
  ws.on("close", (code) => {
    if (stop || code === 1008) {
      console.error("Stopped. Check your key, request, and connection limits.");
      return;
    }
    const waitMs = Math.max(retryMs, minimumWaitMs) + Math.random() * 250;
    console.log(`Disconnected. Reconnecting in ${Math.ceil(waitMs)} ms...`);
    retryMs = Math.min(retryMs * 2, 30000);
    setTimeout(connect, waitMs);
  });
}

connect();

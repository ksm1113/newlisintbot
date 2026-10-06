const { setTimeout: delay } = require("node:timers/promises");

function createRequester({ timeoutMs = 10000, fetchImpl = fetch, maxBytes = 32 * 1024 * 1024, minIntervalMs = 200, allowHeaders = false } = {}) {
  const queues = new Map();
  const lastStarts = new Map();
  const blockedUntil = new Map();
  return async function requestJson(url, { method = "GET", body, signal, headers } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !["GET", "POST"].includes(method)) throw new Error("Invalid public market API request.");
    const host = parsed.host;
    const previous = queues.get(host) || Promise.resolve();
    let release;
    const turn = new Promise(resolve => { release = resolve; });
    queues.set(host, previous.catch(() => {}).then(() => turn));
    await previous.catch(() => {});
    try {
      const remaining = (blockedUntil.get(host) || 0) - Date.now();
      if (remaining > 0) {
        const error = new Error(`Market API cooldown (${host}).`);
        error.code = "HOST_COOLDOWN"; error.retryAfterMs = remaining;
        throw error;
      }
      const spacing = Math.max(0, (lastStarts.get(host) || 0) + minIntervalMs - Date.now());
      if (spacing) await delay(spacing, undefined, { signal });
      if (signal?.aborted) throw new Error("Market request cancelled.");
      lastStarts.set(host, Date.now());
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method, headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(allowHeaders ? headers : {}) },
          body: body === undefined ? undefined : JSON.stringify(body), signal: combined, redirect: "error",
        });
      } catch (cause) {
        const error = new Error(`Market request failed (${host}): ${cause.cause?.code || cause.code || cause.name || "NETWORK_ERROR"}`);
        error.code = cause.cause?.code || cause.code || cause.name || "NETWORK_ERROR";
        throw error;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const error = new Error(`Market API HTTP ${response.status} (${host}).`);
        error.code = `HTTP_${response.status}`;
        const retry = response.headers.get("retry-after");
        error.retryAfterMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : null;
        if ([429, 418].includes(response.status)) {
          if (!Number.isFinite(error.retryAfterMs) || error.retryAfterMs < 1) error.retryAfterMs = response.status === 418 ? 60000 : 30000;
          blockedUntil.set(host, Date.now() + error.retryAfterMs);
        }
        throw error;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`Empty market response (${host}).`);
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) throw new Error(`Market response exceeds ${maxBytes} bytes.`);
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
      catch { throw new Error(`Invalid market JSON (${host}).`); }
    } finally { release(); }
  };
}

module.exports = { createRequester };

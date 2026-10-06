const fs = require("node:fs/promises");
const path = require("node:path");
const { acquireLock } = require("../lock.cjs");
const { writeJsonAtomic } = require("../jsonl.cjs");
const { adaptersFor } = require("./registry.cjs");
const { createRequester } = require("./http.cjs");
const { validateMarkets } = require("./model.cjs");
const DEFAULT_CONFIG = require("../../config/markets.json");

function validConfig(config) {
  for (const key of ["refresh_interval_ms", "cache_ttl_ms", "request_timeout_ms", "segment_timeout_ms", "lookup_retry_ms"]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid market config ${key}.`);
  }
  if (!Number.isSafeInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 9 ||
      !Number.isSafeInteger(config.lookup_max_attempts) || config.lookup_max_attempts < 1 || config.lookup_max_attempts > 100) throw new Error("Invalid market config concurrency/retries.");
  return config;
}

function exclusionsFor(items = []) {
  if (!Array.isArray(items) || items.length > 20000) throw new Error("Invalid catalog exclusions.");
  const ids = new Set();
  return items.map(item => {
    if (!item || ["market_id", "base_symbol", "native_status", "reason", "source"].some(key => typeof item[key] !== "string" || !item[key].trim()) ||
        typeof item.native_contract_type !== "string" || ids.has(item.market_id)) throw new Error("Invalid catalog exclusion item.");
    ids.add(item.market_id);
    return { market_id: item.market_id, base_symbol: item.base_symbol, native_contract_type: item.native_contract_type,
      native_status: item.native_status, reason: item.reason, source: item.source };
  });
}

class Catalog {
  static async open({ root = path.resolve(__dirname, "../.."), config = DEFAULT_CONFIG, adapters, requestJson, now = () => Date.now() } = {}) {
    const catalog = new Catalog(root, validConfig({ ...DEFAULT_CONFIG, ...config }), adapters, requestJson, now);
    await fs.mkdir(catalog.directory, { recursive: true });
    await fs.mkdir(path.join(root, "state"), { recursive: true });
    catalog.releaseLock = await acquireLock(path.join(root, "state", "catalog.lock"));
    try {
      try {
        const summary = JSON.parse(await fs.readFile(path.join(catalog.directory, "status.json"), "utf8"));
        if (summary.schema_version !== 1 || !Array.isArray(summary.segments)) throw new Error("Invalid catalog status file.");
        for (const task of catalog.tasks) {
          const entry = summary.segments.find(item => item.venue === task.adapter.id && item.segment === task.segment.id);
          if (entry?.error) {
            if (!Number.isFinite(Date.parse(entry.error.at))) throw new Error("Invalid catalog retry state.");
            catalog.failures.set(task.key, entry.error);
          }
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      for (const task of catalog.tasks) {
        const file = catalog.file(task);
        const stat = await fs.stat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (!stat) continue;
        if (stat.size > 64 * 1024 * 1024) throw new Error(`Oversized catalog: ${task.key}`);
        const stored = JSON.parse(await fs.readFile(file, "utf8"));
        if (stored.schema_version !== 1 || stored.venue !== task.adapter.id || stored.segment !== task.segment.id ||
            !Number.isFinite(Date.parse(stored.last_success_at)) || !Number.isFinite(Date.parse(stored.valid_until))) throw new Error(`Invalid catalog: ${task.key}`);
        stored.markets = validateMarkets(stored.markets, task.adapter, task.segment);
        stored.exclusions = exclusionsFor(stored.exclusions);
        catalog.snapshots.set(task.key, stored);
      }
      return catalog;
    } catch (error) { await catalog.close(); throw error; }
  }

  constructor(root, config, adapters, requestJson, now) {
    this.root = root; this.config = config; this.now = now;
    this.adapters = adapters || adaptersFor(config.venues);
    this.directory = path.join(root, "data", "catalogs");
    this.requestJson = requestJson || createRequester({ timeoutMs: config.request_timeout_ms });
    this.tasks = this.adapters.flatMap(adapter => adapter.segments.map(segment => ({ adapter, segment, key: `${adapter.id}/${segment.id}` })));
    if (!this.tasks.length || this.tasks.some(task => !/^[a-z0-9_-]+$/.test(task.adapter.id) || !/^[a-z0-9_-]+$/.test(task.segment.id)) || new Set(this.tasks.map(task => task.key)).size !== this.tasks.length) throw new Error("Invalid catalog registry.");
    this.snapshots = new Map(); this.failures = new Map(); this.listeners = new Set();
    this.controller = new AbortController(); this.closed = false; this.active = null;
  }

  file(task) { return path.join(this.directory, `${task.adapter.id}-${task.segment.id}.json`); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  view(task) {
    const stored = this.snapshots.get(task.key);
    const failure = this.failures.get(task.key) || stored?.last_error || null;
    const fresh = Boolean(stored && !failure && Date.parse(stored.valid_until) > this.now());
    return {
      venue: task.adapter.id, venue_kind: task.adapter.kind, segment: task.segment.id,
      market_type: task.segment.market_type, scope: task.segment.description,
      status: fresh ? "FRESH" : stored ? "STALE" : failure ? "ERROR" : "NOT_FETCHED",
      fetched_at: stored?.last_success_at || null, valid_until: stored?.valid_until || null,
      error: failure, markets: stored?.markets || [], exclusions: stored?.exclusions || [],
      excluded_count: stored?.exclusions?.length || 0,
    };
  }
  views() { return this.tasks.map(task => this.view(task)); }
  refresh({ dueOnly = false } = {}) {
    if (this.closed) return Promise.reject(new Error("Catalog closed."));
    if (this.active) return this.active;
    this.active = this.refreshAll({ dueOnly }).finally(() => { this.active = null; });
    return this.active;
  }
  async refreshAll({ dueOnly }) {
    const batch = new AbortController();
    const queue = this.tasks.filter(task => {
      if (!dueOnly) return true;
      const stored = this.snapshots.get(task.key);
      const failure = this.failures.get(task.key) || stored?.last_error;
      const last = failure?.at || stored?.last_attempt_at;
      const interval = failure ? Math.max(this.config.lookup_retry_ms, failure.retry_after_ms || 0) : this.config.refresh_interval_ms;
      return !last || this.now() - Date.parse(last) >= interval;
    });
    const workers = Array.from({ length: Math.min(this.config.concurrency, queue.length) }, async () => {
      while (queue.length && !this.closed && !batch.signal.aborted) {
        const task = queue.shift();
        const attempt = new Date(this.now()).toISOString();
        const signal = AbortSignal.any([this.controller.signal, batch.signal, AbortSignal.timeout(this.config.segment_timeout_ms)]);
        let stored;
        try {
          const result = await task.adapter.fetchSegment(task.segment.id, { requestJson: this.requestJson, signal });
          if (signal.aborted) throw new Error("Catalog refresh cancelled or timed out.");
          const markets = validateMarkets(result, task.adapter, task.segment);
          const exclusions = exclusionsFor(result.exclusions);
          stored = {
            schema_version: 1, venue: task.adapter.id, venue_kind: task.adapter.kind,
            segment: task.segment.id, market_type: task.segment.market_type,
            scope: task.segment.description, last_attempt_at: attempt,
            last_success_at: new Date(this.now()).toISOString(),
            valid_until: new Date(this.now() + this.config.cache_ttl_ms).toISOString(),
            last_error: null, markets, exclusions,
          };
          if (Buffer.byteLength(JSON.stringify(stored)) > 32 * 1024 * 1024) throw new Error("Catalog snapshot exceeds 32 MiB.");
        } catch (error) {
          if (this.closed || batch.signal.aborted) return;
          const failure = { message: String(error.message).slice(0, 400), code: error.code || "CATALOG_ERROR", at: attempt,
            retry_after_ms: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null };
          this.failures.set(task.key, failure);
          const previous = this.snapshots.get(task.key);
          if (previous) {
            const degraded = { ...previous, last_attempt_at: attempt, last_error: failure };
            await writeJsonAtomic(this.file(task), degraded);
            this.snapshots.set(task.key, degraded);
          }
          for (const listener of this.listeners) listener(this.view(task));
          continue;
        }
        // Storage errors are fatal; they must not be disguised as an API outage.
        await writeJsonAtomic(this.file(task), stored);
        this.snapshots.set(task.key, stored); this.failures.delete(task.key);
        for (const listener of this.listeners) listener(this.view(task));
      }
    }).map(worker => worker.catch(error => { batch.abort(); throw error; }));
    const outcomes = await Promise.allSettled(workers);
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed) throw failed.reason;
    const summary = this.summary();
    await writeJsonAtomic(path.join(this.directory, "status.json"), summary);
    return summary;
  }
  summary() {
    const views = this.views();
    return { schema_version: 1, checked_at: new Date(this.now()).toISOString(), venues: this.adapters.length,
      segments: views.map(({ markets, ...view }) => ({ ...view, market_count: markets.length })),
      fresh_segments: views.filter(view => view.status === "FRESH").length,
      total_segments: views.length, trading_allowed: false };
  }
  start({ onError = console.error } = {}) {
    if (this.timer || this.closed) throw new Error("Catalog already started or closed.");
    const tick = () => this.refresh({ dueOnly: true }).catch(onError);
    this.timer = setInterval(tick, Math.min(this.config.refresh_interval_ms, this.config.lookup_retry_ms));
    tick();
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; clearInterval(this.timer); this.controller.abort();
    this.closePromise = (async () => {
      try { await this.active; } finally { await this.releaseLock?.(); }
    })();
    return this.closePromise;
  }
}

module.exports = { Catalog, DEFAULT_CONFIG };

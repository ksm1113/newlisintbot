const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { acquireLock } = require("../lock.cjs");
const { writeJsonAtomic, MAX_RECORD_BYTES } = require("../jsonl.cjs");
const { buildResult } = require("./matcher.cjs");

const MAX_JOBS = 50000;
const MAX_JOB_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const EVENT_ID = /^[a-f0-9]{64}$/;
const JOB_STATUSES = new Set(["QUEUED", "RUNNING", "WAITING_CATALOG", "RETRY", "COMPLETE", "WAITING_IDENTITY", "FAILED"]);
const RESULT_STATUSES = new Set(["CATALOG_CANDIDATES_READY", "CATALOG_SEARCH_EMPTY", "CATALOG_PARTIAL", "SYMBOL_REQUIRED"]);
const TERMINAL = new Set(["COMPLETE", "WAITING_IDENTITY"]);

function validEvent(event) {
  return Boolean(event && event.schema_version === 1 && EVENT_ID.test(event.event_id) &&
    event.status === "LOOKUP_PENDING" && event.identity_status === "UNVERIFIED" &&
    event.trading_allowed === false && Array.isArray(event.assets));
}

function validResult(result, eventId) {
  return Boolean(result && result.schema_version === 1 && result.event_id === eventId &&
    RESULT_STATUSES.has(result.status) && result.identity_status === "UNVERIFIED" &&
    result.trading_allowed === false && Array.isArray(result.assets) && Array.isArray(result.coverage));
}

function completionStatus(result) {
  if (result.status === "SYMBOL_REQUIRED") return "WAITING_IDENTITY";
  if (result.status === "CATALOG_CANDIDATES_READY" || result.status === "CATALOG_SEARCH_EMPTY") return "COMPLETE";
  return null;
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtime_ms: stat.birthtimeMs };
}

function fingerprint(views) {
  if (!Array.isArray(views)) throw new Error("Catalog views must be an array.");
  const version = views.map(view => ({
    venue: view.venue, segment: view.segment, status: view.status,
    fetched_at: view.fetched_at ?? null, valid_until: view.valid_until ?? null,
    error: view.error ?? null,
    // Candidate-relevant fields cover updates in injected catalogs without timestamps.
    markets: (view.markets || []).map(item => [item.market_id, item.base_symbol, item.quote_symbol, item.market_status]),
    exclusions: (view.exclusions || []).map(item => [item.market_id, item.base_symbol, item.native_status, item.reason]),
  }));
  return createHash("sha256").update(JSON.stringify(version)).digest("hex");
}

function cooldownUntil(views, now, retryMs) {
  let deadline = null;
  for (const view of views) {
    if (view.status === "FRESH" || !view.error) continue;
    const providerDelay = view.error.retry_after_ms;
    // Ordinary errors spend the bounded matcher retry budget. Only an explicit
    // provider block longer than our retry interval postpones that budget.
    if (!Number.isFinite(providerDelay) || providerDelay <= retryMs) continue;
    const attemptedAt = Date.parse(view.error.at);
    if (!Number.isFinite(attemptedAt)) continue;
    const until = attemptedAt + providerDelay;
    if (until > now) deadline = Math.max(deadline ?? until, until);
  }
  return deadline;
}

function freshUntil(views) {
  let earliest = Infinity;
  for (const view of views) {
    const expires = view.status === "FRESH" ? Date.parse(view.valid_until) : NaN;
    if (Number.isFinite(expires)) earliest = Math.min(earliest, expires);
  }
  return earliest;
}

async function readJson(file, maxBytes, { optional = false } = {}) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Invalid or oversized lookup file: ${file}`);
  return JSON.parse(await fs.readFile(file, "utf8"));
}

class LookupWorker {
  static async open({ root = path.resolve(__dirname, "../.."), catalog, onResult = () => {}, now = () => Date.now() } = {}) {
    if (!catalog || typeof catalog.views !== "function" || typeof catalog.subscribe !== "function") throw new Error("Lookup worker requires a catalog.");
    const retryMs = catalog.config?.lookup_retry_ms;
    const maxAttempts = catalog.config?.lookup_max_attempts ?? catalog.config?.max_attempts;
    if (!Number.isSafeInteger(retryMs) || retryMs < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("Invalid lookup retry configuration.");
    const worker = new LookupWorker(root, catalog, onResult, now, retryMs, maxAttempts);
    for (const directory of [path.join(root, "state"), path.join(root, "data"), worker.jobsDirectory, worker.resultsDirectory]) await fs.mkdir(directory, { recursive: true });
    worker.releaseLock = await acquireLock(path.join(root, "state", "market-lookup.lock"));
    try {
      await worker.loadJobs();
      const state = await readJson(worker.cursorFile, 64 * 1024, { optional: true });
      if (state) {
        if (state.schema_version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < 0 ||
            (state.input_identity !== null && (!state.input_identity || ![state.input_identity.dev, state.input_identity.ino, state.input_identity.birthtime_ms].every(Number.isFinite))) ||
            (state.offset > 0 && (!EVENT_ID.test(state.last_event_id) || !worker.jobs.has(state.last_event_id)))) {
          throw new Error("Invalid lookup checkpoint or missing durable job. Keep data and state together.");
        }
        worker.state = state;
      } else await writeJsonAtomic(worker.cursorFile, worker.state);
      return worker;
    } catch (error) {
      await worker.close().catch(() => {});
      throw error;
    }
  }

  constructor(root, catalog, onResult, now, retryMs, maxAttempts) {
    this.root = root; this.catalog = catalog; this.onResult = onResult; this.now = now;
    this.retryMs = retryMs; this.maxAttempts = maxAttempts;
    this.inputFile = path.join(root, "data", "info-results.jsonl");
    this.cursorFile = path.join(root, "state", "market-lookup-consumer.json");
    this.jobsDirectory = path.join(root, "state", "market-jobs");
    this.resultsDirectory = path.join(root, "data", "market-results");
    this.jobs = new Map();
    this.state = { schema_version: 1, offset: 0, input_identity: null, last_event_id: null };
    this.active = null; this.closed = false; this.stopped = false; this.requested = false;
    this.retryFailedRequested = false; this.observedRefreshes = new WeakSet();
    this.onError = console.error;
  }

  jobFile(eventId) { return path.join(this.jobsDirectory, `${eventId}.json`); }
  resultFile(eventId) { return path.join(this.resultsDirectory, `${eventId}.json`); }

  async saveJob(job) {
    if (Buffer.byteLength(JSON.stringify(job)) > MAX_JOB_BYTES) throw new Error("Lookup job exceeds 8 MiB.");
    await writeJsonAtomic(this.jobFile(job.event_id), job);
    this.jobs.set(job.event_id, job);
  }

  async loadJobs() {
    const entries = await fs.readdir(this.jobsDirectory, { withFileTypes: true });
    const files = entries.filter(entry => entry.name.endsWith(".json"));
    if (files.length > MAX_JOBS) throw new Error("Lookup job limit of 50000 exceeded; archive data/state together before continuing.");
    for (const entry of files) {
      const eventId = entry.name.slice(0, -5);
      if (!EVENT_ID.test(eventId) || !entry.isFile()) throw new Error("Unexpected lookup job file.");
      let job = await readJson(this.jobFile(eventId), MAX_JOB_BYTES);
      if (!job || job.schema_version !== 1 || job.event_id !== eventId || !validEvent(job.event) || job.event.event_id !== eventId ||
          !JOB_STATUSES.has(job.status) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 ||
          (job.next_retry_at !== null && !Number.isFinite(Date.parse(job.next_retry_at))) ||
          (job.catalog_fingerprint != null && !EVENT_ID.test(job.catalog_fingerprint))) throw new Error(`Invalid lookup job: ${eventId}`);
      const result = await readJson(this.resultFile(eventId), MAX_RESULT_BYTES, { optional: true });
      if (result && !validResult(result, eventId)) throw new Error(`Invalid lookup result: ${eventId}`);
      const completed = result && completionStatus(result);
      if (TERMINAL.has(job.status) && completed !== job.status) throw new Error(`Completed lookup job has no matching durable result: ${eventId}. Keep data and state together.`);
      // A crash after result publication but before job completion must not replay it.
      if (!TERMINAL.has(job.status) && completed) {
        job = { ...job, status: completed, next_retry_at: null, result_status: result.status, updated_at: new Date(this.now()).toISOString() };
        await this.saveJob(job);
      } else if (job.status === "RUNNING") {
        job = { ...job, status: "QUEUED", next_retry_at: null, updated_at: new Date(this.now()).toISOString() };
        await this.saveJob(job);
      } else this.jobs.set(eventId, job);
    }
    // A removed old job cannot hide behind a newer intake cursor while its result remains.
    const results = await fs.readdir(this.resultsDirectory, { withFileTypes: true });
    for (const entry of results.filter(entry => entry.name.endsWith(".json"))) {
      if (!entry.isFile() || !this.jobs.has(entry.name.slice(0, -5))) throw new Error("Orphaned lookup result has no durable job. Keep data and state together.");
    }
  }

  drain({ retryFailed = false } = {}) {
    if (this.closed || this.stopped) return Promise.reject(new Error("Lookup worker is closed or stopped."));
    this.requested = true;
    this.retryFailedRequested ||= retryFailed;
    if (!this.active) {
      this.active = this.runRequested().catch(error => {
        // A malformed input or storage error is fatal, not a retryable API outage.
        this.requested = false;
        this.retryFailedRequested = false;
        throw error;
      }).finally(() => {
        this.active = null;
        // A wake queued between the last loop condition and promise settlement
        // starts another pass instead of disappearing behind the old promise.
        if (this.requested && !this.closed && !this.stopped) this.wake();
      });
    }
    return this.active;
  }

  async runRequested() {
    while (this.requested && !this.closed) {
      this.requested = false;
      const retryFailed = this.retryFailedRequested;
      this.retryFailedRequested = false;
      await this.readAvailable();
      if (!this.closed) await this.processJobs(retryFailed);
    }
  }

  async readAvailable() {
    let handle;
    try { handle = await fs.open(this.inputFile, "r"); }
    catch (error) {
      if (error.code === "ENOENT" && this.state.offset === 0 && !this.state.input_identity) return;
      throw error;
    }
    try {
      const stat = await handle.stat();
      const inputIdentity = identity(stat);
      if (this.state.input_identity && JSON.stringify(this.state.input_identity) !== JSON.stringify(inputIdentity)) throw new Error("Lookup input was replaced; append-only info-results.jsonl is required.");
      if (stat.size < this.state.offset) throw new Error("Lookup input was truncated; checkpoint was preserved.");
      if (!this.state.input_identity) {
        this.state = { ...this.state, input_identity: inputIdentity };
        await writeJsonAtomic(this.cursorFile, this.state);
      }
      let position = this.state.offset;
      let bufferStart = position;
      let pending = Buffer.alloc(0);
      let lines = 0;
      while (position < stat.size && !this.closed) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) throw new Error("Lookup input changed during reading.");
        position += bytesRead;
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let newline;
        while ((newline = pending.indexOf(10)) >= 0 && !this.closed) {
          if (++lines > MAX_JOBS) throw new Error("Lookup intake exceeds 50000 lines per drain.");
          if (newline + 1 > MAX_RECORD_BYTES) throw new Error(`Lookup input line exceeds 2 MiB at byte ${bufferStart}.`);
          let event;
          try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline))); }
          catch { throw new Error(`Invalid lookup input JSON/UTF-8 at byte ${bufferStart}; record was not skipped.`); }
          if (!validEvent(event)) throw new Error(`Invalid lookup input record at byte ${bufferStart}.`);
          if (!this.jobs.has(event.event_id)) {
            if (this.jobs.size >= MAX_JOBS) throw new Error("Lookup job limit of 50000 reached; no jobs were dropped.");
            const timestamp = new Date(this.now()).toISOString();
            await this.saveJob({
              schema_version: 1, event_id: event.event_id, event,
              status: "QUEUED", attempts: 0, next_retry_at: null,
              catalog_fingerprint: null, result_status: null,
              created_at: timestamp, updated_at: timestamp,
            });
          }
          // Registration is durable first. An intake replay finds the same job by ID.
          const nextState = { ...this.state, offset: bufferStart + newline + 1, last_event_id: event.event_id };
          await writeJsonAtomic(this.cursorFile, nextState);
          this.state = nextState;
          pending = pending.subarray(newline + 1);
          bufferStart = nextState.offset;
        }
        if (pending.length > MAX_RECORD_BYTES) throw new Error(`Unfinished lookup line exceeds 2 MiB at byte ${bufferStart}.`);
      }
    } finally { await handle.close(); }
  }

  async processJobs(retryFailed) {
    let views = this.catalog.views();
    let currentFingerprint = fingerprint(views);
    let loading = Boolean(this.catalog.active);
    let snapshotCatalog = { views: () => views };
    let nextExpiry = freshUntil(views);
    for (let job of this.jobs.values()) {
      if (this.closed) break;
      if (TERMINAL.has(job.status)) continue;
      // Long backlogs must not reuse a FRESH label after its TTL has passed.
      // Rehash only at a freshness boundary, rather than for every queued job.
      if (this.now() >= nextExpiry) {
        views = this.catalog.views();
        currentFingerprint = fingerprint(views);
        loading = Boolean(this.catalog.active);
        snapshotCatalog = { views: () => views };
        nextExpiry = freshUntil(views);
      }
      if (job.status === "FAILED") {
        if (!retryFailed) continue;
        job = { ...job, status: "QUEUED", attempts: 0, next_retry_at: null, catalog_fingerprint: null, retry_generation: (job.retry_generation || 0) + 1 };
        await this.saveJob(job);
      }
      const changed = job.catalog_fingerprint !== currentFingerprint;
      if (job.status === "WAITING_CATALOG" && !changed) {
        if (loading || job.wait_reason === "UNCLASSIFIED_CATALOG_ENTRY" ||
            (job.next_retry_at && this.now() < Date.parse(job.next_retry_at))) continue;
      }
      if (job.status === "RETRY" && !changed && (loading || this.now() < Date.parse(job.next_retry_at))) continue;
      const result = buildResult(job.event, snapshotCatalog);
      if (!validResult(result, job.event_id)) throw new Error("Matcher returned an invalid or trading-enabled lookup result.");
      const partial = result.status === "CATALOG_PARTIAL";
      const unclassifiedOnly = partial && result.coverage.every(view => view.status === "FRESH") &&
        result.assets.some(asset => asset.status === "UNCLASSIFIED_CATALOG_ENTRY");
      const cooldownDeadline = partial && !loading ? cooldownUntil(views, this.now(), this.retryMs) : null;
      const waitReason = !partial ? null : loading ? "CATALOG_REFRESH" : unclassifiedOnly ? "UNCLASSIFIED_CATALOG_ENTRY" : cooldownDeadline ? "CATALOG_COOLDOWN" : null;
      const waiting = waitReason !== null;
      const attempts = job.attempts + (waiting ? 0 : 1);
      const timestamp = new Date(this.now()).toISOString();
      job = { ...job, status: "RUNNING", attempts, catalog_fingerprint: currentFingerprint, updated_at: timestamp };
      await this.saveJob(job);
      const published = { ...result, lookup_attempt: attempts, catalog_fingerprint: currentFingerprint, looked_up_at: timestamp };
      if (Buffer.byteLength(JSON.stringify(published)) > MAX_RESULT_BYTES) throw new Error("Lookup result exceeds 16 MiB.");
      await writeJsonAtomic(this.resultFile(job.event_id), published);
      const completed = completionStatus(published);
      const status = completed || (waiting ? "WAITING_CATALOG" : attempts >= this.maxAttempts ? "FAILED" : "RETRY");
      await this.saveJob({
        ...job, status, result_status: result.status, wait_reason: waitReason,
        next_retry_at: status === "RETRY" ? new Date(this.now() + this.retryMs).toISOString()
          : waitReason === "CATALOG_COOLDOWN" ? new Date(cooldownDeadline).toISOString() : null,
        updated_at: new Date(this.now()).toISOString(),
      });
      this.onResult(published);
    }
  }

  wake() {
    if (this.closed || this.stopped) return Promise.resolve();
    const refresh = this.catalog.active;
    if (refresh && typeof refresh.then === "function" && !this.observedRefreshes.has(refresh)) {
      this.observedRefreshes.add(refresh);
      refresh.then(() => { void this.wake(); }, () => { void this.wake(); });
    }
    const operation = this.drain();
    // A runtime wake can be fire-and-forget, while explicit drain still rejects visibly.
    operation.catch(error => {
      if (this.stopped || this.closed) return;
      this.stop();
      this.onError(error);
    });
    return operation;
  }

  start({ pollMs = 1000, onError = console.error } = {}) {
    if (this.timer || this.closed || this.stopped) throw new Error("Lookup worker already started, closed, or stopped.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("Invalid lookup polling interval.");
    this.onError = onError;
    this.unsubscribe = this.catalog.subscribe(() => { this.wake(); });
    this.timer = setInterval(() => { this.wake(); }, pollMs);
    this.wake();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer); this.timer = null;
    this.unsubscribe?.(); this.unsubscribe = null;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.stop(); this.closed = true;
    this.closePromise = (async () => {
      try { await this.active; }
      finally { await this.releaseLock?.(); }
    })();
    return this.closePromise;
  }
}

module.exports = { LookupWorker, Worker: LookupWorker, MAX_JOBS };

const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");

const MAX_RECORD_BYTES = 2 * 1024 * 1024;

async function writeAll(handle, buffer, position = null) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position === null ? null : position + offset);
    if (bytesWritten === 0) throw new Error("File write made no progress.");
    offset += bytesWritten;
  }
}

async function repairTail(handle, file, onRecovery) {
  const { size } = await handle.stat();
  if (!size) return;
  const buffer = Buffer.alloc(Math.min(size, MAX_RECORD_BYTES + 1));
  const start = size - buffer.length;
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  const tail = buffer.subarray(0, bytesRead);
  if (tail[tail.length - 1] === 10) return;
  const newline = tail.lastIndexOf(10);
  if (newline < 0 && start > 0) throw new Error(`Unfinished record is too large: ${file}`);
  const recordStart = start + newline + 1;
  const fragment = tail.subarray(newline + 1);
  let complete = false;
  try {
    JSON.parse(fragment.toString("utf8"));
    complete = true;
  } catch { /* Preserve an interrupted write separately before truncating it. */ }
  if (complete) {
    await writeAll(handle, Buffer.from("\n"), size);
    await handle.sync();
    onRecovery(`Completed the newline of the last record: ${file}`);
    return;
  }
  const backup = `${file}.partial-${randomUUID()}`;
  const backupHandle = await fs.open(backup, "wx");
  try {
    await writeAll(backupHandle, fragment);
    await backupHandle.sync();
  } finally {
    await backupHandle.close();
  }
  await handle.truncate(recordStart);
  await handle.sync();
  onRecovery(`Interrupted record preserved in ${backup}; it was not processed.`);
}

class JsonlWriter {
  static async open(file, { onRecovery = console.warn, maxPendingBytes = 16 * MAX_RECORD_BYTES } = {}) {
    const create = await fs.open(file, "a");
    await create.close();
    // Windows append handles cannot truncate. Repair through a separate read/write handle.
    const recovery = await fs.open(file, "r+");
    try {
      await repairTail(recovery, file, onRecovery);
    } finally { await recovery.close(); }
    const handle = await fs.open(file, "a");
    return new JsonlWriter(handle, maxPendingBytes);
  }

  constructor(handle, maxPendingBytes) {
    this.handle = handle;
    this.maxPendingBytes = maxPendingBytes;
    this.pendingBytes = 0;
    this.tail = Promise.resolve();
    this.closed = false;
  }

  append(record) {
    if (this.closed) return Promise.reject(new Error("JSONL writer is closed."));
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (buffer.length > MAX_RECORD_BYTES) return Promise.reject(new Error("JSONL record exceeds 2 MiB."));
    if (this.pendingBytes + buffer.length > this.maxPendingBytes) {
      return Promise.reject(new Error("JSONL write queue is full; stopping instead of dropping records silently."));
    }
    this.pendingBytes += buffer.length;
    this.tail = this.tail.then(async () => {
      await writeAll(this.handle, buffer);
      await this.handle.sync();
    }).finally(() => { this.pendingBytes -= buffer.length; });
    return this.tail;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.tail;
    } finally {
      await this.handle.close();
    }
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

module.exports = { JsonlWriter, writeJsonAtomic, MAX_RECORD_BYTES };

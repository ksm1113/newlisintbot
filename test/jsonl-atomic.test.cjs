const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { writeJsonAtomic } = require("../lib/jsonl.cjs");

async function temporary(t) {
  const prefix = "newlisting-atomic-test-";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    const absolute = path.resolve(root);
    const relative = path.relative(path.resolve(os.tmpdir()), absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(absolute).startsWith(prefix)) throw new Error("Unsafe temporary cleanup.");
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return { root, file: path.join(root, "state.json") };
}

test("atomic JSON replacement survives a transient Windows reader lock while preserving the old version", async t => {
  const { root, file } = await temporary(t);
  await writeJsonAtomic(file, { revision: "old" });
  const rename = fs.rename;
  let failures = 2;
  t.mock.method(fs, "rename", async (from, to) => {
    if (failures-- > 0) {
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: "old" });
      throw Object.assign(new Error("synthetic reader sharing lock"), { code: "EPERM" });
    }
    return rename(from, to);
  });
  await writeJsonAtomic(file, { revision: "new" });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: "new" });
  assert.deepEqual(await fs.readdir(root), ["state.json"]);
});

test("persistent replacement failure remains visible and keeps the last durable JSON", async t => {
  const { root, file } = await temporary(t);
  await writeJsonAtomic(file, { revision: "old" });
  t.mock.method(fs, "rename", async () => { throw Object.assign(new Error("synthetic persistent sharing lock"), { code: "EBUSY" }); });
  await assert.rejects(writeJsonAtomic(file, { revision: "new" }), { code: "EBUSY" });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: "old" });
  assert.deepEqual(await fs.readdir(root), ["state.json"]);
});

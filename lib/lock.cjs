const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");

async function acquireLock(file) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 4; attempt++) {
    let handle;
    try {
      handle = await fs.open(file, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try {
        previous = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw new Error(`Invalid lock file: ${file}. Check that its process has stopped before removing it.`);
      }
      if (!Number.isInteger(previous.pid) || previous.pid <= 0) {
        throw new Error(`Invalid PID in lock file: ${file}`);
      }
      try {
        process.kill(previous.pid, 0);
        throw new Error(`Already running (PID ${previous.pid}): ${file}`);
      } catch (pidError) {
        if (pidError.code !== "ESRCH") throw pidError;
      }
      // Serialize stale-lock removal so simultaneous restarts cannot delete a new lock.
      const recoveryFile = `${file}.recovery`;
      let recovery;
      try {
        recovery = await fs.open(recoveryFile, "wx");
      } catch (recoveryError) {
        if (recoveryError.code === "EEXIST") {
          throw new Error(`Lock recovery already in progress: ${recoveryFile}`);
        }
        throw recoveryError;
      }
      try {
        const current = JSON.parse(await fs.readFile(file, "utf8"));
        if (current.token === previous.token && current.pid === previous.pid) {
          await fs.unlink(file);
        }
      } catch (readError) {
        if (readError.code !== "ENOENT") throw readError;
      } finally {
        await recovery.close();
        await fs.unlink(recoveryFile);
      }
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() }));
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.unlink(file);
      throw error;
    }
    await handle.close();
    let released = false;
    return async () => {
      if (released) return;
      const current = JSON.parse(await fs.readFile(file, "utf8"));
      if (current.token !== token) throw new Error(`Lock ownership changed: ${file}`);
      await fs.unlink(file);
      released = true;
    };
  }
  throw new Error(`Could not acquire lock: ${file}`);
}

module.exports = { acquireLock };

/**
 * One server owns the store.
 *
 * Two processes on the same `universes/` folder corrupt real work: each of them treats the turns
 * found on disk as its own and marks the other one's running turns as interrupted, then both
 * resume the same queue. The lock file holds the pid of the running server; a second instance
 * refuses to start while that process is alive, and takes over a lock left behind by a crash.
 */
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_NAME = '.server.lock';

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Takes the lock for this process. Returns a handle to release it, or throws an error whose
 * message names the process that already holds the store.
 */
export async function acquireStoreLock(storeDir) {
  const file = join(storeDir, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      return {
        file,
        async release() {
          await handle.close().catch(() => {});
          await unlink(file).catch(() => {});
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const previous = await readFile(file, 'utf8').then((text) => JSON.parse(text)).catch(() => null);
      if (previous && isAlive(previous.pid) && previous.pid !== process.pid) {
        throw new Error(
          `another scriptaWorlds server is already running (pid ${previous.pid}, since ${previous.startedAt}) and owns ${storeDir}; stop it before starting a second one`
        );
      }
      await unlink(file).catch(() => {});
    }
  }
  throw new Error(`could not take the store lock in ${storeDir}`);
}

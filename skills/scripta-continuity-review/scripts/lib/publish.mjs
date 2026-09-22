// Atomic publication of one run's result directory (no external dependencies).
//
// `--out` is the result directory of a single run, and the workspace gives every
// run its own directory. Everything is written into a fresh sibling staging
// directory, the complete inventory is verified there, and only then is the
// staging directory renamed onto `--out`, which also replaces an existing empty
// directory atomically. A reader therefore sees either the previous complete
// result or the new complete result, never a mixture, and a crash between
// staging and publication leaves `--out` untouched.
//
// Refusals a caller can act on carry `OUTPUT_NOT_DIRECTORY` or
// `OUTPUT_NOT_EMPTY` and exit status 2; a failure of the write itself carries
// `IO_ERROR` or `INCOMPLETE_BUNDLE` and exit status 1.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const EXIT_USAGE = 2;
const EXIT_PROCESSING = 1;

export class PublishError extends Error {
  constructor(code, message, exitCode = EXIT_PROCESSING) {
    super(`${code}: ${message}`);
    this.name = 'PublishError';
    this.code = code;
    this.exitCode = exitCode;
    this.detail = message;
  }
}

function stagingPathFor(outDir) {
  const abs = resolve(outDir);
  return join(dirname(abs), `${basename(abs)}.staging-${randomBytes(6).toString('hex')}`);
}

// Retry semantics for an incomplete run: a process killed between staging and
// publication leaves a sibling `<name>.staging-<hex>` directory behind. Such a
// directory is never read and never published, and the next run for the same
// destination removes the leftovers of the same naming scheme, so a crashed run
// cannot accumulate. The pattern matches only this module's own naming (the
// destination basename plus twelve hex characters), never a foreign directory.
export async function discardAbandonedStaging(outDir) {
  const abs = resolve(outDir);
  const parent = dirname(abs);
  const pattern = new RegExp(`^${basename(abs).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.staging-[0-9a-f]{12}$`);
  let names;
  try {
    names = await readdir(parent);
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw new PublishError('IO_ERROR', `cannot inspect the destination parent ${parent}: ${cause.message}`);
  }
  const abandoned = names.filter((name) => pattern.test(name));
  for (const name of abandoned) {
    await rm(join(parent, name), { recursive: true, force: true });
  }
  return abandoned;
}

// Refuse a result directory that is not an empty directory: a run owns its own
// directory, so an existing file or a non-empty directory is a conflict. An
// existing accepted result is therefore never overwritten file by file.
export async function inspectOutDirectory(outDir) {
  const abs = resolve(outDir);
  let info;
  try {
    info = await stat(abs);
  } catch (cause) {
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return { exists: false };
    throw new PublishError('IO_ERROR', `cannot inspect --out ${abs}: ${cause.message}`);
  }
  if (!info.isDirectory()) {
    throw new PublishError('OUTPUT_NOT_DIRECTORY', `--out ${abs} exists and is not a directory`, EXIT_USAGE);
  }
  const entries = await readdir(abs);
  if (entries.length > 0) {
    throw new PublishError(
      'OUTPUT_NOT_EMPTY',
      `--out ${abs} exists and is not empty (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}); ` +
        'every run writes its own result directory',
      EXIT_USAGE,
    );
  }
  return { exists: true };
}

// Write every file into a fresh sibling staging directory and verify the
// inventory and the bytes there. Returns the staging directory path.
export async function stageFiles(outDir, files) {
  const abs = resolve(outDir);
  const stagingDir = stagingPathFor(abs);
  try {
    // Recursive: a destination whose parent directories do not exist yet is a
    // normal request (each workspace run gets its own directory), and the
    // parents are created beside the destination, never inside --out.
    await mkdir(stagingDir, { recursive: true });
  } catch (cause) {
    throw new PublishError('IO_ERROR', `cannot create the staging directory ${stagingDir}: ${cause.message}`);
  }
  try {
    for (const file of files) {
      await writeFile(join(stagingDir, file.name), file.content, 'utf8');
    }
    const names = (await readdir(stagingDir)).sort();
    const expected = files.map((file) => file.name).sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      throw new PublishError(
        'INCOMPLETE_BUNDLE',
        `staged inventory ${names.join(', ') || 'nothing'} does not match the expected ${expected.join(', ')}`,
      );
    }
    for (const file of files) {
      const written = await readFile(join(stagingDir, file.name));
      const expectedBytes = Buffer.from(file.content, 'utf8');
      if (!written.equals(expectedBytes)) {
        throw new PublishError(
          'INCOMPLETE_BUNDLE',
          `staged file ${file.name} does not match the bytes that were written`,
        );
      }
    }
    return stagingDir;
  } catch (cause) {
    await discardStaging(stagingDir);
    if (cause instanceof PublishError) throw cause;
    throw new PublishError('IO_ERROR', `cannot stage the result in ${stagingDir}: ${cause.message}`);
  }
}

// One rename publishes the whole bundle, so nothing else may be touching `--out`.
export async function publishStaging(stagingDir, outDir) {
  try {
    await rename(stagingDir, resolve(outDir));
  } catch (cause) {
    await discardStaging(stagingDir);
    throw new PublishError(
      'IO_ERROR',
      `cannot publish the staged result onto ${resolve(outDir)}: ${cause.message}; --out was left untouched`,
    );
  }
}

export async function discardStaging(stagingDir) {
  await rm(stagingDir, { recursive: true, force: true });
}

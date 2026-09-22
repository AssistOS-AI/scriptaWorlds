/**
 * Output-workspace safety and atomic publication.
 *
 * Two rules, enforced together because a run has to satisfy both before it may
 * write a single byte:
 *
 *   1. the destination must be separate from every protected input, decided on
 *      real paths so a symlink alias (including a non-existent child beneath a
 *      symlink) cannot smuggle the result into the input packet;
 *   2. the whole bundle is staged in a sibling directory, inventory-verified
 *      there, and published with one `rename`, so a reader sees either the
 *      previous complete result or the new complete result, never a mixture.
 *
 * Nothing here reads the inputs; it only resolves paths and writes the staging
 * directory, and it removes that directory on any failure.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { CliError, EXIT_PROCESSING, fail } from './errors.mjs';

/**
 * Real path of `target` even when it does not exist yet: walk up to the nearest
 * existing ancestor, resolve that with realpath, then re-append the missing
 * segments. A non-existent child under a symlink therefore resolves through it.
 */
export function realDestination(target) {
  let current = resolve(target);
  const missing = [];
  for (;;) {
    if (existsSync(current)) {
      const real = realpathSync(current);
      return missing.length === 0 ? real : join(real, ...missing.slice().reverse());
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...missing.slice().reverse());
    missing.push(basename(current));
    current = parent;
  }
}

/** True when `child` equals `parent` or lives inside it. Both must be real paths. */
export function isInside(child, parent) {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Refuse a destination that is the protected input, nests under it, contains
 * it, or collides with a supplied file. `protect` is `[{ label, path }]` with
 * paths that exist. Comparison happens on real paths.
 */
export function assertOutputSeparate({ out, protect }) {
  const outReal = realDestination(out);
  for (const { label, path } of protect) {
    if (!path) continue;
    const inputReal = realpathSync(path);
    if (isInside(outReal, inputReal)) {
      fail(
        `--out must not be the ${label} or live inside it: ${out} resolves to ${outReal}, inside ${inputReal}`,
        'OUTPUT_INSIDE_INPUT',
      );
    }
    if (isInside(inputReal, outReal)) {
      fail(
        `--out must not contain the ${label}: ${out} resolves to ${outReal}, which contains ${inputReal}`,
        'OUTPUT_CONTAINS_INPUT',
      );
    }
  }
}

function listRelativeFiles(root, prefix = '') {
  const found = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) found.push(...listRelativeFiles(join(root, dirent.name), rel));
    else found.push(rel);
  }
  return found;
}

/**
 * Publish `files` (`[{ name, data }]`) as the complete inventory of `out`.
 *
 * Refuses an existing non-directory or non-empty `out`; stages into
 * `<out>.staging-<hex>`; verifies the staged inventory; then renames once. On
 * failure the staging directory is removed and `out` is left untouched.
 */
export function publishBundle({ out, files, protect }) {
  const outPath = resolve(out);
  assertOutputSeparate({ out: outPath, protect });

  if (existsSync(outPath)) {
    const stat = statSync(outPath);
    if (!stat.isDirectory()) {
      fail(`--out ${outPath} exists and is not a directory`, 'OUTPUT_NOT_DIRECTORY');
    }
    if (readdirSync(outPath).length > 0) {
      fail(
        `--out ${outPath} exists and is not empty; every run writes its own result directory`,
        'OUTPUT_NOT_EMPTY',
      );
    }
  }

  const parent = dirname(outPath);
  const expected = files.map((f) => f.name);
  const staging = `${outPath}.staging-${randomBytes(4).toString('hex')}`;
  try {
    mkdirSync(parent, { recursive: true });
    mkdirSync(staging);
    // Recheck once the staging directory exists: an alias may have appeared.
    assertOutputSeparate({ out: staging, protect });
    if (dirname(realpathSync(staging)) !== realpathSync(parent)) {
      fail(`staging directory ${staging} resolved outside ${parent}`, 'PATH_ESCAPE');
    }
    for (const file of files) {
      const target = join(staging, file.name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.data);
    }
    const found = listRelativeFiles(staging).sort();
    const wanted = [...expected].sort();
    if (found.length !== wanted.length || found.some((name, i) => name !== wanted[i])) {
      fail(
        `staged bundle inventory does not match the expected files ` +
          `(expected ${wanted.join(', ')}, found ${found.join(', ') || 'nothing'})`,
        'INCOMPLETE_BUNDLE',
        EXIT_PROCESSING,
      );
    }
    renameSync(staging, outPath);
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
    if (error instanceof CliError) throw error;
    fail(
      `cannot publish the bundle into ${outPath}: ${error && error.message ? error.message : String(error)}`,
      'IO_ERROR',
      EXIT_PROCESSING,
    );
  }
  return expected;
}

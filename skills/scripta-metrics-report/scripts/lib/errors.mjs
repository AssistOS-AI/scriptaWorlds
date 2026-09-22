/**
 * Shared errors, exit codes and small deterministic helpers.
 *
 * Exit-code convention for every skill CLI:
 *   0 = completed (findings/observations are result data, not failure)
 *   2 = invalid input/arguments/schema
 *   1 = execution failure (I/O, unexpected)
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

export const EXIT_PROCESSING = 1;
export const EXIT_USAGE = 2;

export class CliError extends Error {
  constructor(message, code, exitCode = EXIT_USAGE) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function fail(message, code = 'INVALID_INPUT', exitCode = EXIT_USAGE) {
  throw new CliError(message, code, exitCode);
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function isSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function isIsoString(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Validate a portable relative path: forward slashes only, no `..`, no `.`
 * segments, no absolute paths, no null bytes. Every refusal uses the shared
 * `PATH_ESCAPE` code of the assessment-packet vocabulary (`docs/contracts.md`
 * §8.3), so all four consumers answer identically.
 */
export function validateRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    fail(`path must be a non-empty string, got ${JSON.stringify(path)}`, 'PATH_ESCAPE');
  }
  if (path.includes('\0')) {
    fail(`path contains a null byte: ${JSON.stringify(path)}`, 'PATH_ESCAPE');
  }
  if (path.includes('\\')) {
    fail(`path must use forward slashes, got ${JSON.stringify(path)}`, 'PATH_ESCAPE');
  }
  if (isAbsolute(path) || path.startsWith('/')) {
    fail(`path must be relative, got ${JSON.stringify(path)}`, 'PATH_ESCAPE');
  }
  const parts = path.split('/');
  if (parts.includes('..') || parts.includes('.')) {
    fail(`path must not contain '.' or '..' segments, got ${JSON.stringify(path)}`, 'PATH_ESCAPE');
  }
  return path;
}

/** True when `bytes` decodes as strict UTF-8. */
export function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `relPath` strictly inside `baseDir`, rejecting traversal and
 * symlink escape via a realpath containment check. Returns the absolute path.
 */
export function resolveInside(baseDir, relPath) {
  validateRelativePath(relPath);
  let baseReal;
  try {
    baseReal = realpathSync(baseDir);
  } catch {
    fail(`directory is not readable: ${baseDir}`, 'MISSING_FILE');
  }
  const full = resolve(baseDir, relPath);
  let real;
  try {
    real = realpathSync(full);
  } catch {
    fail(`file not found or unreadable: ${relPath}`, 'MISSING_FILE');
  }
  const rel = relative(baseReal, real);
  if (rel === '') {
    fail(`path must reference a file, got ${JSON.stringify(relPath)}`, 'PATH_ESCAPE');
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    fail(`path escapes its root (traversal or symlink): ${JSON.stringify(relPath)}`, 'PATH_ESCAPE');
  }
  return full;
}

export function readBytesChecked(file, label) {
  try {
    return readFileSync(file);
  } catch (error) {
    fail(
      `cannot read ${label}: ${error && error.message ? error.message : String(error)}`,
      'IO_ERROR',
      EXIT_PROCESSING,
    );
  }
}

export function readJsonChecked(file, label) {
  const bytes = readBytesChecked(file, label);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(
      `${label} is not valid JSON: ${error && error.message ? error.message : String(error)}`,
      'INVALID_JSON',
    );
  }
  return value;
}


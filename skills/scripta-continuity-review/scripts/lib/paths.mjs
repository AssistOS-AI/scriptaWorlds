// Real-path reasoning about the destination (no external dependencies).
//
// A lexically separate destination is not enough: `--out` may be a symlink into
// the packet, or may not exist yet while an existing ancestor is a symlink into
// it. Every separation decision is therefore made on the real path of the
// nearest existing ancestor joined with the still-missing segments, never by
// comparing strings.
//
// The refusal codes are shared with the metrics CLI, which owns the same rule:
// `OUTPUT_INSIDE_INPUT` when the destination is a protected input or lives
// inside it, `OUTPUT_CONTAINS_INPUT` when it contains one.

import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

export class SeparationError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(list.join('; '));
    this.name = 'SeparationError';
    this.errors = list;
  }
}

export function structuredError(code, message) {
  return `${code}: ${message}`;
}

// True when `child` equals `parent` or lives inside it. Both must be real paths.
export function isInside(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent + sep);
}

// Real path of `target` even when it does not exist yet: walk up to the nearest
// existing ancestor, resolve that with realpath, and re-append the missing
// segments. A non-existent child beneath a symlink therefore resolves through it.
export async function realDestination(target) {
  let current = resolve(target);
  const missing = [];
  for (;;) {
    try {
      const resolved = await realpath(current);
      return missing.length === 0 ? resolved : join(resolved, ...missing);
    } catch (cause) {
      if (cause.code !== 'ENOENT' && cause.code !== 'ENOTDIR') {
        throw new SeparationError([
          structuredError('PATH_ESCAPE', `cannot resolve ${current}: ${cause.message}`),
        ]);
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new SeparationError([
          structuredError('PATH_ESCAPE', `cannot resolve ${current}: ${cause.message}`),
        ]);
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

// Refuse a destination that is a protected input, lives inside one, or contains
// one. `protect` is `[{ label, path }]`; every comparison happens on real paths,
// so an alias (including a not-yet-existing child beneath a symlink) is caught.
export async function assertOutputSeparate({ out, protect }) {
  const errors = [];
  const outReal = await realDestination(out);
  for (const { label, path } of protect) {
    if (!path) continue;
    const inputReal = await realDestination(path);
    if (outReal === inputReal) {
      errors.push(
        structuredError(
          'OUTPUT_INSIDE_INPUT',
          `--out must not be the ${label}: ${out} resolves to ${outReal}`,
        ),
      );
      continue;
    }
    if (isInside(outReal, inputReal)) {
      errors.push(
        structuredError(
          'OUTPUT_INSIDE_INPUT',
          `--out must not live inside the ${label}: ${out} resolves to ${outReal}, inside ${inputReal}`,
        ),
      );
    }
    if (isInside(inputReal, outReal)) {
      errors.push(
        structuredError(
          'OUTPUT_CONTAINS_INPUT',
          `--out must not contain the ${label}: ${out} resolves to ${outReal}, which contains ${inputReal}`,
        ),
      );
    }
  }
  if (errors.length > 0) throw new SeparationError(errors);
  return outReal;
}

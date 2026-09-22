/**
 * evidence.v1 verification.
 *
 * An evidence item is { id, file, sha256, start, end, quote } with zero-based
 * half-open UTF-8 byte offsets into the original file bytes. A verifier
 * recomputes the file hash and the quote slice and rejects any mismatch,
 * impossible offsets, out-of-range ranges and non-UTF-8 boundaries.
 */

import { TextDecoder } from 'node:util';

import { fail, isNonNegativeInteger, isPlainObject, isSha256Hex, sha256Hex } from './errors.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });

/** True when `offset` sits on a code-point boundary (never inside a multibyte char). */
export function isUtf8Boundary(bytes, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) return false;
  if (offset === 0 || offset === bytes.length) return true;
  return (bytes[offset] & 0xc0) !== 0x80;
}

/**
 * Verify one evidence item against the file bytes. Pure: returns
 *   { ok, errors: string[], item: normalized|null }.
 */
export function verifyEvidenceItem(item, bytes) {
  if (!isPlainObject(item)) {
    return { ok: false, errors: ['evidence item must be a JSON object'], item: null };
  }
  const { id, file, sha256, start, end, quote } = item;
  const errors = [];
  if (typeof id !== 'string' || id.length === 0) errors.push('id must be a non-empty string');
  if (typeof file !== 'string' || file.length === 0) errors.push('file must be a non-empty string');
  if (!isSha256Hex(sha256)) errors.push('sha256 must be 64 lowercase hex characters');
  if (!isNonNegativeInteger(start)) errors.push('start must be a non-negative integer byte offset');
  if (!isNonNegativeInteger(end)) errors.push('end must be a non-negative integer byte offset');
  if (typeof quote !== 'string') errors.push('quote must be a string');
  if (errors.length) return { ok: false, errors, item: null };

  if (start > end) {
    errors.push(`offsets inverted: start ${start} > end ${end}`);
  }
  if (!(bytes instanceof Uint8Array)) {
    errors.push('verification requires the file bytes');
    return { ok: false, errors, item: null };
  }
  if (end > bytes.length) {
    errors.push(`end ${end} exceeds file length ${bytes.length}`);
  }
  if (!isUtf8Boundary(bytes, start)) {
    errors.push(`start ${start} is not a UTF-8 code-point boundary`);
  }
  if (!isUtf8Boundary(bytes, end)) {
    errors.push(`end ${end} is not a UTF-8 code-point boundary`);
  }

  if (errors.length) return { ok: false, errors, item: null };

  const actualHash = sha256Hex(bytes);
  if (actualHash !== sha256) {
    errors.push(`sha256 mismatch: expected ${sha256}, computed ${actualHash}`);
  }
  let slice = '';
  try {
    slice = decoder.decode(bytes.subarray(start, end));
  } catch (error) {
    errors.push(`range [${start},${end}) is not valid UTF-8: ${error.message}`);
  }
  if (slice !== quote) {
    errors.push(
      `quote does not match the byte slice [${start},${end}): ` +
        `expected ${JSON.stringify(quote)}, got ${JSON.stringify(slice)}`,
    );
  }

  if (errors.length) return { ok: false, errors, item: null };
  return { ok: true, errors: [], item: { id, file, sha256, start, end, quote } };
}

/**
 * Structural validation of an evidence list: array of objects with unique,
 * non-empty string ids. Throws CliError on malformed input.
 */
export function parseEvidenceList(raw, label = 'evidence') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${label} must be an array of evidence items`, 'INVALID_EVIDENCE');
  const seen = new Set();
  const items = [];
  for (const item of raw) {
    if (!isPlainObject(item)) fail(`${label} contains a non-object entry`, 'INVALID_EVIDENCE');
    if (typeof item.id !== 'string' || item.id.length === 0) {
      fail(`${label} contains an entry without a valid id`, 'INVALID_EVIDENCE');
    }
    if (seen.has(item.id)) fail(`duplicate evidence id ${JSON.stringify(item.id)}`, 'DUPLICATE_ID');
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

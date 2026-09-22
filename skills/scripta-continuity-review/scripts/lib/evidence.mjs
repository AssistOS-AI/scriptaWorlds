// evidence.v1 helpers (no external dependencies).
//
// An evidence item cites an immutable span of a packet file: stable id, relative
// path, SHA-256, zero-based half-open UTF-8 byte range, and the exact quote.
// Verification is strict in the same way the metrics skill is: the hash of the
// whole file is recomputed, both offsets must sit on UTF-8 code-point
// boundaries, the range must decode as UTF-8, and the decoded slice must equal
// the declared quote byte for byte. A span that would end inside a multi-byte
// character is never produced and never accepted.

import { TextDecoder } from 'node:util';

const SHA256_RE = /^[0-9a-fA-F]{64}$/;

// Longest window a single check cites around an offending value.
const EVIDENCE_WINDOW = 160;

const decoder = new TextDecoder('utf-8', { fatal: true });

function isValidSha256(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

// True when `offset` sits on a code-point boundary (never inside a multi-byte
// character). Out-of-range offsets are not boundaries.
function isUtf8Boundary(data, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > data.length) return false;
  if (offset === data.length || offset === 0) return true;
  return (data[offset] & 0xc0) !== 0x80;
}

// Largest boundary at or below `offset`, clamped into [0, data.length].
function floorBoundary(data, offset) {
  let at = Math.max(0, Math.min(Math.trunc(offset), data.length));
  while (at > 0 && (data[at] & 0xc0) === 0x80) at -= 1;
  return at;
}

// Smallest boundary at or above `offset`, clamped into [0, data.length].
function ceilBoundary(data, offset) {
  let at = Math.max(0, Math.min(Math.trunc(offset), data.length));
  while (at < data.length && (data[at] & 0xc0) === 0x80) at += 1;
  return at;
}

// Verify one evidence.v1 item against the packet files map. Returns { ok, error? }.
export function verifyEvidenceItem(item, files) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { ok: false, error: 'evidence item must be an object' };
  }
  const { id, file, sha256, start, end, quote } = item;
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'evidence.id must be a non-empty string' };
  }
  if (typeof file !== 'string' || file.length === 0) {
    return { ok: false, error: 'evidence.file must be a non-empty string' };
  }
  const entry = files.get(file);
  if (!entry) {
    return { ok: false, error: `evidence.file is not present in the packet: ${file}` };
  }
  if (!isValidSha256(sha256)) {
    return { ok: false, error: `evidence.sha256 is not 64 hex characters (${file})` };
  }
  if (sha256.toLowerCase() !== entry.sha256) {
    return { ok: false, error: `evidence.sha256 does not match the packet file (${file})` };
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, error: `evidence.start/end must be integers (${file})` };
  }
  if (start < 0 || end < start || end > entry.data.length) {
    return {
      ok: false,
      error: `evidence byte range is out of bounds (${file}, bytes ${start}-${end}, file has ${entry.data.length})`,
    };
  }
  if (typeof quote !== 'string') {
    return { ok: false, error: `evidence.quote must be a string (${file})` };
  }
  if (!isUtf8Boundary(entry.data, start)) {
    return { ok: false, error: `evidence.start is not a UTF-8 code-point boundary (${file}, byte ${start})` };
  }
  if (!isUtf8Boundary(entry.data, end)) {
    return { ok: false, error: `evidence.end is not a UTF-8 code-point boundary (${file}, byte ${end})` };
  }
  let actual;
  try {
    actual = decoder.decode(entry.data.subarray(start, end));
  } catch (cause) {
    return { ok: false, error: `evidence range is not valid UTF-8 (${file}, bytes ${start}-${end}): ${cause.message}` };
  }
  if (actual !== quote) {
    return { ok: false, error: `evidence.quote does not match the packet bytes (${file}, bytes ${start}-${end})` };
  }
  return { ok: true };
}

// Build a valid evidence.v1 item from a packet file entry over a byte range.
// Offsets are snapped outward to code-point boundaries, so the item always
// verifies even when the requested window ends inside a multi-byte character.
export function buildEvidence(entry, start, end) {
  const data = entry.data;
  const s = ceilBoundary(data, Math.max(0, Math.min(start, data.length)));
  const e = Math.max(s, floorBoundary(data, Math.min(end, data.length)));
  const quote = data.subarray(s, e).toString('utf8');
  return {
    id: `${entry.path}@${s}-${e}`,
    file: entry.path,
    sha256: entry.sha256,
    start: s,
    end: e,
    quote,
  };
}

// Cite the member that carries an offending value: from the start of its key,
// through its value and into the surrounding container, capped at
// EVIDENCE_WINDOW bytes on a code-point boundary. `keyStart` and `valueEnd` are
// byte offsets from the span tree, so the cited span is the offending object
// rather than the first key with that name anywhere in the file.
export function locateMemberEvidence(entry, keyStart, valueEnd, containerEnd = valueEnd) {
  const from = Math.max(0, Math.min(keyStart, entry.data.length));
  const to = Math.max(valueEnd, Math.min(containerEnd, entry.data.length));
  const capped = Math.min(to, from + EVIDENCE_WINDOW);
  return buildEvidence(entry, from, Math.max(capped, from + 1));
}

/**
 * Errors, exit codes and small shared utilities.
 *
 * `fail` throws the `BookError` that the CLI turns into the single JSON line and the exit
 * code of docs/contracts.md §3 (0 success, 2 usage, 1 processing). The byte helpers are used
 * by the TrueType subsetter in ./truetype.mjs.
 */

import { readFileSync } from 'node:fs';

// Exit codes (docs/contracts.md §3): 0 success (default), 1 processing error,
// 2 usage error.
export const EXIT_PROCESSING = 1;
export const EXIT_USAGE = 2;

export class BookError extends Error {
  constructor(message, code, exitCode) {
    super(message);
    this.name = 'BookError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function fail(message, code, exitCode = EXIT_PROCESSING) {
  throw new BookError(message, code, exitCode);
}

export function readTextFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    return fail(`Cannot read ${file}: ${err.message}`, 'IO_ERROR');
  }
}

export function readBytesFile(file) {
  try {
    return readFileSync(file);
  } catch (err) {
    return fail(`Cannot read ${file}: ${err.message}`, 'IO_ERROR');
  }
}

export function readJsonFile(file) {
  const raw = readTextFile(file);
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fail(`Invalid JSON in ${file}: ${err.message}`, 'BAD_JSON');
  }
}

const LIGATURE_MAP = {
  '\u0219': 's', '\u021b': 't', '\u015f': 's', '\u0163': 't', '\u00df': 'ss',
  '\u00e6': 'ae', '\u0153': 'oe', '\u00f8': 'o', '\u00f0': 'd', '\u00fe': 'th',
};

export function slugify(title) {
  const folded = String(title).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let out = '';
  for (const ch of folded.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (LIGATURE_MAP[ch]) out += LIGATURE_MAP[ch];
    else out += '-';
  }
  out = out.replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
  return out || 'book';
}

export function countWords(text) {
  const matches = String(text).match(/[\p{L}\p{N}]+/gu);
  return matches ? matches.length : 0;
}

export function formatStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

export function pdfDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}Z`;
}

export function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** PDF string: UTF-16BE with BOM, in hexadecimal form (no escaping issues). */
export function pdfTextString(text) {
  let hex = 'feff';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return hex.toUpperCase();
}

/* --------------- Byte and big-endian helpers --------------- */

let crcTable = null;

/** CRC-32 (the ZIP member checksum) of a byte buffer. */
export function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[i] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function byteTag(bytes, off) {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

export function u16(bytes, off) {
  return (bytes[off] << 8) | bytes[off + 1];
}

export function i16(bytes, off) {
  const v = (bytes[off] << 8) | bytes[off + 1];
  return v & 0x8000 ? v - 0x10000 : v;
}

export function concatBytes(list) {
  let total = 0;
  for (const part of list) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of list) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function pad4(bytes) {
  const rem = bytes.length % 4;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + (4 - rem));
  out.set(bytes, 0);
  return out;
}

export function tableChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

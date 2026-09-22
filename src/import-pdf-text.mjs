// The content-stream half of the PDF import: the tokenizer that reads a decoded stream, the `Tj`,
// `TJ`, `'` and `"` operators that carry text, and the line and paragraph assembly built on the
// positioning operators `Td`, `TD`, `T*`, `Tm` and `TL`. `./import-pdf.mjs` owns the container — the
// indirect objects, their streams and the page tree — and calls into this module once per page.
//
// Invariants:
// - Text in, plain data out: no file, no module state, no dependency beyond the language itself.
// - An operator this reader does not understand is skipped, never guessed at. An unknown operator leaves
//   the text cursor where it was, so the worst case is a line that is not split, not text that is moved.
// - A string is decoded as UTF-16BE when it carries that byte order mark, as UTF-8 when the bytes decode
//   cleanly and as Latin-1 otherwise. A font with a character map of its own is not decoded here, and
//   `./import-pdf.mjs` warns when the result does not look like prose.
// - A vertical move starts a line and a move of more than one and a half lines ends the paragraph, so
//   blank-line separated paragraphs and hyphenated line breaks survive into the returned text.

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\0']);
const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

/** The numeric value of an operand token, or null when the token is not a number. */
function numberOf(value) {
  return value?.t === 'number' ? value.v : null;
}

// ---------------------------------------------------------------------------------------------
// The tokenizer and the operators that carry text.

function readLiteralString(text, start) {
  let index = start + 1;
  let depth = 1;
  let out = '';
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      const next = text[index + 1];
      if (next === undefined) {
        index += 1;
        break;
      }
      if (next === '\n') { index += 2; continue; }
      if (next === '\r') { index += text[index + 2] === '\n' ? 3 : 2; continue; }
      if (next === 'n') { out += '\n'; index += 2; continue; }
      if (next === 'r') { out += '\r'; index += 2; continue; }
      if (next === 't') { out += '\t'; index += 2; continue; }
      if (next === 'b') { out += '\b'; index += 2; continue; }
      if (next === 'f') { out += '\f'; index += 2; continue; }
      if (next >= '0' && next <= '7') {
        let digits = '';
        let cursor = index + 1;
        while (cursor < text.length && digits.length < 3 && text[cursor] >= '0' && text[cursor] <= '7') {
          digits += text[cursor];
          cursor += 1;
        }
        out += String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
        index = cursor;
        continue;
      }
      out += next;
      index += 2;
      continue;
    }
    if (char === '(') { depth += 1; out += char; index += 1; continue; }
    if (char === ')') {
      depth -= 1;
      index += 1;
      if (depth === 0) break;
      out += char;
      continue;
    }
    out += char;
    index += 1;
  }
  return { value: out, next: index };
}

function readHexString(text, start) {
  let index = start + 1;
  let hex = '';
  while (index < text.length && text[index] !== '>') {
    if (!WHITESPACE.has(text[index])) hex += text[index];
    index += 1;
  }
  if (index < text.length) index += 1;
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let at = 0; at + 1 < hex.length; at += 2) out += String.fromCharCode(Number.parseInt(hex.slice(at, at + 2), 16) || 0);
  return { value: out, next: index };
}

// An inline image (`BI ... ID <bytes> EI`) carries binary data that must not reach the tokenizer.
function inlineImageEnd(text, from) {
  let at = text.indexOf('EI', from);
  while (at >= 0) {
    const before = text[at - 1];
    const after = text[at + 2];
    if (WHITESPACE.has(before) && (after === undefined || WHITESPACE.has(after) || DELIMITERS.has(after))) return at + 2;
    at = text.indexOf('EI', at + 2);
  }
  return -1;
}

/** The tokens of a content stream: operands, strings, names, arrays and operators, in source order. */
export function tokenizeContent(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (WHITESPACE.has(char)) { index += 1; continue; }
    if (char === '%') {
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
      continue;
    }
    if (char === '(') {
      const read = readLiteralString(text, index);
      tokens.push({ t: 'string', v: read.value });
      index = read.next;
      continue;
    }
    if (char === '<' && text[index + 1] === '<') { index += 2; continue; }
    if (char === '>' && text[index + 1] === '>') { index += 2; continue; }
    if (char === '<') {
      const read = readHexString(text, index);
      tokens.push({ t: 'string', v: read.value });
      index = read.next;
      continue;
    }
    if (char === '[' || char === ']') { tokens.push({ t: char }); index += 1; continue; }
    if (char === '{' || char === '}') { index += 1; continue; }
    if (char === '/') {
      let cursor = index + 1;
      while (cursor < text.length && !WHITESPACE.has(text[cursor]) && !DELIMITERS.has(text[cursor])) cursor += 1;
      tokens.push({ t: 'name', v: text.slice(index + 1, cursor) });
      index = cursor;
      continue;
    }
    if (char === '+' || char === '-' || char === '.' || (char >= '0' && char <= '9')) {
      let cursor = index;
      if (text[cursor] === '+' || text[cursor] === '-') cursor += 1;
      while (cursor < text.length && ((text[cursor] >= '0' && text[cursor] <= '9') || text[cursor] === '.')) cursor += 1;
      const value = Number(text.slice(index, cursor));
      tokens.push({ t: 'number', v: Number.isFinite(value) ? value : 0 });
      index = cursor;
      continue;
    }
    let cursor = index;
    while (cursor < text.length && !WHITESPACE.has(text[cursor]) && !DELIMITERS.has(text[cursor])) cursor += 1;
    const word = text.slice(index, cursor);
    tokens.push({ t: 'op', v: word });
    index = cursor;
    if (word === 'BI') {
      const end = inlineImageEnd(text, cursor);
      tokens.push({ t: 'inlineImage' });
      index = end < 0 ? text.length : end;
    }
  }
  return tokens;
}

/** The text of one PDF string: UTF-16BE when it says so, otherwise UTF-8 when it decodes cleanly. */
export function pdfStringText(raw) {
  const bytes = Buffer.from(raw, 'latin1');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2, bytes.length - (bytes.length % 2));
    return Buffer.from(body).swap16().toString('utf16le').replace(/\u0000+$/, '');
  }
  const utf8 = bytes.toString('utf8');
  return utf8.includes('\uFFFD') ? bytes.toString('latin1') : utf8;
}

function joinArrayText(items) {
  let out = '';
  for (const item of items) {
    if (item.t === 'string') out += pdfStringText(item.v);
    else if (item.t === 'number' && item.v <= -100) out += ' ';
  }
  return out;
}

/**
 * The lines of one content stream. `y` follows the text cursor, so a vertical move starts a line and a
 * move larger than one and a half lines marks the paragraph a blank gap separated.
 */
export function interpretContent(text, { page = null } = {}) {
  const lines = [];
  const stack = [];
  let array = null;
  let size = 0;
  let leading = 0;
  let lineY = 0; // the absolute baseline of the line being built
  let origin = 0; // the y the relative moves of Td, TD and T* accumulate from; BT resets it, Tm sets it
  let lineText = '';
  let lineSize = 0;
  let lastSize = 0;
  let forms = 0;
  let inlineImages = 0;

  const flush = (breakAfter) => {
    const value = lineText.replace(/[\u0000-\u0008\u000b-\u001f\s]+/g, ' ').trim();
    if (value) lines.push({ text: value, size: lineSize || size, breakAfter: breakAfter === true, page });
    lastSize = lineSize || size;
    lineText = '';
    lineSize = 0;
  };
  // A vertical move starts a line. A move of more than one and a half lines is a blank gap, so the
  // paragraph the previous line belongs to ends there; the smaller of the two sizes is the unit,
  // because a heading followed by body text keeps its distance even in the body's own leading.
  const startLine = (nextY) => {
    if (lineText) {
      const unit = Math.min(lastSize || size || 10, size || lastSize || 10) || 10;
      flush(lineY - nextY > 1.5 * unit);
    }
    lineY = nextY;
    origin = nextY;
  };
  const step = () => leading || size * 1.2;
  const show = (value) => {
    if (!value) return;
    lineText += value;
    lineSize = Math.max(lineSize, size);
  };

  const run = (operator) => {
    if (operator === 'Tf') {
      const value = numberOf(stack[stack.length - 1]);
      if (value !== null && value > 0) size = value;
    } else if (operator === 'TL') {
      const value = numberOf(stack[0]);
      if (value !== null) leading = value;
    } else if (operator === 'BT') {
      origin = 0; // a new text object restarts the line matrix, the text cursor itself does not move
    } else if (operator === 'Td' || operator === 'TD') {
      const ty = numberOf(stack[stack.length - 1]) ?? 0;
      if (operator === 'TD') leading = -ty;
      if (ty !== 0) startLine(origin + ty);
    } else if (operator === 'Tm') {
      const value = numberOf(stack[5]);
      if (value !== null) startLine(value);
    } else if (operator === 'T*') {
      startLine(origin - step());
    } else if (operator === 'Tj') {
      show(pdfStringText(stack.find((item) => item.t === 'string')?.v ?? ''));
    } else if (operator === "'" || operator === '"') {
      startLine(origin - step());
      show(pdfStringText(stack.find((item) => item.t === 'string')?.v ?? ''));
    } else if (operator === 'TJ') {
      const items = stack.find((item) => item.t === 'array');
      if (items) show(joinArrayText(items.v));
    } else if (operator === 'Do') {
      forms += 1;
    }
  };

  for (const token of tokenizeContent(text)) {
    if (token.t === 'inlineImage') { inlineImages += 1; continue; }
    if (token.t === '[') { array = []; continue; }
    if (token.t === ']') { stack.push({ t: 'array', v: array ?? [] }); array = null; continue; }
    if (array) { array.push(token); continue; }
    if (token.t !== 'op') { stack.push(token); continue; }
    run(token.v);
    stack.length = 0;
  }
  flush(false);
  return { lines, forms, inlineImages };
}

/** The paragraphs of a page range: wrapped lines are joined and a hyphenated break is closed up. */
export function assembleParagraphs(lines) {
  const paragraphs = [];
  let buffer = null;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (buffer === null) {
      buffer = { text, size: line.size, lines: 1, page: line.page };
      if (line.breakAfter) { paragraphs.push(buffer); buffer = null; }
      continue;
    }
    if (/[A-Za-z\u00c0-\u024f]-$/.test(buffer.text) && /^[a-z\u00e0-\u024f]/.test(text)) {
      buffer.text = `${buffer.text.slice(0, -1)}${text}`;
    } else {
      buffer.text = `${buffer.text} ${text}`;
    }
    buffer.lines += 1;
    buffer.size = Math.max(buffer.size, line.size);
    if (line.breakAfter) { paragraphs.push(buffer); buffer = null; }
  }
  if (buffer) paragraphs.push(buffer);
  return paragraphs;
}

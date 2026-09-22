// Position-aware JSON parsing (no external dependencies).
//
// A plain JSON.parse loses the byte offset of every value, which forces a check
// to search for the first occurrence of a key and cite the wrong object when a
// key repeats. This parser returns a span tree instead: every node carries the
// exact byte range of its own token, so evidence can cite the offending value.
//
// Node shape:
//   { type: 'object', start, end, members: [{ key, keyStart, keyEnd, value }] }
//   { type: 'array',  start, end, items: [node] }
//   { type: 'string'|'number'|'boolean'|'null', start, end, value }
//
// Offsets are zero-based half-open UTF-8 byte offsets into the original file.

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class JsonSpanError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'JsonSpanError';
    this.offset = offset;
  }
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

// Parse JSON bytes into a span tree. Throws JsonSpanError with a byte offset.
export function parseJsonSpans(data) {
  let i = 0;

  const error = (message) => new JsonSpanError(`${message} at byte ${i}`, i);

  const skipWs = () => {
    while (i < data.length && WS.has(data[i])) i += 1;
  };

  const expect = (byte, what) => {
    if (i >= data.length || data[i] !== byte) throw error(`expected ${what}`);
    i += 1;
  };

  const parseString = () => {
    const start = i;
    expect(0x22, '"');
    let closed = false;
    while (i < data.length) {
      const byte = data[i];
      if (byte === 0x5c) {
        i += 2; // escape: the next byte can never close the string
        continue;
      }
      if (byte === 0x22) {
        i += 1;
        closed = true;
        break;
      }
      i += 1;
    }
    if (!closed) throw error('unterminated string');
    const raw = data.subarray(start, i).toString('utf8');
    let value;
    try {
      value = JSON.parse(raw);
    } catch (cause) {
      throw error(`invalid string literal: ${cause.message}`);
    }
    return { type: 'string', start, end: i, value };
  };

  const parseNumber = () => {
    const start = i;
    if (i < data.length && data[i] === 0x2d) i += 1;
    while (i < data.length && data[i] >= 0x30 && data[i] <= 0x39) i += 1;
    if (i < data.length && data[i] === 0x2e) {
      i += 1;
      while (i < data.length && data[i] >= 0x30 && data[i] <= 0x39) i += 1;
    }
    if (i < data.length && (data[i] === 0x65 || data[i] === 0x45)) {
      i += 1;
      if (i < data.length && (data[i] === 0x2b || data[i] === 0x2d)) i += 1;
      while (i < data.length && data[i] >= 0x30 && data[i] <= 0x39) i += 1;
    }
    const raw = data.subarray(start, i).toString('utf8');
    const value = Number(raw);
    if (raw.length === 0 || Number.isNaN(value)) throw error('invalid number');
    return { type: 'number', start, end: i, value };
  };

  const parseValue = () => {
    skipWs();
    if (i >= data.length) throw error('unexpected end of input');
    const byte = data[i];
    if (byte === 0x7b) return parseObject();
    if (byte === 0x5b) return parseArray();
    if (byte === 0x22) return parseString();
    if (byte === 0x74) {
      const start = i;
      if (data.subarray(i, i + 4).toString('utf8') !== 'true') throw error('invalid literal');
      i += 4;
      return { type: 'boolean', start, end: i, value: true };
    }
    if (byte === 0x66) {
      const start = i;
      if (data.subarray(i, i + 5).toString('utf8') !== 'false') throw error('invalid literal');
      i += 5;
      return { type: 'boolean', start, end: i, value: false };
    }
    if (byte === 0x6e) {
      const start = i;
      if (data.subarray(i, i + 4).toString('utf8') !== 'null') throw error('invalid literal');
      i += 4;
      return { type: 'null', start, end: i, value: null };
    }
    if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) return parseNumber();
    throw error(`unexpected byte 0x${byte.toString(16)}`);
  };

  const parseObject = () => {
    const start = i;
    expect(0x7b, '{');
    const members = [];
    skipWs();
    if (i < data.length && data[i] === 0x7d) {
      i += 1;
      return { type: 'object', start, end: i, members };
    }
    for (;;) {
      skipWs();
      const keyStart = i;
      const key = parseString();
      skipWs();
      expect(0x3a, ':');
      const value = parseValue();
      members.push({ key: key.value, keyStart, keyEnd: key.end, value });
      skipWs();
      if (i < data.length && data[i] === 0x2c) {
        i += 1;
        continue;
      }
      expect(0x7d, '}');
      return { type: 'object', start, end: i, members };
    }
  };

  const parseArray = () => {
    const start = i;
    expect(0x5b, '[');
    const items = [];
    skipWs();
    if (i < data.length && data[i] === 0x5d) {
      i += 1;
      return { type: 'array', start, end: i, items };
    }
    for (;;) {
      items.push(parseValue());
      skipWs();
      if (i < data.length && data[i] === 0x2c) {
        i += 1;
        continue;
      }
      expect(0x5d, ']');
      return { type: 'array', start, end: i, items };
    }
  };

  const root = parseValue();
  skipWs();
  if (i !== data.length) throw error('unexpected trailing content');
  return root;
}

// First member of an object node with this key, or null. Repeating a key is
// legal JSON, so the first occurrence wins, as `JSON.parse` does for a value.
export function memberNamed(node, key) {
  if (node === null || node.type !== 'object') return null;
  return node.members.find((member) => member.key === key) ?? null;
}

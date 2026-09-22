// Small structural helpers for the chapter validator: the rules that decide whether a value in a
// plan, a thread, an atlas node or an offer is usable. They are deliberately mechanical — the
// validator proves that a declaration exists and is well formed, never that it is dramatically good.

const PLACEHOLDERS = new Set(['-', '--', '?', 'n/a', 'na', 'none', 'null', 'tbd', 'todo', 'niciun', 'niciuna', 'niciunul', 'niciunele']);

/** A value that carries information: long enough, with a letter, and not a placeholder word. */
export function meaningful(value) {
  const text = String(value ?? '')
    .replace(/^[`*_"'\[\]]+|[`*_"'\[\]]+$/g, '')
    .trim();
  if (text.length < 3) return false;
  if (!/\p{L}/u.test(text)) return false;
  return !PLACEHOLDERS.has(text.toLowerCase().replace(/[.!]+$/, ''));
}

/** A finite integer, or `null` when the value is absent or not an integer. */
export function integer(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

/** A non-empty string identifier with no surrounding whitespace. */
export function identifier(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && !/\s/.test(text) ? text : null;
}

/** Whether a string is a member of a documented set, ignoring case. */
export function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value.trim().toLowerCase());
}

/** The number of sentences in a short reader-facing text. */
export function sentenceCount(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/[.!?…]+[\s"»”)]|$/u).filter((part) => /\p{L}/u.test(part)).length;
}

/** The number of words in a short label. */
export function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The dotted paths of duplicate keys in a JSON document, for example `open[0].id`.
 *
 * `JSON.parse` keeps the last of two identical keys, so a duplicated key silently erases a
 * declaration: `{"due_chapter": 3, "due_chapter": 9}` is valid JSON and a lie. The scan runs only
 * after a successful parse, so on invalid JSON it never has to report syntax.
 */
export function duplicateKeys(raw) {
  const text = String(raw ?? '');
  const duplicates = [];
  let index = 0;

  const skipSpace = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };

  const readString = () => {
    index += 1;
    let out = '';
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        return out;
      }
      if (char === '\\') {
        out += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      out += char;
      index += 1;
    }
    return out;
  };

  const walk = (path) => {
    skipSpace();
    const char = text[index];
    if (char === '{') {
      index += 1;
      const seen = new Set();
      for (;;) {
        skipSpace();
        if (index >= text.length) return;
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] === ',') {
          index += 1;
          continue;
        }
        if (text[index] !== '"') {
          index += 1;
          continue;
        }
        const key = readString();
        if (seen.has(key)) duplicates.push(path ? `${path}.${key}` : key);
        seen.add(key);
        skipSpace();
        if (text[index] === ':') {
          index += 1;
          walk(path ? `${path}.${key}` : key);
        }
      }
    }
    if (char === '[') {
      index += 1;
      let position = 0;
      for (;;) {
        skipSpace();
        if (index >= text.length) return;
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] === ',') {
          index += 1;
          continue;
        }
        walk(`${path}[${position}]`);
        position += 1;
      }
    }
    if (char === '"') {
      // A string scalar may contain `,`, `}` or `]`; it must be consumed whole, or the scan resumes
      // inside the text and reads prose as keys.
      readString();
      return;
    }
    while (index < text.length && !/[,}\]]/.test(text[index])) index += 1;
  };

  walk('');
  return duplicates;
}

// The container half of the PDF import (`./import.mjs`), and the module that answers `extractPdf`. A
// PDF has no document text of its own: its text lives in the content streams of its pages. This module
// reads the indirect objects, inflates the streams with `node:zlib`, walks the page tree, and hands each
// page's decoded stream to `./import-pdf-text.mjs`, which owns the operators, the lines and the
// paragraphs.
//
// Invariants:
// - The result is derived from the bytes alone: no module state, no writing, no working-directory path.
// - A file that is not a readable PDF is refused with a code and a message, never with a stack trace:
//   a missing `%PDF-` header, a page tree this reader cannot follow, a stream that cannot be inflated.
// - A scanned book has no text layer, so it is refused with `IMPORT_NO_TEXT` and a message naming the
//   number of pages examined. The importer never guesses text and never returns an empty book.
// - `PDF_LIMITS` bounds the work: more objects than `maxObjects`, more pages than `maxPages`, or a
//   stream that inflates beyond `maxStreamBytes` is refused with `IMPORT_TOO_LARGE` instead of hanging.
// - What cannot be read is reported, not hidden: a content stream under an unsupported filter and a
//   `Do` operator that draws inside a form XObject both become warnings, so a partial result says so.
//
// Known limits of this reader, stated again in its warnings: compressed object streams are expanded,
// but embedded-font character maps are not decoded, so a page set in a subset font comes out as character
// codes and the result is warned about; form XObjects are not expanded; and only FlateDecode,
// ASCIIHexDecode, ASCII85Decode and RunLengthDecode streams are inflated.
import { inflateRawSync, inflateSync } from 'node:zlib';
import { UniverseError } from './errors.mjs';
import { assembleParagraphs, interpretContent, pdfStringText, tokenizeContent } from './import-pdf-text.mjs';

/** The bounds of the PDF path: page count, indirect object count and inflated stream size. */
export const PDF_LIMITS = { maxPages: 2000, maxObjects: 20000, maxStreamBytes: 32 * 1024 * 1024 };

const PDF_MAGIC = '%PDF-';
// The trailer dictionary of a file is small; the bound only keeps a malformed file from scanning the
// whole stream of bytes looking for the closing `>>`.
const TRAILER_LIMIT = 4000;

const OBJECT_RE = /(\d{1,7})\s+(\d{1,5})\s+obj\b/g;

function unreadable(message) {
  return new UniverseError('IMPORT_UNREADABLE', message, 400);
}

function tooLarge(message) {
  return new UniverseError('IMPORT_TOO_LARGE', message, 413);
}

// ---------------------------------------------------------------------------------------------
// The object table: the indirect objects of the file, with their stream data kept as Latin-1 text.

function findStreamKeyword(text, from, limit) {
  let at = text.indexOf('stream', from);
  while (at >= 0 && at < limit) {
    const after = text[at + 6];
    const before = text[at - 1];
    if ((after === '\n' || after === '\r') && (before === '\n' || before === '\r' || before === ' ')) return at;
    at = text.indexOf('stream', at + 6);
  }
  return -1;
}

function streamExtent(text, dict, dataAt, endObjAt) {
  const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
  if (declared) {
    const end = dataAt + Number(declared[1]);
    let cursor = end;
    if (text[cursor] === '\r') cursor += 1;
    if (text[cursor] === '\n') cursor += 1;
    if (text.startsWith('endstream', cursor)) return { end, next: cursor + 9 };
  }
  const endstreamAt = text.indexOf('endstream', dataAt);
  if (endstreamAt < 0) return { end: endObjAt, next: endObjAt + 6 };
  let end = endstreamAt;
  if (text[end - 1] === '\n') end -= 1;
  if (text[end - 1] === '\r') end -= 1;
  return { end, next: endstreamAt + 9 };
}

function scanObjects(text, bounds) {
  const objects = new Map();
  let match;
  OBJECT_RE.lastIndex = 0;
  while ((match = OBJECT_RE.exec(text)) !== null) {
    if (objects.size >= bounds.maxObjects) {
      throw tooLarge(`The PDF holds more than ${bounds.maxObjects} indirect objects, above the bound the importer reads.`);
    }
    const num = Number(match[1]);
    const bodyAt = match.index + match[0].length;
    const endObjAt = text.indexOf('endobj', bodyAt);
    if (endObjAt < 0) break; // A torn tail: what was read before it is still usable.
    const streamAt = findStreamKeyword(text, bodyAt, endObjAt);
    if (streamAt < 0) {
      objects.set(num, { num, dict: text.slice(bodyAt, endObjAt), raw: null });
      OBJECT_RE.lastIndex = endObjAt + 6;
      continue;
    }
    const dict = text.slice(bodyAt, streamAt);
    const keywordEnd = streamAt + 6;
    let dataAt = keywordEnd;
    if (text[keywordEnd] === '\r') dataAt += 1;
    if (text[dataAt] === '\n') dataAt += 1;
    const { end, next } = streamExtent(text, dict, dataAt, endObjAt);
    objects.set(num, { num, dict, raw: text.slice(dataAt, end) });
    OBJECT_RE.lastIndex = next;
  }
  return objects;
}

function filterNames(dict) {
  const match = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (!match) return [];
  return [...match[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((entry) => entry[1]);
}

function inflateAny(data) {
  try {
    return inflateSync(data);
  } catch {
    // A few producers write raw deflate where the standard asks for a zlib wrapper.
  }
  try {
    return inflateRawSync(data);
  } catch {
    return null;
  }
}

function asciiHexDecode(data) {
  const digits = data.toString('latin1').replace(/[^0-9A-Fa-f]/g, '');
  const out = Buffer.alloc(digits.length >> 1);
  for (let index = 0; index + 1 < digits.length; index += 2) {
    out[index >> 1] = Number.parseInt(digits.slice(index, index + 2), 16);
  }
  return out;
}

function ascii85Decode(data) {
  const text = data.toString('latin1').replace(/\s+/g, '');
  const out = [];
  let group = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '~') break;
    if (char === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const value = char.charCodeAt(0) - 33;
    if (value < 0 || value > 84) continue;
    group.push(value);
    if (group.length === 5) {
      let packed = 0;
      for (const digit of group) packed = packed * 85 + digit;
      out.push((packed >>> 24) & 0xff, (packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const fill = 5 - group.length;
    let packed = 0;
    for (const digit of [...group, ...Array(fill).fill(84)]) packed = packed * 85 + digit;
    const bytes = [(packed >>> 24) & 0xff, (packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff];
    out.push(...bytes.slice(0, 4 - fill));
  }
  return Buffer.from(out);
}

function runLengthDecode(data) {
  const out = [];
  let index = 0;
  while (index < data.length) {
    const length = data[index];
    index += 1;
    if (length === 128) break;
    if (length < 128) {
      for (let count = 0; count <= length && index < data.length; count += 1) out.push(data[index + count]);
      index += length + 1;
    } else if (index < data.length) {
      for (let count = 0; count < 257 - length; count += 1) out.push(data[index]);
      index += 1;
    }
  }
  return Buffer.from(out);
}

/** The decoded bytes of a stream, or null when its filter is one this reader does not decode. */
function decodeStream(object, bounds) {
  if (object.raw === null) return null;
  let data = Buffer.from(object.raw, 'latin1');
  for (const filter of filterNames(object.dict)) {
    if (filter === 'FlateDecode' || filter === 'Fl') data = inflateAny(data);
    else if (filter === 'ASCIIHexDecode' || filter === 'AHx') data = asciiHexDecode(data);
    else if (filter === 'ASCII85Decode' || filter === 'A85') data = ascii85Decode(data);
    else if (filter === 'RunLengthDecode' || filter === 'RL') data = runLengthDecode(data);
    else return null;
    if (data === null) return null;
    if (data.length > bounds.maxStreamBytes) {
      throw tooLarge(`A stream inflates to ${data.length} bytes, above the ${bounds.maxStreamBytes} bytes the importer reads.`);
    }
  }
  return data;
}

// An object stream (PDF 1.5) hides small indirect objects, including the page tree, inside a stream.
function readObjectStreams(objects, bounds) {
  for (const object of [...objects.values()]) {
    if (object.raw === null || !/\/Type\s*\/ObjStm\b/.test(object.dict)) continue;
    const count = Number.parseInt(/\/N\s+(\d+)/.exec(object.dict)?.[1] ?? '', 10);
    const first = Number.parseInt(/\/First\s+(\d+)/.exec(object.dict)?.[1] ?? '', 10);
    if (!Number.isInteger(count) || !Number.isInteger(first)) continue;
    const data = decodeStream(object, bounds);
    if (data === null || first > data.length) continue;
    const text = data.toString('latin1');
    const pairs = [...text.slice(0, first).matchAll(/(\d+)\s+(\d+)/g)].map((entry) => Number(entry[1]));
    for (let index = 0; index + 1 < pairs.length; index += 2) {
      const num = pairs[index];
      if (objects.has(num)) continue;
      const start = first + pairs[index + 1];
      const stop = index + 3 < pairs.length ? first + pairs[index + 3] : text.length;
      if (start > text.length) continue;
      objects.set(num, { num, dict: text.slice(start, Math.max(start, Math.min(stop, text.length))), raw: null });
      if (objects.size > bounds.maxObjects) {
        throw tooLarge(`The PDF expands to more than ${bounds.maxObjects} indirect objects, above the bound the importer reads.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The page tree.

function dictionaryEntries(dict, key) {
  const match = new RegExp(`/${key}\\b\\s*(\\[[^\\]]*\\]|\\d+\\s+\\d+\\s+R|\\/[^\\s/<>\\[\\]()]+)`).exec(dict);
  if (!match) return { refs: [], name: null };
  const value = match[1];
  if (value.startsWith('/')) return { refs: [], name: value.slice(1) };
  if (value.startsWith('[')) {
    return { refs: [...value.matchAll(/(\d+)\s+\d+\s+R/g)].map((entry) => Number(entry[1])), name: null };
  }
  return { refs: [Number(value.split(/\s+/)[0])], name: null };
}

/** The page objects in reading order, through `/Root`, `/Pages` and `/Kids`, with a flat fallback. */
export function collectPages(objects) {
  const pages = [];
  const seen = new Set();
  const visit = (num, depth) => {
    if (depth > 64 || seen.has(num)) return;
    seen.add(num);
    const object = objects.get(num);
    if (!object) return;
    if (/\/Type\s*\/Page(?![A-Za-z])/.test(object.dict)) {
      pages.push(object);
      return;
    }
    for (const kid of dictionaryEntries(object.dict, 'Kids').refs) visit(kid, depth + 1);
  };
  const catalog = [...objects.values()].find((object) => /\/Type\s*\/Catalog\b/.test(object.dict));
  const root = catalog ? dictionaryEntries(catalog.dict, 'Pages').refs[0] : undefined;
  if (root !== undefined) visit(root, 0);
  if (pages.length === 0) {
    for (const object of [...objects.values()].sort((left, right) => left.num - right.num)) {
      if (/\/Type\s*\/Page(?![A-Za-z])/.test(object.dict)) pages.push(object);
    }
  }
  return pages;
}

// ---------------------------------------------------------------------------------------------
// The document.

function dictStringValue(dict, key) {
  const tokens = tokenizeContent(dict);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index].t === 'name' && tokens[index].v === key && tokens[index + 1].t === 'string') {
      return pdfStringText(tokens[index + 1].v);
    }
  }
  return null;
}

function infoDictionary(objects, text) {
  const trailers = [...text.matchAll(/trailer\s*<<([\s\S]{0,TRAILER_LIMIT}?)>>/g)];
  const ref = trailers.length ? dictionaryEntries(trailers[trailers.length - 1][1], 'Info').refs[0] : undefined;
  if (ref !== undefined && objects.has(ref)) return objects.get(ref).dict;
  return [...objects.values()].find((object) => /\/Producer\b/.test(object.dict) && /\/Title\b/.test(object.dict))?.dict ?? null;
}

// A page set in an embedded subset font without a readable encoding yields character codes instead of
// prose: the glyphs are there, but nothing tells this reader which letter each code stands for. The
// share of characters that are letters, digits or ordinary punctuation separates such a page from real
// text (measured on a real book: 0.98 for prose, 0.53 for undecoded font codes), and the extractor says
// so instead of presenting the codes as a book.
const NON_PROSE_CHARACTERS = /[^A-Za-z0-9\s.,;:!?'"()\-–—…«»„“”]/g;
const MIN_PROSE_SHARE = 0.85;

function proseShare(text) {
  if (!text) return 1;
  // Removing every character outside the set leaves exactly the ones prose is made of.
  return text.replace(NON_PROSE_CHARACTERS, '').length / text.length;
}

/**
 * The text of a PDF: the pages examined, the paragraphs with the font size each was set in, and the
 * metadata of the document information dictionary. Text without a text layer is refused here.
 */
export function extractPdf({ bytes, limits = {} } = {}) {
  const bounds = { ...PDF_LIMITS, ...limits };
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const head = data.subarray(0, PDF_MAGIC.length).toString('latin1');
  if (head !== PDF_MAGIC) {
    throw unreadable(`The file does not start with a PDF header (%PDF-); it starts with ${JSON.stringify(data.subarray(0, 8).toString('latin1'))}.`);
  }
  const text = data.toString('latin1');
  const objects = scanObjects(text, bounds);
  readObjectStreams(objects, bounds);
  const pages = collectPages(objects);
  if (pages.length === 0) throw unreadable('The PDF has no readable page object, so its text cannot be located.');
  if (pages.length > bounds.maxPages) {
    throw tooLarge(`The PDF declares ${pages.length} pages, above the ${bounds.maxPages} pages the importer reads.`);
  }

  const warnings = [];
  const paragraphs = [];
  let unreadableStreams = 0;
  let forms = 0;
  let inlineImages = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const chunks = [];
    for (const ref of dictionaryEntries(pages[index].dict, 'Contents').refs) {
      const object = objects.get(ref);
      if (!object) continue;
      const stream = decodeStream(object, bounds);
      if (stream === null) { unreadableStreams += 1; continue; }
      chunks.push(stream.toString('latin1'));
    }
    const interpreted = interpretContent(chunks.join('\n'), { page: index + 1 });
    forms += interpreted.forms;
    inlineImages += interpreted.inlineImages;
    paragraphs.push(...assembleParagraphs(interpreted.lines));
  }

  const characters = paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0);
  if (paragraphs.length === 0 || characters < 8) {
    throw new UniverseError(
      'IMPORT_NO_TEXT',
      `The PDF was examined page by page (${pages.length} page(s)) and yielded no text: it has no text layer, so a scanned book must be recognised by OCR before it is imported.`,
      422
    );
  }
  if (unreadableStreams > 0) {
    warnings.push(`${unreadableStreams} content stream(s) use a filter the importer does not decode; text inside them is missing from this result.`);
  }
  if (forms > 0) {
    warnings.push(`${forms} content stream(s) draw through a \`Do\` operator; text or images inside a form XObject are not expanded and are missing from this result.`);
  }
  if (inlineImages > 0) warnings.push(`${inlineImages} inline image(s) were skipped; they carry no text.`);
  const share = proseShare(paragraphs.map((paragraph) => paragraph.text).join('\n'));
  if (share < MIN_PROSE_SHARE) {
    warnings.push(`Only ${Math.round(share * 100)}% of the extracted characters are letters, digits or ordinary punctuation, which usually means the pages are set in an embedded font whose character encoding this importer does not decode; treat the extracted text as unverified.`);
  }
  const info = infoDictionary(objects, text);
  const language = info === null ? null : dictStringValue(info, 'Lang');
  return {
    pages: pages.length,
    paragraphs,
    title: info === null ? null : dictStringValue(info, 'Title'),
    author: info === null ? null : dictStringValue(info, 'Author'),
    language: language === null ? null : language.toLowerCase().split(/[-_]/)[0],
    warnings
  };
}

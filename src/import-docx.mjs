// The DOCX half of the book import (`./import.mjs`). A DOCX is a ZIP package whose main document part
// is `word/document.xml`, so this module reads the container's central directory itself and inflates
// only the parts it needs with `node:zlib`; nothing is written to disk and no dependency is added.
//
// Invariants:
// - The result is derived from the bytes alone: no module state, no working-directory path, no write.
// - A package that is not a readable DOCX is refused with a code and a message, never with a stack
//   trace: a missing ZIP signature, a torn central directory, an entry that disagrees with its local
//   header, an encrypted entry, a part that cannot be inflated, or a part that inflates to a different
//   size than its directory entry declares.
// - `word/document.xml` is required. A package that does not list that part is refused with
//   `IMPORT_UNREADABLE`, because the document text cannot exist without it.
// - More entries than `DOCX_LIMITS.maxEntries`, or a part larger than `DOCX_LIMITS.maxPartBytes`, is
//   refused with `IMPORT_TOO_LARGE` before anything is inflated: a pathological package is refused,
//   it never runs the importer out of time or memory.
// - Paragraphs keep document order, empty paragraphs are dropped, XML entities are decoded, and each
//   paragraph carries the depth its `w:pStyle` (or `w:outlineLvl`) gives it. Which of those depths
//   starts a chapter is decided once, in the shared segmentation of `./import.mjs`.
import { inflateRawSync } from 'node:zlib';
import { UniverseError } from './errors.mjs';

/** The bounds of the DOCX path: an entry count and a per-part inflated size. */
export const DOCX_LIMITS = { maxEntries: 512, maxPartBytes: 32 * 1024 * 1024 };

// The parts an import needs. Media, styles and headers are listed by the directory but never inflated.
const WANTED_PARTS = ['word/document.xml', 'docProps/core.xml', 'docProps/app.xml'];
const MAIN_PART = 'word/document.xml';

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_END_SIZE = 22;
const ZIP_MAX_COMMENT = 0xffff;
const ZIP64 = 0xffffffff;

function unreadable(message) {
  return new UniverseError('IMPORT_UNREADABLE', message, 400);
}

function tooLarge(message) {
  return new UniverseError('IMPORT_TOO_LARGE', message, 413);
}

function findEndOfCentralDirectory(bytes) {
  const lowest = Math.max(0, bytes.length - ZIP_END_SIZE - ZIP_MAX_COMMENT);
  for (let at = bytes.length - ZIP_END_SIZE; at >= lowest; at--) {
    if (bytes.readUInt32LE(at) === ZIP_END) return at;
  }
  return -1;
}

// One central directory entry, kept so a wanted part can be inflated lazily.
function readCentralEntry(bytes, at) {
  return {
    nameLength: bytes.readUInt16LE(at + 28),
    extraLength: bytes.readUInt16LE(at + 30),
    commentLength: bytes.readUInt16LE(at + 32),
    flags: bytes.readUInt16LE(at + 8),
    method: bytes.readUInt16LE(at + 10),
    compressedSize: bytes.readUInt32LE(at + 20),
    size: bytes.readUInt32LE(at + 24),
    localOffset: bytes.readUInt32LE(at + 42)
  };
}

function inflateEntry(bytes, entry, name, limits) {
  if (entry.flags & 0x1) throw unreadable(`${name} is encrypted and cannot be read.`);
  if (entry.size === ZIP64 || entry.compressedSize === ZIP64) {
    throw unreadable(`${name} declares ZIP64 entry sizes, which the importer does not read.`);
  }
  if (entry.size > limits.maxPartBytes) {
    throw tooLarge(`${name} declares ${entry.size} bytes, above the ${limits.maxPartBytes} bytes the importer inflates.`);
  }
  const { localOffset } = entry;
  if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== ZIP_LOCAL) {
    throw unreadable(`${name} has no local file header at the offset its directory entry gives.`);
  }
  const nameLength = bytes.readUInt16LE(localOffset + 26);
  const extraLength = bytes.readUInt16LE(localOffset + 28);
  const dataAt = localOffset + 30 + nameLength + extraLength;
  if (dataAt + entry.compressedSize > bytes.length) {
    throw unreadable(`${name} extends past the end of the file.`);
  }
  const payload = bytes.subarray(dataAt, dataAt + entry.compressedSize);
  let content;
  if (entry.method === 0) content = payload;
  else if (entry.method === 8) {
    try {
      content = inflateRawSync(payload);
    } catch (error) {
      throw unreadable(`The compressed data of ${name} cannot be inflated (${error.message}).`);
    }
  } else throw unreadable(`${name} uses the unsupported compression method ${entry.method}.`);
  if (content.length !== entry.size) {
    throw unreadable(`${name} inflates to ${content.length} bytes instead of the ${entry.size} its directory entry declares.`);
  }
  return content;
}

/**
 * Reads a ZIP package. `wanted` limits inflation to the named entries, `required` names the entries
 * that must be listed by the central directory, and the answer maps entry name to inflated bytes.
 */
export function unzipParts(bytes, { wanted = null, required = [], ...limits } = {}) {
  const bounds = { ...DOCX_LIMITS, ...limits };
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (data.length < ZIP_END_SIZE || data.readUInt32LE(0) !== ZIP_LOCAL) {
    throw unreadable('The file does not start with a ZIP local file header, so it is not a DOCX package.');
  }
  const endAt = findEndOfCentralDirectory(data);
  if (endAt < 0) throw unreadable('The file has no ZIP end of central directory record, so it is not a readable DOCX package.');
  const entryCount = data.readUInt16LE(endAt + 10);
  const centralSize = data.readUInt32LE(endAt + 12);
  const centralOffset = data.readUInt32LE(endAt + 16);
  if (entryCount === 0) throw unreadable('The package has an empty central directory.');
  if (entryCount > bounds.maxEntries) {
    throw tooLarge(`The package holds ${entryCount} entries, above the ${bounds.maxEntries} entries the importer reads.`);
  }
  if (centralOffset + centralSize > data.length) throw unreadable('The central directory of the package lies past the end of the file.');

  const parts = new Map();
  const listed = new Set();
  let at = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== ZIP_CENTRAL) {
      throw unreadable(`Central directory entry ${index + 1} does not parse.`);
    }
    const entry = readCentralEntry(data, at);
    const name = data.subarray(at + 46, at + 46 + entry.nameLength).toString('utf8');
    at += 46 + entry.nameLength + entry.extraLength + entry.commentLength;
    if (!name) throw unreadable(`Central directory entry ${index + 1} has no name.`);
    listed.add(name);
    if (wanted === null || wanted.includes(name)) parts.set(name, inflateEntry(data, entry, name, bounds));
  }
  for (const name of required) {
    if (!listed.has(name)) throw unreadable(`The package has no ${name} part.`);
  }
  return parts;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the XML entities of a document part: the five built-ins, `&nbsp;` and numeric references. */
export function decodeXml(text) {
  return String(text ?? '').replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const value = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // A reference to no character, a surrogate or a value beyond Unicode is not text: it is dropped.
      if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '';
      return String.fromCodePoint(value);
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

// A paragraph and its runs. `w:tab`, `w:br` and `w:cr` flatten to a space, because the imported
// contract carries prose whose paragraphs are single blocks separated by blank lines.
const PARAGRAPH_RE = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
const RUN_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)\b[^>]*\/?>/g;
const STYLE_RE = /<w:pStyle\b[^>]*w:val="([^"]*)"/;
const OUTLINE_RE = /<w:outlineLvl\b[^>]*w:val="(\d+)"/;

// The style identifiers Word, LibreOffice and the book exporter use for a title and for heading depth.
const TITLE_STYLE = /^(title|titlu|titre|titel|título)$/i;
const HEADING_STYLES = [/^heading\s*([1-9])$/i, /^h([1-6])$/i, /^titlu\s*([1-9])$/i, /^titre\s*([1-9])$/i];

function headingDepth(style) {
  if (!style) return null;
  for (const pattern of HEADING_STYLES) {
    const match = pattern.exec(style.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

function paragraphText(body) {
  let text = '';
  RUN_RE.lastIndex = 0;
  let match;
  while ((match = RUN_RE.exec(body)) !== null) {
    text += match[1] === undefined ? ' ' : decodeXml(match[1]);
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** The paragraphs of a `word/document.xml` part, in document order, with empty paragraphs dropped. */
export function documentParagraphs(xml) {
  const paragraphs = [];
  PARAGRAPH_RE.lastIndex = 0;
  let match;
  while ((match = PARAGRAPH_RE.exec(xml)) !== null) {
    const body = match[1] ?? '';
    const text = paragraphText(body);
    if (!text) continue;
    const style = STYLE_RE.exec(body)?.[1] ?? null;
    const outline = OUTLINE_RE.exec(body)?.[1];
    const depth = headingDepth(style) ?? (outline === undefined ? null : Number(outline) + 1);
    paragraphs.push({ text, size: null, lines: 1, depth, title: TITLE_STYLE.test(style ?? '') });
  }
  return paragraphs;
}

function readField(xml, tag) {
  if (!xml) return null;
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  const value = match ? decodeXml(match[1]).replace(/\s+/g, ' ').trim() : '';
  return value || null;
}

function readDeclaredPages(xml) {
  const raw = readField(xml, 'Pages');
  const pages = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(pages) && pages > 0 ? pages : null;
}

/**
 * The text of a DOCX package: the document title, the author and language of its core properties, the
 * page count Word last recorded (or null, because a DOCX carries no layout), and the paragraphs.
 */
export function extractDocx({ bytes } = {}) {
  const parts = unzipParts(bytes, { wanted: WANTED_PARTS, required: [MAIN_PART] });
  const xml = parts.get(MAIN_PART).toString('utf8');
  const core = parts.get('docProps/core.xml')?.toString('utf8') ?? null;
  const paragraphs = documentParagraphs(xml);
  let title = readField(core, 'dc:title');
  let author = readField(core, 'dc:creator');
  const language = readField(core, 'dc:language');
  const warnings = [];
  const kept = [];
  let titleSeen = false;
  for (const paragraph of paragraphs) {
    // The first title-styled paragraph is the title of the book, not a division of it, and the title
    // recorded in the core properties wins over it. A later title-styled paragraph is a top-level
    // division, so it keeps depth 1 next to the first heading level of the document.
    if (paragraph.title && !titleSeen) {
      titleSeen = true;
      if (title === null) title = paragraph.text;
      continue;
    }
    kept.push(paragraph.title ? { ...paragraph, depth: 1 } : paragraph);
  }
  if (author === null) warnings.push('The DOCX declares no author in docProps/core.xml.');
  return {
    title,
    author,
    language: language === null ? null : language.toLowerCase().split(/[-_]/)[0],
    pages: readDeclaredPages(parts.get('docProps/app.xml')?.toString('utf8') ?? null),
    paragraphs: kept,
    warnings
  };
}

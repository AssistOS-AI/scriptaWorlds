/**
 * Structural verification of a produced edition, with no external tool and no npm dependency: a
 * produced file is proved readable before the CLI reports success.
 *
 * The PDF path checks what the writer of ./pdf.mjs guarantees: the `%PDF-` header, the objects and
 * their `endobj`, the cross-reference table the `startxref` offset points at, the trailer with the
 * root reference (which must reach a `/Type /Catalog` object) and the page count read from the page
 * objects, cross-checked with the `/Count` of the page tree.
 *
 * The DOCX path checks the ZIP container of ./docx.mjs entry by entry — central directory, local
 * headers, sizes and CRC-32 — the OOXML parts an edition must carry, and that `word/document.xml`
 * is well formed and yields at least one paragraph.
 *
 * Codes: `BAD_PDF` and `BAD_DOCX` exit 1 (docs/contracts.md §3: the file is not an edition a reader
 * could open, so the run is a processing failure); `USAGE` exits 2 (the verifier was asked for a
 * format it does not define). Verification never reports success for bytes it could not read.
 */

import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { EXIT_USAGE, crc32, fail, readBytesFile } from './errors.mjs';

const PDF_HEADER = '%PDF-';
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_END_SIZE = 22;
const ZIP_MAX_COMMENT = 0xffff;

function badPdf(message) {
  return fail(`The produced PDF is not readable: ${message}`, 'BAD_PDF');
}

function badDocx(message) {
  return fail(`The produced DOCX is not readable: ${message}`, 'BAD_DOCX');
}

/* ------------------------------- PDF ------------------------------- */

/** The page objects of a PDF: `/Type /Page` (never the `/Type /Pages` tree node). */
const PAGE_OBJECT_RE = /\/Type\s*\/Page(?![A-Za-z])/;

/**
 * Verifies the structure ./pdf.mjs writes.
 * @returns {{format:'pdf', bytes:number, objects:number, pages:number, root:number}}
 */
export function verifyPdf(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length < PDF_HEADER.length || bytes.subarray(0, PDF_HEADER.length).toString('latin1') !== PDF_HEADER) {
    badPdf(`it does not start with a %PDF- header (it starts with ${JSON.stringify(bytes.subarray(0, 8).toString('latin1'))}).`);
  }

  const startxrefAt = bytes.lastIndexOf('startxref');
  if (startxrefAt < 0) badPdf('it has no startxref entry, so its cross-reference table cannot be found.');
  const startxrefMatch = /^startxref\s+(\d+)/.exec(bytes.subarray(startxrefAt).toString('latin1'));
  if (!startxrefMatch) badPdf('its startxref entry carries no offset.');
  const xrefOffset = Number(startxrefMatch[1]);
  if (xrefOffset <= 0 || xrefOffset >= bytes.length || bytes.subarray(xrefOffset, xrefOffset + 4).toString('latin1') !== 'xref') {
    badPdf(`its startxref offset (${xrefOffset}) does not point at a cross-reference table.`);
  }

  const xrefText = bytes.subarray(xrefOffset).toString('latin1');
  const header = /^xref\r?\n(\d+)\s+(\d+)\r?\n/.exec(xrefText);
  if (!header || Number(header[1]) !== 0) badPdf('its cross-reference table has no subsection starting at object 0.');
  const entryCount = Number(header[2]);
  if (entryCount < 2) badPdf('its cross-reference table lists no object.');

  const entriesAt = xrefOffset + header[0].length;
  if (entriesAt + entryCount * 20 > bytes.length) badPdf('its cross-reference table is truncated.');
  const objects = new Map();
  for (let index = 0; index < entryCount; index++) {
    const record = bytes.subarray(entriesAt + index * 20, entriesAt + (index + 1) * 20).toString('latin1');
    const entry = /^(\d{10}) (\d{5}) ([nf]) /.exec(record);
    if (!entry) badPdf(`its cross-reference entry ${index} is malformed (${JSON.stringify(record)}).`);
    if (index === 0) {
      if (entry[3] !== 'f') badPdf('the first cross-reference entry (object 0) is not a free entry.');
      continue;
    }
    if (entry[3] === 'f') continue;
    const offset = Number(entry[1]);
    if (offset <= 0 || offset >= bytes.length) badPdf(`its cross-reference entry for object ${index} points outside the file.`);
    if (!bytes.subarray(offset, offset + 32).toString('latin1').startsWith(`${index} 0 obj`)) {
      badPdf(`its cross-reference entry for object ${index} does not point at that object.`);
    }
    objects.set(index, offset);
  }
  if (!objects.size) badPdf('it contains no object.');

  // Object bodies run from their offset to the next object (the writer emits them in order), and
  // each one must be closed by `endobj`. Nothing is read out of a compressed stream.
  const offsets = [...objects.values()].sort((a, b) => a - b);
  const bodies = new Map();
  for (const [number, offset] of objects) {
    const next = offsets.find((candidate) => candidate > offset) ?? xrefOffset;
    const body = bytes.subarray(offset, next).toString('latin1');
    if (!/\d+ 0 obj/.test(body) || !body.includes('endobj')) {
      badPdf(`object ${number} has no obj/endobj pair.`);
    }
    bodies.set(number, body);
  }

  const trailerAt = bytes.indexOf('trailer', entriesAt + entryCount * 20);
  if (trailerAt < 0) badPdf('it has no trailer.');
  const trailer = bytes.subarray(trailerAt, trailerAt + 1024).toString('latin1');
  const root = /\/Root\s+(\d+)\s+0\s+R/.exec(trailer);
  if (!root) badPdf('its trailer carries no root reference.');
  const rootNumber = Number(root[1]);
  const rootBody = bodies.get(rootNumber);
  if (!rootBody) badPdf(`its trailer root reference (/Root ${rootNumber} 0 R) points at no object.`);
  if (!/\/Type\s*\/Catalog/.test(rootBody)) badPdf(`its root object ${rootNumber} is not a /Type /Catalog.`);
  const size = /\/Size\s+(\d+)/.exec(trailer);
  if (!size) badPdf('its trailer carries no /Size.');
  if (Number(size[1]) !== entryCount) badPdf(`its trailer declares /Size ${size[1]} but its cross-reference table holds ${entryCount} entries.`);

  let pages = 0;
  let declaredCount = null;
  for (const [number, body] of bodies) {
    if (PAGE_OBJECT_RE.test(body)) pages += 1;
    if (/\/Type\s*\/Pages/.test(body)) {
      const count = /\/Count\s+(\d+)/.exec(body);
      if (!count) badPdf(`its page tree (object ${number}) declares no /Count.`);
      declaredCount = Number(count[1]);
    }
  }
  if (pages <= 0) badPdf('it contains no page object.');
  if (declaredCount === null) badPdf('it contains no page tree.');
  if (declaredCount !== pages) badPdf(`its page tree declares ${declaredCount} pages but it contains ${pages} page objects.`);

  return { format: 'pdf', bytes: bytes.length, objects: objects.size, pages, root: rootNumber };
}

/* ------------------------------- DOCX ------------------------------- */

function findEndOfCentralDirectory(bytes) {
  const lowest = Math.max(0, bytes.length - ZIP_END_SIZE - ZIP_MAX_COMMENT);
  for (let at = bytes.length - ZIP_END_SIZE; at >= lowest; at--) {
    if (bytes.readUInt32LE(at) === ZIP_END) return at;
  }
  return -1;
}

export function verifyDocx(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length < ZIP_END_SIZE) badDocx('it is shorter than a ZIP end of central directory record.');
  if (bytes.readUInt32LE(0) !== ZIP_LOCAL) {
    badDocx('it does not start with a ZIP local file header, so it is not a ZIP container.');
  }
  const endAt = findEndOfCentralDirectory(bytes);
  if (endAt < 0) badDocx('it has no end of central directory record.');
  const diskNumber = bytes.readUInt16LE(endAt + 4);
  const centralDisk = bytes.readUInt16LE(endAt + 6);
  const diskEntries = bytes.readUInt16LE(endAt + 8);
  const entryCount = bytes.readUInt16LE(endAt + 10);
  const centralSize = bytes.readUInt32LE(endAt + 12);
  const centralOffset = bytes.readUInt32LE(endAt + 16);
  const commentLength = bytes.readUInt16LE(endAt + 20);
  if (diskNumber !== 0 || centralDisk !== 0) badDocx('its end record describes a spanned archive.');
  if (commentLength !== 0) badDocx('its end record carries a trailing comment.');
  if (diskEntries !== entryCount) badDocx('its end record disagrees with itself on the number of entries.');
  if (!entryCount) badDocx('its central directory is empty.');
  if (centralOffset + centralSize !== endAt || centralOffset + centralSize > bytes.length) {
    badDocx('its central directory does not end where its end record says.');
  }

  const parts = new Map();
  let at = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (at + 46 > endAt || bytes.readUInt32LE(at) !== ZIP_CENTRAL) {
      badDocx(`central directory entry ${index} does not parse.`);
    }
    const method = bytes.readUInt16LE(at + 10);
    const checksum = bytes.readUInt32LE(at + 16);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const entryComment = bytes.readUInt16LE(at + 32);
    const localOffset = bytes.readUInt32LE(at + 42);
    if (at + 46 + nameLength > endAt) badDocx(`central directory entry ${index} has a truncated name.`);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (!name) badDocx(`central directory entry ${index} has no name.`);
    at += 46 + nameLength + extraLength + entryComment;

    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== ZIP_LOCAL) {
      badDocx(`${name} has no local file header at the offset its central directory entry gives.`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    if (localName !== name) badDocx(`the local header of ${name} names ${JSON.stringify(localName)} instead.`);
    if (bytes.readUInt16LE(localOffset + 8) !== method || bytes.readUInt32LE(localOffset + 14) !== checksum) {
      badDocx(`the local header of ${name} disagrees with its central directory entry.`);
    }
    if (bytes.readUInt32LE(localOffset + 18) !== compressedSize || bytes.readUInt32LE(localOffset + 22) !== size) {
      badDocx(`the local header of ${name} disagrees with its central directory entry on the size.`);
    }

    const dataAt = localOffset + 30 + localNameLength + localExtraLength;
    if (dataAt + compressedSize > bytes.length) badDocx(`the data of ${name} lies outside the file.`);
    const payload = bytes.subarray(dataAt, dataAt + compressedSize);
    let content;
    try {
      if (method === 8) content = inflateRawSync(payload);
      else if (method === 0) content = payload;
      else badDocx(`${name} uses the unsupported compression method ${method}.`);
    } catch (error) {
      badDocx(`the compressed data of ${name} cannot be inflated (${error.message}).`);
    }
    if (content.length !== size) badDocx(`${name} inflates to ${content.length} bytes instead of ${size}.`);
    if (crc32(content) !== checksum) badDocx(`the CRC-32 of ${name} does not match its directory entry.`);
    parts.set(name, content);
  }
  if (at !== centralOffset + centralSize) badDocx('its central directory does not hold exactly the entries its end record counts.');

  for (const required of ['[Content_Types].xml', 'word/document.xml', 'word/_rels/document.xml.rels']) {
    if (!parts.has(required)) badDocx(`it does not contain ${required}.`);
  }
  if (!parts.get('[Content_Types].xml').toString('utf8').includes('/word/document.xml')) {
    badDocx('[Content_Types].xml does not declare the main document part.');
  }

  // Every required part is parsed as XML, not merely looked for: a part that is present but torn is
  // not a document a word processor can open.
  for (const required of ['[Content_Types].xml', 'word/_rels/document.xml.rels', 'word/document.xml']) {
    assertWellFormedXml(parts.get(required).toString('utf8'), required);
  }
  const document = parts.get('word/document.xml').toString('utf8');
  const paragraphs = (document.match(/<w:p(?=[\s>])/g) || []).length;
  if (!paragraphs) badDocx('word/document.xml contains no paragraph.');

  // The document's own relationships resolve against `word/`; every part they name must be in the
  // archive, or the package a word processor opens is missing what the document refers to.
  const relationships = [...parts.get('word/_rels/document.xml.rels').toString('utf8').matchAll(/<Relationship\b[^>]*>/g)];
  if (!relationships.length) badDocx('word/_rels/document.xml.rels relates no part of the document.');
  for (const relationship of relationships) {
    if (/TargetMode\s*=\s*"External"/.test(relationship[0])) continue;
    const target = /Target\s*=\s*"([^"]*)"/.exec(relationship[0]);
    if (!target || !target[1]) badDocx('word/_rels/document.xml.rels has a relationship without a target.');
    const part = target[1].startsWith('/') ? target[1].slice(1) : join('word', target[1]);
    if (!parts.has(part)) {
      badDocx(`word/_rels/document.xml.rels points at ${target[1]}, which the archive does not contain.`);
    }
  }

  return { format: 'docx', bytes: bytes.length, entries: entryCount, paragraphs };
}

/** Enough XML well-formedness for a produced part: every element opens and closes in order. */
function assertWellFormedXml(xml, part) {
  const stack = [];
  let seen = 0;
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open < 0) break;
    const skipTo = (marker, what) => {
      const end = xml.indexOf(marker, open + 1);
      if (end < 0) badDocx(`${part} has an unterminated ${what}.`);
      index = end + marker.length;
    };
    if (xml.startsWith('<!--', open)) {
      skipTo('-->', 'comment');
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      skipTo(']]>', 'CDATA section');
      continue;
    }
    if (xml.startsWith('<?', open)) {
      skipTo('?>', 'processing instruction');
      continue;
    }
    const close = xml.indexOf('>', open);
    if (close < 0) badDocx(`${part} has a tag that never closes.`);
    const inner = xml.slice(open + 1, close);
    index = close + 1;
    if (inner.startsWith('!')) continue;
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const expected = stack.pop();
      if (expected !== name) {
        badDocx(`${part} closes </${name}> where <${expected ?? 'nothing'}> was open.`);
      }
      continue;
    }
    if (inner.endsWith('/')) {
      seen += 1; // a self-closing element is still an element
      continue;
    }
    const name = inner.split(/[\s/]/)[0];
    if (!name) badDocx(`${part} has an element without a name.`);
    stack.push(name);
    seen += 1;
  }
  if (!seen) badDocx(`${part} has no element.`);
  if (stack.length) badDocx(`${part} never closes <${stack[stack.length - 1]}>.`);
}

/* ---------------------------- dispatchers ---------------------------- */

/** Verifies an edition in memory; `format` is `pdf` or `docx`. */
export function verifyEdition(data, format) {
  const kind = String(format == null ? '' : format).toLowerCase();
  if (kind === 'pdf') return verifyPdf(data);
  if (kind === 'docx') return verifyDocx(data);
  return fail(
    `Unknown format for verification: ${JSON.stringify(String(format))}. Defined formats: pdf, docx.`,
    'USAGE',
    EXIT_USAGE,
  );
}

/** Verifies an edition on disk; a file that cannot be read is an IO_ERROR (exit 1). */
export function verifyFile(file, format) {
  return verifyEdition(readBytesFile(file), format);
}

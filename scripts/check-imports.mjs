// The import group of `scripts/check.mjs`: the book importer that turns an uploaded PDF or DOCX into
// the `book-import.v1` object. Its fixtures are assembled here from first principles — a real ZIP
// package and a real PDF with a FlateDecode content stream — so the checks exercise the extractors
// themselves and not a mock of them.
//
// It proves the properties the pipeline depends on: a DOCX yields its chapters with the heading styles
// and the numbered paragraphs that start them; a PDF yields its text with both font sizes recognised;
// a scanned PDF without a text layer is refused with `IMPORT_NO_TEXT`; a corrupt file, an empty file and
// a package without its document part are refused with a code instead of a stack trace; and the byte,
// page, object and entry limits refuse an oversized or pathological upload.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { detectFormat, extractBook, segmentChapters } from '../src/import.mjs';
import { extractPdf } from '../src/import-pdf.mjs';
import { unzipParts } from '../src/import-docx.mjs';

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const PDF_HEADER = '%PDF-1.4';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let entry = value;
    for (let bit = 0; bit < 8; bit += 1) entry = entry & 1 ? 0xedb88320 ^ (entry >>> 1) : entry >>> 1;
    table[value] = entry >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Assembles a ZIP package with a local header, a central directory and an end record per entry. */
function buildZip(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(ZIP_CENTRAL, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    directory.push(record, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = directory.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A DOCX package: the content types, the main document part and, optionally, core properties. */
function buildDocx({ paragraphs = [], core = null, extra = [] }) {
  const runs = paragraphs
    .map((paragraph) => {
      const style = paragraph.style ? `<w:pPr><w:pStyle w:val="${paragraph.style}"/></w:pPr>` : '';
      if (paragraph.empty) return '<w:p/>';
      return `<w:p>${style}<w:r><w:t xml:space="preserve">${paragraph.raw ?? xmlEscape(paragraph.text)}</w:t></w:r></w:p>`;
    })
    .join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${runs}</w:body></w:document>`;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') }
  ];
  if (core !== null) entries.push({ name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') });
  entries.push(...extra);
  return buildZip(entries);
}

function pdfString(value) {
  return `(${String(value).replace(/([\\()])/g, '\\$1')})`;
}

/** A real PDF: numbered objects, FlateDecode content streams and a cross-reference table. */
function buildPdf({ pageStreams, info = null }) {
  const objects = new Map();
  let next = 1;
  const catalogNum = next;
  next += 1;
  const pagesNum = next;
  next += 1;
  const fontNums = { F1: next, F2: next + 1 };
  next += 2;
  const pageNums = [];
  for (const stream of pageStreams) {
    const pageNum = next;
    const contentNum = next + 1;
    next += 2;
    pageNums.push(pageNum);
    const body = deflateSync(Buffer.from(stream, 'latin1'));
    objects.set(contentNum, { stream: body, dict: `/Length ${body.length} /Filter /FlateDecode` });
    objects.set(pageNum, {
      dict:
        `/Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 ${fontNums.F1} 0 R /F2 ${fontNums.F2} 0 R >> >> /Contents ${contentNum} 0 R`
    });
  }
  objects.set(catalogNum, { dict: `/Type /Catalog /Pages ${pagesNum} 0 R` });
  objects.set(pagesNum, { dict: `/Type /Pages /Kids [${pageNums.map((num) => `${num} 0 R`).join(' ')}] /Count ${pageNums.length}` });
  objects.set(fontNums.F1, { dict: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica' });
  objects.set(fontNums.F2, { dict: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold' });
  let infoNum = null;
  if (info !== null) {
    infoNum = next;
    next += 1;
    objects.set(infoNum, { dict: info });
  }

  const chunks = [Buffer.from(`${PDF_HEADER}\n`, 'latin1')];
  let offset = chunks[0].length;
  const offsets = new Map();
  for (const num of [...objects.keys()].sort((left, right) => left - right)) {
    const object = objects.get(num);
    offsets.set(num, offset);
    const head = Buffer.from(`${num} 0 obj\n<< ${object.dict} >>\n`, 'latin1');
    chunks.push(head);
    offset += head.length;
    if (object.stream) {
      const open = Buffer.from('stream\n', 'latin1');
      const close = Buffer.from('\nendstream\n', 'latin1');
      chunks.push(open, object.stream, close);
      offset += open.length + object.stream.length + close.length;
    }
    const tail = Buffer.from('endobj\n', 'latin1');
    chunks.push(tail);
    offset += tail.length;
  }
  const startxref = offset;
  const size = objects.size + 1;
  const lines = [`xref\n0 ${size}\n`, '0000000000 65535 f \n'];
  for (let num = 1; num < size; num += 1) lines.push(`${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`);
  lines.push(`trailer\n<< /Size ${size} /Root ${catalogNum} 0 R${infoNum === null ? '' : ` /Info ${infoNum} 0 R`} >>\n`);
  lines.push(`startxref\n${startxref}\n%%EOF\n`);
  chunks.push(Buffer.from(lines.join(''), 'latin1'));
  return Buffer.concat(chunks);
}

const CHAPTER_ONE = [
  'BT',
  '/F2 18 Tf',
  '72 720 Td',
  '(Chapter 1) Tj',
  'ET',
  'BT',
  '/F1 10 Tf',
  '14 TL',
  '72 690 Td',
  '(A cautious archivist at the end of an era discovers that every map he draws con-) Tj',
  'T*',
  '(tradicts the ground it describes, and the contradiction is what people come to see.) Tj',
  'ET',
  'BT',
  '/F1 10 Tf',
  '72 640 Td',
  '(The second paragraph opens in the same body size and names a token: ) Tj',
  '<66697874757265> Tj',
  '(, which is a hex string.) Tj',
  'ET'
].join('\n');

const CHAPTER_TWO = [
  'BT',
  '/F2 18 Tf',
  '72 720 Td',
  '(Chapter 2. The Ledger) Tj',
  'ET',
  'BT',
  '/F1 10 Tf',
  '14 TL',
  '72 690 Td',
  '(A line shown with the quote operator.) \'',
  '(A line shown with the double quote operator.) "',
  'ET',
  'BT',
  '/F1 10 Tf',
  '1 0 0 1 72 620 Tm',
  '[(A line set with the TJ operator, ) -200 (joined after a kerned gap.)] TJ',
  'ET',
  'BT',
  '/F1 10 Tf',
  '0 -60 TD',
  '(An escaped parenthesis \\) and a backslash \\\\ arrive in one literal.) Tj',
  'ET'
].join('\n');

const SCANNED_PAGE = ['0.5 g', '100 100 100 100 re', 'f'].join('\n');

/**
 * Writes a DOCX fixture that the importer reads as a real book: each chapter is a `Heading1` paragraph
 * carrying its title, followed by its body paragraphs. The package carries no core properties, so the
 * extractor answers a null title and author and notes the missing author in its warnings; a caller that
 * needs a book title gives the first chapter one, or writes its own `docProps/core.xml`.
 */
export async function writeDocxFixture({ dir, filename = 'book.docx', chapters = [] }) {
  const paragraphs = [];
  for (const chapter of chapters) {
    if (chapter?.title) paragraphs.push({ text: String(chapter.title), style: 'Heading1' });
    for (const paragraph of chapter?.paragraphs ?? []) paragraphs.push({ text: String(paragraph) });
  }
  const path = join(dir, filename);
  await writeFile(path, buildDocx({ paragraphs }));
  return path;
}

const DOCX_PARAGRAPHS = [
  { text: 'The Fixture Book', style: 'Title' },
  { text: 'Chapter 1. The Salt Road', style: 'Heading1' },
  { text: 'First paragraph of the first chapter, with an ampersand &amp; and an accent &#233;.', raw: 'First paragraph of the first chapter, with an ampersand &amp; and an accent &#233;.' },
  { text: 'A subsection of the first chapter', style: 'Heading2' },
  { text: 'Second paragraph, which mentions <angle brackets> as text.', raw: 'Second paragraph, which mentions &lt;angle brackets&gt; as text.' },
  { empty: true },
  { text: '2.', style: 'Heading1' },
  { text: 'Body of the second chapter.' },
  { text: 'Chapter 3. The Long Night' },
  { text: 'Body of the third chapter, spelled out.' }
];

async function refusalFor(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error?.code ? error : { code: 'NO_CODE', message: String(error?.message ?? error), stack: error?.stack };
  }
}

export async function runImportChecks({ ok, fail }) {
  const dir = await mkdtemp(join(tmpdir(), 'scripta-import-'));
  const save = async (name, bytes) => {
    const target = join(dir, name);
    await writeFile(target, bytes);
    return target;
  };
  try {
    // ---------------------------------------------------------------- the assembled DOCX package
    const core =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>A. Tester</dc:creator></cp:coreProperties>';
    const docx = buildDocx({ paragraphs: DOCX_PARAGRAPHS, core });
    const docxPath = await save('fixture.docx', docx);
    const book = await extractBook({ path: docxPath, filename: 'fixture.docx' });
    const chapterOne = book.chapters[0] ?? {};
    const docxOk =
      book.schema_version === 'book-import.v1' &&
      book.source.format === 'docx' &&
      book.source.bytes === docx.length &&
      book.source.sha256 === createHash('sha256').update(docx).digest('hex') &&
      book.source.pages === null &&
      book.detected.title === 'The Fixture Book' &&
      book.detected.author === 'A. Tester' &&
      book.detected.language === null &&
      book.chapters.length === 3 &&
      chapterOne.number === 1 &&
      chapterOne.title === 'Chapter 1. The Salt Road' &&
      chapterOne.words > 10 &&
      chapterOne.text.includes('ampersand & and an accent é') &&
      chapterOne.text.includes('A subsection of the first chapter') &&
      chapterOne.text.includes('mentions <angle brackets> as text') &&
      chapterOne.text.split('\n\n').length === 3 &&
      book.chapters[1].title === '2.' &&
      book.chapters[1].number === 2 &&
      book.chapters[1].text === 'Body of the second chapter.' &&
      book.chapters[2].title === 'Chapter 3. The Long Night' &&
      book.chapters[2].number === 3 &&
      !book.chapters.some((chapter) => /<w:p/.test(chapter.text));
    if (docxOk) {
      ok('DOCX import: 3 chapters from the heading styles and the numbered paragraphs, entities decoded, the title paragraph kept out of the text');
    } else {
      fail(`DOCX import: ${JSON.stringify({ source: book.source, detected: book.detected, chapters: book.chapters, warnings: book.warnings })}`);
    }

    const parts = unzipParts(docx);
    if (parts.has('[Content_Types].xml') && parts.has('word/document.xml')) {
      ok('DOCX package: the central directory was read and both parts inflated');
    } else fail(`DOCX package: parts=${[...parts.keys()].join(', ')}`);

    const missingPart = buildZip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') }]);
    const missingPath = await save('nodocument.docx', missingPart);
    const missing = await refusalFor(extractBook({ path: missingPath, filename: 'nodocument.docx' }));
    if (missing?.code === 'IMPORT_UNREADABLE' && /word\/document\.xml/.test(missing.message)) {
      ok(`DOCX without its document part: refused with ${missing.code}`);
    } else fail(`DOCX without its document part: ${JSON.stringify(missing)}`);

    const flood = buildDocx({
      paragraphs: [{ text: 'One paragraph.', style: 'Heading1' }],
      extra: Array.from({ length: 600 }, (unused, index) => ({ name: `word/media/part${index}.bin`, data: Buffer.from('x') }))
    });
    const floodPath = await save('flood.docx', flood);
    const flooded = await refusalFor(extractBook({ path: floodPath, filename: 'flood.docx' }));
    if (flooded?.code === 'IMPORT_TOO_LARGE' && /entries/.test(flooded.message)) {
      ok(`pathological package: 601 entries refused with ${flooded.code}`);
    } else fail(`pathological package: ${JSON.stringify(flooded)}`);

    const plain = buildDocx({ paragraphs: [{ text: 'Only prose, with no heading anywhere.' }, { text: 'A second paragraph of the same book.' }] });
    const plainPath = await save('plain.docx', plain);
    const plainBook = await extractBook({ path: plainPath, filename: 'plain.docx' });
    if (plainBook.chapters.length === 1 && plainBook.chapters[0].words > 5 && plainBook.warnings.some((warning) => /No chapter heading/.test(warning))) {
      ok('a document with no detectable boundary: one chapter plus the warning that names it');
    } else fail(`a document with no detectable boundary: ${JSON.stringify(plainBook.chapters)} / ${JSON.stringify(plainBook.warnings)}`);

    const oversized = await refusalFor(extractBook({ path: docxPath, filename: 'fixture.docx', maxBytes: 16 }));
    if (oversized?.code === 'IMPORT_TOO_LARGE' && /above the 16 bytes/.test(oversized.message)) {
      ok(`oversized upload: refused with ${oversized.code}`);
    } else fail(`oversized upload: ${JSON.stringify(oversized)}`);

    // ---------------------------------------------------------------- the assembled PDF
    const pdf = buildPdf({
      pageStreams: [CHAPTER_ONE, CHAPTER_TWO],
      info: `/Title ${pdfString('The Fixture Book')} /Author ${pdfString('A. Tester')} /Lang ${pdfString('en-GB')} /Producer ${pdfString('check-imports')}`
    });
    const pdfPath = await save('fixture.pdf', pdf);
    const pdfBook = await extractBook({ path: pdfPath, filename: 'fixture.pdf' });
    const pdfChapterOne = pdfBook.chapters[0] ?? {};
    const pdfChapterTwo = pdfBook.chapters[1] ?? {};
    const pdfOk =
      pdfBook.source.format === 'pdf' &&
      pdfBook.source.pages === 2 &&
      pdfBook.source.sha256 === createHash('sha256').update(pdf).digest('hex') &&
      pdfBook.detected.title === 'The Fixture Book' &&
      pdfBook.detected.author === 'A. Tester' &&
      pdfBook.detected.language === 'en' &&
      pdfBook.chapters.length === 2 &&
      pdfChapterOne.title === 'Chapter 1' &&
      pdfChapterOne.text.includes('contradicts the ground it describes') &&
      pdfChapterOne.text.includes('names a token: fixture, which is a hex string.') &&
      pdfChapterOne.text.split('\n\n').length === 2 &&
      pdfChapterTwo.title === 'Chapter 2. The Ledger' &&
      pdfChapterTwo.text.includes('quote operator. A line shown with the double quote operator.') &&
      pdfChapterTwo.text.includes('A line set with the TJ operator, joined after a kerned gap.') &&
      pdfChapterTwo.text.includes('An escaped parenthesis ) and a backslash \\ arrive in one literal.');
    if (pdfOk) {
      ok('PDF import: 2 chapters from two page content streams, hyphenated line breaks joined, paragraphs separated by blank lines');
    } else {
      fail(`PDF import: ${JSON.stringify({ source: pdfBook.source, detected: pdfBook.detected, chapters: pdfBook.chapters, warnings: pdfBook.warnings })}`);
    }

    const pdfText = extractPdf({ bytes: pdf });
    const sizes = new Set(pdfText.paragraphs.map((paragraph) => paragraph.size));
    const headingSize = pdfText.paragraphs.find((paragraph) => paragraph.text === 'Chapter 1')?.size;
    const bodySegments = segmentChapters(pdfText.paragraphs, { documentTitle: 'The Fixture Book' });
    if (sizes.has(18) && sizes.has(10) && headingSize === 18 && bodySegments.bodySize === 10) {
      ok('PDF text: the two font sizes were detected (10 body, 18 heading) and the heading was recognised by size');
    } else fail(`PDF text: sizes=${[...sizes].join(',')} headingSize=${headingSize} bodySize=${bodySegments.bodySize}`);

    const tooManyPages = await refusalFor(Promise.resolve().then(() => extractPdf({ bytes: pdf, limits: { maxPages: 1 } })));
    const tooManyObjects = await refusalFor(Promise.resolve().then(() => extractPdf({ bytes: pdf, limits: { maxObjects: 3 } })));
    if (tooManyPages?.code === 'IMPORT_TOO_LARGE' && tooManyObjects?.code === 'IMPORT_TOO_LARGE') {
      ok('PDF bounds: the page limit and the object limit both refuse with IMPORT_TOO_LARGE');
    } else fail(`PDF bounds: pages=${JSON.stringify(tooManyPages)} objects=${JSON.stringify(tooManyObjects)}`);

    const scanned = buildPdf({ pageStreams: [SCANNED_PAGE] });
    const scannedPath = await save('scanned.pdf', scanned);
    const scannedRefusal = await refusalFor(extractBook({ path: scannedPath, filename: 'scanned.pdf' }));
    if (scannedRefusal?.code === 'IMPORT_NO_TEXT' && scannedRefusal.name === 'UniverseError' && /1 page\(s\)/.test(scannedRefusal.message)) {
      ok(`scanned PDF: refused with ${scannedRefusal.code} and the number of pages it examined`);
    } else fail(`scanned PDF: ${JSON.stringify(scannedRefusal)}`);

    // ---------------------------------------------------------------- a page set in unreadable font codes
    const codes = Buffer.from(Array.from({ length: 80 }, (unused, index) => 0x80 + (index % 24))).toString('hex');
    const fontCodes = buildPdf({
      pageStreams: [
        ['BT', '/F1 10 Tf', '72 700 Td', `<${codes}> Tj`, '(A short line of real prose follows the codes.) Tj', 'ET'].join('\n')
      ]
    });
    const fontCodesPath = await save('fontcodes.pdf', fontCodes);
    const fontCodesBook = await extractBook({ path: fontCodesPath, filename: 'fontcodes.pdf' });
    if (fontCodesBook.chapters.length === 1 && fontCodesBook.warnings.some((warning) => /does not decode/.test(warning))) {
      ok('PDF in an unreadable font encoding: the text is returned with the warning that says it must be treated as unverified');
    } else fail(`PDF in an unreadable font encoding: ${JSON.stringify(fontCodesBook.warnings)}`);

    // ---------------------------------------------------------------- the files that are not books
    const corruptPath = await save('broken.pdf', Buffer.from('this is not a book at all\n', 'utf8'));
    const corrupt = await refusalFor(extractBook({ path: corruptPath, filename: 'broken.pdf' }));
    const corruptDocxPath = await save('broken.docx', Buffer.from('this is not a package at all\n', 'utf8'));
    const corruptDocx = await refusalFor(extractBook({ path: corruptDocxPath, filename: 'broken.docx' }));
    if (corrupt?.code === 'IMPORT_UNREADABLE' && corrupt.name === 'UniverseError'
      && corruptDocx?.code === 'IMPORT_UNREADABLE' && corruptDocx.name === 'UniverseError') {
      ok(`corrupt files: refused with ${corrupt.code} for both a .pdf and a .docx name, as a coded error and not a crash`);
    } else fail(`corrupt files: pdf=${JSON.stringify(corrupt)} docx=${JSON.stringify(corruptDocx)}`);

    const mislabelledPath = await save('mislabelled.docx', pdf);
    const mislabelled = await refusalFor(extractBook({ path: mislabelledPath, filename: 'mislabelled.docx' }));
    const emptyPath = await save('empty.pdf', Buffer.alloc(0));
    const empty = await refusalFor(extractBook({ path: emptyPath, filename: 'empty.pdf' }));
    if (mislabelled?.code === 'IMPORT_UNREADABLE' && /declared as docx but its bytes are a pdf/.test(mislabelled.message)
      && empty?.code === 'IMPORT_UNREADABLE' && /empty/.test(empty.message)) {
      ok(`a PDF named .docx and an empty file: refused with ${empty.code}`);
    } else fail(`mislabelled=${JSON.stringify(mislabelled)} empty=${JSON.stringify(empty)}`);

    const unsupported = await refusalFor(extractBook({ path: docxPath, filename: 'book.epub', format: 'epub' }));
    if (unsupported?.code === 'IMPORT_UNSUPPORTED') {
      ok(`unsupported format: refused with ${unsupported.code}`);
    } else fail(`unsupported format: ${JSON.stringify(unsupported)}`);

    const formats =
      detectFormat({ filename: 'book.pdf', bytes: Buffer.from('%PDF-1.7\n', 'latin1') }) === 'pdf' &&
      detectFormat({ filename: 'book.docx', bytes: docx.subarray(0, 8) }) === 'docx' &&
      detectFormat({ filename: 'BOOK.PDF', bytes: null }) === 'pdf' &&
      detectFormat({ filename: 'notes.txt', bytes: Buffer.from('hello', 'utf8') }) === null;
    if (formats) ok('format detection: the bytes decide first, the file extension second, an unknown upload answers null');
    else fail('format detection: the answers of detectFormat are not the expected ones');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

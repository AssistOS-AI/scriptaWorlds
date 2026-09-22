/**
 * DOCX engine: a minimal ZIP writer (node:zlib `deflateRawSync` + CRC32) plus valid OOXML
 * parts — document, styles, footer with a `PAGE` field and a `TOC \o "1-1" \h \z \u` field
 * whose cached result comes from the shared layout engine. Needs no library.
 */

import { deflateRawSync } from 'node:zlib';

import { crc32, xmlEscape } from './errors.mjs';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const DOCX_FONT = 'Times New Roman';
const DOCX_PAGE_TWIPS_W = 8391; // 148 mm
const DOCX_PAGE_TWIPS_H = 11906; // 210 mm
const DOCX_MARGIN_TWIPS = 1134; // 2 cm

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function zipArchive(files, buildDate) {
  const dosTime = (buildDate.getHours() << 11) | (buildDate.getMinutes() << 5) | (buildDate.getSeconds() >> 1);
  const dosDate = ((buildDate.getFullYear() - 1980) << 9) | ((buildDate.getMonth() + 1) << 5) | buildDate.getDate();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const raw = file.data;
    const compressed = deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBytes, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

function docxRun(run) {
  const props = [];
  if (run.bold) props.push('<w:b/>');
  if (run.italic) props.push('<w:i/>');
  if (run.size) props.push(`<w:sz w:val="${run.size}"/><w:szCs w:val="${run.size}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
}

function docxPara(style, runs, options = {}) {
  const pPr = [];
  if (options.pageBreakBefore) pPr.push('<w:pageBreakBefore/>');
  if (options.keepNext) pPr.push('<w:keepNext/>');
  pPr.push(`<w:pStyle w:val="${style}"/>`);
  if (options.align) pPr.push(`<w:jc w:val="${options.align}"/>`);
  if (options.indent) pPr.push(`<w:ind w:left="${options.indent}" w:right="${options.indent}"/>`);
  if (options.spacing) pPr.push(options.spacing);
  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${runs.map(docxRun).join('')}</w:p>`;
}

function docxBlocks(blocks) {
  const out = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'h1':
        out.push(docxPara('Heading1', block.runs, { keepNext: true, align: 'center' }));
        break;
      case 'h2':
        out.push(docxPara('Heading2', block.runs, { keepNext: true }));
        break;
      case 'quote':
        out.push(docxPara('Quote', block.runs));
        break;
      case 'sep':
        out.push(docxPara('Normal', [{ text: '* * *' }], { align: 'center' }));
        break;
      default:
        out.push(docxPara('Normal', block.runs));
    }
  }
  return out.join('');
}

function docxStyles(book) {
  return (
    XML_DECL +
    `<w:styles xmlns:w="${W_NS}">` +
    '<w:docDefaults>' +
    '<w:rPrDefault><w:rPr>' +
    `<w:rFonts w:ascii="${DOCX_FONT}" w:hAnsi="${DOCX_FONT}" w:cs="${DOCX_FONT}" w:eastAsia="${DOCX_FONT}"/>` +
    `<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="${xmlEscape(book.locale)}"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:spacing w:before="2400" w:after="240" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' +
    '<w:rPr><w:sz w:val="52"/><w:szCs w:val="52"/><w:b/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="240"/><w:jc w:val="center"/></w:pPr>' +
    '<w:rPr><w:sz w:val="40"/><w:szCs w:val="40"/><w:b/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="300" w:after="120"/></w:pPr>' +
    '<w:rPr><w:sz w:val="27"/><w:szCs w:val="27"/><w:b/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="420" w:right="420"/><w:spacing w:before="60" w:after="180"/><w:jc w:val="both"/></w:pPr>' +
    '<w:rPr><w:i/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/>' +
    `<w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${DOCX_PAGE_TWIPS_W - 2 * DOCX_MARGIN_TWIPS}"/></w:tabs>` +
    '<w:spacing w:after="60" w:line="276" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr>' +
    '<w:rPr><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>' +
    '</w:styles>'
  );
}

function docxFieldToc(entries) {
  const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-1" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  if (!entries.length) return `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>${begin}${end}</w:p>`;
  return entries
    .map((entry, index) => {
      const runs = [];
      if (index === 0) runs.push(begin);
      runs.push(`<w:r><w:t xml:space="preserve">${xmlEscape(entry.title)}</w:t></w:r>`);
      runs.push('<w:r><w:tab/></w:r>');
      runs.push(`<w:r><w:t>${entry.page}</w:t></w:r>`);
      if (index === entries.length - 1) runs.push(end);
      return `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>${runs.join('')}</w:p>`;
    })
    .join('');
}

function docxDocument(book, layout, buildDate) {
  const body = [];
  body.push(docxPara('Title', [{ text: book.title }]));
  if (book.subtitle) body.push(docxPara('Normal', [{ text: book.subtitle, italic: true }], { align: 'center', spacing: '<w:spacing w:after="480"/>' }));
  if (book.author) body.push(docxPara('Normal', [{ text: book.author }], { align: 'center', spacing: '<w:spacing w:before="2400" w:after="60"/>' }));
  body.push(docxPara('Normal', [{ text: book.year }], { align: 'center' }));
  if (book.dedication) {
    body.push(docxPara('Normal', [{ text: book.dedication, italic: true }], { align: 'center', pageBreakBefore: true, spacing: '<w:spacing w:before="4800"/>' }));
  }
  body.push(docxPara('Normal', [{ text: book.labels.toc, bold: true, size: 36 }], { align: 'center', pageBreakBefore: true, spacing: '<w:spacing w:after="240"/>' }));
  body.push(docxFieldToc(layout.entries));
  for (const section of book.sections) {
    if (section.label) {
      body.push(
        docxPara('Normal', [{ text: section.label, size: 19 }], {
          align: 'center',
          pageBreakBefore: true,
          spacing: '<w:spacing w:before="1200" w:after="60"/>',
        }),
      );
      body.push(docxPara('Heading1', [{ text: section.title }], { align: 'center' }));
    } else {
      body.push(docxPara('Heading1', [{ text: section.title }], { align: 'center', pageBreakBefore: true }));
    }
    body.push(docxBlocks(section.blocks));
  }
  const sectPr =
    '<w:sectPr>' +
    '<w:footerReference w:type="default" r:id="rId2"/>' +
    '<w:titlePg/>' +
    `<w:pgSz w:w="${DOCX_PAGE_TWIPS_W}" w:h="${DOCX_PAGE_TWIPS_H}"/>` +
    `<w:pgMar w:top="${DOCX_MARGIN_TWIPS}" w:right="${DOCX_MARGIN_TWIPS}" w:bottom="${DOCX_MARGIN_TWIPS}" w:left="${DOCX_MARGIN_TWIPS}" w:header="567" w:footer="567" w:gutter="0"/>` +
    '<w:cols w:space="708"/><w:docGrid w:linePitch="360"/>' +
    '</w:sectPr>';
  return (
    XML_DECL +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body.join('')}${sectPr}</w:body></w:document>`
  );
}

function docxFooter() {
  const field =
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
  return XML_DECL + `<w:ftr xmlns:w="${W_NS}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${field}</w:p></w:ftr>`;
}

export function renderDocx(book, layout, buildDate) {
  const contentTypes =
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';
  const rootRels =
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';
  const documentRels =
    XML_DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${R_NS}/footer" Target="footer1.xml"/>` +
    '</Relationships>';
  const stamp = buildDate.toISOString().replace(/\.\d+Z$/, 'Z');
  const core =
    XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlEscape(book.title)}</dc:title>` +
    `<dc:creator>${xmlEscape(book.author || book.universeId)}</dc:creator>` +
    `<cp:lastModifiedBy>${xmlEscape(book.author || book.universeId)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    `<dc:language>${xmlEscape(book.language)}</dc:language>` +
    '</cp:coreProperties>';
  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(docxDocument(book, layout, buildDate), 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(docxStyles(book), 'utf8') },
    { name: 'word/footer1.xml', data: Buffer.from(docxFooter(), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
  ];
  return { data: zipArchive(files, buildDate), pages: null };
}

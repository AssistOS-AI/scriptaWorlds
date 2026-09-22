/**
 * PDF engine: object/xref writer, compressed content streams, subsetted Type0/CIDFontType2
 * fonts with Identity-H encoding and a `ToUnicode` CMap, page objects, document info and a
 * flat outline. Needs no library.
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { pdfDate, pdfTextString } from './errors.mjs';
import { PAGE, usedFaces } from './layout.mjs';

function fmt(value) {
  return Number(value.toFixed(2)).toString();
}

function streamObject(dict, payload, compress) {
  const data = compress ? deflateSync(payload, { level: 9 }) : payload;
  const head = Buffer.from(
    `<< ${dict} /Length ${data.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
    'latin1',
  );
  return Buffer.concat([head, data, Buffer.from('\nendstream', 'latin1')]);
}

function toUnicodeCMap(face) {
  const byGid = new Map();
  for (const code of [...face.codes].sort((a, b) => a - b)) {
    const newGid = face.gidMap.get(face.font.gidFor(code));
    if (!newGid) continue;
    if (!byGid.has(newGid)) byGid.set(newGid, code);
  }
  const entries = [...byGid.entries()].sort((a, b) => a[0] - b[0]);
  const parts = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    parts.push(`${chunk.length} beginbfchar`);
    for (const [gid, code] of chunk) {
      parts.push(`<${gid.toString(16).padStart(4, '0')}> <${code.toString(16).padStart(4, '0')}>`);
    }
    parts.push('endbfchar');
  }
  parts.push(
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  );
  return Buffer.from(`${parts.join('\n')}\n`, 'latin1');
}

function buildFontObjects(faces, used, add) {
  const refs = new Map();
  const order = ['regular', 'bold', 'italic', 'bolditalic'];
  let index = 0;
  for (const style of order) {
    const face = faces[style];
    if (!used.has(face)) continue;
    index += 1;
    face.pdfName = `F${index}`;
    const scale = 1000 / face.font.unitsPerEm;
    const bbox = [face.font.xMin, face.font.yMin, face.font.xMax, face.font.yMax]
      .map((value) => Math.round(value * scale))
      .join(' ');
    const ascent = Math.round(face.font.ascender * scale);
    const descent = Math.round(face.font.descender * scale);
    const stem = style === 'bold' || style === 'bolditalic' ? 120 : 80;
    let flags = 32 | 2; // nonsymbolic + serif
    if (style === 'italic' || style === 'bolditalic') flags |= 64;
    const widths = [];
    for (let gid = 0; gid < face.subsetGlyphCount(); gid++) {
      widths.push(`${gid} [${Math.round(face.advanceOf(gid) * scale)}]`);
    }
    const fileRef = add(streamObject(`/Length1 ${face.subsetData.length}`, face.subsetData, true));
    const toUnicodeRef = add(streamObject('', toUnicodeCMap(face), false));
    const descriptorRef = add(
      Buffer.from(
        `<< /Type /FontDescriptor /FontName /${face.subsetTag()}+${face.psName} /Flags ${flags} ` +
          `/FontBBox [${bbox}] /ItalicAngle ${fmt(face.font.italicAngle)} /Ascent ${ascent} /Descent ${descent} ` +
          `/CapHeight ${Math.round(ascent * 0.72)} /StemV ${stem} /FontFile2 ${fileRef} 0 R >>`,
        'latin1',
      ),
    );
    const descendantRef = add(
      Buffer.from(
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${face.subsetTag()}+${face.psName} ` +
          `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
          `/FontDescriptor ${descriptorRef} 0 R /DW 1000 /W [${widths.join(' ')}] /CIDToGIDMap /Identity >>`,
        'latin1',
      ),
    );
    const fontRef = add(
      Buffer.from(
        `<< /Type /Font /Subtype /Type0 /BaseFont /${face.subsetTag()}+${face.psName} /Encoding /Identity-H ` +
          `/DescendantFonts [${descendantRef} 0 R] /ToUnicode ${toUnicodeRef} 0 R >>`,
        'latin1',
      ),
    );
    refs.set(face, fontRef);
  }
  return refs;
}

function pageContentStream(page) {
  const ops = [];
  for (const line of page.lines) {
    ops.push('BT');
    let currentFont = null;
    let cursor = line.x;
    for (let i = 0; i < line.tokens.length; i++) {
      const token = line.tokens[i];
      const x = token.x === undefined ? cursor : token.x;
      if (token.face.pdfName !== currentFont) {
        ops.push(`/${token.face.pdfName} ${fmt(token.size)} Tf`);
        currentFont = token.face.pdfName;
      }
      ops.push(`1 0 0 1 ${fmt(x)} ${fmt(line.y)} Tm`);
      ops.push(`<${token.face.hex(token.text)}> Tj`);
      cursor = x + token.w;
      if (!line.raw && i < line.tokens.length - 1) {
        const gap = token.gap + (line.extraGap || 0);
        if (gap > 0) {
          ops.push(`1 0 0 1 ${fmt(cursor)} ${fmt(line.y)} Tm`);
          ops.push(`<${token.face.hex(' ')}> Tj`);
        }
        cursor += gap;
      }
    }
    ops.push('ET');
  }
  return Buffer.from(`${ops.join('\n')}\n`, 'latin1');
}

export function renderPdf(book, faces, layout, buildDate) {
  const used = usedFaces(layout);
  for (const face of used) face.finish();
  const objects = [];
  const add = (buffer) => {
    objects.push(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'latin1'));
    return objects.length;
  };

  const fontRefs = buildFontObjects(faces, used, add);

  // The /Pages object is reserved before the pages, so every page can reference /Parent directly.
  const pagesRef = add(Buffer.from('<< /Type /Pages >>', 'latin1'));
  const pageRefs = [];
  for (const page of layout.pages) {
    const contentRef = add(streamObject('', pageContentStream(page), true));
    const pageFaces = new Set();
    for (const line of page.lines) for (const token of line.tokens) pageFaces.add(token.face);
    const fontEntries = [...pageFaces].map((face) => `/${face.pdfName} ${fontRefs.get(face)} 0 R`).join(' ');
    pageRefs.push(
      add(
        Buffer.from(
          `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${fmt(PAGE.W)} ${fmt(PAGE.H)}] ` +
            `/Resources << /ProcSet [/PDF /Text] /Font << ${fontEntries} >> >> /Contents ${contentRef} 0 R >>`,
          'latin1',
        ),
      ),
    );
  }
  objects[pagesRef - 1] = Buffer.from(
    `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(' ')}] >>`,
    'latin1',
  );

  // Outline: slots reserved first, then filled with consistent next/prev links.
  const items = layout.bookmarks.filter((bookmark) => pageRefs[bookmark.page - 1]);
  let outlinesRef = null;
  if (items.length) {
    outlinesRef = add(Buffer.from('<< /Type /Outlines >>', 'latin1'));
    const firstItemRef = objects.length + 1;
    for (let i = 0; i < items.length; i++) objects.push(Buffer.from('<< >>', 'latin1'));
    items.forEach((bookmark, index) => {
      const parts = [
        `/Title <${pdfTextString(bookmark.title)}>`,
        `/Parent ${outlinesRef} 0 R`,
        `/Dest [${pageRefs[bookmark.page - 1]} 0 R /XYZ ${fmt(PAGE.LEFT)} ${fmt(bookmark.y)} null]`,
      ];
      if (index < items.length - 1) parts.push(`/Next ${firstItemRef + index + 1} 0 R`);
      if (index > 0) parts.push(`/Prev ${firstItemRef + index - 1} 0 R`);
      objects[firstItemRef + index - 1] = Buffer.from(`<< ${parts.join(' ')} >>`, 'latin1');
    });
    objects[outlinesRef - 1] = Buffer.from(
      `<< /Type /Outlines /First ${firstItemRef} 0 R /Last ${firstItemRef + items.length - 1} 0 R /Count ${items.length} >>`,
      'latin1',
    );
  }

  const catalogRef = add(
    Buffer.from(
      `<< /Type /Catalog /Pages ${pagesRef} 0 R${outlinesRef ? ` /Outlines ${outlinesRef} 0 R /PageMode /UseOutlines` : ''} /Lang (${book.language}) >>`,
      'latin1',
    ),
  );
  const infoRef = add(
    Buffer.from(
      `<< /Title <${pdfTextString(book.title)}> /Author <${pdfTextString(book.author || book.universeId)}> ` +
        `/Subject <${pdfTextString(book.subtitle || book.title)}> /Creator (scripta-book-export) ` +
        `/Producer (scripta-book-export) /CreationDate (${pdfDate(buildDate)}) >>`,
      'latin1',
    ),
  );

  const fileId = createHash('md5').update(`${book.title}|${book.universeId}|${buildDate.toISOString()}`).digest('hex').toUpperCase();
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(offset);
    const head = Buffer.from(`${index + 1} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(head, object, tail);
    offset += head.length + object.length + tail.length;
  });
  const xrefLines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const position of offsets) xrefLines.push(`${String(position).padStart(10, '0')} 00000 n `);
  xrefLines.push(
    'trailer',
    `<< /Size ${objects.length + 1} /Root ${catalogRef} 0 R /Info ${infoRef} 0 R /ID [<${fileId}> <${fileId}>] >>`,
    'startxref',
    String(offset),
    '%%EOF',
    '',
  );
  chunks.push(Buffer.from(xrefLines.join('\n'), 'latin1'));
  return { data: Buffer.concat(chunks), pages: layout.pages.length };
}

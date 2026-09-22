/**
 * Layout engine (real pagination, shared by PDF and DOCX): A5 page geometry, block styles,
 * word tokenisation with real glyph advances, greedy line breaking with justification,
 * widow/orphan control, the TOC pass (iterated with the body until its page count is stable)
 * and the title/dedication pages.
 */

import { blockText } from './markdown.mjs';

// A5 page (148 × 210 mm) in PDF points.
export const PAGE = { W: 419.53, H: 595.28, TOP: 56, BOTTOM: 68, LEFT: 52, RIGHT: 52 };
const CONTENT_W = PAGE.W - PAGE.LEFT - PAGE.RIGHT;
const TEXT_TOP = PAGE.H - PAGE.TOP;
const TEXT_BOTTOM = PAGE.BOTTOM;
const FOOTER_Y = 34;

const BLOCK_STYLES = {
  label: { face: 'regular', size: 9, lineHeight: 13, spaceAfter: 5, align: 'center' },
  h1: { face: 'bold', size: 20, lineHeight: 25, spaceBefore: 10, spaceAfter: 13, align: 'center', keep: 2 },
  h2: { face: 'bold', size: 13, lineHeight: 17.5, spaceBefore: 15, spaceAfter: 6, align: 'left', keep: 2 },
  para: { face: 'regular', size: 10.5, lineHeight: 14.2, spaceAfter: 6, align: 'justify' },
  quote: { face: 'italic', size: 10, lineHeight: 13.4, spaceBefore: 3, spaceAfter: 9, align: 'justify', indent: 20 },
  sep: { face: 'regular', size: 10, lineHeight: 15, spaceBefore: 6, spaceAfter: 12, align: 'center' },
  tocHeading: { face: 'bold', size: 17, lineHeight: 22, spaceBefore: 4, spaceAfter: 18, align: 'center' },
  tocEntry: { face: 'regular', size: 10.5, lineHeight: 15.5, spaceAfter: 1 },
};

function faceKeyFor(baseFace, run) {
  const bold = Boolean(run && run.bold) || baseFace === 'bold';
  const italic = Boolean(run && run.italic) || baseFace === 'italic';
  if (bold && italic) return 'bolditalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}

/** Turns a block's runs into measurable tokens (words + spaces). */
function tokenizeRuns(runs, faces, style) {
  const tokens = [];
  for (const run of runs) {
    const face = faces[faceKeyFor(style.face, run)];
    const size = style.size;
    for (const part of String(run.text).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        if (tokens.length) tokens[tokens.length - 1].gap += face.width(' ', size) * part.length;
        continue;
      }
      tokens.push({ text: part, face, size, w: face.width(part, size), gap: 0 });
    }
  }
  if (tokens.length) tokens[tokens.length - 1].gap = 0;
  return tokens;
}

/** Breaks words wider than the line (no hyphenation) so the text does not overflow the page. */
function splitOversizedTokens(tokens, maxWidth) {
  const out = [];
  for (const token of tokens) {
    if (token.w <= maxWidth) {
      out.push(token);
      continue;
    }
    let chunk = '';
    let width = 0;
    const chunks = [];
    for (const ch of token.text) {
      const chWidth = token.face.width(ch, token.size);
      if (width + chWidth > maxWidth && chunk) {
        chunks.push({ chunk, width });
        chunk = '';
        width = 0;
      }
      chunk += ch;
      width += chWidth;
    }
    if (chunk) chunks.push({ chunk, width });
    chunks.forEach((part, index) => {
      out.push({
        text: part.chunk,
        face: token.face,
        size: token.size,
        w: part.width,
        gap: index === chunks.length - 1 ? token.gap : 0,
      });
    });
  }
  return out;
}

/** Splits the tokens into lines; computes the start x and the justification gaps. */
function wrapTokens(tokens, maxWidth, style) {
  const lines = [];
  tokens = splitOversizedTokens(tokens, maxWidth);
  const finish = (lineTokens, width, isLast) => {
    const indent = style.indent || 0;
    let x = PAGE.LEFT + indent;
    let extraGap = 0;
    if (style.align === 'center') {
      x = PAGE.LEFT + indent + Math.max(0, (maxWidth - width) / 2);
    } else if (style.align === 'justify' && !isLast && lineTokens.length > 1) {
      const extra = (maxWidth - width) / (lineTokens.length - 1);
      if (extra > 0 && extra <= 4) extraGap = extra;
    }
    let ascentRatio = 0;
    for (const token of lineTokens) ascentRatio = Math.max(ascentRatio, token.face.ascentRatio);
    lines.push({
      tokens: lineTokens,
      width,
      x,
      extraGap,
      size: style.size,
      ascentRatio,
      centered: style.align === 'center',
    });
  };
  let current = [];
  let currentWidth = 0;
  for (const token of tokens) {
    const gap = current.length ? current[current.length - 1].gap : 0;
    if (current.length && currentWidth + gap + token.w > maxWidth) {
      finish(current, currentWidth, false);
      current = [];
      currentWidth = 0;
    }
    currentWidth += (current.length ? gap : 0) + token.w;
    current.push(token);
  }
  if (current.length) finish(current, currentWidth, true);
  return lines;
}

class Flower {
  constructor(faces, startPage) {
    this.faces = faces;
    this.start = startPage;
    this.pages = [];
    this.cursor = 0;
  }

  get index() {
    return this.start + this.pages.length - 1;
  }

  get page() {
    return this.pages[this.pages.length - 1];
  }

  beginPage() {
    this.pages.push({ lines: [] });
    this.cursor = TEXT_TOP;
  }

  ensurePage() {
    if (!this.pages.length) this.beginPage();
  }

  space() {
    this.ensurePage();
    return this.cursor - TEXT_BOTTOM;
  }

  push(line) {
    this.page.lines.push(line);
  }
}

const BODY_LINE_HEIGHT = BLOCK_STYLES.para.lineHeight;

/** Lays out the blocks of a chapter/section across pages, with minimal orphan/widow control. */
function flowBlocks(flower, blocks, options = {}) {
  for (const block of blocks) {
    if (block.type === 'tocEntry') {
      flowTocEntry(flower, block, options);
      continue;
    }
    const style = BLOCK_STYLES[block.type];
    if (!style) continue;
    const tokens = block.type === 'sep'
      ? tokenizeRuns([{ text: '* * *', bold: false, italic: false }], flower.faces, style)
      : tokenizeRuns(block.runs, flower.faces, style);
    if (!tokens.length) continue;
    const indent = style.indent || 0;
    const maxWidth = CONTENT_W - indent * 2;
    const lines = wrapTokens(tokens, maxWidth, style);
    flower.ensurePage();
    const needed = (style.spaceBefore || 0) + lines.length * style.lineHeight;
    const keep = style.keep ? needed + style.keep * BODY_LINE_HEIGHT : needed;
    if (flower.space() < keep) flower.beginPage();
    else if (!style.keep && lines.length > 1 && flower.space() < (style.spaceBefore || 0) + 2 * style.lineHeight) {
      flower.beginPage();
    }
    flower.cursor -= style.spaceBefore || 0;
    let first = true;
    for (const line of lines) {
      if (flower.cursor - style.lineHeight < TEXT_BOTTOM) flower.beginPage();
      const y = flower.cursor - line.ascentRatio * style.size;
      flower.push({ y, x: line.x, tokens: line.tokens, extraGap: line.extraGap, size: style.size });
      flower.cursor -= style.lineHeight;
      if (first && options.onHeading && (block.type === 'h1' || block.type === 'h2')) {
        options.onHeading(block.type === 'h1' ? 1 : 2, blockText(block), flower.index, y);
      }
      first = false;
    }
    flower.cursor -= style.spaceAfter || 0;
  }
}

/** Table of contents line: title, leader dots and the page number aligned to the right. */
function flowTocEntry(flower, block, options) {
  const style = BLOCK_STYLES.tocEntry;
  const face = flower.faces.regular;
  const size = style.size;
  const numberText = String(block.page);
  const numberWidth = face.width(numberText, size);
  const dotWidth = face.width('.', size);
  const spaceWidth = face.width(' ', size);
  const titleTokens = tokenizeRuns([{ text: block.title, bold: false, italic: false }], flower.faces, style);
  const lines = wrapTokens(titleTokens, CONTENT_W - numberWidth - 22, style);
  if (!lines.length) return;
  const numberX = PAGE.LEFT + CONTENT_W - numberWidth;
  lines.forEach((line, index) => {
    if (index === lines.length - 1) {
      const dotsStart = PAGE.LEFT + line.width + spaceWidth;
      const available = numberX - spaceWidth - dotsStart;
      const dotCount = Math.max(0, Math.floor(available / dotWidth));
      if (dotCount > 0) {
        const dots = '.'.repeat(dotCount);
        line.tokens.push({ text: dots, face, size, w: dotCount * dotWidth, gap: spaceWidth, x: dotsStart });
      }
      line.tokens.push({ text: numberText, face, size, w: numberWidth, gap: 0, x: numberX });
    }
    if (flower.cursor - style.lineHeight < TEXT_BOTTOM) flower.beginPage();
    const y = flower.cursor - line.ascentRatio * size;
    flower.push({ y, x: line.x, tokens: line.tokens, extraGap: 0, size });
    flower.cursor -= style.lineHeight;
  });
  flower.cursor -= style.spaceAfter || 0;
}

function layoutToc(entries, faces, startPage, headingText) {
  const flower = new Flower(faces, startPage);
  const heading = BLOCK_STYLES.tocHeading;
  const lines = wrapTokens(tokenizeRuns([{ text: headingText, bold: false, italic: false }], faces, heading), CONTENT_W, heading);
  flower.ensurePage();
  flower.cursor -= heading.spaceBefore;
  for (const line of lines) {
    const y = flower.cursor - line.ascentRatio * heading.size;
    flower.push({ y, x: line.x, tokens: line.tokens, extraGap: line.extraGap, size: heading.size });
    flower.cursor -= heading.lineHeight;
  }
  flower.cursor -= heading.spaceAfter;
  flowBlocks(flower, entries.map((entry) => ({ type: 'tocEntry', title: entry.title, page: entry.page })), {});
  return { pages: flower.pages };
}

function layoutBody(book, faces, startPage) {
  const flower = new Flower(faces, startPage);
  const headings = [];
  const onHeading = (level, title, page, y) => headings.push({ level, title, page, y });
  for (const section of book.sections) {
    flower.beginPage();
    const blocks = [];
    if (section.label) blocks.push({ type: 'label', runs: [{ text: section.label, bold: false, italic: false }] });
    blocks.push({ type: 'h1', runs: [{ text: section.title, bold: false, italic: false }] });
    blocks.push(...section.blocks);
    flowBlocks(flower, blocks, { onHeading });
  }
  return { pages: flower.pages, headings };
}

function centeredTextLines(faces, text, faceKey, size, lineHeight, topY, maxWidth) {
  const style = { face: faceKey, size, align: 'center', lineHeight };
  const tokens = tokenizeRuns([{ text, bold: false, italic: false }], faces, style);
  const lines = wrapTokens(tokens, maxWidth || CONTENT_W, style);
  const out = [];
  let cursor = topY;
  for (const line of lines) {
    out.push({ y: cursor - line.ascentRatio * size, x: line.x, tokens: line.tokens, extraGap: 0, size });
    cursor -= lineHeight;
  }
  return out;
}

function buildTitlePage(book, faces) {
  const lines = [];
  const titleLines = centeredTextLines(faces, book.title, 'bold', 25, 33, PAGE.H - 230);
  lines.push(...titleLines);
  if (book.subtitle) {
    lines.push(...centeredTextLines(faces, book.subtitle, 'italic', 12.5, 18, PAGE.H - 230 - titleLines.length * 33 - 16));
  }
  if (book.author) lines.push(...centeredTextLines(faces, book.author, 'regular', 12, 17, 128));
  lines.push(...centeredTextLines(faces, book.year, 'regular', 12, 17, 108));
  return { lines };
}

function buildDedicationPage(book, faces) {
  const lines = centeredTextLines(faces, book.dedication, 'italic', 11.5, 17, PAGE.H * 0.55);
  return { lines };
}

function footerLine(faces, number) {
  const face = faces.regular;
  const size = 9;
  const text = String(number);
  const width = face.width(text, size);
  return {
    y: FOOTER_Y,
    x: PAGE.LEFT + (CONTENT_W - width) / 2,
    tokens: [{ text, face, size, w: width, gap: 0 }],
    extraGap: 0,
    size,
    raw: true,
  };
}

/**
 * Paginates the book: title page, dedication (optional), table of contents, then the body.
 * The table of contents and the body are iterated until the number of TOC pages stabilizes,
 * so that the page numbers in the table of contents are exact.
 */
export function layoutBook(book, faces) {
  const titlePage = buildTitlePage(book, faces);
  const dedicationPage = book.dedication ? buildDedicationPage(book, faces) : null;
  const frontCount = 1 + (dedicationPage ? 1 : 0);
  let tocPages = 1;
  let toc = null;
  let body = null;
  let entries = [];
  for (let iteration = 0; iteration < 10; iteration++) {
    body = layoutBody(book, faces, frontCount + tocPages + 1);
    entries = body.headings.filter((heading) => heading.level === 1).map((heading) => ({ title: heading.title, page: heading.page }));
    toc = layoutToc(entries, faces, frontCount + 1, book.labels.toc);
    if (toc.pages.length === tocPages) break;
    tocPages = toc.pages.length;
  }
  const pages = [titlePage, ...(dedicationPage ? [dedicationPage] : []), ...toc.pages, ...body.pages];
  pages.forEach((page, index) => {
    if (index > 0) page.lines.push(footerLine(faces, index + 1));
  });
  const bookmarks = [{ title: book.labels.toc, page: frontCount + 1, y: TEXT_TOP }];
  for (const heading of body.headings) bookmarks.push({ title: heading.title, page: heading.page, y: heading.y, level: heading.level });
  return { pages, entries, bookmarks };
}

/**
 * Notes on every face the characters the finished layout asks it to render, and returns the set of
 * faces that appear. The renderer uses it twice: before a family is accepted, to prove that each
 * face covers the characters rendered with it (see `resolveFonts` in fonts.mjs), and before the PDF
 * fonts are subsetted. Calling it twice is harmless: `BookFace.note` only adds.
 */
export function usedFaces(layout) {
  const used = new Set();
  for (const page of layout.pages) {
    for (const line of page.lines) {
      for (const token of line.tokens) {
        token.face.note(token.text);
        used.add(token.face);
      }
    }
  }
  return used;
}

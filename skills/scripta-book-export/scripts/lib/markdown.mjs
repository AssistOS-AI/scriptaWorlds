/**
 * Markdown parser for the accepted subset (docs/contracts.md §2.3): `#`/`##` headings,
 * blank-line separated paragraphs, `> ` quotes, `---` scene separators and `**bold**` /
 * `*italic*` inline runs.
 */

function parseInline(text) {
  const runs = [];
  let buffer = '';
  let index = 0;
  const flush = () => {
    if (buffer) {
      runs.push({ text: buffer, bold: false, italic: false });
      buffer = '';
    }
  };
  while (index < text.length) {
    if (text.startsWith('***', index)) {
      const end = text.indexOf('***', index + 3);
      if (end > index + 3) {
        flush();
        runs.push({ text: text.slice(index + 3, end), bold: true, italic: true });
        index = end + 3;
        continue;
      }
    }
    if (text.startsWith('**', index)) {
      const end = text.indexOf('**', index + 2);
      if (end > index + 2 && text[index + 2] !== ' ') {
        flush();
        runs.push({ text: text.slice(index + 2, end), bold: true, italic: false });
        index = end + 2;
        continue;
      }
    }
    if (text[index] === '*') {
      const end = text.indexOf('*', index + 1);
      if (end > index + 1 && text[index + 1] !== ' ' && text[end - 1] !== ' ') {
        flush();
        runs.push({ text: text.slice(index + 1, end), bold: false, italic: true });
        index = end + 1;
        continue;
      }
    }
    buffer += text[index];
    index += 1;
  }
  flush();
  return runs;
}

const BLOCK_TEXT = {
  h1: (runs) => runs.map((run) => run.text).join(''),
  h2: (runs) => runs.map((run) => run.text).join(''),
  para: (runs) => runs.map((run) => run.text).join(''),
  quote: (runs) => runs.map((run) => run.text).join(''),
};

/** @returns {Array<{type:'h1'|'h2'|'para'|'quote'|'sep', runs:Array}>} */
export function parseMarkdown(markdown) {
  const blocks = [];
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  let quote = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'para', runs: parseInline(paragraph.join(' ').trim()) });
      paragraph = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ type: 'quote', runs: parseInline(quote.join(' ').trim()) });
      quote = [];
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushQuote();
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      blocks.push({ type: 'sep', runs: [] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushQuote();
      blocks.push({ type: heading[1].length === 1 ? 'h1' : 'h2', runs: parseInline(heading[2].trim()) });
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      quote.push(trimmed.replace(/^>\s?/, ''));
      continue;
    }
    flushQuote();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushQuote();
  return blocks;
}

export function blockText(block) {
  const joiner = BLOCK_TEXT[block.type];
  return joiner ? joiner(block.runs) : '';
}

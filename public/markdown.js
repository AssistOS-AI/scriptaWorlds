/**
 * Renderer minimal pentru Markdown-ul de capitol (docs/contracts.md §2.3):
 * titluri `#`/`##`, paragrafe separate prin linie goală, citate `> `,
 * separatoare de scenă `---`, evidențiere `**bold**` / `*italic*`.
 * Nu produce HTML din text: totul se construiește ca noduri DOM.
 */

const HEADING = /^(#{1,6})\s+(.*)$/;
const SCENE_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/;
const QUOTE = /^>\s?(.*)$/;

export function renderMarkdown(markdown, { className = 'prose' } = {}) {
  const root = document.createElement('div');
  root.className = className;
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');

  let index = 0;
  while (index < lines.length) {
    const raw = lines[index];
    const trimmed = raw.trim();

    if (trimmed === '') {
      index += 1;
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      const node = document.createElement(`h${Math.min(heading[1].length, 6)}`);
      appendInline(node, heading[2].trim());
      root.append(node);
      index += 1;
      continue;
    }

    if (SCENE_BREAK.test(trimmed)) {
      root.append(Object.assign(document.createElement('hr'), { className: 'scene-break' }));
      index += 1;
      continue;
    }

    if (QUOTE.test(raw.trimStart())) {
      const blockquote = document.createElement('blockquote');
      let paragraph = [];
      const flush = () => {
        if (!paragraph.length) return;
        const node = document.createElement('p');
        appendInline(node, paragraph.join(' '));
        blockquote.append(node);
        paragraph = [];
      };
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index].trimStart());
        if (!match) break;
        const content = match[1].trim();
        index += 1;
        if (content === '') flush();
        else paragraph.push(content);
      }
      flush();
      root.append(blockquote);
      continue;
    }

    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      const nextTrimmed = next.trim();
      if (nextTrimmed === '') break;
      if (HEADING.test(nextTrimmed) || SCENE_BREAK.test(nextTrimmed) || QUOTE.test(next.trimStart())) break;
      paragraph.push(nextTrimmed);
      index += 1;
    }
    const node = document.createElement('p');
    appendInline(node, paragraph.join(' '));
    root.append(node);
  }

  return root;
}

function appendInline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|__[^_]+__|_[^_\n]+_)/g;
  let cursor = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > cursor) parent.append(text.slice(cursor, match.index));
    const token = match[0];
    const strong = token.startsWith('**') || token.startsWith('__');
    const marker = strong ? 2 : 1;
    const node = document.createElement(strong ? 'strong' : 'em');
    appendInline(node, token.slice(marker, token.length - marker));
    parent.append(node);
    cursor = match.index + token.length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}

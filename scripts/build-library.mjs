#!/usr/bin/env node
/**
 * Builds the start-template library from `vision/periodic_table.pdf`.
 *
 * The book is a course of nights: each night opens a memorial sector, states a prohibition, puts a
 * central problem in front of the children and names the cells of the Table that are active in it.
 * Those nights are the best starting points this project has — a world with rules and a story
 * already under way — so each one becomes a template the reader can load into the request field.
 *
 * Layout (docs/contracts.md §7): `library/index.json` lists every template with the line the
 * interface shows, and `library/<slug>/template.json` holds the full template.
 *
 *   node scripts/build-library.mjs            # rebuild everything
 *   node scripts/build-library.mjs --check    # verify the library against the book, write nothing
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDir } from '../src/paths.mjs';

const PDF = join(rootDir, 'vision', 'periodic_table.pdf');
const LIBRARY = join(rootDir, 'library');
const TABLE = join(rootDir, 'data', 'periodic-table.json');

function pdftotext() {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', PDF, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => reject(new Error(`pdftotext is required to rebuild the library: ${error.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`pdftotext failed (${code}): ${err.trim()}`))));
  });
}

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

function slugify(text, maxLength = 56) {
  return clean(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

function firstSentence(text, limit = 240) {
  const body = clean(text);
  const match = body.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = match ? match[1] : body;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1).trimEnd()}…` : sentence;
}

/** Splits the book text into one block per `NIGHT n`. */
function nights(text) {
  const lines = text.split('\n');
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*NIGHT\s+(\d+)\s*(?:[-–—]\s*(.*))?$/);
    if (match) starts.push({ index, number: Number(match[1]), inlineTitle: clean(match[2]) });
  }
  const noise = /^(?:\s*\d{1,4}\s*|\s*THE PERIODIC TABLE OF SPECULATIVE IDEAS\s*)$/;
  return starts.map((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1].index : lines.length;
    const raw = lines.slice(start.index + 1, end);
    // The title sits between `NIGHT n` and the `Memorial sector:` line; the rest is the body.
    const metaAt = raw.findIndex((line) => /Memorial sector:/.test(line));
    const head = (metaAt === -1 ? raw.slice(0, 6) : raw.slice(0, metaAt))
      .filter((line) => line.trim() && !noise.test(line));
    const title = start.inlineTitle || clean(head.join(' ')).replace(/\s*Memorial sector:.*$/, '');
    // The body starts after the `Active cells:` line that closes the meta block, and skips the
    // wrapped tail of that list, so headings never leak into the sentences the template is built from.
    // `Active cells:` is sometimes wrapped as `Active` + `cells: ...`; both forms close the meta block.
    const cellsAt = raw.findIndex((line, position) => /Active\s*cells:/.test(line)
      || (/Active\s*$/.test(line.trim()) && /^\s*cells:/.test(raw[position + 1] ?? '')));
    let bodyAt = cellsAt === -1 ? (metaAt === -1 ? 0 : metaAt) : cellsAt + 1;
    while (bodyAt < raw.length) {
      const line = raw[bodyAt];
      if (line.trim().length > 70 || /\.\s*$/.test(line.trim())) break;
      if (line.trim() && !noise.test(line) && line.trim().length <= 70 && /[a-z]{3}/.test(line) === false) { bodyAt += 1; continue; }
      if (!line.trim()) { bodyAt += 1; continue; }
      break;
    }
    const bodyLines = raw.slice(bodyAt);
    const body = clean(bodyLines.join('\n'));
    const paragraphs = [];
    for (const line of bodyLines) {
      const text = line.trim();
      if (!text || noise.test(line)) continue;
      // A paragraph starts on an indented line; the ones that follow continue it.
      if (/^\s{2,}\S/.test(line) || paragraphs.length === 0) paragraphs.push(text);
      else paragraphs[paragraphs.length - 1] += ` ${text}`;
    }
    for (let index = 0; index < paragraphs.length; index += 1) {
      paragraphs[index] = clean(paragraphs[index]);
    }
    const meta = clean(raw.slice(metaAt === -1 ? 0 : metaAt, cellsAt === -1 ? bodyAt : cellsAt + 2).join(' '));
    return { number: start.number, title: clean(title).replace(/^\d+\s*/, ''), body, meta, paragraphs };
  });
}

function cut(text, pattern, limit = 600) {
  const match = text.match(pattern);
  return match ? clean(match[1]).slice(0, limit) : '';
}

/** Maps the cells a night works with onto the canonical table symbols. */
function resolveCells(list, table) {
  const cells = [];
  for (const raw of list.split(';')) {
    const entry = clean(raw);
    if (!entry) continue;
    const match = entry.match(/^(\S{2,3})\s*(?:—|-)\s*([^:]+):?\s*(.*)$/);
    if (!match) continue;
    const [, bookSymbol, name, description] = match;
    const wanted = clean(name).toLowerCase();
    const element = table.elements.find((candidate) => candidate.name.toLowerCase() === wanted)
      ?? table.elements.find((candidate) => candidate.bookSymbol === bookSymbol);
    cells.push({
      bookSymbol,
      name: element?.name ?? clean(name),
      symbol: element?.symbol ?? null,
      family: element?.family ?? null,
      operator: element?.operator ?? null,
      gist: element?.gist ?? clean(description).slice(0, 200),
      // The sentence a reader understands, exactly as the table writes it for its own cells.
      ingredient: element?.ingredient ?? ''
    });
  }
  return cells;
}

function buildTemplate(night, table) {
  const { body, meta } = night;
  const sector = cut(meta, /Memorial sector:\s*(.+?)\s*•/, 80);
  const genealogy = cut(meta, /Genealogy:\s*(.+?)\s*•\s*Active\s*cells:/, 200)
    .split(';').map(clean).filter(Boolean);
  // The header of the night lists the symbols; the analytical sentence names them and says what
  // they do ("The active cells were Hn — Hunger for Novelty: ...; Ce — ...").
  const named = cut(body, /The active cells were\s*(.+?)(?:\.\s|$)/, 600);
  const headerCells = cut(meta, /Active\s*cells:\s*([^.•]+)/, 200);
  const cells = named
    ? resolveCells(named, table)
    : resolveCells(headerCells.split(',').map((symbol) => `${clean(symbol)} — ${clean(symbol)}: `).join(';'), table);
  const prohibition = firstSentence(cut(body, /prohibition:\s*(.+?)(?:\.\s|$)/, 300));
  // The situation is the first paragraph of the night that is not ceremony: the book opens every
  // night with a fixed set of sentences (the theme, the threshold, the memorial) and only then says
  // what happens in that world.
  const ceremony = /^(On night \d+|Aster did not announce|Aster presents sectors|The name on the threshold was|The .{2,40} sector was already in progress|The memorial bore the name|In this part of the course|Aster considered it indecent|Kesh built his classifications|Kesh builds the Table|Marae kept her|The laboratory architecture|Aster could follow many histories|The children were met by|In the hall between sectors|\d+$)/;
  const situationSource = (night.paragraphs ?? []).find((paragraph) => paragraph.length > 50 && !ceremony.test(paragraph)) ?? '';
  const situation = firstSentence(situationSource, 320);
  const story = firstSentence(cut(body, /The problem closed quickly around them:\s*(.+?)(?:\.\sThere was no clean option|$)/, 500), 400);
  // Initials such as "Robert L. Forward" carry a period: stop at the sentence that follows instead.
  const references = clean(cut(body, /Course references included\s*(.+?)(?:\.\s+(?:The rule was strict|They had to identify|$)|$)/, 300))
    .split(';')
    .map((part) => clean(part))
    .filter((part) => part.length > 2 && !/^(uploads?|original concept|final thesis|hard SF|simulation SF)$/i.test(part))
    .filter((part, index, list) => list.findIndex((other) => other.startsWith(part) || part.startsWith(other)) === index)
    .join('; ');
  const operator = cut(body, /linked the night to the\s+([A-Z]+)\s+operator/, 40);

  const slug = `night-${String(night.number).padStart(2, '0')}-${slugify(night.title)}`;
  const summary = story || prohibition || night.title;
  return {
    slug,
    kind: 'night',
    number: night.number,
    title: night.title,
    sector,
    genealogy,
    cells,
    operator,
    references,
    prohibition,
    situation,
    story,
    summary,
    // The text that lands in the request field: every indication the book gives for this world, in
    // the order ALA reads it, with nothing generic added — the reader edits it and sends it.
    request: [
      // The opening positions the world, the way the library does: a sector and the authors it is
      // kept after. No course, no night numbers — these are worlds a reader continues.
      `A world in the ${sector || 'unnamed'} sector${genealogy.length ? `, kept after ${genealogy.slice(0, 3).join('; ')}` : ''}.`,
      prohibition ? `Prohibition: ${prohibition}.` : '',
      cells.length
        ? `The operations this world is built from:\n${cells.map((cell) => `- ${cell.ingredient || `${cell.name}: a universe where ${cell.gist} (${String(cell.family ?? '').toLowerCase()}, ${String(cell.operator ?? '').toLowerCase()}).`}`).join('\n')}`
        : '',
      situation ? `When we arrive: ${situation}` : '',
      story ? `The central tension we want to continue: ${story}` : '',
      references ? `What the course asks of this world: ${references}.` : ''
    ].filter(Boolean).join('\n\n'),
    // The same material as a labelled list, so the interface can show what was read out of the book
    // without the reader having to parse the request text.
    indications: [
      sector ? { label: 'Sector', text: sector } : null,
      genealogy.length ? { label: 'Genealogy', text: genealogy.join('; ') } : null,
      prohibition ? { label: 'Prohibition', text: prohibition } : null,
      cells.length
        ? { label: 'Active cells', text: cells.map((cell) => `${cell.name} — ${cell.gist}`).join('; ') }
        : null,
      situation ? { label: 'Situation', text: situation } : null,
      story ? { label: 'Central tension', text: story } : null,
      references ? { label: 'Seen in', text: references } : null
    ].filter(Boolean),
    // The night as the book writes it, for the reader who wants the whole context before choosing.
    sourceText: body.slice(0, 6000)
  };
}

async function main() {
  const check = process.argv.includes('--check');
  const table = JSON.parse(await readFile(TABLE, 'utf8'));
  const text = await pdftotext();
  const found = nights(text);
  const templates = found
    .map((night) => buildTemplate(night, table))
    .filter((template) => template.situation || template.story || template.prohibition);

  const unsymbolised = templates.flatMap((template) => template.cells.filter((cell) => !cell.symbol)
    .map((cell) => `${template.slug}: ${cell.bookSymbol} ${cell.name}`));

  if (check) {
    const index = JSON.parse(await readFile(join(LIBRARY, 'index.json'), 'utf8'));
    const problems = [];
    if (index.templates.length !== templates.length) {
      problems.push(`index has ${index.templates.length} templates, the book has ${templates.length}`);
    }
    if (unsymbolised.length) problems.push(`${unsymbolised.length} cells without a table symbol`);
    console.log(`library: ${index.templates.length} templates indexed, ${templates.length} in the book`);
    for (const problem of problems) console.log(`  ! ${problem}`);
    if (problems.length) process.exit(1);
    return;
  }

  // Only the templates this script generates are replaced. Hand-authored entries (`empty/`) stay on
  // disk: a rebuild must never drop the world a reader can start from when nothing else fits.
  await mkdir(LIBRARY, { recursive: true });
  const existing = await readdir(LIBRARY, { withFileTypes: true }).catch(() => []);
  for (const entry of existing) {
    if (entry.isDirectory() && entry.name.startsWith('night-')) {
      await rm(join(LIBRARY, entry.name), { recursive: true, force: true });
    }
  }
  const entries = [];
  for (const template of templates) {
    const dir = join(LIBRARY, template.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'template.json'), `${JSON.stringify(template, null, 1)}\n`, 'utf8');
    entries.push({
      slug: template.slug,
      kind: template.kind,
      number: template.number,
      title: template.title,
      sector: template.sector,
      genealogy: template.genealogy,
      cells: template.cells.map((cell) => ({ symbol: cell.symbol, name: cell.name, family: cell.family, operator: cell.operator })),
      summary: template.summary
    });
  }
  // The empty template is authored by hand: it is read, never generated, and always listed first.
  const emptyPath = join(LIBRARY, 'empty', 'template.json');
  let emptyEntry = null;
  try {
    const empty = JSON.parse(await readFile(emptyPath, 'utf8'));
    emptyEntry = {
      slug: empty.slug, kind: empty.kind, number: empty.number, title: empty.title,
      sector: empty.sector, genealogy: empty.genealogy, cells: empty.cells ?? [], summary: empty.summary
    };
  } catch {
    throw new Error(`the hand-authored template is missing: ${emptyPath}`);
  }
  entries.unshift(emptyEntry);

  // One template per line: the start screen reads the whole index at once, and a reader who opens the
  // file should see one world at a time instead of a screenful of nested braces.
  const header = {
    source: 'vision/periodic_table.pdf',
    note: 'Start templates read from the book: each night opens a sector, states a prohibition and puts one problem at the centre of the world. The first entry is the empty template.',
    count: entries.length
  };
  const headerLines = Object.entries(header).map(([key, value]) => ` "${key}": ${JSON.stringify(value)}`).join(',\n');
  const templateLines = entries.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n');
  // Which nights work which cell: the scenes a reader can continue, per cell of the table.
  const cellScenes = {};
  for (const template of templates) {
    for (const cell of template.cells) {
      if (!cell.symbol) continue;
      const list = cellScenes[cell.symbol] ?? (cellScenes[cell.symbol] = []);
      if (list.length >= 3) continue;
      list.push({ slug: template.slug, title: template.title, sector: template.sector, situation: template.situation, story: template.story });
    }
  }
  await writeFile(join(LIBRARY, 'index.json'), `{\n${headerLines},\n "cellScenes": ${JSON.stringify(cellScenes)},\n "templates": [\n${templateLines}\n ]\n}\n`, 'utf8');

  console.log(`library built: ${entries.length} templates in ${LIBRARY}`);
  console.log(`  cells without a table symbol: ${unsymbolised.length}`);
  for (const item of unsymbolised.slice(0, 6)) console.log(`    ${item}`);
  console.log(`  first: ${entries[0]?.slug} — ${entries[0]?.summary.slice(0, 80)}`);
}

main().catch((error) => {
  console.error(`[library] ${error.message}`);
  process.exit(1);
});

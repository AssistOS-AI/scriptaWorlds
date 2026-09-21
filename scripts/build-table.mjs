#!/usr/bin/env node
/**
 * Builds `data/periodic-table.json` from `vision/periodic_table.pdf`.
 *
 * The book prints the table twice: the cell tables give the systematic symbol of every cell
 * (family letter + operator letter), and the isotope sections give, for each cell, its name, the
 * mechanism in one line, a literary landmark and the four prose sections the reader sees when a cell
 * is opened (nucleus, genealogy, propagation, instability, compounds).
 *
 *   node scripts/build-table.mjs            # rebuild the data file
 *   node scripts/build-table.mjs --check    # verify it against the book, write nothing
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDir } from '../src/paths.mjs';

const PDF = join(rootDir, 'vision', 'periodic_table.pdf');
const OUT = join(rootDir, 'data', 'periodic-table.json');

const FAMILY_LETTER = {
  COSMOS: 'C', SPACE: 'S', TIME: 'T', LIFE: 'L', MIND: 'M', BODY: 'B',
  INFORMATION: 'I', SOCIETY: 'P', ARTIFACT: 'A', CONTACT: 'X', FANTASY: 'F',
  'META-REALITY': 'R'
};
const OPERATOR_LETTER = {
  ALTERATION: 'A', SUBSTITUTION: 'S', EXTENSION: 'E', RATE: 'R', BOUNDARY: 'B',
  DISTRIBUTION: 'D', COPYING: 'C', COUPLING: 'K', EXTERNALIZATION: 'X', INVERSION: 'I',
  LOOP: 'L', GENESIS: 'G', 'SCARCITY SHIFT': 'Q', REFLEXIVITY: 'F', OUTFINITE: 'O'
};
const OPERATOR_DOES = {
  ALTERATION: 'changes the value or form of an existing rule without yet changing the kind of thing on which it operates',
  SUBSTITUTION: 'replaces the substrate, carrier, or medium of a function',
  EXTENSION: 'adds a degree of freedom, capacity, or axis absent from the baseline world',
  RATE: 'changes the speed at which processes unfold without necessarily changing their order',
  BOUNDARY: 'moves, perforates, or redefines the boundary between inside and outside',
  DISTRIBUTION: 'spreads a unit across several bodies, places, agents, or nodes',
  COPYING: 'creates a second instance similar enough for continuity to become a problem',
  COUPLING: 'makes previously independent domains determine one another',
  EXTERNALIZATION: 'turns an internal property into an object, companion, infrastructure, or institution',
  INVERSION: 'reverses an order, dependence, direction, or relation taken as natural',
  LOOP: 'feeds a system output back into its own input, producing recurrence',
  GENESIS: 'allows a system to create new agents, worlds, laws, or substrates',
  'SCARCITY SHIFT': 'makes what was rare abundant, or what was abundant rare, forcing a new economy of power',
  REFLEXIVITY: 'makes description, prediction, belief, or observation modify the thing described',
  OUTFINITE: 'allows successive finite extensions without postulating an already-given final infinite state'
};
// The descriptive labels the detailed sections use for the twelve families.
const FAMILY_LABEL = {
  COSMOS: 'COSMOS', SPACE: 'SPACE AND GEOMETRY', TIME: 'TIME AND CAUSALITY',
  LIFE: 'LIFE AND EVOLUTION', MIND: 'MIND AND IDENTITY', BODY: 'BODY AND METAMORPHOSIS',
  INFORMATION: 'INFORMATION AND LANGUAGE', SOCIETY: 'SOCIETY AND POWER',
  ARTIFACT: 'MACHINES AND ARTIFACTS', CONTACT: 'CONTACT AND CIVILIZATIONS',
  FANTASY: 'FANTASY AND MAGICAL ONTOLOGIES', 'META-REALITY': 'SCIENCE FANTASY AND META-REALITY'
};
const SECTION_LABELS = ['Nucleus.', 'Genealogy.', 'Periodic position.', 'Propagation.', 'Instability.', 'Compounds.'];
const HEADING = /^(\d{2}\.\d{2})\s+(\S{2,3})\s+—\s+(.+?)\s*$/;
const FAMILY_LINE = /^Family:\s*(.+?)\s*•\s*landmark:\s*(.+?)\s*$/;

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// Every isotope section of the book repeats the same skeleton, so only the family sentence that the
// Propagation section adds is worth keeping: it says what the change does to a world of that family.
const PROPAGATION_OPENER = /^A serious implementation must show who gains new access, who loses an old protection, and which everyday metaphors stop working\.\s*/;
function familyNoteFor(elements) {
  const notes = new Map();
  for (const element of elements) {
    if (notes.has(element.family)) continue;
    const propagation = element.sections?.Propagation ?? '';
    const note = clean(propagation.replace(PROPAGATION_OPENER, '').split(/\sIn this sense, social consequence/)[0]);
    if (note) notes.set(element.family, note);
  }
  return notes;
}

function pdftotext() {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', PDF, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => reject(new Error(`pdftotext is required to rebuild the table: ${error.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`pdftotext failed (${code}): ${err.trim()}`))));
  });
}

/** One record per `NN.NN Symbol — Name` section of the book. */
function parseElements(text) {
  const lines = text.split('\n');
  const elements = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = HEADING.exec(lines[index].trim());
    if (!heading) continue;

    let cursor = index + 1;
    let familyLine = null;
    while (cursor < lines.length && cursor < index + 6 && !familyLine) {
      familyLine = FAMILY_LINE.exec(lines[cursor].trim());
      cursor += 1;
    }
    if (!familyLine) continue;

    const body = [];
    while (cursor < lines.length && !HEADING.test(lines[cursor].trim())) {
      body.push(lines[cursor].trim());
      cursor += 1;
    }

    const sections = {};
    let current = null;
    for (const line of body) {
      const label = SECTION_LABELS.find((candidate) => line.startsWith(candidate));
      if (label) {
        current = label.slice(0, -1);
        sections[current] = line.slice(label.length).trim();
      } else if (current && line) {
        sections[current] = `${sections[current]} ${line}`.trim();
      }
    }
    for (const key of Object.keys(sections)) sections[key] = clean(sections[key]);

    const declared = sections['Periodic position']?.match(/corresponding abstract symbol is ([A-Z]{2}[0-9]?)\./);
    const operatorWord = sections['Periodic position']?.match(/associated with the ([a-z\- ]+?) operator/)?.[1]?.trim().toUpperCase() ?? '';
    // The detailed sections use the long label ("SPACE AND GEOMETRY"); the tables use the short name.
    const familyLabel = clean(familyLine[1]).toUpperCase();
    const labelToFamily = new Map(Object.entries(FAMILY_LABEL).map(([name, label]) => [label, name]));
    const family = labelToFamily.get(familyLabel) ?? familyLabel;
    const symbol = declared?.[1] ?? `${FAMILY_LETTER[family] ?? ''}${OPERATOR_LETTER[operatorWord] ?? ''}`;
    const nucleus = sections.Nucleus ?? '';
    const minimal = nucleus.match(/In its minimal form, the idea says that (.+?)(?:\.\s|\.$)/);

    elements.push({
      id: heading[1],
      symbol,
      bookSymbol: heading[2],
      name: clean(heading[3]),
      family,
      familyLabel: FAMILY_LABEL[family] ?? familyLabel,
      operator: operatorWord,
      gist: clean(minimal?.[1] ?? ''),
      landmark: clean(familyLine[2]),
      sections
    });
    index = cursor - 1;
  }
  return elements;
}

/**
 * The line the interface shows under a cell, phrased as the beginning of a request so a reader can
 * put it in the field as it is: "A universe where gravity changes anatomy, architecture, and culture."
 */
function promptFor(element) {
  const gist = element.gist.replace(/\.$/, '');
  if (!gist) return `A universe built on ${element.name.toLowerCase()} (${element.familyLabel.toLowerCase()}).`;
  return `A universe where ${gist}.`;
}

/**
 * What a reader sees and what ALA is told when this cell is an ingredient: a sentence, never the
 * two-letter symbol. The symbol is an address inside the table, not something to read.
 */
function ingredientFor(element) {
  const family = element.familyLabel.toLowerCase();
  const operator = element.operator.toLowerCase();
  const gist = element.gist.replace(/\.$/, '');
  const sentence = gist ? `a universe where ${gist}` : `a world built on ${element.name.toLowerCase()}`;
  return `${element.name}: ${sentence} (${family}, ${operator}).`;
}

async function build() {
  const text = await pdftotext();
  const elements = parseElements(text);
  const families = Object.keys(FAMILY_LETTER);
  const operators = Object.keys(OPERATOR_LETTER);
  const problems = [];
  if (elements.length !== 180) problems.push(`found ${elements.length} elements, expected 180`);
  const symbols = new Set(elements.map((element) => element.symbol));
  if (symbols.size !== 180) problems.push(`${symbols.size} unique symbols, expected 180`);
  for (const element of elements) {
    const expected = `${FAMILY_LETTER[element.family]}${OPERATOR_LETTER[element.operator]}`;
    if (element.symbol !== expected) problems.push(`${element.id} symbol ${element.symbol} != ${expected}`);
    if (!element.gist) problems.push(`${element.id} has no one-line mechanism`);
  }
  return {
    problems,
    payload: {
      source: 'vision/periodic_table.pdf',
      note: 'The Periodic Table of Speculative Ideas: twelve families and fifteen operators, one hundred and eighty cells.',
      families: families.map((name) => ({
        name,
        label: FAMILY_LABEL[name],
        letter: FAMILY_LETTER[name],
        note: familyNoteFor(elements).get(name) ?? '',
        // The book gives no paragraph per family, so the family is described by its own cells below.
        cells: elements.filter((element) => element.family === name).map((element) => element.symbol)
      })),
      operators: operators.map((name) => ({ name, does: OPERATOR_DOES[name], letter: OPERATOR_LETTER[name] })),
      elements: elements.map((element) => ({ ...element, prompt: promptFor(element), ingredient: ingredientFor(element) }))
    }
  };
}

async function main() {
  const check = process.argv.includes('--check');
  const { problems, payload } = await build();
  if (check) {
    const current = JSON.parse(await readFile(OUT, 'utf8'));
    const diffs = [];
    if (current.elements.length !== payload.elements.length) diffs.push(`count ${current.elements.length} != ${payload.elements.length}`);
    const bySymbol = new Map(current.elements.map((element) => [element.symbol, element]));
    const changed = payload.elements.filter((element) => {
      const previous = bySymbol.get(element.symbol);
      return !previous
        || previous.name !== element.name
        || previous.operator !== element.operator
        || previous.gist !== element.gist
        || previous.prompt !== element.prompt
        || previous.ingredient !== element.ingredient;
    });
    if (changed.length) diffs.push(`${changed.length} cells differ: ${changed.slice(0, 5).map((element) => element.symbol).join(', ')}`);
    console.log(`table: ${payload.elements.length} cells, ${payload.families.length} families, ${payload.operators.length} operators`);
    for (const problem of [...problems, ...diffs]) console.log(`  ! ${problem}`);
    if (problems.length || diffs.length) process.exit(1);
    return;
  }
  if (problems.length) {
    console.error('[table] the book did not parse cleanly, nothing written:');
    for (const problem of problems.slice(0, 10)) console.error(`  ! ${problem}`);
    process.exit(1);
  }
  await writeFile(OUT, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
  console.log(`table written: ${payload.elements.length} cells in ${OUT}`);
  console.log(`  first: ${payload.elements[0].symbol} ${payload.elements[0].name} — ${payload.elements[0].prompt}`);
}

main().catch((error) => {
  console.error(`[table] ${error.message}`);
  process.exit(1);
});

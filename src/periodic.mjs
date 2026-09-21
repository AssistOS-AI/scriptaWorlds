/**
 * The Periodic Table of Speculative Ideas.
 *
 * `data/periodic-table.json` is extracted from `vision/periodic_table.pdf` (the atlas the project
 * treats as its design instrument): twelve families, fifteen operators, one hundred and eighty
 * abstract cells. A universe is built as a **compound** of a few elements; the reader picks them
 * when the universe is created and may add an element the table does not contain.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDir } from './paths.mjs';
import { UniverseError } from './errors.mjs';

const tablePath = join(rootDir, 'data', 'periodic-table.json');

let cached = null;

export async function loadTable() {
  if (cached) return cached;
  let raw;
  try {
    raw = await readFile(tablePath, 'utf8');
  } catch {
    throw new UniverseError('NO_TABLE', 'The periodic table data file is missing (data/periodic-table.json).', 500);
  }
  const parsed = JSON.parse(raw);
  // Families are objects (name, label, letter, cells); an older file with bare names is still read.
  const families = (Array.isArray(parsed.families) ? parsed.families : [])
    .map((entry) => (typeof entry === 'string' ? { name: entry, label: entry, letter: '', cells: [] } : entry))
    .filter((entry) => entry?.name);
  const operators = (Array.isArray(parsed.operators) ? parsed.operators : [])
    .map((entry) => (typeof entry === 'string' ? { name: entry, does: '' } : entry))
    .filter((entry) => entry?.name);
  const elements = (Array.isArray(parsed.elements) ? parsed.elements : []).map((element) => ({
    id: element.id,
    // `symbol` is the systematic cell symbol from the book's tables (family letter + operator
    // letter, e.g. `CA` = cosmos + alteration); `bookSymbol` is the mnemonic used in the prose.
    symbol: String(element.symbol ?? '').toUpperCase(),
    bookSymbol: element.bookSymbol ?? element.symbol,
    name: element.name,
    family: element.family,
    operator: element.operator,
    gist: element.gist ?? '',
    // The line the interface can drop into the request field unchanged, and the sentence that says
    // what the ingredient is for a human reader.
    prompt: element.prompt ?? '',
    ingredient: element.ingredient ?? '',
    familyLabel: element.familyLabel ?? element.family,
    landmark: element.landmark ?? ''
  }));
  cached = {
    familyNames: families.map((family) => family.name),
    familyList: families,
    operators,
    elements,
    bySymbol: new Map(elements.map((element) => [element.symbol.toUpperCase(), element]))
  };
  return cached;
}

/**
 * The table as the interface reads it: families with their cells, the operators with what they do,
 * and one line per cell. Opening a single cell is `cellDetail`, so the grid stays small enough to
 * load at once and the book's repeated prose never travels with it.
 */
export async function tableForClient() {
  const table = await loadTable();
  return {
    families: table.familyList,
    operators: table.operators,
    elements: table.elements.map((element) => ({
      id: element.id,
      symbol: element.symbol,
      bookSymbol: element.bookSymbol,
      name: element.name,
      family: element.family,
      operator: element.operator,
      gist: element.gist,
      prompt: element.prompt ?? '',
      ingredient: element.ingredient ?? '',
      landmark: element.landmark
    }))
  };
}

/**
 * What a reader needs about one cell, and nothing else.
 *
 * The book repeats the same skeleton for all one hundred and eighty cells ("Nucleus", "Genealogy",
 * "Periodic position", "Propagation", "Instability", "Compounds"), so serving that prose would be
 * noise. What is unique is kept: the idea in one line, the same idea phrased as the beginning of a
 * request, the sentence that says what this kind of change does to a world, the work it is seen in,
 * and the scenes of the course that already work this cell — the story a reader can continue.
 */
export async function cellDetail(symbol) {
  const table = await loadTable();
  const element = table.bySymbol.get(String(symbol ?? '').trim().toUpperCase());
  if (!element) {
    throw new UniverseError('UNKNOWN_ELEMENT', `The table has no element ${symbol}.`, 404);
  }
  const family = table.familyList.find((entry) => entry.name === element.family) ?? null;
  const operator = table.operators.find((entry) => entry.name === element.operator) ?? null;
  const { scenesForCell } = await import('./library.mjs');
  return {
    id: element.id,
    symbol: element.symbol,
    bookSymbol: element.bookSymbol,
    name: element.name,
    family: element.family,
    familyLabel: element.familyLabel ?? family?.label ?? element.family,
    familyNote: family?.note ?? '',
    operator: element.operator,
    operatorDoes: operator?.does ?? '',
    essence: element.gist,
    prompt: element.prompt ?? '',
    ingredient: element.ingredient ?? '',
    seenIn: element.landmark,
    scenes: await scenesForCell(element.symbol)
  };
}

const MAX_ELEMENTS = 6;

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Resolves the reader's ingredient selection against the table.
 * Accepts symbols (`"CG"`), objects (`{symbol}`) and proposed elements the table does not contain
 * (`{custom: true, name, family, operator, note}`); at most `MAX_ELEMENTS` ingredients.
 */
export async function resolveElements(selection) {
  if (selection == null) return [];
  if (!Array.isArray(selection)) {
    throw new UniverseError('BAD_ELEMENTS', 'elements must be a list.', 400);
  }
  if (selection.length > MAX_ELEMENTS) {
    throw new UniverseError('BAD_ELEMENTS', 'Six ingredients are the most a universe law can hold. Remove one first.', 400);
  }
  const table = await loadTable();
  const operatorNames = new Set(table.operators.map((entry) => entry.name));
  const familyNames = new Set(table.familyNames);
  const resolved = [];
  const seen = new Set();

  for (const entry of selection) {
    const raw = typeof entry === 'string' ? { symbol: entry } : entry;
    if (!raw || typeof raw !== 'object') {
      throw new UniverseError('BAD_ELEMENTS', 'Each ingredient must be a symbol or an object.', 400);
    }

    if (raw.custom === true || (!raw.symbol && raw.name)) {
      const name = cleanText(raw.name, 60);
      if (name.length < 2) {
        throw new UniverseError('BAD_ELEMENT_NAME', 'A proposed ingredient needs a name.', 400);
      }
      const family = cleanText(raw.family, 40).toUpperCase();
      const operator = cleanText(raw.operator, 40).toUpperCase();
      if (family && !familyNames.has(family)) {
        throw new UniverseError('BAD_ELEMENT_FAMILY', `Unknown family: ${family}.`, 400);
      }
      if (operator && !operatorNames.has(operator)) {
        throw new UniverseError('BAD_ELEMENT_OPERATOR', `Unknown operator: ${operator}.`, 400);
      }
      const key = `custom:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({
        symbol: null,
        name,
        family: family || null,
        operator: operator || null,
        gist: cleanText(raw.gist, 200),
        note: cleanText(raw.note, 400),
        custom: true
      });
      continue;
    }

    const symbol = cleanText(raw.symbol, 3).toUpperCase();
    const cell = table.bySymbol.get(symbol)
      ?? table.elements.find((element) => element.symbol.toUpperCase() === symbol);
    if (!cell) {
      throw new UniverseError('UNKNOWN_ELEMENT', `The table has no element ${symbol}.`, 400);
    }
    if (seen.has(cell.symbol)) continue;
    seen.add(cell.symbol);
    resolved.push({
      symbol: cell.symbol,
      name: cell.name,
      family: cell.family,
      operator: cell.operator,
      gist: cell.gist,
      ingredient: cell.ingredient ?? '',
      custom: false
    });
  }
  return resolved;
}

/**
 * The ingredient list as a reader and as the ALA agent read it: one sentence per ingredient, with
 * the mechanism, and never the two-letter symbol — that is an address inside the table, not prose.
 */
export function elementLines(elements) {
  return (elements ?? []).map((element) => {
    if (element.custom) {
      const parts = [element.family, element.operator].filter(Boolean).map((part) => part.toLowerCase()).join(', ');
      const note = element.note || element.gist;
      return `- ${element.name}${parts ? ` (${parts})` : ''}: ${note || 'proposed by the reader; no entry in the table'}.`;
    }
    if (element.ingredient) return `- ${element.ingredient}`;
    const family = String(element.family ?? '').toLowerCase();
    const operator = String(element.operator ?? '').toLowerCase();
    const gist = String(element.gist ?? '').replace(/\.$/, '');
    return `- ${element.name}: ${gist ? `a universe where ${gist}` : 'a world built on this idea'} (${family}, ${operator}).`;
  });
}

/**
 * Composes the fundamental law of a universe from the reader's ingredients.
 *
 * The book is explicit that a world is a compound, not an element: the law states which speculative
 * operations the world is built from, so the ALA agent has the mechanism and not just a theme. A
 * reader who also wrote a law keeps it; the ingredients are appended to it.
 */
export function composeLaw(elements, typedLaw = '') {
  const head = 'The world is built from the following speculative operations of the Periodic Table of Ideas:';
  const body = elementLines(elements).join('\n');
  const parts = [];
  const typed = String(typedLaw ?? '').trim();
  if (typed) parts.push(typed);
  if (body) parts.push(`${head}\n${body}`);
  return parts.join('\n\n').trim();
}

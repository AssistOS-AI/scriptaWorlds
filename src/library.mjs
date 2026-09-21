/**
 * The library of start templates.
 *
 * `library/index.json` lists every template with the one line the interface shows, so the list
 * loads without reading seventy-four folders; `library/<slug>/template.json` is read only when a
 * template is chosen. The templates are built from `vision/periodic_table.pdf` by
 * `scripts/build-library.mjs`: each night of the book opens a sector, states a prohibition, puts one
 * problem at the centre and names the cells of the Table that are active, which is exactly what a
 * universe needs before it has a first chapter.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDir } from './paths.mjs';
import { UniverseError } from './errors.mjs';

export const libraryDir = join(rootDir, 'library');

let indexCache = null;
const templateCache = new Map();

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;

export async function readLibraryIndex() {
  if (indexCache) return indexCache;
  let raw;
  try {
    raw = await readFile(join(libraryDir, 'index.json'), 'utf8');
  } catch {
    throw new UniverseError('NO_LIBRARY', 'The template library is missing (library/index.json).', 500);
  }
  const parsed = JSON.parse(raw);
  const templates = (Array.isArray(parsed.templates) ? parsed.templates : [])
    .filter((entry) => entry?.slug && SLUG_RE.test(entry.slug));
  indexCache = {
    source: parsed.source ?? '',
    note: parsed.note ?? '',
    count: templates.length,
    cellScenes: parsed.cellScenes && typeof parsed.cellScenes === 'object' ? parsed.cellScenes : {},
    templates
  };
  return indexCache;
}

/**
 * The nights of the book that work a given cell: the scenes a reader can continue, with the
 * situation they arrive in and the problem that is already under way there.
 */
export async function scenesForCell(symbol) {
  const clean = String(symbol ?? '').trim().toUpperCase();
  if (!clean) return [];
  const index = await readLibraryIndex();
  const scenes = index.cellScenes?.[clean];
  return Array.isArray(scenes) ? scenes : [];
}

export async function readTemplate(slug) {
  const clean = String(slug ?? '').trim();
  if (!SLUG_RE.test(clean)) {
    throw new UniverseError('BAD_TEMPLATE', 'Invalid template name.', 400);
  }
  if (templateCache.has(clean)) return templateCache.get(clean);
  let raw;
  try {
    raw = await readFile(join(libraryDir, clean, 'template.json'), 'utf8');
  } catch {
    throw new UniverseError('UNKNOWN_TEMPLATE', `The library has no template "${clean}".`, 404);
  }
  const template = JSON.parse(raw);
  templateCache.set(clean, template);
  return template;
}

/** The templates that exist on disk but are missing from the index, and the other way round. */
export async function auditLibrary() {
  const index = await readLibraryIndex();
  let dirs = [];
  try {
    dirs = (await readdir(libraryDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SLUG_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return { missing: [], orphan: index.templates.map((entry) => entry.slug) };
  }
  const indexed = new Set(index.templates.map((entry) => entry.slug));
  return {
    missing: dirs.filter((name) => !indexed.has(name)),
    orphan: [...indexed].filter((slug) => !dirs.includes(slug))
  };
}

/**
 * What a template gives a new universe: the law (its prohibition plus the operations it is built
 * from), the starting situation, the summary shown under the title and the cells as ingredients.
 * The title stays empty on purpose: the reader names nothing, so ALA names the book after the first
 * chapter exactly as it does for any unnamed universe.
 */
export function creationFromTemplate(template, { language, prompt, elements = [] } = {}) {
  // The reader may add their own operations on top of the template's: both are ingredients of the
  // same compound and the server composes one law from all of them. A proposed element is kept as it
  // came (it has no symbol), so it is deduplicated by its name instead.
  const merged = [];
  const seen = new Set();
  for (const item of [...(template.cells ?? []).map((cell) => cell.symbol), ...(Array.isArray(elements) ? elements : [])]) {
    const key = typeof item === 'string'
      ? String(item).trim().toUpperCase()
      : (item?.symbol ? String(item.symbol).trim().toUpperCase() : `custom:${String(item?.name ?? '').trim().toLowerCase()}`);
    if (!item || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  const unique = merged.slice(0, 6);
  const prohibition = String(template.prohibition ?? '').trim();
  const request = String(prompt ?? '').trim();
  // A night states its prohibition; the empty template has none, so the request the reader sends
  // becomes the first law of that world, exactly as the template promises.
  const typedLaw = prohibition
    ? `Prohibition that holds in this world: ${prohibition}`
    : (template.kind === 'empty' && !unique.length ? request.slice(0, 2000) : '');
  const premise = [template.situation, template.story].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ');
  return {
    title: '',
    provisionalTitle: String(template.title ?? '').trim(),
    summary: String(template.summary ?? '').trim().slice(0, 600),
    law: typedLaw,
    premise,
    elements: unique,
    language,
    prompt: request
  };
}

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDir } from './paths.mjs';

const TEMPLATES_PATH = join(rootDir, 'templates', 'universes.json');
const PARTS_DIR = join(rootDir, 'templates', 'parts');

let cache = { stamp: '', templates: [] };

function localized(value, language) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return String(value[language] ?? value.en ?? value.ro ?? '').trim();
}

function localizedList(value, language) {
  if (Array.isArray(value)) {
    // array of entries, each either a plain string or a { ro, en } object
    return value.map((entry) => localized(entry, language)).filter(Boolean);
  }
  if (value && typeof value === 'object') {
    // language-keyed value: { ro: [...], en: [...] } or the legacy { ro: "...", en: "..." }
    const resolved = value[language] ?? value.en ?? value.ro;
    if (Array.isArray(resolved)) return resolved.map((entry) => localized(entry, language)).filter(Boolean);
    const single = localized(resolved, language);
    return single ? [single] : [];
  }
  const single = localized(value, language);
  return single ? [single] : [];
}

async function readCatalogFiles() {
  const files = [];
  const main = await stat(TEMPLATES_PATH).catch(() => null);
  if (main) files.push({ path: TEMPLATES_PATH, mtimeMs: main.mtimeMs });
  const parts = await readdir(PARTS_DIR).catch(() => []);
  for (const name of parts.sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(PARTS_DIR, name);
    const info = await stat(path).catch(() => null);
    if (info) files.push({ path, mtimeMs: info.mtimeMs });
  }
  return files;
}

/**
 * Catalogue of possible universes. Reads `templates/universes.json` plus every file in
 * `templates/parts/*.json`, de-duplicated by `id`. Each template exposes a descriptive title,
 * the fundamental law and 3–4 concrete openings, localised (English fallback, then Romanian).
 */
export async function listTemplates(language = 'ro') {
  const files = await readCatalogFiles();
  const stamp = files.map((file) => `${file.path}:${file.mtimeMs}`).join('|');
  if (stamp !== cache.stamp) {
    const templates = [];
    const seen = new Set();
    for (const file of files) {
      let parsed;
      try {
        parsed = JSON.parse(await readFile(file.path, 'utf8'));
      } catch {
        continue;
      }
      for (const template of parsed?.templates ?? []) {
        const id = String(template?.id ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        templates.push(template);
      }
    }
    cache = { stamp, templates };
  }
  return cache.templates
    .map((template) => ({
      id: String(template.id),
      tags: Array.isArray(template.tags) ? template.tags.map((tag) => String(tag)) : [],
      title: localized(template.title, language),
      law: localized(template.law, language),
      openings: localizedList(template.openings ?? template.opening, language)
    }))
    .filter((template) => template.id && template.title && template.law);
}

export async function findTemplate(id) {
  const templates = await listTemplates('en');
  return templates.find((template) => template.id === id) ?? null;
}

export { TEMPLATES_PATH, PARTS_DIR };

#!/usr/bin/env node
// Merges every `templates/parts/*.json` file into `templates/universes.json` (the catalogue the server
// serves). Sources stay in `templates/parts/`; the merged file is what `GET /api/templates` reads first.
// Usage: npm run catalog

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDir } from '../src/paths.mjs';
import { PARTS_DIR, TEMPLATES_PATH } from '../src/templates.mjs';

const LANGUAGES = ['ro', 'en'];

function localized(value, language) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return String(value[language] ?? '').trim();
}

function problemsFor(template) {
  const problems = [];
  if (!/^[a-z0-9-]+$/.test(template.id ?? '')) problems.push('id must be a lowercase slug');
  for (const language of LANGUAGES) {
    if (localized(template.title, language).length < 20) problems.push(`title.${language} too short`);
    if (localized(template.law, language).length < 200) problems.push(`law.${language} too short`);
    const openings = (template.openings?.[language] ?? []).filter((entry) => String(entry).trim().length >= 60);
    if (openings.length < 3) problems.push(`needs at least 3 openings in ${language}`);
    if (language === 'en' && /[ăâîșțĂÂÎȘȚ]/.test(localized(template.law, language))) problems.push('law.en contains Romanian diacritics');
  }
  if (!Array.isArray(template.tags) || template.tags.length < 1) problems.push('tags are missing');
  return problems;
}

const files = (await readdir(PARTS_DIR).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
if (files.length === 0) {
  console.log('No files in templates/parts/ — nothing to merge.');
  process.exit(0);
}

const merged = [];
const seen = new Set();
const report = [];
for (const name of files) {
  const path = join(PARTS_DIR, name);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    report.push({ file: name, count: 0, problems: [`invalid JSON: ${error.message}`] });
    continue;
  }
  let count = 0;
  const problems = [];
  for (const template of parsed?.templates ?? []) {
    if (seen.has(template.id)) {
      problems.push(`duplicate id skipped: ${template.id}`);
      continue;
    }
    const templateProblems = problemsFor(template);
    if (templateProblems.length > 0) {
      problems.push(`${template.id}: ${templateProblems.join('; ')}`);
      continue;
    }
    seen.add(template.id);
    merged.push(template);
    count += 1;
  }
  report.push({ file: name, count, problems });
}

await writeFile(
  TEMPLATES_PATH,
  `${JSON.stringify({ version: 2, generated: new Date().toISOString(), templates: merged }, null, 2)}\n`,
  'utf8'
);

console.log(`Merged ${merged.length} universes into templates/universes.json`);
for (const entry of report) {
  console.log(`  ${entry.file}: ${entry.count} kept${entry.problems.length ? `, ${entry.problems.length} problems` : ''}`);
  for (const problem of entry.problems.slice(0, 5)) console.log(`    - ${problem}`);
}
const tags = new Map();
for (const template of merged) for (const tag of template.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
console.log(`  tags: ${[...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, count]) => `${tag}(${count})`).join(', ')}`);

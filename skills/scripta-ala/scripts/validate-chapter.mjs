#!/usr/bin/env node
// Validator for one scriptaWorlds chapter (no external dependencies).
// Utilizare:
//   node validate-chapter.mjs --universe . [--chapter 0004] [--min 800] [--max 2500]
// Output: one JSON line on stdout; errors are also listed on stderr. Exit code 1 when errors exist.

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REQUIRED_PLAN_KEYS = [
  'dramatic_question', 'anchor_character', 'character_want', 'primary_idea', 'human_need',
  'opening_hook', 'beats', 'decision', 'local_consequence', 'long_horizon', 'payoff',
  'return_hook', 'new_entities', 'deferred_answers'
];

const VALID_ATLAS_STATES = new Set(['mentioned', 'dramatized', 'decision', 'recontextualized']);
const CANON_SECTIONS = ['## World', '## Recurring characters', '## Timeline', '## Stable facts', '## Mysteries with a fixed cause'];
const CANON_LAW_SECTION = '## Fundamental laws';

function parseArgs(argv) {
  const args = { universe: '.', chapter: null, min: 800, max: 2500 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--universe') args.universe = argv[++index];
    else if (token === '--chapter') args.chapter = argv[++index];
    else if (token === '--min') args.min = Number.parseInt(argv[++index], 10);
    else if (token === '--max') args.max = Number.parseInt(argv[++index], 10);
  }
  return args;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(path) {
  const raw = await readText(path);
  if (raw === null) return { missing: true };
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    return { error: String(error.message) };
  }
}

function countWords(markdown) {
  return markdown.replace(/^#+\s*/gm, '').split(/\s+/).filter(Boolean).length;
}

function pad4(value) {
  return String(value).padStart(4, '0');
}

const args = parseArgs(process.argv.slice(2));
const universeDir = resolve(args.universe);
const errors = [];
const warnings = [];

const chapterDir = join(universeDir, 'chapters');
let chapterFiles = [];
try {
  chapterFiles = (await readdir(chapterDir)).filter((name) => /^\d{4}-[a-z0-9-]+\.md$/.test(name)).sort();
} catch {
  errors.push('the chapters/ folder is missing');
}

let chapterNumber = args.chapter ? Number.parseInt(args.chapter, 10) : null;
if (chapterNumber === null) {
  const last = chapterFiles.at(-1);
  chapterNumber = last ? Number.parseInt(last.slice(0, 4), 10) : 1;
}

const prefix = pad4(chapterNumber);
const matches = chapterFiles.filter((name) => name.startsWith(`${prefix}-`));
if (matches.length === 0) errors.push(`missing the chapter file chapters/${prefix}-<slug>.md`);
if (matches.length > 1) errors.push(`${matches.length} files exist for chapter ${prefix}: ${matches.join(', ')}`);

const result = { ok: false, chapter: { number: chapterNumber, file: null, title: null, words: 0, offer: false } };

if (matches.length === 1) {
  const file = matches[0];
  const markdown = await readText(join(chapterDir, file));
  result.chapter.file = `chapters/${file}`;
  const lines = (markdown ?? '').split('\n');
  const titleLine = lines.find((line) => line.trim().length > 0) ?? '';
  if (!/^#\s+\S/.test(titleLine.trim())) {
    errors.push('the first non-empty line must be the title: `# Chapter title`');
  } else {
    result.chapter.title = titleLine.replace(/^#\s+/, '').trim();
  }
  const words = countWords(markdown ?? '');
  result.chapter.words = words;
  if (words < args.min) warnings.push(`short chapter: ${words} words (minimum ${args.min})`);
  if (words > args.max) warnings.push(`long chapter: ${words} words (maximum ${args.max})`);
  if (/```/.test(markdown)) errors.push('the chapter contains code blocks (```)');
  if (/^\s*\|.+\|\s*$/m.test(markdown)) errors.push('the chapter contains markdown tables');
  if (/!\[[^\]]*\]\(/.test(markdown)) errors.push('the chapter contains markdown images');
  if (/\]\([^)]+\)/.test(markdown)) errors.push('the chapter contains markdown links');
  if (/^\s*(TODO|FIXME)/im.test(markdown)) errors.push('the chapter contains TODO/FIXME');
  if (/\bStoryPlan\b|\bnew_entities\b|\bdramatic_question\b/.test(markdown)) {
    errors.push('the chapter contains plan text (meta keys) instead of prose');
  }
}

const planPath = join(universeDir, 'drafts', `${prefix}-plan.md`);
const plan = await readText(planPath);
if (plan === null) {
  errors.push(`missing the plan drafts/${prefix}-plan.md`);
} else {
  const missing = REQUIRED_PLAN_KEYS.filter((key) => !new RegExp(`(^|\\n)\\s*-\\s*${key}\\s*:`, 'i').test(plan));
  if (missing.length > 0) errors.push(`the plan is missing keys: ${missing.join(', ')}`);
  const beatsMatch = /(^|\n)\s*-\s*beats\s*:\s*([\s\S]*?)(\n\s*-\s*[a-z_]+\s*:|$)/i.exec(plan);
  if (beatsMatch) {
    const beats = beatsMatch[2].split('\n').filter((line) => /^\s*[-*]\s+\S/.test(line) || /\d\./.test(line));
    if (beats.length > 0 && (beats.length < 4 || beats.length > 6)) {
      warnings.push(`the plan has ${beats.length} beats (4–6 required)`);
    }
  }
}

const offer = await readJson(join(universeDir, 'chapters', `${prefix}-offer.json`));
if (offer.missing) {
  warnings.push(`missing chapters/${prefix}-offer.json (ALA's voice for the reader)`);
} else if (offer.error) {
  errors.push(`chapters/${prefix}-offer.json is not valid JSON: ${offer.error}`);
} else {
  const value = offer.value ?? {};
  result.chapter.offer = false;
  if (typeof value.teaser !== 'string' || value.teaser.trim().length < 40) {
    errors.push('the offer needs a `teaser` (2–3 sentences addressed to the reader)');
  }
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) {
    errors.push('the offer needs 2–3 entries in `options`');
  } else {
    value.options.forEach((option, index) => {
      if (!option || typeof option !== 'object' || !option.label || !option.prompt) {
        errors.push(`offer.options[${index}] needs \`label\` and \`prompt\``);
        return;
      }
      if (String(option.label).split(/\s+/).length > 8) {
        warnings.push(`offer.options[${index}].label is long: "${option.label}"`);
      }
      if (String(option.prompt).trim().length < 12) {
        warnings.push(`offer.options[${index}].prompt looks too short to be a request`);
      }
    });
    if (value.options.every((option) => option && typeof option === 'object')) result.chapter.offer = true;
  }
}

const threads = await readJson(join(universeDir, 'threads.json'));
if (threads.missing) errors.push('threads.json is missing');
else if (threads.error) errors.push(`threads.json is not valid JSON: ${threads.error}`);
else {
  const value = threads.value ?? {};
  for (const key of ['open', 'closed', 'promises', 'deferred_answers']) {
    if (!Array.isArray(value[key])) errors.push(`threads.json: ${key} must be a list`);
  }
  for (const key of ['open', 'closed', 'promises', 'deferred_answers']) {
    for (const entry of value[key] ?? []) {
      if (!entry || typeof entry !== 'object') {
        errors.push(`threads.json: invalid entry in ${key}`);
        continue;
      }
      if (!entry.id) errors.push(`threads.json: entry without id in ${key}`);
      if (!entry.status) warnings.push(`threads.json: entry ${entry.id ?? '?'} in ${key} has no status`);
    }
  }
  const freshDeferred = (value.deferred_answers ?? []).filter((entry) => Number(entry.asked_chapter) === chapterNumber);
  if (freshDeferred.length > 1) errors.push(`threads.json: ${freshDeferred.length} new deferred answers in the same episode (maximum 1)`);
  for (const entry of value.deferred_answers ?? []) {
    if (entry.due_chapter && Number(entry.due_chapter) > chapterNumber + 3) {
      warnings.push(`threads.json: due date too far for ${entry.id} (due_chapter ${entry.due_chapter})`);
    }
  }
  const overdue = (value.open ?? []).filter((entry) => entry.due_chapter && Number(entry.due_chapter) < chapterNumber);
  if (overdue.length > 0) {
    warnings.push(`overdue unpaid threads: ${overdue.map((entry) => entry.id).join(', ')}`);
  }
}

const atlas = await readJson(join(universeDir, 'atlas.json'));
if (atlas.missing) errors.push('atlas.json is missing');
else if (atlas.error) errors.push(`atlas.json is not valid JSON: ${atlas.error}`);
else {
  const value = atlas.value ?? {};
  if (!Array.isArray(value.axes)) errors.push('atlas.json: axes must be a list');
  const seen = new Set();
  let touched = 0;
  for (const axis of value.axes ?? []) {
    if (!axis?.id) errors.push('atlas.json: axis without id');
    for (const node of axis?.nodes ?? []) {
      if (!node?.id) errors.push(`atlas.json: node without id in axis ${axis?.id ?? '?'}`);
      if (seen.has(node?.id)) errors.push(`atlas.json: duplicated node ${node?.id}`);
      seen.add(node?.id);
      if (!VALID_ATLAS_STATES.has(node?.state)) {
        errors.push(`atlas.json: invalid state "${node?.state}" on node ${node?.id} (use ${[...VALID_ATLAS_STATES].join('/')})`);
      }
      if ((node?.chapters ?? []).includes(chapterNumber)) touched += 1;
    }
  }
  if (touched === 0) warnings.push(`atlas.json: no node is marked as touched in chapter ${chapterNumber}`);
}

const canon = await readText(join(universeDir, 'canon.md'));
const universeMeta = await readJson(join(universeDir, 'universe.json'));
const universeLaw = typeof universeMeta.value?.law === 'string' ? universeMeta.value.law.trim() : '';
if (canon === null) errors.push('canon.md is missing');
else {
  for (const section of CANON_SECTIONS) {
    if (!canon.includes(section)) errors.push(`canon.md does not contain the section "${section}"`);
  }
  if (universeLaw) {
    const lawIndex = canon.indexOf(CANON_LAW_SECTION);
    if (lawIndex < 0) {
      errors.push(`canon.md does not contain the section "${CANON_LAW_SECTION}" (this universe has a fundamental law)`);
    } else {
      const body = canon.slice(lawIndex + CANON_LAW_SECTION.length).split(/\n## /)[0].trim();
      if (body.length < 20) errors.push('the "Fundamental laws" section is empty — copy the universe law and the established consequences');
    }
  }
  if (canon.trim().length < 80) warnings.push('canon.md looks unfinished');
}

result.ok = errors.length === 0;
result.warnings = warnings;
result.errors = errors;
process.stdout.write(`${JSON.stringify(result)}\n`);
for (const error of errors) process.stderr.write(`error: ${error}\n`);
for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
process.exit(errors.length === 0 ? 0 : 1);

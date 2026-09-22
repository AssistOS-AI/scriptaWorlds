#!/usr/bin/env node
// Structural validator for one scriptaWorlds chapter (no external dependencies).
//
// Usage:
//   node validate-chapter.mjs --universe . [--chapter 0004] [--min 900] [--max 2400]
//
// What it proves is structure, never literary quality: the chapter file exists once and is prose, the
// episode plan declares every required key with a usable value, the reader offer exists with two or
// three usable options, and `canon.md`, `threads.json` and `atlas.json` follow their schemas with
// chapter references that point at accepted material. A due date may point forward; an occurrence may
// not. Output: one JSON line on standard output, the same lines on standard error, exit code 1 when at
// least one error was found and 0 otherwise.

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duplicateKeys, identifier, integer, meaningful, oneOf, sentenceCount, wordCount } from './lib/schema.mjs';

const REQUIRED_PLAN_KEYS = [
  'dramatic_question', 'anchor_character', 'character_want', 'primary_idea', 'human_need',
  'opening_hook', 'beats', 'decision', 'local_consequence', 'long_horizon', 'payoff',
  'return_hook', 'new_entities', 'deferred_answers'
];
const PROSE_PLAN_KEYS = new Set(REQUIRED_PLAN_KEYS.filter((key) => !['beats', 'new_entities', 'deferred_answers'].includes(key)));
// `return_hook` is the one required key that may legitimately say there is none: an episode ends with
// at most one hook, and a quiet chapter is allowed to end without one. Every other prose key must
// carry a real value, because a plan that says "none" for the decision or the payoff is not a plan.
const OPTIONAL_PLAN_KEYS = new Set(['return_hook']);
const VALID_ATLAS_STATES = ['mentioned', 'dramatized', 'decision', 'recontextualized'];
const THREAD_KINDS = ['promise', 'mystery', 'decision', 'question'];
const THREAD_STATUSES = ['open', 'deferred', 'closed', 'abandoned'];
const CANON_SECTIONS = ['## World', '## Recurring characters', '## Timeline', '## Stable facts', '## Mysteries with a fixed cause'];
const CANON_LAW_SECTION = '## Fundamental laws';
const MIN_OFFER_OPTIONS = 2;
const MAX_OFFER_OPTIONS = 3;
// The prompt and the skill ask for a label of at most six words; seven or eight are tolerated with a
// warning, and a longer label is refused because it stops being a button.
const LABEL_WARNING_WORDS = 6;
const LABEL_ERROR_WORDS = 10;

function parseArgs(argv) {
  const args = { universe: '.', chapter: null, min: 900, max: 2400 };
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

/** A JSON file read with the raw text kept, so duplicate keys can be reported before `JSON.parse`. */
async function readJson(path, errors) {
  const label = path.split(/[\\/]/).pop();
  const raw = await readText(path);
  if (raw === null) return { missing: true };
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { error: String(error.message) };
  }
  for (const key of duplicateKeys(raw)) errors.push(`${label}: the key ${key} is declared twice (the format allows one)`);
  return { value, raw };
}

function countWords(markdown) {
  return markdown.replace(/^#+\s*/gm, '').split(/\s+/).filter(Boolean).length;
}

function pad4(value) {
  return String(value).padStart(4, '0');
}

/**
 * The keys of the episode plan with the lines that belong to each. A key is a top-level `- key:` line;
 * everything more indented, or a bare list line, belongs to the key above it.
 */
function parsePlan(plan) {
  const entries = new Map();
  const order = [];
  let current = null;
  for (const line of plan.split('\n')) {
    const match = /^\s*[-*]\s+([a-z_]+)\s*:\s*(.*)$/.exec(line);
    if (match) {
      current = { key: match[1].toLowerCase(), value: match[2], body: [] };
      order.push(current);
      if (entries.has(current.key)) entries.get(current.key).push(current);
      else entries.set(current.key, [current]);
      continue;
    }
    if (current) current.body.push(line);
  }
  return { entries, order };
}

/** The number of items a plan list declares: numbered items and bullets, whichever is larger. */
function countPlanItems(entry) {
  const text = [entry.value, ...entry.body].join('\n');
  const numbered = (text.match(/(^|\s)\d+[.)]\s+\S/g) ?? []).length;
  const bullets = text.split('\n').filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
  const inline = entry.value.trim().length > 0 && numbered === 0 && bullets === 0 ? 1 : 0;
  return Math.max(numbered, bullets, inline);
}

function checkPlan(plan, chapterNumber, errors, warnings) {
  const { entries } = parsePlan(plan);
  for (const key of REQUIRED_PLAN_KEYS) {
    if (!entries.has(key)) errors.push(`the plan is missing the key "${key}"`);
  }
  for (const [key, list] of entries) {
    if (list.length > 1) {
      errors.push(`the plan declares "${key}" ${list.length} times (the format allows one)`);
    }
    if (!REQUIRED_PLAN_KEYS.includes(key)) warnings.push(`the plan carries an unknown key "${key}"`);
  }
  for (const key of REQUIRED_PLAN_KEYS) {
    const entry = entries.get(key)?.[0];
    if (!entry) continue;
    if (PROSE_PLAN_KEYS.has(key)) {
      // A required key with no usable value is an error; `return_hook` may say there is none.
      if (!meaningful(entry.value) && !OPTIONAL_PLAN_KEYS.has(key)) {
        errors.push(`the plan key "${key}" has no usable value`);
      }
      continue;
    }
    if (key === 'beats') {
      const beats = countPlanItems(entry);
      if (beats < 4 || beats > 6) errors.push(`the plan declares ${beats} beats (4–6 causal steps required)`);
      continue;
    }
    if (key === 'new_entities') {
      const entities = countPlanItems(entry);
      if (!meaningful(entry.value) && entities === 0) warnings.push('the plan lists no new entity for this episode');
      if (entities > 2) warnings.push(`the plan lists ${entities} new entities (at most two important characters)`);
      continue;
    }
    if (key === 'deferred_answers' && meaningful(entry.value)) {
      const due = /due_chapter\s*:?\s*(-?\d+)/i.exec([entry.value, ...entry.body].join(' '));
      if (due && integer(due[1]) <= chapterNumber) {
        errors.push('the plan defers an answer with a due chapter that is not in the future');
      }
    }
  }
}

function checkChapterText(markdown, min, max, errors, warnings, chapter) {
  const lines = markdown.split('\n');
  const titleLine = lines.find((line) => line.trim().length > 0) ?? '';
  if (!/^#\s+\S/.test(titleLine.trim())) {
    errors.push('the first non-empty line must be the title: `# Chapter title`');
  } else {
    chapter.title = titleLine.replace(/^#\s+/, '').trim();
  }
  const words = countWords(markdown);
  chapter.words = words;
  if (words < min) warnings.push(`short chapter: ${words} words (minimum ${min})`);
  if (words > max) warnings.push(`long chapter: ${words} words (maximum ${max})`);
  if (/```/.test(markdown)) errors.push('the chapter contains code blocks (```)');
  if (/^\s*\|.+\|\s*$/m.test(markdown)) errors.push('the chapter contains markdown tables');
  if (/!\[[^\]]*\]\(/.test(markdown)) errors.push('the chapter contains markdown images');
  if (/\]\([^)]+\)/.test(markdown)) errors.push('the chapter contains markdown links');
  if (/^\s*(TODO|FIXME)/im.test(markdown)) errors.push('the chapter contains TODO/FIXME');
  if (/\bStoryPlan\b|\bnew_entities\b|\bdramatic_question\b/.test(markdown)) {
    errors.push('the chapter contains plan text (meta keys) instead of prose');
  }
}

/** The reader offer: present, usable, and with a continuation the reader can actually send. */
function checkOffer(offer, prefix, errors, warnings, chapter) {
  if (offer.missing) {
    errors.push(`missing chapters/${prefix}-offer.json (the reader's decisions after this chapter)`);
    return;
  }
  if (offer.error) {
    errors.push(`chapters/${prefix}-offer.json is not valid JSON: ${offer.error}`);
    return;
  }
  const value = offer.value ?? {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('the offer must be a JSON object with `teaser` and `options`');
    return;
  }
  const sentences = sentenceCount(value.teaser);
  if (typeof value.teaser !== 'string' || !meaningful(value.teaser)) {
    errors.push('the offer needs a `teaser` (2–3 sentences addressed to the reader)');
  } else if (sentences < 2 && value.teaser.trim().length < 120) {
    errors.push(`the offer teaser has ${sentences} sentence(s) and ${value.teaser.trim().length} characters (2–3 sentences required)`);
  } else if (sentences < 2) {
    warnings.push('the offer teaser reads as one long sentence (2–3 expected)');
  } else if (sentences > 4) {
    warnings.push(`the offer teaser has ${sentences} sentences (2–3 expected)`);
  }
  if (!Array.isArray(value.options)) {
    errors.push('the offer needs 2–3 entries in `options`');
    return;
  }
  if (value.options.length < MIN_OFFER_OPTIONS || value.options.length > MAX_OFFER_OPTIONS) {
    errors.push(`the offer has ${value.options.length} options (${MIN_OFFER_OPTIONS}–${MAX_OFFER_OPTIONS} required)`);
  }
  let usable = 0;
  value.options.forEach((option, index) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      errors.push(`offer.options[${index}] must be an object with \`label\` and \`prompt\``);
      return;
    }
    if (!meaningful(option.label)) errors.push(`offer.options[${index}].label is missing or empty`);
    else if (wordCount(option.label) > LABEL_ERROR_WORDS) {
      errors.push(`offer.options[${index}].label has ${wordCount(option.label)} words (at most ${LABEL_ERROR_WORDS} tolerated)`);
    } else if (wordCount(option.label) > LABEL_WARNING_WORDS) {
      warnings.push(`offer.options[${index}].label is long: ${wordCount(option.label)} words`);
    }
    if (!meaningful(option.prompt)) errors.push(`offer.options[${index}].prompt is missing or empty`);
    else if (String(option.prompt).trim().length < 12) {
      warnings.push(`offer.options[${index}].prompt looks too short to be a request`);
    } else usable += 1;
  });
  chapter.offer = usable >= MIN_OFFER_OPTIONS;
}

/** Threads: schemas, identifiers, kinds, statuses and chapter references. */
function checkThreads(value, chapterNumber, errors, warnings) {
  const seen = new Set();
  const collections = ['open', 'closed', 'promises', 'deferred_answers'];
  for (const key of collections) {
    const list = Array.isArray(value[key]) ? value[key] : [];
    list.forEach((entry, index) => {
      const where = `${key}[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`threads.json: ${where} must be an object`);
        return;
      }
      const id = identifier(entry.id);
      if (!id) errors.push(`threads.json: ${where} has no usable id`);
      else if (!/^[a-z]{2,8}-\d{4}$/.test(id)) errors.push(`threads.json: ${where} id "${id}" must be <prefix>-NNNN`);
      else if (seen.has(id)) errors.push(`threads.json: the id ${id} is used twice`);
      else seen.add(id);

      const created = integer(entry.created_chapter ?? entry.asked_chapter);
      if (created === null) errors.push(`threads.json: ${where} has no integer created_chapter/asked_chapter`);
      else if (created < 1 || created > chapterNumber) {
        errors.push(`threads.json: ${where} references chapter ${created}, which is not accepted material (chapters 1–${chapterNumber})`);
      }
      const closed = integer(entry.closed_chapter);
      if (entry.closed_chapter !== undefined && closed === null) errors.push(`threads.json: ${where} closed_chapter must be an integer`);
      if (closed !== null && (closed < 1 || closed > chapterNumber)) {
        errors.push(`threads.json: ${where} closed in chapter ${closed}, which is not accepted material`);
      }
      if (closed !== null && created !== null && closed < created) {
        errors.push(`threads.json: ${where} closes in chapter ${closed} before it was created in ${created}`);
      }
      const due = entry.due_chapter === undefined ? null : integer(entry.due_chapter);
      if (entry.due_chapter !== undefined && due === null) errors.push(`threads.json: ${where} due_chapter must be an integer`);
      if (due !== null && due < 1) errors.push(`threads.json: ${where} due_chapter must be a chapter number`);
      const isNew = created === chapterNumber;
      if (due !== null && created !== null && due <= created) {
        errors.push(`threads.json: ${where} is due in chapter ${due}, at or before its creation in chapter ${created}`);
      }
      if (due !== null && isNew && key === 'deferred_answers' && due > chapterNumber + 3) {
        errors.push(`threads.json: ${where} defers past the allowed horizon (due_chapter ${due} > ${chapterNumber + 3})`);
      }
      if (due !== null && !isNew && due > chapterNumber + 3) {
        warnings.push(`threads.json: ${where} is due far ahead (due_chapter ${due})`);
      }
      if (entry.kind !== undefined && !oneOf(entry.kind, THREAD_KINDS)) {
        errors.push(`threads.json: ${where} has the unknown kind "${entry.kind}" (use ${THREAD_KINDS.join('/')})`);
      }
      if (key === 'open' && entry.kind === undefined) errors.push(`threads.json: ${where} has no kind`);
      if (entry.status !== undefined && !oneOf(entry.status, THREAD_STATUSES)) {
        errors.push(`threads.json: ${where} has the unknown status "${entry.status}" (use ${THREAD_STATUSES.join('/')})`);
      }
      const text = key === 'promises' ? entry.promise : key === 'closed' ? entry.resolution : entry.question ?? entry.reason;
      if (!meaningful(text)) errors.push(`threads.json: ${where} has no usable ${key === 'promises' ? 'promise' : key === 'closed' ? 'resolution' : 'question'}`);
    });
  }
  const freshDeferred = (Array.isArray(value.deferred_answers) ? value.deferred_answers : [])
    .filter((entry) => entry && typeof entry === 'object' && integer(entry.asked_chapter) === chapterNumber);
  if (freshDeferred.length > 1) errors.push(`threads.json: ${freshDeferred.length} new deferred answers in the same episode (maximum 1)`);
  const overdue = (Array.isArray(value.open) ? value.open : [])
    .filter((entry) => entry && typeof entry === 'object' && integer(entry.due_chapter) !== null && integer(entry.due_chapter) < chapterNumber);
  if (overdue.length > 0) warnings.push(`overdue unpaid threads: ${overdue.map((entry) => entry.id).join(', ')}`);
}

/** The atlas: axes, unique node identifiers, known states and accepted chapter references. */
function checkAtlas(value, chapterNumber, errors, warnings) {
  if (!Array.isArray(value.axes)) {
    errors.push('atlas.json: axes must be a list');
    return;
  }
  const axisIds = new Set();
  const nodeIds = new Set();
  let touched = 0;
  value.axes.forEach((axis, axisIndex) => {
    if (!axis || typeof axis !== 'object' || Array.isArray(axis)) {
      errors.push(`atlas.json: axes[${axisIndex}] must be an object`);
      return;
    }
    const axisId = identifier(axis.id);
    if (!axisId) errors.push(`atlas.json: axes[${axisIndex}] has no usable id`);
    else if (axisIds.has(axisId)) errors.push(`atlas.json: the axis ${axisId} is declared twice`);
    else axisIds.add(axisId);
    axis.nodes = Array.isArray(axis.nodes) ? axis.nodes : [];
    axis.nodes.forEach((node, nodeIndex) => {
      const where = `atlas.json: axis ${axisId ?? axisIndex} node[${nodeIndex}]`;
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const nodeId = identifier(node.id);
      if (!nodeId) errors.push(`${where} has no usable id`);
      else if (nodeIds.has(nodeId)) errors.push(`atlas.json: the node ${nodeId} is declared twice`);
      else nodeIds.add(nodeId);
      if (!oneOf(node.state, VALID_ATLAS_STATES)) {
        errors.push(`${where} has the invalid state "${node.state}" (use ${VALID_ATLAS_STATES.join('/')})`);
      }
      if (node.chapters !== undefined) {
        if (!Array.isArray(node.chapters)) errors.push(`${where} chapters must be a list`);
        else {
          for (const chapter of node.chapters) {
            const number = integer(chapter);
            if (number === null) errors.push(`${where} lists a non-integer chapter "${chapter}"`);
            else if (number < 1 || number > chapterNumber) {
              errors.push(`${where} references chapter ${number}, which is not accepted material (chapters 1–${chapterNumber})`);
            }
          }
          if (node.chapters.some((chapter) => integer(chapter) === chapterNumber)) touched += 1;
        }
      }
    });
  });
  if (touched === 0) warnings.push(`atlas.json: no node is marked as touched in chapter ${chapterNumber}`);
}

/** Canon: the fixed sections, and a fundamental-law section that actually carries the law. */
function checkCanon(canon, universeLaw, errors, warnings) {
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

/** Run the structural validator over one universe; exported so the check suite can call it directly. */
export async function validateChapter({ universeDir, chapter, min, max }) {
  const errors = [];
  const warnings = [];
  const chapterDir = join(universeDir, 'chapters');
  let chapterFiles = [];
  try {
    chapterFiles = (await readdir(chapterDir)).filter((name) => /^\d{4}-[a-z0-9-]+\.md$/.test(name)).sort();
  } catch {
    errors.push('the chapters/ folder is missing');
  }

  let chapterNumber = chapter === null || chapter === undefined ? null : Number.parseInt(chapter, 10);
  if (chapterNumber === null || Number.isNaN(chapterNumber)) {
    const last = chapterFiles.at(-1);
    chapterNumber = last ? Number.parseInt(last.slice(0, 4), 10) : 1;
  }
  const prefix = pad4(chapterNumber);
  const result = { ok: false, chapter: { number: chapterNumber, file: null, title: null, words: 0, offer: false } };

  const matches = chapterFiles.filter((name) => name.startsWith(`${prefix}-`));
  if (matches.length === 0) errors.push(`missing the chapter file chapters/${prefix}-<slug>.md`);
  else if (matches.length > 1) errors.push(`${matches.length} files exist for chapter ${prefix}: ${matches.join(', ')}`);
  else {
    const markdown = await readText(join(chapterDir, matches[0])) ?? '';
    result.chapter.file = `chapters/${matches[0]}`;
    checkChapterText(markdown, min, max, errors, warnings, result.chapter);
  }

  const plan = await readText(join(universeDir, 'drafts', `${prefix}-plan.md`));
  if (plan === null) errors.push(`missing the plan drafts/${prefix}-plan.md`);
  else checkPlan(plan, chapterNumber, errors, warnings);

  checkOffer(await readJson(join(chapterDir, `${prefix}-offer.json`), errors), prefix, errors, warnings, result.chapter);

  const threads = await readJson(join(universeDir, 'threads.json'), errors);
  if (threads.missing) errors.push('threads.json is missing');
  else if (threads.error) errors.push(`threads.json is not valid JSON: ${threads.error}`);
  else if (threads.value === null || typeof threads.value !== 'object' || Array.isArray(threads.value)) {
    errors.push('threads.json: the root must be an object');
  } else {
    for (const key of ['open', 'closed', 'promises', 'deferred_answers']) {
      if (!Array.isArray(threads.value[key])) errors.push(`threads.json: ${key} must be a list`);
    }
    checkThreads(threads.value, chapterNumber, errors, warnings);
  }

  const atlas = await readJson(join(universeDir, 'atlas.json'), errors);
  if (atlas.missing) errors.push('atlas.json is missing');
  else if (atlas.error) errors.push(`atlas.json is not valid JSON: ${atlas.error}`);
  else if (atlas.value === null || typeof atlas.value !== 'object' || Array.isArray(atlas.value)) {
    errors.push('atlas.json: the root must be an object');
  } else {
    checkAtlas(atlas.value, chapterNumber, errors, warnings);
  }

  const canon = await readText(join(universeDir, 'canon.md'));
  const meta = await readJson(join(universeDir, 'universe.json'), errors);
  const law = typeof meta.value?.law === 'string' ? meta.value.law.trim() : '';
  if (canon === null) errors.push('canon.md is missing');
  else checkCanon(canon, law, errors, warnings);

  result.ok = errors.length === 0;
  result.warnings = warnings;
  result.errors = errors;
  return result;
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const args = parseArgs(process.argv.slice(2));
  const report = await validateChapter({
    universeDir: resolve(args.universe),
    chapter: args.chapter,
    min: args.min,
    max: args.max
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  for (const error of report.errors) process.stderr.write(`error: ${error}\n`);
  for (const warning of report.warnings) process.stderr.write(`warning: ${warning}\n`);
  process.exit(report.ok ? 0 : 1);
}

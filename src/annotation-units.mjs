// A whole-book reading, bounded.
//
// One request to read every chapter does not scale and cannot say what it left out, so a generic review of
// a book is planned here as a sequence of bounded units — a chapter, or a byte range of a chapter with its
// surrounding text read for understanding — and each unit is evaluated on its own. What the units observed
// is then assembled by a separate synthesis, which is where book and arc conclusions are drawn: a
// conclusion is a reading of the observations, never the mean of the per-unit grades.
//
// Everything a reader needs to judge the claim lives in three files the run keeps beside its packet: the
// plan (with the limits it was planned under, written before any evaluator exists), one artifact per unit
// (so an interrupted reading resumes the units it already paid for), and the reading record, which states
// whether the selection was read completely and names every unit that was omitted or failed.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nowIso } from './io.mjs';

export const READING_SCHEMA = 'bounded-reading.v1';
export const UNIT_ARTIFACT_SCHEMA = 'review-unit.v1';
/** One call per unit and one repair, plus the same allowance for the synthesis. */
export const CALLS_PER_UNIT = 2;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pad = (number, width = 4) => String(number).padStart(width, '0');

/** The unit identifier of a chapter, or of one range inside it: stable across a retry of the same reading. */
const unitId = (index, kind, chapter, range = null) =>
  `u${pad(index)}-${kind}-${pad(chapter)}${range === null ? '' : `-r${range}`}`;

/**
 * The paragraph boundaries of a chapter, as byte offsets, so a chapter that does not fit one unit is split
 * where the text itself breaks rather than in the middle of a sentence.
 */
function paragraphOffsets(bytes) {
  const offsets = [];
  const text = bytes.toString('utf8');
  const pattern = /\n[ \t]*\n/g;
  let match = pattern.exec(text);
  while (match) {
    offsets.push(match.index + match[0].length);
    match = pattern.exec(text);
  }
  return offsets;
}

/**
 * Plan the bounded units of one selection. The plan is a pure function of the packet and the budget: the
 * same book and the same limits always plan the same units, which is what lets a retry reuse the units an
 * interrupted reading already completed.
 */
export function planReviewUnits({ chapters, selection, budget, contextChapters = [], version = null }) {
  const byNumber = new Map(chapters.map((chapter) => [chapter.number, chapter]));
  const selected = selection.chapters.length > 0 ? selection.chapters : chapters.map((chapter) => chapter.number);
  const declaredContext = contextChapters.filter(Number.isInteger);
  const units = [];
  const omitted = [];
  let used = 0;
  let index = 0;
  for (const number of selected) {
    const chapter = byNumber.get(number);
    if (!chapter) continue;
    const ranges = splitChapter(chapter, budget.unit_bytes);
    for (const [position, range] of ranges.entries()) {
      const selectionBytes = range.end - range.start;
      if (units.length >= budget.max_units || used + selectionBytes > budget.total_bytes) {
        omitted.push({
          id: unitId(index + 1, 'chapter', number, ranges.length > 1 ? position + 1 : null),
          chapters: [number],
          range,
          selection_bytes: selectionBytes,
          reason:
            `the reading budget allows ${budget.max_units} unit(s) and ${budget.total_bytes} bytes of selected ` +
            `prose; this part of chapter ${number} is declared unread rather than summarised`
        });
        continue;
      }
      index += 1;
      used += selectionBytes;
      // The explicit surrounding context of a unit: the chapters the caller permitted as context, plus —
      // for a range inside a longer chapter — the rest of that chapter, which the unit reads for
      // understanding only. A chapter the caller did not permit is not context: it stays omitted.
      const context = [...declaredContext];
      if (range.start > 0 || range.end < chapter.bytes) context.push(number);
      units.push({
        id: unitId(index, 'chapter', number, ranges.length > 1 ? position + 1 : null),
        index,
        kind: 'chapter',
        chapters: [number],
        file: chapter.path,
        ranges: [range],
        selection_bytes: selectionBytes,
        context_chapters: context
      });
    }
  }
  const declared = units.length + omitted.length;
  return {
    // The plan is a document of the run, not a note: it names the version it was made for, the selection it
    // covers and the limits it was made under, and it is written before any evaluator exists.
    schema_version: READING_SCHEMA,
    version,
    selection: { kind: selection.kind ?? 'book', chapters: [...selected] },
    planned_at: nowIso(),
    units,
    omitted,
    budget,
    planned_bytes: used,
    note:
      omitted.length === 0
        ? 'every declared unit of this selection fits the reading budget'
        : `${omitted.length} unit(s) of ${declared} do not fit the reading budget and are declared unread, so this reading is partial`
  };
}

/** One chapter as one unit, or as several contiguous ranges when it does not fit the per-unit budget. */
function splitChapter(chapter, unitBytes) {
  if (chapter.bytes <= unitBytes) return [{ chapter: chapter.number, start: 0, end: chapter.bytes }];
  const offsets = [0, ...paragraphOffsets(Buffer.from(chapter.text, 'utf8')), chapter.bytes];
  const ranges = [];
  let start = 0;
  let previous = 0;
  for (const offset of offsets) {
    if (offset - start > unitBytes && previous > start) {
      ranges.push({ chapter: chapter.number, start, end: previous });
      start = previous;
    }
    previous = offset;
  }
  ranges.push({ chapter: chapter.number, start, end: chapter.bytes });
  return ranges;
}

/** The reading list of one unit: the bytes it is asked to judge, the text around it, and what is unread. */
export function unitReadingList(unit, chapters, omittedChapters = []) {
  const byNumber = new Map(chapters.map((chapter) => [chapter.number, chapter]));
  const selected = unit.chapters
    .map((number) => byNumber.get(number))
    .filter(Boolean)
    .map((chapter) => ({
      path: chapter.path,
      chapter: chapter.number,
      ranges: unit.ranges.filter((range) => range.chapter === chapter.number),
      whole: !unit.ranges.some((range) => range.chapter === chapter.number && (range.start > 0 || range.end < chapter.bytes))
    }));
  const context = [...new Set(unit.context_chapters)]
    .map((number) => byNumber.get(number))
    .filter((chapter) => chapter && !unit.chapters.includes(chapter.number))
    .map((chapter) => ({ path: chapter.path, chapter: chapter.number }));
  const omitted = [...new Set(omittedChapters)]
    .filter((number) => !unit.chapters.includes(number))
    .map((number) => byNumber.get(number))
    .filter((chapter) => chapter && !unit.chapters.includes(chapter.number))
    .map((chapter) => ({ path: chapter.path, chapter: chapter.number }));
  return { selected, context, omitted };
}

/** Where one unit artifact lives inside the run directory. */
export const unitArtifactPath = (directory, id) => join(directory, 'generated', 'units', `${id}.json`);
export const planPath = (directory) => join(directory, 'generated', 'units', 'plan.json');

export async function writePlan(directory, plan) {
  const path = planPath(directory);
  await mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  await writeFile(path, bytes);
  return { path: 'generated/units/plan.json', sha256: sha256(bytes), bytes: bytes.length };
}

/**
 * An artifact a unit already produced. A retry of an interrupted reading reuses it instead of reading the
 * same unit again; what it may not do is reuse a document that does not belong to the unit being planned
 * now, so the planned selection it names is compared before it is accepted.
 */
export async function readUnitArtifact(directory, unit, planIdentity) {
  const path = unitArtifactPath(directory, unit.id);
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  const parsed = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  if (!parsed || parsed.schema_version !== UNIT_ARTIFACT_SCHEMA) return null;
  if (parsed.plan_identity !== planIdentity) return null;
  if (!parsed.unit || parsed.unit.id !== unit.id || parsed.unit.file !== unit.file) return null;
  const ranges = JSON.stringify(parsed.unit.ranges ?? []);
  if (ranges !== JSON.stringify(unit.ranges)) return null;
  if (!parsed.document || typeof parsed.document !== 'object') return null;
  return { ...parsed, sha256: sha256(Buffer.from(raw, 'utf8')), path: `generated/units/${unit.id}.json` };
}

export async function writeUnitArtifact(directory, unit, planIdentity, document, prompt) {
  const path = unitArtifactPath(directory, unit.id);
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    schema_version: UNIT_ARTIFACT_SCHEMA,
    unit: { id: unit.id, kind: unit.kind, chapters: unit.chapters, file: unit.file, ranges: unit.ranges },
    plan_identity: planIdentity,
    prompt,
    document,
    accepted_at: nowIso()
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(path, bytes);
  return { path: `generated/units/${unit.id}.json`, sha256: sha256(bytes), bytes: bytes.length };
}

/** The identity of the plan one artifact belongs to: the same selection and context plans the same units. */
export function planIdentity({ version, planId, unit }) {
  return sha256([version, planId, unit.id, unit.file, JSON.stringify(unit.ranges), JSON.stringify(unit.context_chapters)].join('\n'));
}

/**
 * Namespace the evidence identifiers of one unit document, so several units can be composed into one
 * document without two of them claiming the same identifier. Every string that is exactly one of the
 * unit's own evidence ids is rewritten, and the composed document is validated afterwards, so a reference
 * the rewrite missed is a refusal rather than a quiet loss.
 */
export function namespaceUnitDocument(document, prefix) {
  const ids = new Set((Array.isArray(document?.evidence) ? document.evidence : [])
    .map((item) => (item && typeof item.id === 'string' ? item.id : null))
    .filter(Boolean));
  const rename = (value) => (typeof value === 'string' && ids.has(value) ? `${prefix}${value}` : value);
  const walk = (value) => {
    if (typeof value === 'string') return rename(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, entry] of Object.entries(value)) out[key] = walk(entry);
      return out;
    }
    return value;
  };
  const namespaced = walk(document);
  namespaced.evidence = (Array.isArray(document.evidence) ? document.evidence : []).map((item) => ({ ...item, id: rename(item.id) }));
  return namespaced;
}

/**
 * The document one reading publishes. The metrics, indicators, findings, departures and preserved passages
 * are the synthesis's own conclusions over the verified unit observations; the evidence, the segments and
 * the rule outcomes are the unit observations themselves, so every citation resolves to bytes a unit
 * actually read. The synthesis may add evidence for a passage it read itself, and may not redefine the
 * rule outcomes a unit recorded for its own chapter.
 */
export function composeSelectionDocument({
  synthesis,
  units,
  requirements,
  continuity,
  provenance,
  request,
  brief,
  sourceVersion
}) {
  const evidence = [];
  const byId = new Set();
  // Only the synthesis declares segments: a unit numbers its segments inside its own chapter, and two units
  // would collide on `seg1`. The unit documents keep their own segments in their artifacts.
  for (const item of Array.isArray(synthesis.evidence) ? synthesis.evidence : []) {
    const id = item && typeof item.id === 'string' ? item.id : null;
    if (!id || byId.has(id)) continue;
    byId.add(id);
    evidence.push(item);
  }
  for (const unit of units) {
    for (const item of Array.isArray(unit.document?.evidence) ? unit.document.evidence : []) {
      const id = item && typeof item.id === 'string' ? item.id : null;
      if (!id || byId.has(id)) continue;
      byId.add(id);
      evidence.push(item);
    }
  }
  return {
    schema_version: synthesis.schema_version,
    source_version: sourceVersion,
    request: request ?? synthesis.request ?? null,
    brief: brief ?? synthesis.brief ?? null,
    evidence,
    segments: Array.isArray(synthesis.segments) ? synthesis.segments : [],
    metrics: synthesis.metrics ?? {},
    indicators: Array.isArray(synthesis.indicators) ? synthesis.indicators : [],
    findings: Array.isArray(synthesis.findings) ? synthesis.findings : [],
    preserved_qualities: synthesis.preserved_qualities ?? { passages: [], reason: null },
    departures: Array.isArray(synthesis.departures) ? synthesis.departures : [],
    requirements: requirements ?? null,
    continuity: continuity ?? null,
    unit_observations: units.map((unit) => ({
      unit: unit.id,
      chapters: unit.chapters ?? [],
      artifact: unit.artifact ?? null,
      findings: (Array.isArray(unit.document?.findings) ? unit.document.findings : []).map((finding) => finding?.id).filter(Boolean),
      evidence: (Array.isArray(unit.document?.evidence) ? unit.document.evidence : []).length
    })),
    evaluator_provenance: provenance ?? null
  };
}

/**
 * What a reader is told about the reading itself: how many units the plan declared, how many were attempted,
 * completed, omitted or failed, the limits it was planned under, and whether the claim covers the whole
 * selection. A complete-book claim requires every declared unit to have completed.
 */
export function readingRecord({ plan, results, planFile }) {
  const completed = results.filter((result) => result.state === 'completed');
  const omitted = plan.omitted.map((entry) => ({ id: entry.id, chapters: entry.chapters, reason: entry.reason }));
  const failed = results.filter((result) => result.state === 'failed').map((result) => ({ id: result.id, reason: result.reason ?? null }));
  const complete = omitted.length === 0 && failed.length === 0 && completed.length === plan.units.length;
  return {
    schema_version: READING_SCHEMA,
    complete,
    units_declared: plan.units.length + omitted.length,
    units_planned: plan.units.length,
    units_completed: completed.length,
    units_omitted: omitted.length,
    units_failed: failed.length,
    units_reused: results.filter((result) => result.reused === true).length,
    // The calls the units of this reading made; the synthesis is a call of the stage, recorded beside this.
    unit_calls: results.reduce((total, result) => total + (result.calls ?? 0), 0),
    selection_bytes_read: completed.reduce((total, result) => total + (result.selection_bytes ?? 0), 0),
    budget: plan.budget,
    plan: planFile ?? null,
    units: results.map((result) => ({
      id: result.id,
      kind: result.kind,
      chapters: result.chapters,
      state: result.state,
      calls: result.calls ?? 0,
      reused: result.reused === true,
      selection_bytes: result.selection_bytes ?? 0,
      artifact: result.artifact ?? null
    })),
    omitted,
    failed,
    note: complete
      ? `every declared unit of the selection was read: ${completed.length} unit(s)`
      : `this reading is partial: ${completed.length} of ${plan.units.length + omitted.length} declared unit(s) were read` +
        `${omitted.length > 0 ? `, ${omitted.length} were left out by the reading budget` : ''}` +
        `${failed.length > 0 ? `, ${failed.length} failed` : ''}`
  };
}

/**
 * The per-unit states a run records, in plan order: `completed`, `failed`, `omitted` for a unit the reading
 * budget left out, and `unread` for a planned unit an interrupted reading never reached.
 */
export function unitResults({ plan, results }) {
  const byId = new Map(results.map((result) => [result.id, result]));
  const planned = new Set(plan.units.map((unit) => unit.id));
  return [...plan.units, ...plan.omitted].map((unit) => {
    const result = byId.get(unit.id);
    return {
      id: unit.id,
      kind: unit.kind ?? 'chapter',
      chapters: unit.chapters,
      ranges: unit.ranges ?? [],
      state: result ? result.state : (planned.has(unit.id) ? 'unread' : 'omitted'),
      calls: result?.calls ?? 0,
      reused: result?.reused === true,
      artifact: result?.artifact ?? null,
      errors: (result?.errors ?? []).slice(0, 3)
    };
  });
}

// Frozen reading targets of the team's readers (`docs/contracts.md` §8.7): the accepted version of a
// book, of a declared arc or of one chapter, copied out of `universes/` into the external workspace
// together with the questionnaire the reader was shown. The invariants this module keeps:
//
//  - a target is written once. Its identifier is derived from the universe, the accepted version and
//    the scope, so a second session against the same version and scope opens the same target instead
//    of freezing a second copy of the same prose;
//  - the frozen text is a copy, byte for byte: nothing here writes inside `universes/`, and a target
//    whose frozen files no longer reproduce the hashes it recorded answers `STALE_TARGET` rather than
//    attaching a reading to prose that changed;
//  - `target.json` is written last, through a temporary file and a rename, so a target is never read
//    half-written, and every freeze is serialized per universe, so two simultaneous sessions cannot
//    each write the same target.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { nowIso, readJson, writeJson } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { currentVersion, sha256, universeWorkspace } from './assessment-packet.mjs';
import { acceptedChapters } from './universe-chapters.mjs';
import { readUniverseMeta } from './universe.mjs';
import { universeDir } from './paths.mjs';

export const TARGET_SCHEMA = 'reader-feedback-target.v1';
export const QUESTIONNAIRE_VERSION = 'reader-questionnaire.v1';

/**
 * The reading questionnaire, versioned and frozen into every target: stable question identifiers, the
 * label and the anchored endpoints a reader saw, and the options a response may name. §8.7 states the
 * form in prose (interest, clarity, voice distinctness, emotional effect, desire to continue, each
 * optional and anchored 1 to 5); the declaration lives here so validation and the interface read one
 * source instead of two that drift.
 */
export const QUESTIONNAIRE = Object.freeze({
  version: QUESTIONNAIRE_VERSION,
  questions: [
    { id: 'interest', label: 'How interesting was this text?', low: 'flat', high: 'gripping', options: [1, 2, 3, 4, 5] },
    { id: 'clarity', label: 'How clearly was this told?', low: 'confusing', high: 'crystal clear', options: [1, 2, 3, 4, 5] },
    { id: 'voice', label: 'How distinct are the voices?', low: 'interchangeable', high: 'each their own', options: [1, 2, 3, 4, 5] },
    { id: 'emotion', label: 'How strongly did this text move you?', low: 'untouched', high: 'moved', options: [1, 2, 3, 4, 5] },
    { id: 'continue', label: 'How much do you want to read what comes next?', low: 'not at all', high: 'at once', options: [1, 2, 3, 4, 5] }
  ]
});

/** The limits of §8.7 in one place: the store and the validation of a response both read them here. */
export const LIMITS = Object.freeze({
  idChars: 64,
  noteChars: 200,
  displayNameChars: 80,
  whereChars: 200,
  deviceChars: 200,
  commentChars: 4000,
  answerCommentChars: 1200,
  evidenceChars: 600,
  listEntries: 20
});

export const feedbackRoot = (universeId) => join(universeWorkspace(universeId), 'feedback');
export const targetsRoot = (universeId) => join(feedbackRoot(universeId), 'targets');
export const targetDir = (universeId, targetId) => join(targetsRoot(universeId), targetId);
export const targetFile = (universeId, targetId) => join(targetDir(universeId, targetId), 'target.json');
export const targetTextDir = (universeId, targetId) => join(targetDir(universeId, targetId), 'text');

const TARGET_ID_RE = /^target-[0-9a-f]{16}$/;
const VERSION_DIR_RE = /^sha256-[0-9a-f]{8,}$/;
const SCOPE_KINDS = ['book', 'arc', 'chapter'];

export const isTargetId = (targetId) => typeof targetId === 'string' && TARGET_ID_RE.test(targetId);

const invalid = (message) => new UniverseError('INVALID_FEEDBACK', message, 400);
const stale = (message) => new UniverseError('STALE_TARGET', message, 409);

// A freeze is serialized per universe, the way a run creation is in `./assessments.mjs`: the lookup
// and the write must not interleave, or two simultaneous sessions would each find nothing.
const chains = new Map();

function serialize(universeId, work) {
  const previous = chains.get(universeId) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(universeId, next.then(() => undefined, () => undefined));
  return next;
}

/** A copy of the questionnaire a target can carry without sharing the frozen constant. */
export function frozenQuestionnaire() {
  return JSON.parse(JSON.stringify(QUESTIONNAIRE));
}

/** The displayed file a name refers to, by its path inside the book or by its frozen file name. */
export function displayedFile(target, name) {
  const files = target.displayed?.files ?? [];
  return files.find((file) => file.path === name) ?? files.find((file) => basename(file.path) === name) ?? null;
}

/** The frozen text of one displayed file, read back from the target's own copy. */
export async function readFrozenText(universeId, target, name) {
  const file = displayedFile(target, name);
  if (!file) return null;
  const text = await readFile(join(targetTextDir(universeId, target.target_id), basename(file.path)), 'utf8').catch(() => null);
  return text === null ? null : { file, text };
}

/**
 * The frozen text of a target, checked against the hashes the target recorded. A missing or changed
 * file means the prose a response quotes cannot be reproduced, so the caller is given `STALE_TARGET`
 * instead of a reading that would silently point at other words.
 */
export async function verifyFrozenText(universeId, target) {
  const recorded = new Map((target.displayed?.files ?? []).map((file) => [file.path, file.sha256]));
  for (const chapter of target.chapters ?? []) {
    if (chapter.path !== undefined && recorded.get(chapter.path) !== chapter.sha256) {
      throw stale(`Target ${target.target_id} lists chapter ${chapter.number} with a hash its displayed files do not carry.`);
    }
  }
  for (const file of target.displayed?.files ?? []) {
    const bytes = await readFile(join(targetTextDir(universeId, target.target_id), basename(file.path))).catch(() => null);
    if (!bytes || sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) {
      throw stale(`The frozen text of ${target.target_id} cannot be reproduced (${file.path}); open a new target instead of attaching a response to prose that changed.`);
    }
  }
}

/** `sha256:` + the identity of a displayed text bundle, the convention §8.2 uses for a version. */
function bundleHash(files) {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\t${file.sha256}\t${file.bytes}\n`)
    .join('');
  return `sha256:${sha256(lines)}`;
}

const targetIdFor = (universeId, sourceVersion, scope) =>
  `target-${sha256([universeId, sourceVersion, scope.kind, scope.chapters.join(',')].join('|')).slice(0, 16)}`;

/** The chapters a requested scope names, checked against the accepted chapters of the book. */
function scopeChapters(rawScope, accepted) {
  const source = rawScope && typeof rawScope === 'object' ? rawScope : {};
  const kind = String(source.kind ?? '');
  if (!SCOPE_KINDS.includes(kind)) throw invalid(`A target scope is a ${SCOPE_KINDS.join(', ')} (received ${kind || 'nothing'}).`);
  const acceptedNumbers = accepted.map((chapter) => chapter.number);
  if (kind === 'book') {
    if (acceptedNumbers.length === 0) throw new UniverseError('NOT_FOUND', 'This book has no accepted chapter to display yet.', 404);
    return { kind, chapters: acceptedNumbers };
  }
  const requested = Array.isArray(source.chapters) ? source.chapters
    : Number.isInteger(source.chapter) ? [source.chapter] : [];
  const numbers = [...new Set(requested.map((value) => Number.parseInt(value, 10)))].sort((a, b) => a - b);
  if (numbers.length === 0 || numbers.some((number) => !Number.isInteger(number))) {
    throw invalid(`A ${kind} target names the chapters it displays (\`chapters\`).`);
  }
  const missing = numbers.filter((number) => !acceptedNumbers.includes(number));
  if (missing.length > 0) {
    throw new UniverseError('NOT_FOUND', `Chapter ${missing.join(', ')} is not an accepted chapter of this book.`, 404);
  }
  return { kind, chapters: numbers };
}

/** The run record of one report of this book, or `null`. Only `sha256-…` directories are run records. */
async function findRun(universeId, runId) {
  const root = universeWorkspace(universeId);
  for (const version of await readdir(root).catch(() => [])) {
    if (!VERSION_DIR_RE.test(version)) continue;
    for (const name of await readdir(join(root, version)).catch(() => [])) {
      const record = await readJson(join(root, version, name, 'run.json'), null);
      if (record?.run_id === runId) return record;
    }
  }
  return null;
}

function checkNote(note) {
  if (note === null || note === undefined) return null;
  const value = String(note).trim();
  if (value.length > LIMITS.noteChars) throw invalid(`A note is at most ${LIMITS.noteChars} characters.`);
  return value.length === 0 ? null : value;
}

function checkFindingIds(findingIds) {
  const ids = Array.isArray(findingIds) ? findingIds.map((value) => String(value)) : [];
  if (ids.length > LIMITS.listEntries || ids.some((value) => value.length === 0 || value.length > LIMITS.idChars)) {
    throw invalid(`A target names at most ${LIMITS.listEntries} findings.`);
  }
  return ids;
}

const view = (target, current) => ({ ...target, historical: current !== null && target.source_version !== current });

/**
 * Freeze the accepted version of a book, arc or chapter as a target, or return the target that already
 * exists for that version and scope. `runId` names the report the reader was looking at, if any.
 */
export async function createFeedbackTarget({ universeId, scope = null, runId = null, note = null, findingIds = [] }) {
  await readUniverseMeta(universeId);
  const frozenNote = checkNote(note);
  const findings = checkFindingIds(findingIds);
  const requestedRun = runId === null || runId === undefined ? null : String(runId);
  if (requestedRun !== null && !(await findRun(universeId, requestedRun))) {
    throw new UniverseError('NOT_FOUND', `This book has no report with the identifier ${requestedRun}.`, 404);
  }
  return serialize(universeId, async () => {
    const sourceVersion = await currentVersion(universeId);
    if (sourceVersion === null) {
      throw stale('A chapter of this book is being written right now, so the accepted version is not stable and no target can be frozen for it.');
    }
    const accepted = await acceptedChapters(universeId);
    const resolved = scopeChapters(scope, accepted);
    const targetId = targetIdFor(universeId, sourceVersion, resolved);
    const existing = await readJson(targetFile(universeId, targetId), null);
    if (existing) {
      await verifyFrozenText(universeId, existing);
      return { target: view(existing, sourceVersion), deduplicated: true };
    }
    const meta = await readUniverseMeta(universeId);
    const displayed = [];
    const chapters = [];
    const texts = [];
    for (const chapter of accepted.filter((entry) => resolved.chapters.includes(entry.number))) {
      const bytes = await readFile(join(universeDir(universeId), chapter.file));
      displayed.push({ path: chapter.file, sha256: sha256(bytes), bytes: bytes.length });
      chapters.push({ number: chapter.number, title: chapter.title, path: chapter.file, sha256: displayed.at(-1).sha256 });
      texts.push({ name: basename(chapter.file), bytes });
    }
    const hash = bundleHash(displayed);
    const record = {
      schema_version: TARGET_SCHEMA,
      target_id: targetId,
      universe_id: universeId,
      source_version: sourceVersion,
      scope: resolved,
      language: meta.language ?? 'en',
      created_at: nowIso(),
      displayed: { hash, files: displayed },
      chapters,
      run_id: requestedRun,
      finding_ids: findings,
      context: { note: frozenNote, display: { files: displayed.map((file) => file.path), hash } },
      questionnaire: frozenQuestionnaire()
    };
    // The text first, `target.json` last: a target without its record does not exist for a reader.
    const textDirectory = targetTextDir(universeId, targetId);
    await mkdir(textDirectory, { recursive: true });
    for (const text of texts) await writeFile(join(textDirectory, text.name), text.bytes);
    await writeJson(targetFile(universeId, targetId), record);
    return { target: view(record, sourceVersion), deduplicated: false };
  });
}

/** One target with its frozen files listed, or `404 NOT_FOUND`. */
export async function readFeedbackTarget(universeId, targetId) {
  if (!isTargetId(targetId)) throw new UniverseError('NOT_FOUND', 'Unknown feedback target.', 404);
  const target = await readJson(targetFile(universeId, targetId), null);
  if (!target) throw new UniverseError('NOT_FOUND', 'Unknown feedback target.', 404);
  await verifyFrozenText(universeId, target);
  return view(target, await currentVersion(universeId));
}

/** Every target of a book, newest first. The frozen text is read as given here, not re-checked. */
export async function listFeedbackTargets(universeId) {
  const current = await currentVersion(universeId);
  const targets = [];
  for (const name of await readdir(targetsRoot(universeId)).catch(() => [])) {
    if (!isTargetId(name)) continue;
    const target = await readJson(targetFile(universeId, name), null);
    if (target) targets.push(view(target, current));
  }
  return targets.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.target_id).localeCompare(String(a.target_id)));
}

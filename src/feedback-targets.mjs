// Frozen reading targets of the team's readers (`docs/contracts.md` §8.7): the accepted version of a
// book, of a declared arc or of one chapter, copied out of `universes/` into the external workspace
// together with the questionnaire the reader was shown. The invariants this module keeps:
//
//  - a target is written once. Its identifier is derived from the universe, the accepted version and
//    the scope, so a second session against the same version and scope opens the same target instead
//    of freezing a second copy of the same prose;
//  - a target is only what every reader of that version and scope shares: the frozen text and the
//    questionnaire. What one reader was looking at while answering — a report, findings, a session
//    note, what they had already seen — belongs to that reader's response (`./feedback-entries.mjs`),
//    so no later reader inherits a report association they never had;
//  - the freeze is captured against the version the reader actually read. A client may name that
//    version and the hashes of the chapters it displayed; when either no longer describes the accepted
//    text the capture answers `STALE_TARGET` with the versions in `details` and freezes nothing, or
//    reopens the frozen copy of the earlier version by its own identity when one exists;
//  - the frozen text is a copy, byte for byte: nothing here writes inside `universes/`, and a target
//    whose frozen files no longer reproduce the hashes it recorded answers `STALE_TARGET` rather than
//    attaching a reading to prose that changed;
//  - `target.json` is written last, through a temporary file and a rename, so a target is never read
//    half-written, and every freeze is serialized per universe, so two simultaneous sessions cannot
//    each write the same target. The version is read again after the text is read, so a turn that
//    published while the capture was reading cannot freeze two versions under one identity.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { nowIso, readJson, writeJson } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { assessmentsRoot, currentVersion, sha256, universeWorkspace } from './assessment-packet.mjs';
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
 * source instead of two that drift. `reactions` declares the two reactions a reader may add to a
 * response: how useful the report they were looking at was (`about: 'report'`, so it is only answered
 * when the response names one) and whether they found a defect in the text itself (`about: 'text'`).
 */
export const QUESTIONNAIRE = Object.freeze({
  version: QUESTIONNAIRE_VERSION,
  questions: [
    { id: 'interest', label: 'How interesting was this text?', low: 'flat', high: 'gripping', options: [1, 2, 3, 4, 5] },
    { id: 'clarity', label: 'How clearly was this told?', low: 'confusing', high: 'crystal clear', options: [1, 2, 3, 4, 5] },
    { id: 'voice', label: 'How distinct are the voices?', low: 'interchangeable', high: 'each their own', options: [1, 2, 3, 4, 5] },
    { id: 'emotion', label: 'How strongly did this text move you?', low: 'untouched', high: 'moved', options: [1, 2, 3, 4, 5] },
    { id: 'continue', label: 'How much do you want to read what comes next?', low: 'not at all', high: 'at once', options: [1, 2, 3, 4, 5] }
  ],
  reactions: [
    {
      id: 'usefulness',
      about: 'report',
      label: 'How useful was the report you were looking at?',
      low: 'no use',
      high: 'it changed what I did',
      options: [1, 2, 3, 4, 5]
    },
    {
      id: 'defect_present',
      about: 'text',
      label: 'Did you find a defect in this text?',
      low: null,
      high: null,
      options: ['no', 'unsure', 'yes']
    }
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

const shortVersion = (version) => (typeof version === 'string' && version.length > 18 ? `${version.slice(0, 18)}…` : String(version));

/** The version a client says it read, or `null` when it named none (§8.2 identity of a version). */
function requestedVersion(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = String(raw);
  if (!/^sha256:[0-9a-f]{16,}$/.test(value)) {
    throw invalid(`\`sourceVersion\` is the identity of the accepted version the reader was shown (\`sha256:\` and its hash), received ${JSON.stringify(raw)}.`);
  }
  return value;
}

/**
 * The hashes of the chapters a client displayed, keyed by chapter number. A client that sends them is
 * saying which bytes it put on screen, so the freeze can refuse to attach a reading to a text that is
 * not the one the reader saw.
 */
function checkDisplayed(raw) {
  if (raw === null || raw === undefined) return null;
  const source = Array.isArray(raw) ? raw : raw.chapters;
  if (!Array.isArray(source)) throw invalid('`displayed` lists the chapters the reader saw, each with its number and the sha256 of its displayed text.');
  const shown = new Map();
  for (const entry of source) {
    const number = Number.parseInt(entry?.number, 10);
    const hash = String(entry?.sha256 ?? '').toLowerCase();
    if (!Number.isInteger(number) || number < 1) throw invalid('A displayed chapter is named by its number.');
    if (!/^[0-9a-f]{64}$/.test(hash)) throw invalid(`The displayed hash of chapter ${number} is a sha256 in hexadecimal.`);
    if (shown.has(number)) throw invalid(`Chapter ${number} is listed twice as displayed.`);
    shown.set(number, hash);
  }
  return shown;
}

/** The machine-readable half of a `STALE_TARGET`: which version was asked for, which one is accepted. */
function staleDetails(requested, accepted, resolved, extra = {}) {
  return { requested_version: requested, accepted_version: accepted, scope: resolved, target_id: null, ...extra };
}

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

function checkFindingIds(findingIds) {
  const ids = Array.isArray(findingIds) ? findingIds.map((value) => String(value)) : [];
  if (ids.length > LIMITS.listEntries || ids.some((value) => value.length === 0 || value.length > LIMITS.idChars)) {
    throw invalid(`A response names at most ${LIMITS.listEntries} findings.`);
  }
  return ids;
}

/** Every finding identifier a published report carries, whatever document of it lists them. */
function* findingsIn(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) yield* findingsIn(item, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'findings' && Array.isArray(child)) {
      for (const finding of child) if (finding && typeof finding === 'object') yield finding;
      continue;
    }
    yield* findingsIn(child, depth + 1);
  }
}

/** The findings one report published: the identifiers of the documents it wrote, nothing else. */
async function publishedFindings(universeId, run) {
  const found = new Set();
  const directory = join(assessmentsRoot(), run.result_dir ?? '');
  for (const name of run.outputs ?? []) {
    if (!String(name).endsWith('.json')) continue;
    const document = await readJson(join(directory, name), null);
    for (const finding of findingsIn(document)) if (finding.id) found.add(String(finding.id));
  }
  return found;
}

/**
 * The report and findings a response says its reader was looking at, checked against the target it
 * answers: a finding is only evidence about the text this reader was shown, so the report must be a
 * published run of this book, of the very version the target froze, and about chapters the target
 * displays, and every named finding must be one that report published. A response that names a
 * report of another version, or a finding its report never carried, is refused rather than stored as
 * an association the reader could not have had.
 */
export async function verifyReportReference(universeId, target, runId, findingIds = []) {
  const ids = checkFindingIds(findingIds);
  const wanted = runId === null || runId === undefined || runId === '' ? null : String(runId);
  if (wanted === null) {
    if (ids.length > 0) throw invalid('A finding belongs to a report: name the `runId` the reader read it in.');
    return { run_id: null, finding_ids: [] };
  }
  const run = await findRun(universeId, wanted);
  if (!run) throw new UniverseError('NOT_FOUND', `This book has no report with the identifier ${wanted}.`, 404);
  if (run.status !== 'done') {
    throw invalid(`Report ${wanted} is ${run.status}; a response can only be about a report that was published.`);
  }
  if (run.version !== target.source_version) {
    throw invalid(`Report ${wanted} assessed version ${shortVersion(run.version)} while this target froze ${shortVersion(target.source_version)}; a reader cannot have seen one while answering the other.`);
  }
  const shown = new Set(target.scope?.chapters ?? []);
  const outside = (run.scope?.chapters ?? []).filter((number) => !shown.has(number));
  if (outside.length > 0) {
    throw invalid(`Report ${wanted} assessed chapter(s) ${outside.join(', ')}, which this target does not display.`);
  }
  if (ids.length === 0) return { run_id: run.run_id, finding_ids: [] };
  const published = await publishedFindings(universeId, run);
  const unknown = ids.filter((id) => !published.has(id));
  if (unknown.length > 0) {
    throw invalid(`Report ${wanted} published no finding ${unknown.join(', ')}; the reader cannot have seen it there.`);
  }
  return { run_id: run.run_id, finding_ids: ids };
}

const view = (target, current) => ({ ...target, historical: current !== null && target.source_version !== current });

/**
 * Freeze the accepted version of a book, arc or chapter as a target, or return the target that already
 * exists for that version and scope. A client may name the `sourceVersion` it read and the `displayed`
 * hashes of the chapters it put on screen: either one that no longer describes the accepted text ends
 * the capture with `STALE_TARGET` and freezes nothing, and a version whose frozen copy exists is
 * reopened by its own identity instead.
 */
export async function createFeedbackTarget({ universeId, scope = null, sourceVersion = null, displayed = null }) {
  await readUniverseMeta(universeId);
  const requested = requestedVersion(sourceVersion);
  const shown = checkDisplayed(displayed);
  return serialize(universeId, async () => {
    const source = await currentVersion(universeId);
    if (source === null) {
      throw stale('A chapter of this book is being written right now, so the accepted version is not stable and no target can be frozen for it.');
    }
    const accepted = await acceptedChapters(universeId);
    const resolved = scopeChapters(scope, accepted);
    if (requested !== null && requested !== source) {
      // The reader is asking about the version they read, not the one the store holds now: reopen that
      // frozen copy by its own identity when it exists, and never freeze today's prose under it.
      const earlier = await readJson(targetFile(universeId, targetIdFor(universeId, requested, resolved)), null);
      if (earlier) {
        await verifyFrozenText(universeId, earlier);
        return { target: view(earlier, source), deduplicated: true, reopened: true };
      }
      const error = stale(`Nothing was frozen for version ${shortVersion(requested)}, which is the text the reader read; the book is now ${shortVersion(source)}. Freezing the accepted text would attach the reading to prose the reader never saw, so nothing was frozen and the draft is kept.`);
      error.details = staleDetails(requested, source, resolved, { reopenable: false });
      throw error;
    }
    const targetId = targetIdFor(universeId, source, resolved);
    const existing = await readJson(targetFile(universeId, targetId), null);
    if (existing) {
      await verifyFrozenText(universeId, existing);
      return { target: view(existing, source), deduplicated: true };
    }
    const meta = await readUniverseMeta(universeId);
    const displayedFiles = [];
    const chapters = [];
    const texts = [];
    for (const chapter of accepted.filter((entry) => resolved.chapters.includes(entry.number))) {
      const bytes = await readFile(join(universeDir(universeId), chapter.file));
      const hash = sha256(bytes);
      displayedFiles.push({ path: chapter.file, sha256: hash, bytes: bytes.length });
      chapters.push({ number: chapter.number, title: chapter.title, path: chapter.file, sha256: hash });
      texts.push({ number: chapter.number, name: basename(chapter.file), bytes, hash });
    }
    if (shown !== null) {
      const unknown = [...shown.keys()].filter((number) => !accepted.some((chapter) => chapter.number === number));
      if (unknown.length > 0) throw invalid(`The displayed chapters ${unknown.join(', ')} are not chapters of this book.`);
      const missing = resolved.chapters.filter((number) => !shown.has(number));
      if (missing.length > 0) throw invalid(`Name the displayed hash of every chapter of the scope (missing ${missing.join(', ')}).`);
      for (const text of texts) {
        const claimed = shown.get(text.number);
        if (claimed !== undefined && claimed !== text.hash) {
          const error = stale(`Chapter ${text.number} as it was displayed is not the accepted chapter of version ${shortVersion(source)}: the reader's copy hashes to ${claimed.slice(0, 12)}… and the accepted text to ${text.hash.slice(0, 12)}…. Nothing was frozen.`);
          error.details = staleDetails(requested, source, resolved, { chapter: text.number });
          throw error;
        }
      }
    }
    // The chapter bytes above were read one file at a time, so a turn that published while the capture
    // was reading them could mix two versions of the book. The version is read again from the store,
    // and a target is only written when the text it copied is still exactly the version it names.
    const stable = await currentVersion(universeId);
    if (stable !== source) {
      const now = stable === null ? 'a chapter is being written' : shortVersion(stable);
      const error = stale(`The book changed while its text was being frozen (${shortVersion(source)} → ${now}); nothing was frozen. Read the accepted text and answer that.`);
      error.details = staleDetails(requested, stable, resolved, { reopenable: false });
      throw error;
    }
    const hash = bundleHash(displayedFiles);
    const record = {
      schema_version: TARGET_SCHEMA,
      target_id: targetId,
      universe_id: universeId,
      source_version: source,
      scope: resolved,
      language: meta.language ?? 'en',
      created_at: nowIso(),
      displayed: { hash, files: displayedFiles },
      chapters,
      questionnaire: frozenQuestionnaire()
    };
    // The text first, `target.json` last: a target without its record does not exist for a reader.
    const textDirectory = targetTextDir(universeId, targetId);
    await mkdir(textDirectory, { recursive: true });
    for (const text of texts) await writeFile(join(textDirectory, text.name), text.bytes);
    await writeJson(targetFile(universeId, targetId), record);
    return { target: view(record, source), deduplicated: false };
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

// Reader responses (`docs/contracts.md` §8.7): one entry per submission under
// `<workspace>/<universe-id>/feedback/entries/<feedback-id>/feedback.json`. The invariants:
//
//  - a response is anchored to a frozen target and to nothing else. Every quoted range is resolved
//    against the target's own frozen files, and its character offsets (end exclusive, in the UTF-8
//    decoded text) are resolved now, so a quote still points at the same words years later;
//  - nothing is edited in place: a correction is a new entry that points at the one it replaces
//    (`revision_of`), and the only rewrite of an entry is a withdrawal, which empties its body and
//    flags it `withdrawn`;
//  - a submission is durable and idempotent by identifier: the same `feedback_id` with the same
//    content answers the entry that exists (`deduplicated`), different content answers `409 CONFLICT`;
//  - provenance is recorded, never inferred: `reader_kind` is the kind of the identity that submitted,
//    so a model annotation or a synthetic fixture can never be counted as a team reader;
//  - nothing here writes inside `universes/`.
import { mkdir, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { nowIso, readJson, writeJson } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { currentVersion, sha256 } from './assessment-packet.mjs';
import {
  LIMITS,
  displayedFile,
  feedbackRoot,
  listFeedbackTargets,
  readFeedbackTarget,
  readFrozenText
} from './feedback-targets.mjs';
import { markFeedbackReaderDeleted, readFeedbackReader, touchFeedbackReader } from './feedback-readers.mjs';

export const FEEDBACK_SCHEMA = 'reader-feedback.v1';
const READ_KINDS = ['complete', 'partial', 'unknown'];
const FEEDBACK_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export const entriesRoot = (universeId) => join(feedbackRoot(universeId), 'entries');
export const entryDir = (universeId, feedbackId) => join(entriesRoot(universeId), feedbackId);
export const entryFile = (universeId, feedbackId) => join(entryDir(universeId, feedbackId), 'feedback.json');

export const isFeedbackId = (feedbackId) => typeof feedbackId === 'string' && FEEDBACK_ID_RE.test(feedbackId);

const invalid = (message) => new UniverseError('INVALID_FEEDBACK', message, 400);
const unknownFeedback = (feedbackId) => new UniverseError('NOT_FOUND', `Unknown feedback ${feedbackId}.`, 404);

// Submissions are serialized per universe: the deduplication lookup and the write must not interleave,
// or two simultaneous retries would each find nothing and each write an entry of their own.
const chains = new Map();

function serialize(universeId, work) {
  const previous = chains.get(universeId) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(universeId, next.then(() => undefined, () => undefined));
  return next;
}

function checkText(value, max, what, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw invalid(`${what} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw invalid(`${what} must be text.`);
  const text = value.trim();
  if (required && text.length === 0) throw invalid(`${what} is required.`);
  if (text.length > max) throw invalid(`${what} is at most ${max} characters.`);
  return text.length === 0 ? null : text;
}

/** An answer names a declared option or stays `null`, which is a skipped question, not a low rating. */
function checkAnswerValue(question, value) {
  if (value === null || value === undefined || value === '') return null;
  const declared = question.options ?? [];
  const found = declared.find((candidate) => candidate === value || String(candidate) === String(value));
  if (found === undefined) throw invalid(`Question ${question.id} does not declare the option ${JSON.stringify(value)}.`);
  return found;
}

function normalizeAnswers(raw, questionnaire) {
  if (!Array.isArray(raw)) throw invalid('`answers` must be a list.');
  if (raw.length > LIMITS.listEntries) throw invalid(`A response carries at most ${LIMITS.listEntries} answers.`);
  const questions = new Map((questionnaire.questions ?? []).map((question) => [question.id, question]));
  const seen = new Set();
  return raw.map((entry) => {
    const answer = entry && typeof entry === 'object' ? entry : {};
    const id = String(answer.question_id ?? answer.questionId ?? '');
    const question = questions.get(id);
    if (!question) throw invalid(`The questionnaire does not declare the question ${id || '(missing id)'}.`);
    if (seen.has(id)) throw invalid(`Question ${id} is answered twice.`);
    seen.add(id);
    return {
      question_id: id,
      value: checkAnswerValue(question, answer.value),
      comment: checkText(answer.comment, LIMITS.answerCommentChars, `The comment of ${id}`)
    };
  });
}

/** One quoted range, resolved against the frozen file: offsets in, explicit quote out. */
function resolveRange(text, path, range) {
  const quote = typeof range.quote === 'string' ? range.quote : null;
  const anchored = range.start !== undefined || range.end !== undefined;
  const anchor = (start, end, resolved) => {
    if (resolved.length > LIMITS.evidenceChars) throw invalid(`A quoted range is at most ${LIMITS.evidenceChars} characters.`);
    return { file: path, start, end, quote: resolved };
  };
  if (anchored) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) throw invalid('Evidence offsets are whole numbers.');
    if (range.start < 0 || range.end < range.start || range.end > text.length) {
      throw invalid(`The evidence range ${range.start}–${range.end} does not resolve inside ${path} (${text.length} characters).`);
    }
    const slice = text.slice(range.start, range.end);
    if (quote !== null && quote !== slice) throw invalid(`The quote does not match the frozen text of ${path} at ${range.start}–${range.end}.`);
    if (slice.length === 0) throw invalid('An evidence range is not empty.');
    return anchor(range.start, range.end, slice);
  }
  if (quote === null) throw invalid('Evidence is either `start` and `end`, or a `quote` the frozen file contains exactly once.');
  if (quote.length === 0) throw invalid('An evidence quote is not empty.');
  const first = text.indexOf(quote);
  if (first < 0) throw invalid(`The quote is not part of the frozen text of ${path}.`);
  if (text.indexOf(quote, first + 1) >= 0) throw invalid(`The quote appears more than once in ${path}; give the offsets of the passage meant.`);
  return anchor(first, first + quote.length, quote);
}

async function normalizeEvidence(universeId, target, raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalid('`evidence` must be a list.');
  if (raw.length > LIMITS.listEntries) throw invalid(`A comment quotes at most ${LIMITS.listEntries} ranges.`);
  const ranges = [];
  for (const entry of raw) {
    const range = entry && typeof entry === 'object' ? entry : {};
    const file = displayedFile(target, String(range.file ?? ''));
    if (!file) throw invalid(`The evidence names ${range.file ? `"${range.file}"` : 'no file'}, which the target does not display.`);
    const frozen = await readFrozenText(universeId, target, file.path);
    if (!frozen) {
      throw new UniverseError('STALE_TARGET', `The frozen text of ${target.target_id} cannot be read (${file.path}); open a new target instead.`, 409);
    }
    ranges.push(resolveRange(frozen.text, file.path, range));
  }
  return ranges;
}

async function normalizeComments(universeId, target, raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalid('`comments` must be a list.');
  if (raw.length > LIMITS.listEntries) throw invalid(`A response carries at most ${LIMITS.listEntries} comments.`);
  const comments = [];
  for (const entry of raw) {
    const comment = entry && typeof entry === 'object' ? entry : {};
    comments.push({
      text: checkText(comment.text, LIMITS.commentChars, 'A comment', { required: true }),
      evidence: await normalizeEvidence(universeId, target, comment.evidence ?? [])
    });
  }
  return comments;
}

/** Where and how the reader read: recorded when given, never required, never invented. */
function normalizeConditions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  let duration = null;
  if (source.duration_minutes !== null && source.duration_minutes !== undefined) {
    const minutes = Number(source.duration_minutes);
    if (!Number.isFinite(minutes) || minutes < 0) throw invalid('`duration_minutes` is a number of minutes, zero or more.');
    duration = minutes;
  }
  const read = source.read === null || source.read === undefined || source.read === '' ? null : String(source.read);
  if (read !== null && !READ_KINDS.includes(read)) throw invalid(`\`read\` is one of ${READ_KINDS.join(', ')}.`);
  return {
    where: checkText(source.where, LIMITS.whereChars, '`where`'),
    duration_minutes: duration,
    device: checkText(source.device, LIMITS.deviceChars, '`device`'),
    read
  };
}

/** The correction lineage: one child per response, written by the same reader. */
async function resolveRevision(universeId, revisionOf, reader) {
  const parent = revisionOf === null || revisionOf === undefined || revisionOf === '' ? null : String(revisionOf);
  if (parent === null) return { parent: null, number: 1 };
  if (!isFeedbackId(parent)) throw unknownFeedback(parent);
  const record = await readJson(entryFile(universeId, parent), null);
  if (!record) throw unknownFeedback(parent);
  if (record.request !== 'response') throw invalid('A deletion request cannot be corrected.');
  if (record.withdrawn === true) throw invalid(`Feedback ${parent} was withdrawn; write a new response instead of correcting it.`);
  if (record.reader_id !== reader.reader_id) throw invalid('A correction is written by the reader whose response it corrects.');
  for (const candidate of await readEntries(universeId)) {
    if (candidate.feedback_id !== parent && candidate.revision_of === parent) {
      throw new UniverseError('CONFLICT', `Feedback ${parent} was already corrected by ${candidate.feedback_id}.`, 409);
    }
  }
  return { parent, number: (Number.isInteger(record.revision) ? record.revision : 1) + 1 };
}

async function readEntries(universeId) {
  const entries = [];
  for (const name of await readdir(entriesRoot(universeId)).catch(() => [])) {
    if (!isFeedbackId(name)) continue;
    const entry = await readJson(entryFile(universeId, name), null);
    if (entry) entries.push(entry);
  }
  return entries;
}

const view = (entry, current) => ({
  ...entry,
  historical: current !== null && entry.accepted_source_version !== current,
  withdrawn: entry.withdrawn === true
});

async function viewEntry(universeId, entry, current = undefined) {
  return view(entry, current === undefined ? await currentVersion(universeId) : current);
}

/**
 * Write one reader's response to a frozen target. The identifier is the server's unless the caller
 * names one, which is what makes a retried submission idempotent instead of a second opinion.
 */
export async function submitFeedback({
  universeId,
  targetId = null,
  readerId = null,
  answers = [],
  comments = [],
  conditions = null,
  feedbackId = null,
  revisionOf = null,
  readerKind = null,
  questionnaireVersion = null
}) {
  const target = await readFeedbackTarget(universeId, targetId);
  const reader = await readFeedbackReader(universeId, readerId);
  if (reader.deleted_at) {
    throw new UniverseError('READER_NOT_FOUND', `Reader ${reader.reader_id} asked for their identity to be deleted; a new reading needs a new identity.`, 404);
  }
  if (readerKind !== null && readerKind !== undefined && String(readerKind) !== reader.kind) {
    throw invalid(`This reader is a ${reader.kind}; a response cannot claim to be ${readerKind}.`);
  }
  const questionnaire = target.questionnaire;
  if (!questionnaire?.version) throw invalid('The target does not carry the questionnaire it was frozen with.');
  if (questionnaireVersion !== null && questionnaireVersion !== undefined && String(questionnaireVersion) !== questionnaire.version) {
    throw invalid(`The target was frozen with questionnaire ${questionnaire.version}, not ${questionnaireVersion}.`);
  }
  const revision = await resolveRevision(universeId, revisionOf, reader);
  const normalized = {
    target_id: target.target_id,
    universe_id: universeId,
    reader_id: reader.reader_id,
    reader_kind: reader.kind,
    questionnaire_version: questionnaire.version,
    accepted_source_version: target.source_version,
    scope: target.scope,
    language: target.language,
    run_id: target.run_id ?? null,
    finding_ids: target.finding_ids ?? [],
    answers: normalizeAnswers(answers, questionnaire),
    comments: await normalizeComments(universeId, target, comments),
    conditions: normalizeConditions(conditions),
    revision_of: revision.parent,
    revision: revision.number
  };
  const id = feedbackId === null || feedbackId === undefined || feedbackId === '' ? issuedId() : String(feedbackId);
  if (!isFeedbackId(id)) throw invalid('A feedback identifier is 3 to 64 characters of letters, digits, dots, dashes or underscores.');
  // The identity of the content: what a retry of the same submission reproduces and a different
  // submission under the same identifier does not.
  const submission = sha256(JSON.stringify(normalized));
  return serialize(universeId, async () => {
    const existing = await readJson(entryFile(universeId, id), null);
    if (existing) {
      if (existing.submission_sha256 === submission) return { feedback: await viewEntry(universeId, existing), deduplicated: true };
      throw new UniverseError('CONFLICT', `Feedback ${id} already exists with different content.`, 409);
    }
    const entry = {
      schema_version: FEEDBACK_SCHEMA,
      feedback_id: id,
      created_at: nowIso(),
      ...normalized,
      request: 'response',
      withdrawn: false,
      withdrawn_at: null,
      submission_sha256: submission
    };
    await mkdir(entryDir(universeId, id), { recursive: true });
    await writeJson(entryFile(universeId, id), entry);
    await touchFeedbackReader(universeId, reader.reader_id);
    return { feedback: await viewEntry(universeId, entry), deduplicated: false };
  });
}

function issuedId() {
  return `fb-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
}

/** One response, withdrawn ones included: an opinion that was taken back is still a record. */
export async function readFeedback(universeId, feedbackId) {
  if (!isFeedbackId(feedbackId)) throw unknownFeedback(feedbackId);
  const entry = await readJson(entryFile(universeId, feedbackId), null);
  if (!entry) throw unknownFeedback(feedbackId);
  return viewEntry(universeId, entry);
}

/** The counts the listing reports. Only real responses count as readers saying something. */
function countsOf(entries) {
  const responses = entries.filter((entry) => entry.request === 'response');
  const active = responses.filter((entry) => entry.withdrawn !== true);
  const kind = (name) => active.filter((entry) => entry.reader_kind === name).length;
  return {
    responses: responses.length,
    active: active.length,
    withdrawn: responses.length - active.length,
    identity_deletions: entries.length - responses.length,
    team_human: kind('team_human'),
    model: kind('model'),
    synthetic: kind('synthetic'),
    readers: new Set(active.filter((entry) => entry.reader_kind === 'team_human').map((entry) => entry.reader_id)).size
  };
}

/**
 * The responses of a book, newest first, each with `historical` (its target is no longer the accepted
 * version) and `withdrawn`; the targets they answer, and the counts the team reads.
 */
export async function listFeedback(universeId) {
  const current = await currentVersion(universeId);
  const entries = (await readEntries(universeId)).map((entry) => view(entry, current));
  entries.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.feedback_id).localeCompare(String(a.feedback_id)));
  return { feedback: entries, targets: await listFeedbackTargets(universeId), counts: countsOf(entries) };
}

/** A withdrawal: the entry is kept, flagged, and its answers are no longer shown. */
export async function withdrawFeedback({ universeId, feedbackId }) {
  if (!isFeedbackId(feedbackId)) throw unknownFeedback(feedbackId);
  return serialize(universeId, async () => {
    const entry = await readJson(entryFile(universeId, feedbackId), null);
    if (!entry) throw unknownFeedback(feedbackId);
    if (entry.request !== 'response') throw invalid('A deletion request is not a response; there is nothing to withdraw.');
    if (entry.withdrawn === true) return viewEntry(universeId, entry);
    const withdrawn = { ...entry, withdrawn: true, withdrawn_at: nowIso(), answers: [], comments: [] };
    await writeJson(entryFile(universeId, feedbackId), withdrawn);
    return viewEntry(universeId, withdrawn);
  });
}

/**
 * A reader asking for their identity to be deleted. The request is itself an entry, because a
 * withdrawal has to be visible: the identity stays readable, marked `deleted_at`, and no response can
 * be attributed to it afterwards. Asking twice records nothing twice.
 */
export async function recordReaderDeletion({ universeId, readerId, note = null }) {
  const reader = await readFeedbackReader(universeId, readerId);
  const why = checkText(note, LIMITS.noteChars, 'A note');
  return serialize(universeId, async () => {
    for (const entry of await readEntries(universeId)) {
      if (entry.request === 'delete_identity' && entry.reader_id === reader.reader_id) {
        return { reader: await readFeedbackReader(universeId, reader.reader_id), entry: await viewEntry(universeId, entry), deduplicated: true };
      }
    }
    const id = issuedId();
    const payload = { reader_id: reader.reader_id, reader_kind: reader.kind, note: why };
    const entry = {
      schema_version: FEEDBACK_SCHEMA,
      feedback_id: id,
      created_at: nowIso(),
      target_id: null,
      universe_id: universeId,
      reader_id: reader.reader_id,
      reader_kind: reader.kind,
      questionnaire_version: null,
      accepted_source_version: null,
      scope: null,
      language: null,
      run_id: null,
      finding_ids: [],
      answers: [],
      comments: [],
      conditions: { where: null, duration_minutes: null, device: null, read: null },
      revision_of: null,
      revision: 1,
      request: 'delete_identity',
      note: why,
      withdrawn: false,
      withdrawn_at: null,
      submission_sha256: sha256(JSON.stringify(payload))
    };
    await mkdir(entryDir(universeId, id), { recursive: true });
    await writeJson(entryFile(universeId, id), entry);
    const marked = await markFeedbackReaderDeleted(universeId, reader.reader_id);
    return { reader: marked, entry: await viewEntry(universeId, entry), deduplicated: false };
  });
}

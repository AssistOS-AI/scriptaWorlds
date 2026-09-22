// The reusable dataset of one book's reader feedback (`docs/contracts.md` §8.7): one JSON document
// that another tool can read without knowing the workspace layout, and the same bytes every time it is
// exported from the same store. The invariants this module keeps:
//
//  - the document is built from the store, never from the accepted text. It carries paths, hashes and
//    the reader's own words, so the prose of the book stays where it is frozen and an export writes
//    nothing at all;
//  - it is reproducible: every list is ordered by the identifiers and timestamps the store recorded,
//    the keys are written in the order below, and the document carries no timestamp of its own, so
//    exporting one book twice with nothing changed yields byte-identical bytes;
//  - provenance is never folded: a response keeps the `reader_kind` of the identity that wrote it and
//    every count reports the three kinds separately, so a model's annotation is never added to what a
//    reader said;
//  - a correction is visible rather than counted twice: a response another response names as its
//    `revision_of` is marked `superseded` and stays in the dataset as the reader's first reading;
//  - `historical` is `null` while a turn of the book is queued or running, because then the accepted
//    version cannot be read and the document does not guess which responses are about the current text.
import { currentVersion } from './assessment-packet.mjs';
import { UniverseError } from './errors.mjs';
import { listFeedback } from './feedback-entries.mjs';
import { READER_KINDS, listFeedbackReaders } from './feedback-readers.mjs';
import { acceptedChapters } from './universe-chapters.mjs';
import { readUniverseMeta } from './universe.mjs';

export const FEEDBACK_EXPORT_SCHEMA = 'reader-feedback-export.v1';

/** The file name of the download: one name per book, so the team can keep and diff the same file. */
export const feedbackExportName = (universeId) => `${universeId}-feedback-export.json`;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byCreated = (id) => (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || byText(a[id], b[id]);
const historical = (version, accepted) => (accepted === null ? null : version !== accepted);
const kinds = (items) => Object.fromEntries(READER_KINDS.map((kind) => [kind, items.filter((item) => item.reader_kind === kind).length]));

/** One response of the dataset: the reader, the target, the answers, the quotes and the lineage. */
function responseOf(entry, accepted, superseded) {
  const conditions = entry.conditions ?? {};
  return {
    feedback_id: entry.feedback_id,
    created_at: entry.created_at,
    reader_id: entry.reader_id,
    reader_kind: entry.reader_kind,
    target_id: entry.target_id,
    accepted_source_version: entry.accepted_source_version,
    scope: entry.scope ?? null,
    language: entry.language ?? null,
    questionnaire_version: entry.questionnaire_version ?? null,
    run_id: entry.run_id ?? null,
    finding_ids: entry.finding_ids ?? [],
    // A skipped answer stays skipped: `value` is `null` and is never written as a rating.
    answers: (entry.answers ?? []).map((answer) => ({
      question_id: answer.question_id,
      value: answer.value ?? null,
      comment: answer.comment ?? null
    })),
    comments: (entry.comments ?? []).map((comment) => ({
      text: comment.text,
      evidence: (comment.evidence ?? []).map((range) => ({
        file: range.file,
        start: range.start,
        end: range.end,
        quote: range.quote
      }))
    })),
    conditions: {
      where: conditions.where ?? null,
      duration_minutes: conditions.duration_minutes ?? null,
      device: conditions.device ?? null,
      read: conditions.read ?? null
    },
    revision_of: entry.revision_of ?? null,
    revision: Number.isInteger(entry.revision) ? entry.revision : 1,
    // A response another response names as its `revision_of` was corrected: it stays in the dataset as
    // the reader's first reading, and the summary counts the correction instead of both.
    superseded: superseded.has(entry.feedback_id),
    withdrawn: entry.withdrawn === true,
    withdrawn_at: entry.withdrawn_at ?? null,
    historical: historical(entry.accepted_source_version, accepted)
  };
}

/** One target of the dataset: what was displayed, by path and hash only. The text stays in the target. */
function targetOf(target, accepted) {
  return {
    target_id: target.target_id,
    source_version: target.source_version,
    scope: target.scope ?? null,
    language: target.language ?? null,
    created_at: target.created_at,
    historical: historical(target.source_version, accepted),
    run_id: target.run_id ?? null,
    finding_ids: target.finding_ids ?? [],
    questionnaire_version: target.questionnaire?.version ?? null,
    displayed: {
      hash: target.displayed?.hash ?? null,
      files: (target.displayed?.files ?? []).map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
    },
    chapters: (target.chapters ?? []).map((chapter) => ({
      number: chapter.number,
      title: chapter.title,
      path: chapter.path,
      sha256: chapter.sha256
    })),
    context: { note: target.context?.note ?? null }
  };
}

function readerOf(reader) {
  return {
    reader_id: reader.reader_id,
    display_name: reader.display_name,
    kind: reader.kind,
    created_at: reader.created_at,
    last_seen_at: reader.last_seen_at ?? null,
    deleted_at: reader.deleted_at ?? null
  };
}

/** The distinct identities behind a list of responses, each with the kind it was stored with. */
function distinctReaders(responses) {
  const seen = new Map();
  for (const entry of responses) seen.set(entry.reader_id, entry.reader_kind);
  return [...seen.entries()].map(([reader_id, reader_kind]) => ({ reader_id, reader_kind }));
}

/**
 * The dataset of one book: the responses with their reader, target, accepted version, scope, language,
 * questionnaire version, answers (a skipped answer stays `null`), comments with the evidence ranges
 * resolved against the frozen text, conditions, revision lineage and state, plus the targets they were
 * given against, each with the hashes of the files it froze.
 *
 * `404 NOT_FOUND` for a book that does not exist and `404 NO_FEEDBACK` for a book no reader has
 * responded to yet: there is nothing to export before a response exists.
 */
export async function buildFeedbackExport(universeId) {
  const meta = await readUniverseMeta(universeId);
  const accepted = await currentVersion(universeId);
  const listing = await listFeedback(universeId);
  const responses = listing.feedback.filter((entry) => entry.request === 'response');
  if (responses.length === 0) {
    throw new UniverseError('NO_FEEDBACK', 'No reader has responded to this book yet, so there is no feedback dataset to export.', 404);
  }
  const deletions = listing.feedback.filter((entry) => entry.request !== 'response');
  const active = responses.filter((entry) => entry.withdrawn !== true);
  // Lineage within the dataset: what a correction replaces, and what still counts as the reader's answer.
  const supersededIds = new Set(responses.map((entry) => entry.revision_of).filter((id) => typeof id === 'string'));
  const superseded = responses.filter((entry) => supersededIds.has(entry.feedback_id));
  const current = active.filter((entry) => !supersededIds.has(entry.feedback_id));
  const referenced = new Set(listing.feedback.map((entry) => entry.reader_id));
  const readers = (await listFeedbackReaders(universeId)).filter((reader) => referenced.has(reader.reader_id));
  const targets = [...listing.targets].sort((a, b) => byText(a.target_id, b.target_id));
  const questionnaires = [];
  for (const target of targets) {
    const frozen = target.questionnaire;
    if (!frozen?.version || questionnaires.some((entry) => entry.version === frozen.version)) continue;
    questionnaires.push({
      version: frozen.version,
      questions: (frozen.questions ?? []).map((question) => ({
        id: question.id,
        label: question.label,
        low: question.low,
        high: question.high,
        options: question.options ?? []
      }))
    });
  }
  questionnaires.sort((a, b) => byText(a.version, b.version));
  return {
    schema_version: FEEDBACK_EXPORT_SCHEMA,
    universe_id: universeId,
    book: {
      title: meta.title ?? universeId,
      language: meta.language ?? 'en',
      chapters: (await acceptedChapters(universeId)).length,
      accepted_version: accepted,
      version_stable: accepted !== null
    },
    counts: {
      records: { responses: responses.length, identity_deletions: deletions.length },
      responses: kinds(responses),
      withdrawn: kinds(responses.filter((entry) => entry.withdrawn === true)),
      superseded: kinds(superseded),
      active: kinds(active),
      current: kinds(current),
      readers: kinds(distinctReaders(current)),
      targets: targets.length
    },
    questionnaires,
    readers: [...readers].sort(byCreated('reader_id')).map(readerOf),
    targets: targets.map((target) => targetOf(target, accepted)),
    responses: [...responses].sort(byCreated('feedback_id')).map((entry) => responseOf(entry, accepted, supersededIds)),
    identity_deletions: [...deletions].sort(byCreated('feedback_id')).map((entry) => ({
      feedback_id: entry.feedback_id,
      created_at: entry.created_at,
      reader_id: entry.reader_id,
      reader_kind: entry.reader_kind,
      note: entry.note ?? null
    }))
  };
}

/**
 * The document as the bytes a client keeps or a command writes: two-space JSON, one trailing newline,
 * no wall-clock field. Two exports of the same store are byte-identical through this function.
 */
export function serializeFeedbackExport(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * What the download of one book is: the file name a client keeps and the bytes it receives. The route
 * answers these bytes as they are, so the download and the command cannot describe the same store
 * differently.
 */
export async function feedbackExportDownload(universeId) {
  const bytes = Buffer.from(serializeFeedbackExport(await buildFeedbackExport(universeId)), 'utf8');
  return { name: feedbackExportName(universeId), body: bytes };
}

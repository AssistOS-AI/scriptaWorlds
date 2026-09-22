// Carrying what readers said into an approved revision of one chapter (`docs/contracts.md` §8.7, with
// §8.4 for the approval). The invariants:
//
//  - a selection names stored responses, or single comments of them, and nothing else: every item is
//    resolved against the store, and the version it was given against travels with it, so a request
//    built from it is bound to that version and refused as stale when the book has moved on;
//  - nothing is invented: the proposal quotes the readers' own words, the version they were quoted
//    against, and the provenance of every identity, and it never presents an annotation or a fixture
//    as a reader's response;
//  - the latest reading is the one carried: a correction is carried in place of the response it
//    replaces (and the proposal says which responses it replaces), and a withdrawn response is refused
//    rather than carried;
//  - a proposal is about one accepted version; it names the chapter the revision rewrites, and the
//    findings it carries are the ones `./request-fields.mjs` accepts, validated here through the same
//    function the rewrite path uses;
//  - this module writes nothing, anywhere, and never touches `universes/`: it produces a proposal, and
//    from an approved one a rewrite request that the existing rewrite path performs
//    (`jobs.startRewrite`, §8.4). The only record of a decision is the approval of §8.4 itself.
import { currentVersion, sha256 } from './assessment-packet.mjs';
import { UniverseError } from './errors.mjs';
import { isFeedbackId, listFeedback } from './feedback-entries.mjs';
import { READER_KINDS, listFeedbackReaders } from './feedback-readers.mjs';
import { LIMITS } from './feedback-targets.mjs';
import { nowIso } from './io.mjs';
import { jobs } from './jobs.mjs';
import { normaliseRevision } from './request-fields.mjs';
import { acceptedChapters } from './universe-chapters.mjs';
import { readUniverseMeta } from './universe.mjs';

export const REVISION_PROPOSAL_SCHEMA = 'reader-feedback-revision-proposal.v1';
export const REVISION_REQUEST_SCHEMA = 'reader-feedback-revision.v1';

/** As many selections as a revision can carry findings for (§8.4 bounds one request to eight findings). */
export const MAX_SELECTIONS = 8;
/** The words one revision may quote: a longer selection is refused rather than silently cut short. */
export const MAX_INSTRUCTIONS_CHARS = 12_000;
/** The bound every finding of a request obeys; `normaliseRevision` is the authority and re-checks it. */
const MAX_FINDING_CHARS = 400;

const ATTRIBUTION = { team_human: 'reader', model: 'annotation', synthetic: 'fixture' };
const short = (version) => (typeof version === 'string' && version.length > 18 ? `${version.slice(0, 18)}…` : String(version));
const fit = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** How a revision names an identity: a model's annotation and a fixture are never called readers. */
const describedAs = (item) =>
  item.reader_kind === 'team_human'
    ? `${item.reader_display_name}, a team reader`
    : item.reader_kind === 'model'
      ? `${item.reader_display_name}, an annotation by a model (not a reader)`
      : `${item.reader_display_name}, a synthetic fixture (not a reader)`;

const unknownFeedback = (feedbackId) => new UniverseError('NOT_FOUND', `Unknown feedback ${feedbackId}.`, 404);

/** The selections as identifiers and comment positions, bounded before anything is read. */
function normalizeSelections(selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new UniverseError('BAD_SELECTION', 'A revision names the responses or comments it carries (`selections`), and at least one.', 400);
  }
  if (selections.length > MAX_SELECTIONS) {
    throw new UniverseError('BAD_SELECTION', `At most ${MAX_SELECTIONS} responses or comments are carried into one revision.`, 400);
  }
  return selections.map((raw) => {
    const entry = typeof raw === 'string' ? { feedbackId: raw } : (raw ?? {});
    const feedbackId = String(entry.feedbackId ?? entry.feedback_id ?? '').trim();
    if (!isFeedbackId(feedbackId)) throw unknownFeedback(feedbackId);
    const index = entry.commentIndex ?? entry.comment_index ?? null;
    if (index !== null && index !== undefined && index !== '' && (!Number.isInteger(Number(index)) || Number(index) < 0)) {
      throw new UniverseError('BAD_SELECTION', 'A single comment is named by its position in the response (`commentIndex`, counting from 0).', 400);
    }
    return { feedback_id: feedbackId, comment_index: index === null || index === undefined || index === '' ? null : Number(index) };
  });
}

/**
 * One selection resolved against the store: the response that is carried (the correction of the one the
 * caller named, when it was corrected), the version it was given against, the reader behind it and the
 * words it contributes.
 */
function resolveSelection({ selection, responses, readers, accepted }) {
  const byId = new Map(responses.map((entry) => [entry.feedback_id, entry]));
  const correction = new Map(responses.filter((entry) => entry.revision_of).map((entry) => [entry.revision_of, entry]));
  let entry = byId.get(selection.feedback_id) ?? null;
  if (!entry) throw unknownFeedback(selection.feedback_id);
  // A correction is carried in place of the response it replaces: one child per response, so this is a
  // chain, and the guard is only here so a hand-edited store cannot make it loop.
  const replaces = [];
  for (let step = 0; step < responses.length && correction.has(entry.feedback_id); step += 1) {
    replaces.push(entry.feedback_id);
    entry = correction.get(entry.feedback_id);
  }
  if (entry.withdrawn === true) {
    throw new UniverseError(
      'WITHDRAWN_FEEDBACK',
      `Response ${entry.feedback_id} was withdrawn by its reader${replaces.length > 0 ? `, and it is the correction that replaced ${replaces.join(', ')}` : ''}; a withdrawn response is not carried into a revision.`,
      409
    );
  }
  if (entry.accepted_source_version !== accepted) {
    throw new UniverseError(
      'STALE_REQUEST',
      `Response ${entry.feedback_id} was given against ${short(entry.accepted_source_version)} but the accepted version of this book is ${short(accepted)}; it stays evidence about the older text and is not carried into a revision of this one.`,
      409
    );
  }
  const comments = entry.comments ?? [];
  if (selection.comment_index !== null && selection.comment_index >= comments.length) {
    throw new UniverseError('BAD_SELECTION', `Response ${entry.feedback_id} carries ${comments.length} comment(s); there is no comment at ${selection.comment_index}.`, 400);
  }
  const commentOnly = selection.comment_index !== null;
  const reader = readers.get(entry.reader_id) ?? null;
  return {
    feedback_id: entry.feedback_id,
    selected: { feedback_id: selection.feedback_id, comment_index: selection.comment_index },
    replaces,
    corrected: replaces.length > 0,
    reader_id: entry.reader_id,
    reader_display_name: reader?.display_name ?? null,
    reader_kind: entry.reader_kind,
    attribution: ATTRIBUTION[entry.reader_kind] ?? 'unknown',
    target_id: entry.target_id,
    version: entry.accepted_source_version,
    scope: entry.scope ?? null,
    language: entry.language ?? null,
    questionnaire_version: entry.questionnaire_version ?? null,
    created_at: entry.created_at,
    // A comment selected on its own carries that comment and no rating: the caller asked for a comment,
    // not for the response it came from.
    answers: commentOnly ? [] : entry.answers ?? [],
    comments: commentOnly ? [comments[selection.comment_index]] : comments
  };
}

/** The instructions a rewrite receives: the readers' words, quoted, each with its version and provenance. */
function instructionsFor({ title, chapterNumber, version, items }) {
  const lines = [`Revise chapter ${chapterNumber} of "${title}" in response to what its readers said about ${version}.`];
  items.forEach((item, index) => {
    const origin = `${item.feedback_id}, given against ${item.version}, target ${item.target_id}${item.corrected ? `, a correction of ${item.replaces.join(', ')}` : ''}`;
    lines.push('', `${index + 1}. ${describedAs(item)} — ${origin}`);
    const rated = item.answers.map((answer) => `${answer.question_id} ${answer.value === null ? 'skipped' : `${answer.value} of 5`}`);
    if (rated.length > 0) lines.push(`   rated: ${rated.join('; ')}`);
    for (const comment of item.comments) {
      lines.push(`   wrote: "${comment.text}"`);
      for (const range of comment.evidence ?? []) {
        lines.push(`   quoting ${range.file} [${range.start}-${range.end}]: "${range.quote}"`);
      }
    }
  });
  return lines.join('\n');
}

/** One finding per carried response: it names the reader, the version and the words it rests on. */
function findingsFor(items) {
  return items.map((item) => {
    const rated = item.answers.filter((answer) => answer.value !== null).map((answer) => `${answer.question_id} ${answer.value} of 5`).join(', ');
    const words = item.comments.map((comment) => comment.text).join(' ');
    const head = `${describedAs(item)}${rated ? ` rated ${rated}` : ''} against ${short(item.version)}`;
    return {
      // The stable identifier of the evidence is the identifier of the response it came from.
      id: item.feedback_id,
      claim: fit(`${head}${words ? `: "${words}"` : ''}`, MAX_FINDING_CHARS),
      evidence: item.comments
        .slice(0, 3)
        .map((comment) => fit(comment.evidence?.[0]?.quote ?? comment.text, MAX_FINDING_CHARS))
    };
  });
}

/**
 * Turn a selection of stored feedback into a proposal for revising one chapter. The proposal carries the
 * items with the version each was given against, the scope they were read at, the identities with their
 * provenance, the readers' words as the instructions a rewrite receives, and the findings that name
 * them. `404 NOT_FOUND` for a book or a response that does not exist, `409 STALE_REQUEST` when the
 * feedback is about a version that is no longer accepted, `409 WITHDRAWN_FEEDBACK` for a withdrawn
 * response, and `400 BAD_SELECTION` when the selection is not one a revision can carry.
 */
export async function selectFeedbackForRevision({ universeId, selections, chapterNumber = null, note = null, preserve = [] }) {
  const meta = await readUniverseMeta(universeId);
  const wanted = normalizeSelections(selections);
  const why = note === null || note === undefined ? null : String(note).trim();
  if (why !== null && why.length > LIMITS.noteChars) {
    throw new UniverseError('BAD_SELECTION', `A note on a selection is at most ${LIMITS.noteChars} characters.`, 400);
  }
  const accepted = await currentVersion(universeId);
  if (accepted === null) {
    throw new UniverseError('UNSTABLE_VERSION', 'This book is being written right now; a revision is written against a stable accepted version.', 409);
  }
  const listing = await listFeedback(universeId);
  const responses = listing.feedback.filter((entry) => entry.request === 'response');
  const readers = new Map((await listFeedbackReaders(universeId)).map((reader) => [reader.reader_id, reader]));
  const items = [];
  const carried = new Map();
  for (const selection of wanted) {
    const item = resolveSelection({ selection, responses, readers, accepted });
    // A response named twice — directly and through the response it corrects — would be carried twice.
    if (carried.has(item.feedback_id)) {
      throw new UniverseError('BAD_SELECTION', `Response ${item.feedback_id} is selected twice (once as ${carried.get(item.feedback_id)}, once as ${selection.feedback_id}); it is carried once.`, 400);
    }
    carried.set(item.feedback_id, selection.feedback_id);
    items.push(item);
  }
  const chapters = [...new Set(items.flatMap((item) => item.scope?.chapters ?? []))].sort((a, b) => a - b);
  const kinds = new Set(items.map((item) => item.scope?.kind).filter(Boolean));
  const scope = { kind: kinds.has('book') ? 'book' : (kinds.size === 1 ? [...kinds][0] : 'chapter'), chapters };
  const named = chapterNumber === null || chapterNumber === undefined || chapterNumber === '' ? null : Number(chapterNumber);
  const number = Number.isInteger(named) && named > 0 ? named : (chapters.length === 1 ? chapters[0] : null);
  if (number === null) {
    throw new UniverseError('BAD_SELECTION', `A revision names the chapter it rewrites (\`chapterNumber\`); this selection was read against ${chapters.length === 0 ? 'the whole book' : `chapters ${chapters.join(', ')}`}.`, 400);
  }
  if (!(await acceptedChapters(universeId)).some((chapter) => chapter.number === number)) {
    throw new UniverseError('NOT_FOUND', `Chapter ${number} does not exist.`, 404);
  }
  const instructions = instructionsFor({ title: meta.title ?? universeId, chapterNumber: number, version: accepted, items });
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    throw new UniverseError(
      'BAD_SELECTION',
      `The selected feedback carries ${instructions.length} characters of a reader's words, more than the ${MAX_INSTRUCTIONS_CHARS} one revision can quote; select fewer responses, or name single comments with \`commentIndex\`. Nothing was cut short.`,
      400
    );
  }
  // The findings and the preserved qualities are validated by the same function the rewrite path uses,
  // so a proposal can never carry a request that function would refuse.
  const revision = normaliseRevision({ findings: findingsFor(items), preserve });
  return {
    schema_version: REVISION_PROPOSAL_SCHEMA,
    universe_id: universeId,
    version: accepted,
    historical: false,
    chapter_number: number,
    scope,
    note: why,
    created_at: nowIso(),
    selections: wanted,
    readers: Object.fromEntries(READER_KINDS.map((kind) => [kind, items.filter((item) => item.reader_kind === kind).length])),
    items,
    preserve: revision.preserve,
    findings: revision.findings,
    instructions
  };
}

/** A proposal of this module, with one version and a chapter to rewrite. */
function checkProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    throw new UniverseError('INVALID_PROPOSAL', 'A revision request carries the proposal it was approved from.', 400);
  }
  if (proposal.schema_version !== REVISION_PROPOSAL_SCHEMA) {
    throw new UniverseError('INVALID_PROPOSAL', `A revision proposal is a ${REVISION_PROPOSAL_SCHEMA} document.`, 400);
  }
  if (typeof proposal.version !== 'string' || proposal.version.length === 0 || !Number.isInteger(proposal.chapter_number)) {
    throw new UniverseError('INVALID_PROPOSAL', 'A proposal names the accepted version it is about and the chapter it rewrites.', 400);
  }
  if (!Array.isArray(proposal.items) || proposal.items.length === 0) {
    throw new UniverseError('INVALID_PROPOSAL', 'A proposal carries the feedback it was written from, and at least one item.', 400);
  }
  if (proposal.items.some((item) => item?.version !== proposal.version)) {
    throw new UniverseError('INVALID_PROPOSAL', 'Every item of a proposal names the version it was given against; all of them are the version the proposal is about.', 400);
  }
  return proposal;
}

/** The decision of §8.4, checked against the proposal it decides: approved, of that document, of that version. */
function checkApproval(proposal, approval) {
  if (!approval || typeof approval !== 'object' || approval.decision !== 'approved') {
    const decided = approval && typeof approval === 'object' ? approval.decision : null;
    throw new UniverseError(
      'NOT_APPROVED',
      decided === 'declined'
        ? 'This proposal was declined; a declined proposal is not carried into a revision and is not re-proposed.'
        : 'This proposal has no approval; a revision follows the decision of §8.4 on the proposal itself.',
      409
    );
  }
  if (approval.proposal_sha256 !== sha256(JSON.stringify(proposal, null, 2))) {
    throw new UniverseError('STALE_REQUEST', 'The proposal changed after it was decided: the approval names another document, so it is not applied.', 409);
  }
  if (approval.version !== proposal.version) {
    throw new UniverseError('STALE_REQUEST', `The approval was decided against ${short(approval.version)} while the proposal is about ${short(proposal.version)}; read the proposal again before revising.`, 409);
  }
}

/**
 * The rewrite request an approved proposal becomes: the instructions that quote the readers' words, the
 * findings that name the evidence, and the version the feedback was given against. `409 NOT_APPROVED`
 * for a proposal without an approved decision, and `409 STALE_REQUEST` when the proposal, the approval or
 * the accepted version of the book no longer agree with each other.
 */
export async function buildFeedbackRevisionRequest({ universeId, proposal, approval }) {
  const document = checkProposal(proposal);
  checkApproval(document, approval);
  const current = await currentVersion(universeId);
  if (current === null) {
    throw new UniverseError('UNSTABLE_VERSION', 'This book is being written right now; a revision is written against a stable accepted version.', 409);
  }
  if (current !== document.version) {
    throw new UniverseError(
      'STALE_REQUEST',
      `This feedback was given against ${short(document.version)} but the accepted version is ${short(current)}; it is evidence about the older text, and the revision it asked for is not applied to the newer one.`,
      409
    );
  }
  return {
    schema_version: REVISION_REQUEST_SCHEMA,
    universe_id: universeId,
    chapter_number: document.chapter_number,
    instructions: document.instructions,
    findings: document.findings,
    preserve: document.preserve,
    source_version: document.version,
    feedback_ids: document.items.map((item) => item.feedback_id),
    proposal: {
      schema_version: REVISION_PROPOSAL_SCHEMA,
      sha256: approval.proposal_sha256,
      note: document.note ?? null,
      created_at: document.created_at ?? null
    },
    approval: {
      path: approval.path ?? approval.proposal_path ?? null,
      proposal_sha256: approval.proposal_sha256,
      version: approval.version,
      decision: approval.decision,
      reviewer: approval.reviewer ?? null,
      decided_at: approval.decided_at ?? null
    }
  };
}

/**
 * Ask for the revision an approved proposal describes. The request is built here and performed by the
 * existing rewrite path (`jobs.startRewrite`, §8.4), which checks the chapter, the recorded ancestry
 * and the version the feedback was given against before anything is queued: a proposal written against
 * an older text is refused as stale instead of being reinterpreted against the newer one.
 */
export async function startFeedbackRevision({ universeId, proposal, approval, dropLater = false }) {
  const request = await buildFeedbackRevisionRequest({ universeId, proposal, approval });
  const job = await jobs.startRewrite({
    universeId,
    chapterNumber: request.chapter_number,
    instructions: request.instructions,
    dropLater: dropLater === true,
    findings: request.findings,
    preserve: request.preserve,
    sourceVersion: request.source_version
  });
  return { request, job };
}

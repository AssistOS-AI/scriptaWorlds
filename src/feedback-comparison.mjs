// The before-and-after comparison of one question between two accepted versions of one book, and the
// refusal that says why it cannot be stated (`docs/contracts.md` §8.7). The invariants:
//
//  - the rule that decides whether a comparison is supported is the summary's own rule, applied to the
//    summary's own numbers: at least three answered team responses for the question on each of the two
//    versions, current responses only (a withdrawn response or one a correction replaces is not
//    counted) and the three provenances never added to each other. The document reports the numbers
//    the summary reports for that question and version, so the two surfaces cannot disagree;
//  - a supported comparison shows the two distributions side by side, each with the version it belongs
//    to and the identities behind it, and states no ordering and no difference: the answers are ordinal
//    ratings given by different readers to different texts, which is the refusal the summary already
//    reports as `ORDINAL_RATINGS`;
//  - an unsupported comparison states no number at all: it answers with the summary's own reason and
//    the counts that would be needed, and nothing else;
//  - a version that is not a version of this book — another book's, or one the store keeps no evidence
//    of — is refused with a code of its own before any number is read;
//  - this module reads the store and writes nothing: no file of the book or of the feedback tree is
//    touched, and no number here is invented where the store cannot know one.
import { UniverseError } from './errors.mjs';
import { buildFeedbackExport } from './feedback-export.mjs';
import { READER_KINDS } from './feedback-readers.mjs';
import { MIN_ANSWERED_PER_VERSION, buildFeedbackSummary } from './feedback-summary.mjs';

export const COMPARISON_SCHEMA = 'reader-feedback-comparison.v1';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const short = (version) => (typeof version === 'string' && version.length > 18 ? `${version.slice(0, 18)}…` : String(version));
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** How many team readers answered this question on this version, the summary's own gate. */
const answeredTeam = (question, version) =>
  question.versions.find((entry) => entry.accepted_version === version)?.provenance.team_human.answered ?? 0;

/** The counts per provenance of the current responses of one version. */
const kindCounts = (responses) => Object.fromEntries(READER_KINDS.map((kind) => [kind, responses.filter((entry) => entry.reader_kind === kind).length]));

/** The versions of the book the store holds evidence of: the accepted one, and the ones it froze text or stored a response for. */
function knownVersions(dataset, accepted) {
  const versions = new Set();
  if (accepted !== null) versions.add(accepted);
  for (const target of dataset.targets) if (target.source_version) versions.add(target.source_version);
  for (const response of dataset.responses) if (response.accepted_source_version) versions.add(response.accepted_source_version);
  return versions;
}

/** The current responses of one version: the ones a comparison may count. */
const currentOf = (dataset, version) =>
  dataset.responses.filter((entry) => entry.withdrawn !== true && entry.superseded !== true && entry.accepted_source_version === version);

/** The identities behind one version, each with its provenance and what it answered this question. */
function identitiesOf(dataset, version, questionId) {
  const current = currentOf(dataset, version);
  const readers = [];
  const annotations = [];
  for (const readerId of [...new Set(current.map((entry) => entry.reader_id))].sort(byText)) {
    const mine = current.filter((entry) => entry.reader_id === readerId);
    const identity = dataset.readers.find((reader) => reader.reader_id === readerId) ?? null;
    const answered = mine.reduce(
      (total, entry) => total + entry.answers.filter((answer) => answer.question_id === questionId && answer.value !== null).length,
      0
    );
    const entry = {
      reader_id: readerId,
      display_name: identity?.display_name ?? null,
      responses: mine.length,
      answered
    };
    const kind = mine[0].reader_kind;
    // A model's annotation and a synthetic fixture are named with their own provenance and never
    // listed among the readers who said something.
    if (kind === 'team_human') readers.push(entry);
    else annotations.push({ ...entry, reader_kind: kind });
  }
  return { readers, annotations };
}

/** One side of the comparison: the version, its numbers per provenance, and the identities behind it. */
function sideOf({ role, version, dataset, question }) {
  const block = question.versions.find((entry) => entry.accepted_version === version) ?? null;
  return {
    role,
    accepted_version: version,
    historical: block?.historical ?? null,
    responses: kindCounts(currentOf(dataset, version)),
    provenance: block?.provenance ?? {},
    ...identitiesOf(dataset, version, question.question_id)
  };
}

/** The refusal of a comparison the counts do not support, in the words the summary already uses. */
function unsupported({ question, from, to, summary }) {
  const stated = summary.refusals.find((entry) => entry.claim === 'comparison' && entry.subject === question.question_id && entry.reason_code === 'MIN_ANSWERED_PER_VERSION');
  const listed = [
    `${answeredTeam(question, from)} against ${from}`,
    `${answeredTeam(question, to)} against ${to}`
  ].join(', ');
  const reason = stated?.reason
    ?? `comparison not stated: the question ${question.question_id} was answered by ${listed}; at least ${MIN_ANSWERED_PER_VERSION} answered team responses per version are needed before the two versions could be read side by side, so nothing is stated about them`;
  const error = new UniverseError('COMPARISON_NOT_SUPPORTED', reason, 409);
  // What is missing, never a number the responses do not support: the counts that would be needed, and
  // the reason code the summary itself uses for this refusal.
  error.details = {
    question_id: question.question_id,
    reason_code: 'MIN_ANSWERED_PER_VERSION',
    reason,
    min_answered_per_version: MIN_ANSWERED_PER_VERSION,
    answered: [
      { role: 'from', accepted_version: from, answered: answeredTeam(question, from) },
      { role: 'to', accepted_version: to, answered: answeredTeam(question, to) }
    ]
  };
  return error;
}

/**
 * The comparison of one question between two accepted versions of one book. `404 NOT_FOUND` for a book
 * that does not exist and `404 NO_FEEDBACK` for a book no reader has responded to yet, as the summary
 * answers; `400 BAD_COMPARISON` for a request that does not name one question and two different
 * versions; `409 COMPARISON_UNKNOWN_VERSION` when a named version is not a version of this book; and
 * `409 COMPARISON_NOT_SUPPORTED` — with the summary's reason, its counts and no number — when the
 * responses do not carry the comparison.
 */
export async function buildFeedbackComparison(universeId, { questionId = null, from = null, to = null } = {}) {
  const asked = String(questionId ?? '').trim();
  const first = String(from ?? '').trim();
  const second = String(to ?? '').trim();
  if (!asked || !first || !second) {
    throw new UniverseError('BAD_COMPARISON', 'A comparison names one question and two accepted versions of the same book (`question`, `from`, `to`).', 400);
  }
  if (first === second) {
    throw new UniverseError('BAD_COMPARISON', 'A comparison is between two different accepted versions; both sides of this one name the same version.', 400);
  }
  const summary = await buildFeedbackSummary(universeId);
  const question = summary.questions.find((entry) => entry.question_id === asked) ?? null;
  if (!question) {
    throw new UniverseError('BAD_COMPARISON', `No questionnaire of this book declares the question ${asked}.`, 400);
  }
  const dataset = await buildFeedbackExport(universeId);
  const known = knownVersions(dataset, summary.book.accepted_version);
  const unknown = [first, second].filter((version) => !known.has(version));
  if (unknown.length > 0) {
    const error = new UniverseError(
      'COMPARISON_UNKNOWN_VERSION',
      `${plural(unknown.length, 'named version')} (${unknown.map(short).join(', ')}) ${unknown.length === 1 ? 'is' : 'are'} not a version of this book: a comparison is between two accepted versions of the same book, and the store keeps no text or response of ${unknown.length === 1 ? 'that version' : 'those versions'}.`,
      409
    );
    error.details = {
      unknown_versions: unknown,
      known_versions: [...known].sort(byText),
      accepted_version: summary.book.accepted_version
    };
    throw error;
  }
  if ([first, second].some((version) => answeredTeam(question, version) < MIN_ANSWERED_PER_VERSION)) {
    throw unsupported({ question, from: first, to: second, summary });
  }
  const ordering = summary.refusals.find((entry) => entry.claim === 'comparison' && entry.subject === asked) ?? null;
  return {
    schema_version: COMPARISON_SCHEMA,
    universe_id: summary.universe_id,
    question: {
      question_id: question.question_id,
      label: question.label,
      low: question.low,
      high: question.high,
      options: question.options,
      declared_by: question.declared_by
    },
    basis: {
      rule: `at least ${MIN_ANSWERED_PER_VERSION} answered team responses for this question on each of the two accepted versions, current responses only (a withdrawn response or one a correction replaces is not counted), and the three provenances kept apart`,
      min_answered_per_version: MIN_ANSWERED_PER_VERSION,
      current_responses_only: true,
      provenance_separated: true,
      version_stable: summary.book.version_stable,
      answered: [
        { role: 'from', accepted_version: first, answered: answeredTeam(question, first) },
        { role: 'to', accepted_version: second, answered: answeredTeam(question, second) }
      ],
      note: summary.book.version_stable
        ? 'the two sides are the versions the caller named, in the order it named them; the store does not turn two content identities into a sequence, and no number here is added across them'
        : 'the accepted version of this book cannot be read right now (a turn is queued or running), so whether a side is historical is reported as null instead of guessed'
    },
    versions: [
      sideOf({ role: 'from', version: first, dataset, question }),
      sideOf({ role: 'to', version: second, dataset, question })
    ],
    // The ordering itself is never stated, and the difference is not a number: this is the refusal the
    // summary already reports for this question, carried with the two distributions it rests on.
    ordering: {
      stated: false,
      difference: null,
      reason_code: 'ORDINAL_RATINGS',
      reason: ordering?.reason
        ?? `no ordering is asserted: the question ${asked} is answered by ordinal ratings given by different readers to different texts, so the two versions are reported side by side and never subtracted from each other`
    }
  };
}

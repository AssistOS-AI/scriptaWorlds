// The before-and-after comparison of one question between two accepted versions of one book, and the
// refusal that says why it cannot be stated (`docs/contracts.md` §8.7). The invariants:
//
//  - the rule that decides whether a comparison is supported is the summary's own rule, applied to the
//    summary's own numbers: at least three independent team readers who answered the question on each
//    of the two versions, current answers only (a withdrawn response or one a correction replaces is
//    not counted) and the three provenances never added to each other. The document reports the numbers
//    the summary reports for that question and population, so the two surfaces cannot disagree;
//  - the two sides are read from comparable populations: the same scope, the same language and the same
//    questionnaire version on both versions. A chapter reading is never compared with a book reading
//    and a rating taken with another questionnaire scale is never put beside this one; when a version
//    holds several populations for the question the comparison names the pair it read and lists the
//    others, instead of adding them together;
//  - a supported comparison shows the two distributions side by side, each with the version and the
//    population it belongs to and the identities behind it, and states no ordering and no difference:
//    the answers are ordinal ratings given by different readers to different texts, which is the
//    refusal the summary already reports as `ORDINAL_RATINGS`;
//  - an unsupported comparison states no number at all: it answers with the summary's own reason and
//    the counts that would be needed, and nothing else;
//  - a version that is not a version of this book — another book's, or one the store keeps no evidence
//    of — is refused with a code of its own before any number is read;
//  - this module reads the store and writes nothing: no file of the book or of the feedback tree is
//    touched, and no number here is invented where the store cannot know one.
import { UniverseError } from './errors.mjs';
import { buildFeedbackExport } from './feedback-export.mjs';
import { READER_KINDS } from './feedback-readers.mjs';
import { COUNTING_SELECTION, COUNTING_UNIT, MIN_ANSWERED_PER_VERSION, buildFeedbackSummary } from './feedback-summary.mjs';

export const COMPARISON_SCHEMA = 'reader-feedback-comparison.v1';

/** The code of a comparison whose two versions hold no population read with the same questions. */
export const NO_COMPARABLE_POPULATION = 'NO_COMPARABLE_POPULATION';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bySubmission = (a, b) => String(a.created_at).localeCompare(String(b.created_at))
  || Number(a.revision ?? 1) - Number(b.revision ?? 1)
  || byText(a.feedback_id, b.feedback_id);
const short = (version) => (typeof version === 'string' && version.length > 18 ? `${version.slice(0, 18)}…` : String(version));
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The counts per provenance of a list of response records. */
const kindCounts = (responses) => Object.fromEntries(READER_KINDS.map((kind) => [kind, responses.filter((entry) => entry.reader_kind === kind).length]));

/** The answered readers of one population for one question, the gate this comparison rests on. */
const answeredOf = (population) => population?.provenance?.team_human?.answered ?? 0;

/** The versions of the book the store holds evidence of: the accepted one, and the ones it froze text or stored a response for. */
function knownVersions(dataset, accepted) {
  const versions = new Set();
  if (accepted !== null) versions.add(accepted);
  for (const target of dataset.targets) if (target.source_version) versions.add(target.source_version);
  for (const response of dataset.responses) if (response.accepted_source_version) versions.add(response.accepted_source_version);
  return versions;
}

/** Two populations are comparable when a reader of both saw the same chapters asked the same questions. */
const comparable = (left, right) => (left.scope?.kind ?? null) === (right.scope?.kind ?? null)
  && (left.scope?.chapters ?? []).join(',') === (right.scope?.chapters ?? []).join(',')
  && (left.language ?? null) === (right.language ?? null)
  && (left.questionnaire_version ?? null) === (right.questionnaire_version ?? null);

/** A population named without any number: what a refusal may say, and what a side states about itself. */
const referenceOf = (population) => ({
  population_id: population.population_id,
  label: population.label,
  accepted_version: population.accepted_version,
  scope: population.scope,
  language: population.language,
  questionnaire_version: population.questionnaire_version,
  target_ids: population.target_ids
});

/** The current responses of one population: the records a comparison may count. */
const currentOf = (dataset, current, population) => current.filter((entry) => population.target_ids.includes(entry.target_id));

/**
 * The identities behind one population, each with the provenance it was stored with and the answer of
 * this question the summary counts: the latest current answer of that reader inside the population.
 */
function identitiesOf({ dataset, current, population, questionId }) {
  const scoped = currentOf(dataset, current, population);
  const readers = [];
  const annotations = [];
  for (const readerId of [...new Set(scoped.map((entry) => entry.reader_id))].sort(byText)) {
    const mine = scoped.filter((entry) => entry.reader_id === readerId).sort(bySubmission);
    const identity = dataset.readers.find((reader) => reader.reader_id === readerId) ?? null;
    const said = mine.filter((entry) => entry.answers.some((answer) => answer.question_id === questionId));
    const answered = said.filter((entry) => {
      const answer = entry.answers.find((candidate) => candidate.question_id === questionId);
      return answer.value !== null;
    }).length;
    const latest = said.at(-1) ?? null;
    const counted = latest === null ? null : {
      feedback_id: latest.feedback_id,
      created_at: latest.created_at,
      value: latest.answers.find((answer) => answer.question_id === questionId).value ?? null
    };
    const entry = {
      reader_id: readerId,
      display_name: identity?.display_name ?? null,
      records: mine.length,
      answered,
      counted
    };
    const kind = mine[0].reader_kind;
    // A model's annotation and a synthetic fixture are named with their own provenance and never
    // listed among the readers who said something.
    if (kind === 'team_human') readers.push(entry);
    else annotations.push({ ...entry, reader_kind: kind });
  }
  return { readers, annotations };
}

/** One side of the comparison: the population it was read from, its numbers, and the identities behind it. */
function sideOf({ role, population, dataset, current, question }) {
  return {
    role,
    accepted_version: population.accepted_version,
    historical: population.historical ?? null,
    population: referenceOf(population),
    unit: COUNTING_UNIT,
    selection: COUNTING_SELECTION,
    records: kindCounts(currentOf(dataset, current, population)),
    provenance: population.provenance,
    ...identitiesOf({ dataset, current, population, questionId: question.question_id })
  };
}

/** The populations of one version that declare this question, in the order a reader should read them. */
function populationsOfVersion(question, version) {
  return question.populations.filter((population) => population.accepted_version === version);
}

/**
 * The pair of populations a comparison reads: one side from each version, read with the same scope, the
 * same language and the same questionnaire. When a version holds several such populations the book-wide
 * one is read, or the first in reading order, and the choice is stated rather than hidden in a sum.
 */
function pairOf(question, from, to) {
  const pairs = [];
  for (const left of populationsOfVersion(question, from)) {
    for (const right of populationsOfVersion(question, to)) {
      if (comparable(left, right)) pairs.push({ question, from: left, to: right });
    }
  }
  if (pairs.length === 0) return { pairs, chosen: null, others: [] };
  const book = pairs.filter((pair) => pair.from.scope?.kind === 'book');
  const chosen = book[0] ?? pairs[0];
  return { pairs, chosen, others: pairs.filter((pair) => pair !== chosen) };
}

/** The refusal of a comparison the counts do not support, with the summary's own words where it has them. */
function unsupported({ question, chosen, summary }) {
  const stated = summary.refusals.find((entry) => entry.claim === 'comparison' && entry.subject === question.question_id
    && entry.questionnaire_version === question.questionnaire_version
    && entry.reason_code === 'MIN_ANSWERED_PER_VERSION');
  const from = chosen.from.accepted_version;
  const to = chosen.to.accepted_version;
  const listed = [
    `${answeredOf(chosen.from)} against ${from}`,
    `${answeredOf(chosen.to)} against ${to}`
  ].join(', ');
  const reason = stated?.reason
    ?? `comparison not stated: the question ${question.question_id} was answered by ${listed}; at least ${MIN_ANSWERED_PER_VERSION} independent team readers per version are needed before the two versions could be read side by side, so nothing is stated about them`;
  const error = new UniverseError('COMPARISON_NOT_SUPPORTED', reason, 409);
  // What is missing, never a number the responses do not support: the counts that would be needed, and
  // the reason code the summary itself uses for this refusal.
  error.details = {
    question_id: question.question_id,
    questionnaire_version: question.questionnaire_version,
    reason_code: 'MIN_ANSWERED_PER_VERSION',
    reason,
    min_answered_per_version: MIN_ANSWERED_PER_VERSION,
    counted_unit: 'independent reader',
    answered: [
      { role: 'from', accepted_version: from, population_id: chosen.from.population_id, label: chosen.from.label, answered: answeredOf(chosen.from) },
      { role: 'to', accepted_version: to, population_id: chosen.to.population_id, label: chosen.to.label, answered: answeredOf(chosen.to) }
    ]
  };
  return error;
}

/** The refusal of a comparison whose two versions were not read with the same scope and questionnaire. */
function uncomparable({ question, questionnaires, from, to, first, second }) {
  const named = (populations) => {
    if (populations.length === 0) return 'nothing';
    return populations.map((population) => `${population.label} (${answeredOf(population)} independent team readers answered this question)`).join('; ');
  };
  const reason = `comparison not stated: no population of ${short(first)} and none of ${short(second)} were read with the same scope, the same language and the same questionnaire for the question ${question.question_id}, so the two sides would compare different texts or different scales; ${short(first)} holds ${named(from)} and ${short(second)} holds ${named(to)}`;
  const error = new UniverseError(NO_COMPARABLE_POPULATION, reason, 409);
  error.details = {
    question_id: question.question_id,
    questionnaire_versions: questionnaires,
    reason_code: NO_COMPARABLE_POPULATION,
    reason,
    compared_unit: 'population (scope, language and questionnaire version)',
    from: { accepted_version: first, populations: from.map(referenceOf) },
    to: { accepted_version: second, populations: to.map(referenceOf) }
  };
  return error;
}

/**
 * The comparison of one question between two accepted versions of one book. `404 NOT_FOUND` for a book
 * that does not exist and `404 NO_FEEDBACK` for a book no reader has responded to yet, as the summary
 * answers; `400 BAD_COMPARISON` for a request that does not name one question and two different
 * versions; `409 COMPARISON_UNKNOWN_VERSION` when a named version is not a version of this book;
 * `409 NO_COMPARABLE_POPULATION` when the two versions hold no population read with the same scope,
 * language and questionnaire; and `409 COMPARISON_NOT_SUPPORTED` — with the summary's reason, its
 * counts and no number — when the readers behind the comparable populations do not carry the
 * comparison.
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
  const rows = summary.questions.filter((entry) => entry.question_id === asked);
  if (rows.length === 0) {
    throw new UniverseError('BAD_COMPARISON', `No questionnaire of this book declares the question ${asked}.`, 400);
  }
  const dataset = await buildFeedbackExport(universeId);
  const current = dataset.responses.filter((entry) => entry.withdrawn !== true && entry.superseded !== true);
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
  const options = rows
    .map((question) => pairOf(question, first, second))
    .filter((entry) => entry.chosen !== null)
    .sort((a, b) => byText(b.question.questionnaire_version ?? '', a.question.questionnaire_version ?? ''));
  if (options.length === 0) {
    // Each side is named by the populations that declare this question at all, whatever questionnaire
    // they declare it with: that is what makes a scale mismatch visible instead of looking like a book
    // nobody read.
    const populationsFor = (version) => {
      const found = new Map();
      for (const row of rows) for (const population of populationsOfVersion(row, version)) found.set(population.population_id, population);
      return [...found.values()];
    };
    throw uncomparable({
      question: rows[0],
      questionnaires: rows.map((row) => row.questionnaire_version),
      from: populationsFor(first),
      to: populationsFor(second),
      first,
      second
    });
  }
  // The newest questionnaire that both versions carry for this question is the one read; an older
  // scale is never mixed into it, and the same question on two scales is never one comparison.
  const picked = options[0];
  const { chosen, others } = picked;
  const question = chosen.question;
  if (answeredOf(chosen.from) < MIN_ANSWERED_PER_VERSION || answeredOf(chosen.to) < MIN_ANSWERED_PER_VERSION) {
    throw unsupported({ question, chosen, summary });
  }
  const ordering = summary.refusals.find((entry) => entry.claim === 'comparison' && entry.subject === asked
    && entry.questionnaire_version === question.questionnaire_version) ?? null;
  const selection = others.length === 0
    ? `the question ${asked} is declared by questionnaire ${question.questionnaire_version}, and the two versions were read with one comparable population each (${chosen.from.label} and ${chosen.to.label}); that pair is compared`
    : `the question ${asked} is declared by questionnaire ${question.questionnaire_version}, and this version holds ${plural(options[0].pairs.length, 'comparable population pair')} for it; the pair read here is ${chosen.from.label} and ${chosen.to.label} (the book-wide reading when there is one), and the others are listed in \`other_populations\` instead of being added to it`;
  return {
    schema_version: COMPARISON_SCHEMA,
    universe_id: summary.universe_id,
    question: {
      question_id: question.question_id,
      label: question.label,
      low: question.low,
      high: question.high,
      options: question.options,
      declared_by: question.declared_by,
      questionnaire_version: question.questionnaire_version
    },
    unit: COUNTING_UNIT,
    selection: COUNTING_SELECTION,
    basis: {
      rule: `at least ${MIN_ANSWERED_PER_VERSION} independent team readers who answered this question on each of the two accepted versions, current answers only (a withdrawn response or one a correction replaces is not counted), the three provenances kept apart, and the two sides read from populations that share the scope, the language and the questionnaire version`,
      min_answered_per_version: MIN_ANSWERED_PER_VERSION,
      counted_unit: 'independent reader',
      current_responses_only: true,
      provenance_separated: true,
      comparable_populations: true,
      version_stable: summary.book.version_stable,
      selection,
      other_populations: others.map((pair) => ({
        from: referenceOf(pair.from),
        to: referenceOf(pair.to),
        answered: [answeredOf(pair.from), answeredOf(pair.to)]
      })),
      answered: [
        { role: 'from', accepted_version: first, population_id: chosen.from.population_id, label: chosen.from.label, answered: answeredOf(chosen.from) },
        { role: 'to', accepted_version: second, population_id: chosen.to.population_id, label: chosen.to.label, answered: answeredOf(chosen.to) }
      ],
      note: summary.book.version_stable
        ? 'the two sides are the versions the caller named, in the order it named them; the store does not turn two content identities into a sequence, and no number here is added across them'
        : 'the accepted version of this book cannot be read right now (a turn is queued or running), so whether a side is historical is reported as null instead of guessed'
    },
    versions: [
      sideOf({ role: 'from', population: chosen.from, dataset, current, question }),
      sideOf({ role: 'to', population: chosen.to, dataset, current, question })
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

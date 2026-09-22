// The honest summary of one book's reader feedback (`docs/contracts.md` §8.7). It is computed from the
// dataset of `./feedback-export.mjs` and changes nothing. The invariants:
//
//  - every number belongs to one accepted version and one provenance. The questions are answered per
//    version and per `reader_kind`, and no field adds two versions of the text, or a model's annotation
//    to what a reader said: a comparison that would need such a number is refused instead;
//  - the answers a summary counts are the current ones: a withdrawn response has no body left and a
//    response a correction replaces is not the reader's opinion any more, so both are reported apart
//    (`counts.withdrawn`, `counts.superseded`) and neither enters a distribution;
//  - the summary states facts — who answered what, what was skipped, what was left unmentioned, and
//    the whole distribution of every answer — and refuses the three claims this store cannot support
//    (a comparison between two versions, a trend, a statement about what the team thinks), each with
//    the reason it refuses and the counts that would be needed;
//  - where a number cannot be known it is replaced by the reason: a mean below three answered responses,
//    a reader who answered one question of five, a target that holds a single response;
//  - a mean is a reading of a distribution, never of one answer, and it is always reported beside the
//    distribution it summarizes.
import { buildFeedbackExport } from './feedback-export.mjs';
import { READER_KINDS } from './feedback-readers.mjs';

export const FEEDBACK_SUMMARY_SCHEMA = 'reader-feedback-summary.v1';

/** From this many answered responses on a mean is stated; below it one reader's taste is not a mean. */
export const MIN_ANSWERED_FOR_MEAN = 3;

/** The answered responses per version below which two versions are not comparable at all. */
export const MIN_ANSWERED_PER_VERSION = 3;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const historical = (version, accepted) => (accepted === null ? null : version !== accepted);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const answerCount = (entry) => entry.answers.filter((answer) => answer.value !== null).length;
const withAnswers = (entries) => entries.filter((entry) => answerCount(entry) > 0);
const kinds = (entries) => Object.fromEntries(READER_KINDS.map((kind) => [kind, entries.filter((entry) => entry.reader_kind === kind).length]));

/** The declared questions, newest declaration per identifier, so a label change is named and not hidden. */
function questionDeclarations(dataset) {
  const declarations = new Map();
  for (const questionnaire of [...dataset.questionnaires].sort((a, b) => byText(a.version, b.version))) {
    for (const question of questionnaire.questions ?? []) {
      declarations.set(question.id, { ...question, declared_by: questionnaire.version });
    }
  }
  return [...declarations.values()];
}

/** One question answered by one provenance: what was answered, skipped, left unmentioned, and how. */
function kindNumbers(responses, question) {
  const numbers = {};
  for (const kind of READER_KINDS) {
    const scoped = responses.filter((entry) => entry.reader_kind === kind);
    const values = [];
    let skipped = 0;
    let unmentioned = 0;
    for (const entry of scoped) {
      const answer = entry.answers.find((candidate) => candidate.question_id === question.id);
      if (!answer) unmentioned += 1;
      else if (answer.value === null) skipped += 1;
      else values.push(answer.value);
    }
    const distribution = {};
    for (const option of question.options ?? []) {
      distribution[String(option)] = values.filter((value) => value === option).length;
    }
    numbers[kind] = {
      responses: scoped.length,
      answered: values.length,
      skipped,
      not_mentioned: unmentioned,
      distribution,
      mean: values.length >= MIN_ANSWERED_FOR_MEAN
        ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100
        : null,
      mean_note: values.length >= MIN_ANSWERED_FOR_MEAN
        ? null
        : `not stated: ${plural(values.length, 'answered response')} to this question on this version; a mean is reported from ${MIN_ANSWERED_FOR_MEAN} answered responses on, so these answers are shown as their distribution only`
    };
  }
  return numbers;
}

/** The questions of the book, each answered per accepted version and per provenance, and never summed. */
function questionsOf(dataset, current) {
  const versions = [...new Set(current.map((entry) => entry.accepted_source_version))].sort(byText);
  return questionDeclarations(dataset).map((question) => ({
    question_id: question.id,
    label: question.label,
    low: question.low,
    high: question.high,
    options: question.options ?? [],
    declared_by: question.declared_by,
    versions: versions.map((version) => ({
      accepted_version: version,
      historical: historical(version, dataset.book.accepted_version),
      provenance: kindNumbers(current.filter((entry) => entry.accepted_source_version === version), question)
    }))
  }));
}

/** The book grouped by the accepted version its responses were written against. */
function versionsOf(dataset, current) {
  const distinct = (entries) => [...new Set(entries.map((entry) => entry.reader_id))]
    .map((readerId) => ({ reader_kind: entries.find((entry) => entry.reader_id === readerId).reader_kind }));
  return [...new Set(dataset.responses.map((entry) => entry.accepted_source_version))].sort(byText).map((version) => {
    const scoped = current.filter((entry) => entry.accepted_source_version === version);
    return {
      accepted_version: version,
      historical: historical(version, dataset.book.accepted_version),
      responses: kinds(scoped),
      answered: kinds(withAnswers(scoped)),
      readers: kinds(distinct(scoped)),
      withdrawn: kinds(dataset.responses.filter((entry) => entry.accepted_source_version === version && entry.withdrawn === true)),
      targets: dataset.targets.filter((target) => target.source_version === version).length
    };
  });
}

/** Who answered, what the summary counts for them, and what it does not know about their reading. */
function readersOf(dataset, current, questions) {
  return dataset.readers.map((reader) => {
    const responses = dataset.responses.filter((entry) => entry.reader_id === reader.reader_id);
    const counting = current.filter((entry) => entry.reader_id === reader.reader_id);
    const answered = counting.reduce((total, entry) => total + answerCount(entry), 0);
    const skipped = counting.reduce((total, entry) => total + entry.answers.filter((answer) => answer.value === null).length, 0);
    const latest = counting.at(-1) ?? null;
    const mentioned = latest === null ? 0 : latest.answers.length;
    return {
      reader_id: reader.reader_id,
      display_name: reader.display_name,
      kind: reader.kind,
      deleted_at: reader.deleted_at,
      responses: responses.length,
      counting: counting.length,
      answered,
      skipped,
      superseded: responses.filter((entry) => entry.superseded === true).length,
      withdrawn: responses.filter((entry) => entry.withdrawn === true).length,
      of: questions.length,
      note: counting.length > 0 && mentioned < questions.length
        ? `answered ${mentioned} of ${questions.length} questions of the last target; the rest are skipped or left unmentioned, never low`
        : null
    };
  });
}

/** One target and how many current responses it holds; a target with a single response says so. */
function targetsOf(dataset, current) {
  return dataset.targets.map((target) => {
    const scoped = current.filter((entry) => entry.target_id === target.target_id);
    return {
      target_id: target.target_id,
      scope: target.scope,
      accepted_version: target.source_version,
      historical: target.historical,
      responses: kinds(scoped),
      readers: new Set(scoped.map((entry) => entry.reader_id)).size,
      note: scoped.length === 1
        ? 'a single response is stored against this target: the summary reports it and reads nothing more from it'
        : null
    };
  });
}

/** What the summary refuses, and why, with the counts that would be needed to support the claim. */
function refusalsOf(dataset, current) {
  const answeredValues = (entry, questionId) => entry.answers.filter((answer) => answer.value !== null && answer.question_id === questionId).length;
  const team = current.filter((entry) => entry.reader_kind === 'team_human');
  const answeredTeam = withAnswers(team);
  const refusals = [];
  const versions = [...new Set(current.map((entry) => entry.accepted_source_version))].sort(byText);
  for (const question of questionDeclarations(dataset)) {
    const perVersion = versions
      .map((version) => ({
        version,
        answered: team.filter((entry) => entry.accepted_source_version === version)
          .reduce((total, entry) => total + answeredValues(entry, question.id), 0)
      }))
      .filter((entry) => entry.answered > 0);
    if (perVersion.length < 2) continue;
    const short = perVersion.filter((entry) => entry.answered < MIN_ANSWERED_PER_VERSION);
    const listed = perVersion.map((entry) => `${entry.answered} against ${entry.version}`).join(', ');
    refusals.push({
      claim: 'comparison',
      reason_code: short.length > 0 ? 'MIN_ANSWERED_PER_VERSION' : 'ORDINAL_RATINGS',
      subject: question.id,
      reason: short.length > 0
        ? `comparison not stated: the question ${question.id} was answered by ${listed}; at least ${MIN_ANSWERED_PER_VERSION} answered responses per version are needed before a difference could be read, so these answers are reported per version and never put side by side`
        : `comparison not stated: the question ${question.id} was answered by ${listed}, and the two versions are reported side by side; no ordering is asserted, because the answers are ordinal ratings given by different readers to different texts`
    });
  }
  if (answeredTeam.length > 0) {
    const readers = [...new Set(team.map((entry) => entry.reader_id))];
    const repeated = readers.filter((readerId) => new Set(team.filter((entry) => entry.reader_id === readerId).map((entry) => entry.accepted_source_version)).size > 1);
    refusals.push({
      claim: 'trend',
      reason_code: 'NEED_REPEATED_READINGS',
      subject: 'book',
      reason: `trend not stated: the store holds ${plural(answeredTeam.length, 'answered team response')} over ${plural(versions.length, 'accepted version')}, and ${plural(repeated.length, 'team reader')} answered more than one version; a direction would need the same readers rating the same question against successive versions of the same text, which is a reading this store does not take`
    });
    refusals.push({
      claim: 'population',
      reason_code: 'NON_RESPONDENTS_UNKNOWN',
      subject: 'book',
      reason: `no claim about the team is stated: ${plural(readers.length, 'team reader')} answered, and the store does not record who read the book and did not answer, so the summary reports what those responses say and nothing about what the team thinks`
    });
  }
  return refusals;
}

/** What the summary cannot know here, in the place of the numbers it would have to invent. */
function limitationsOf(dataset, current, questions) {
  const limitations = [];
  if (!dataset.book.version_stable) {
    limitations.push('the book is being written right now: the accepted version cannot be read, so whether a response or a target is historical is reported as null and no version can be named as the current one');
  }
  const withdrawn = dataset.responses.filter((entry) => entry.withdrawn === true);
  if (withdrawn.length > 0) {
    limitations.push(`${plural(withdrawn.length, 'withdrawn response')}: their answers are no longer visible and no distribution counts them`);
  }
  const superseded = dataset.responses.filter((entry) => entry.superseded === true);
  if (superseded.length > 0) {
    limitations.push(`${plural(superseded.length, 'superseded response')}: a correction replaces them, so they are listed with their answers and no distribution counts them twice`);
  }
  if (dataset.identity_deletions.length > 0) {
    limitations.push(`${plural(dataset.identity_deletions.length, 'identity deletion request')}: the identities stay listed and marked, and the responses they left are counted as they were read`);
  }
  const partial = current.filter((entry) => answerCount(entry) < questions.length);
  if (partial.length > 0) {
    limitations.push(`${partial.length} of ${plural(current.length, 'response')} answered fewer than all ${questions.length} questions; an unanswered question is skipped, never a low rating, and the per-question counts say how many`);
  }
  for (const target of dataset.targets) {
    if (current.filter((entry) => entry.target_id === target.target_id).length === 1) {
      limitations.push(`target ${target.target_id} holds a single response: the summary reports it and reads nothing more from that target`);
    }
  }
  if (current.length > 0 && withAnswers(current).length === 0) {
    limitations.push('no question was answered by anyone yet: every stored response skipped all of them, so there is no distribution to report');
  }
  return limitations;
}

/**
 * The summary of one book: how many readers answered, what each question received, how many answers
 * were skipped, the distribution of every answer per accepted version and per provenance, the refusals
 * with their reasons, and the places where a number cannot be known. `404 NOT_FOUND` for a book that
 * does not exist and `404 NO_FEEDBACK` for a book no reader has responded to yet.
 */
export async function buildFeedbackSummary(universeId) {
  const dataset = await buildFeedbackExport(universeId);
  const current = dataset.responses.filter((entry) => entry.withdrawn !== true && entry.superseded !== true);
  const questions = questionDeclarations(dataset);
  const distinct = (entries) => [...new Set(entries.map((entry) => entry.reader_id))]
    .map((readerId) => ({ reader_kind: entries.find((entry) => entry.reader_id === readerId).reader_kind }));
  return {
    schema_version: FEEDBACK_SUMMARY_SCHEMA,
    universe_id: dataset.universe_id,
    book: dataset.book,
    counts: {
      responses: dataset.counts.responses,
      active: dataset.counts.active,
      current: dataset.counts.current,
      answered: kinds(withAnswers(current)),
      withdrawn: dataset.counts.withdrawn,
      superseded: dataset.counts.superseded,
      readers: kinds(distinct(dataset.responses)),
      readers_answered: kinds(distinct(withAnswers(current))),
      identity_deletions: dataset.counts.records.identity_deletions,
      targets: dataset.counts.targets
    },
    versions: versionsOf(dataset, current),
    questions: questionsOf(dataset, current),
    readers: readersOf(dataset, current, questions),
    targets: targetsOf(dataset, current),
    refusals: refusalsOf(dataset, current),
    limitations: limitationsOf(dataset, current, questions)
  };
}

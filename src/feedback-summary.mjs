// The honest summary of one book's reader feedback (`docs/contracts.md` §8.7). It is computed from the
// dataset of `./feedback-export.mjs` and changes nothing. The invariants:
//
//  - every number belongs to one defensible population. A population is the accepted version, the scope
//    the reader was shown, the language and the questionnaire version taken together, so a chapter
//    rating is never added to a book rating and an answer given on a changed questionnaire scale is
//    never added to the answers of the old one. A version-level figure that pools several populations
//    is reported as such, with its unit and its selection named, instead of being presented as one
//    text's rating;
//  - the unit of a distribution is the independent reader, never the response record. For each question
//    one answer of each reader counts — the latest current one that mentions the question inside the
//    population — every submission before it is reported as history and a reader who submitted three
//    times is one reader and never three. `responses` is therefore a count of readers, `records` a
//    count of files, and the two are never confused;
//  - the answers a summary counts are the current ones: a withdrawn response has no body left and a
//    response a correction replaces is not the reader's opinion any more, so both are reported apart
//    (`counts.withdrawn`, `counts.superseded`) and neither enters a distribution;
//  - the questions are declared per questionnaire version. A questionnaire that changed a label or a
//    scale declares a question of its own, so two scales are never collapsed into one question row;
//  - the summary states facts — who answered what, what was skipped, what was left unmentioned, and the
//    whole distribution of every answer — and refuses the three claims this store cannot support (a
//    comparison between two versions, a trend, a statement about what the team thinks), each with the
//    reason it refuses and the counts that would be needed;
//  - where a number cannot be known it is replaced by the reason: a mean below three independent
//    readers, a reader who answered one question of five, a target that holds a single response;
//  - a mean is a reading of a distribution, never of one answer, and it is always reported beside the
//    distribution it summarizes.
import { createHash } from 'node:crypto';
import { buildFeedbackExport } from './feedback-export.mjs';
import { READER_KINDS } from './feedback-readers.mjs';

export const FEEDBACK_SUMMARY_SCHEMA = 'reader-feedback-summary.v1';

/** From this many independent readers on a mean is stated; below it one reader's taste is not a mean. */
export const MIN_ANSWERED_FOR_MEAN = 3;

/** The independent readers per version below which two versions are not comparable at all. */
export const MIN_ANSWERED_PER_VERSION = 3;

/** The unit of every distribution in this document: one independent identity, never one record. */
export const COUNTING_UNIT = 'reader';

/** The selection that turns response records into opinions: one latest current answer per reader. */
export const COUNTING_SELECTION = 'the latest current answer of each independent reader for a question counts once, taken inside one target and one questionnaire; the submissions before it stay in the history of the population and never become a second opinion';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bySubmission = (a, b) => String(a.created_at).localeCompare(String(b.created_at))
  || Number(a.revision ?? 1) - Number(b.revision ?? 1)
  || byText(a.feedback_id, b.feedback_id);
const short = (value) => (typeof value === 'string' && value.length > 18 ? `${value.slice(0, 18)}…` : String(value));
const historical = (version, accepted) => (accepted === null ? null : version !== accepted);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const answerCount = (entry) => entry.answers.filter((answer) => answer.value !== null).length;
const withAnswers = (entries) => entries.filter((entry) => answerCount(entry) > 0);
const kinds = (entries) => Object.fromEntries(READER_KINDS.map((kind) => [kind, entries.filter((entry) => entry.reader_kind === kind).length]));

/** The distinct identities behind a list of responses, each with the kind it was stored with. */
const identitiesOf = (entries) => [...new Set(entries.map((entry) => entry.reader_id))].sort(byText)
  .map((readerId) => ({ reader_id: readerId, reader_kind: entries.find((entry) => entry.reader_id === readerId).reader_kind }));

/** One answer of one response to one question, or `null` when the response never mentioned it. */
const mentionOf = (entry, questionId) => (entry.answers ?? []).find((answer) => answer.question_id === questionId) ?? null;

/**
 * The identity of one comparable text: the accepted version, the scope, the language and the
 * questionnaire version taken together. Two answers that disagree on any of the four were given to
 * different things, so they never share a distribution.
 */
const populationKey = (value) => [
  value.accepted_source_version ?? value.source_version ?? null,
  value.scope?.kind ?? null,
  (value.scope?.chapters ?? []).join(','),
  value.language ?? null,
  value.questionnaire_version ?? null
].join('|');

const populationId = (key) => `pop-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12)}`;

/** What a scope is, in words, so no figure is ever read as being about some other text. */
function scopeLabel(scope) {
  const chapters = scope?.chapters ?? [];
  const listed = chapters.length > 0 ? chapters.join(', ') : 'none';
  if (scope?.kind === 'book') return `the whole book (chapters ${listed})`;
  if (scope?.kind === 'arc') return `a declared arc (chapters ${listed})`;
  if (scope?.kind === 'chapter') return chapters.length === 1 ? `chapter ${listed}` : `chapters ${listed}`;
  return `an unnamed scope (chapters ${listed})`;
}

/** One population in words: what was read, in which language, with which questionnaire. */
const populationLabel = (population) => `${scopeLabel(population.scope)} of ${short(population.accepted_version)} in ${population.language ?? 'an unknown language'} with questionnaire ${population.questionnaire_version ?? 'an unknown questionnaire'}`;

/** The populations of one dataset: the comparable texts the store holds a target or a response for. */
function populationsOf(dataset) {
  const populations = new Map();
  const add = (key, fields) => {
    const found = populations.get(key);
    if (found) return found;
    const entry = { population_id: populationId(key), key, target_ids: [], ...fields };
    populations.set(key, entry);
    return entry;
  };
  for (const target of dataset.targets) {
    const entry = add(populationKey(target), {
      accepted_version: target.source_version ?? null,
      scope: target.scope ?? null,
      language: target.language ?? null,
      questionnaire_version: target.questionnaire_version ?? null,
      historical: target.historical ?? null
    });
    entry.target_ids.push(target.target_id);
  }
  for (const response of dataset.responses) {
    if (populations.has(populationKey(response))) continue;
    // A response whose target the dataset no longer carries still names the text it answered, so it
    // gets a population of its own rather than being pooled with a text it never saw.
    const entry = add(populationKey(response), {
      accepted_version: response.accepted_source_version ?? null,
      scope: response.scope ?? null,
      language: response.language ?? null,
      questionnaire_version: response.questionnaire_version ?? null,
      historical: response.historical ?? null
    });
    entry.target_ids.push(response.target_id);
  }
  for (const entry of populations.values()) {
    entry.target_ids = [...new Set(entry.target_ids)].sort(byText);
    entry.label = populationLabel(entry);
  }
  return [...populations.values()].sort((a, b) => byText(a.accepted_version ?? '', b.accepted_version ?? '') || byText(a.key, b.key));
}

/** The responses of one population, out of the responses a caller scoped for it. */
const recordsOf = (population, responses) => responses.filter((entry) => population.target_ids.includes(entry.target_id) || populationKey(entry) === population.key);

/** The declared questions, one row per questionnaire version, so a changed scale is never collapsed. */
function questionDeclarations(dataset) {
  const declarations = [];
  for (const questionnaire of [...dataset.questionnaires].sort((a, b) => byText(a.version, b.version))) {
    for (const question of questionnaire.questions ?? []) {
      declarations.push({ ...question, declared_by: questionnaire.version, questionnaire_version: questionnaire.version });
    }
  }
  return declarations;
}

/**
 * One question answered in one population by one provenance, counted in independent readers. For each
 * identity the counted answer is the latest current submission of that identity that mentions the
 * question; the submissions before it, and the ones that never mention it, are counted as history.
 */
function kindNumbers(records, question) {
  const numbers = {};
  for (const kind of READER_KINDS) {
    const scoped = records.filter((entry) => entry.reader_kind === kind);
    const readers = [...new Set(scoped.map((entry) => entry.reader_id))].sort(byText);
    const values = [];
    let skipped = 0;
    let unmentioned = 0;
    let earlierAnswers = 0;
    let unmentionedRecords = 0;
    let repeatedReaders = 0;
    for (const readerId of readers) {
      const mine = scoped.filter((entry) => entry.reader_id === readerId).sort(bySubmission);
      if (mine.length > 1) repeatedReaders += 1;
      unmentionedRecords += mine.filter((entry) => mentionOf(entry, question.id) === null).length;
      const said = mine.filter((entry) => mentionOf(entry, question.id) !== null);
      earlierAnswers += Math.max(0, said.length - 1);
      const latest = said.at(-1) ?? null;
      if (latest === null) {
        unmentioned += 1;
        continue;
      }
      if (mentionOf(latest, question.id).value === null) skipped += 1;
      else values.push(mentionOf(latest, question.id).value);
    }
    const distribution = {};
    for (const option of question.options ?? []) distribution[String(option)] = 0;
    let undeclared = 0;
    for (const value of values) {
      const key = String(value);
      if (!(key in distribution)) {
        // An answer outside the declared scale is evidence of a mismatched questionnaire, never a
        // number to hide: it is counted under its own value and reported in `undeclared`.
        distribution[key] = 0;
        undeclared += 1;
      }
      distribution[key] += 1;
    }
    const answered = values.length;
    numbers[kind] = {
      unit: COUNTING_UNIT,
      selection: COUNTING_SELECTION,
      readers: readers.length,
      responses: answered + skipped + unmentioned,
      answered,
      skipped,
      not_mentioned: unmentioned,
      records: scoped.length,
      earlier_answers: earlierAnswers,
      unmentioned_records: unmentionedRecords,
      repeated_readers: repeatedReaders,
      undeclared,
      distribution,
      mean: answered >= MIN_ANSWERED_FOR_MEAN
        ? Math.round((values.reduce((sum, value) => sum + value, 0) / answered) * 100) / 100
        : null,
      mean_note: answered >= MIN_ANSWERED_FOR_MEAN
        ? null
        : `not stated: ${plural(answered, 'independent reader')} answered this question in this population; a mean is reported from ${MIN_ANSWERED_FOR_MEAN} independent readers on, so these answers are shown as their distribution only`
    };
  }
  return numbers;
}

/** The questions of the book, each answered per population and never pooled with another scale. */
function questionsOf(dataset, current, populations) {
  return questionDeclarations(dataset).map((question) => {
    const mine = populations.filter((population) => population.questionnaire_version === question.questionnaire_version);
    const versions = [...new Set(mine.map((population) => population.accepted_version))].sort(byText);
    const provenance = (scoped) => kindNumbers(scoped, question);
    return {
      question_id: question.id,
      label: question.label,
      low: question.low,
      high: question.high,
      options: question.options ?? [],
      declared_by: question.declared_by,
      questionnaire_version: question.questionnaire_version,
      unit: COUNTING_UNIT,
      selection: COUNTING_SELECTION,
      populations: mine.map((population) => ({
        population_id: population.population_id,
        label: population.label,
        accepted_version: population.accepted_version,
        historical: population.historical,
        target_ids: population.target_ids,
        scope: population.scope,
        language: population.language,
        questionnaire_version: population.questionnaire_version,
        unit: COUNTING_UNIT,
        selection: COUNTING_SELECTION,
        provenance: provenance(recordsOf(population, current))
      })),
      versions: versions.map((version) => {
        const ofVersion = mine.filter((population) => population.accepted_version === version);
        const scoped = ofVersion.flatMap((population) => recordsOf(population, current));
        return {
          accepted_version: version,
          historical: historical(version, dataset.book.accepted_version),
          unit: COUNTING_UNIT,
          selection: COUNTING_SELECTION,
          // A figure that adds the ratings of several targets is marked, so a chapter rating is never
          // read as if it were a rating of the whole book.
          pooled_across_targets: ofVersion.length > 1,
          populations: ofVersion.map((population) => population.population_id),
          provenance: provenance(scoped)
        };
      })
    };
  });
}

/** The book grouped by the accepted version its responses were written against. */
function versionsOf(dataset, current, populations) {
  return [...new Set(dataset.responses.map((entry) => entry.accepted_source_version))].sort(byText).map((version) => {
    const scoped = current.filter((entry) => entry.accepted_source_version === version);
    const distinct = identitiesOf(scoped);
    const mine = populations.filter((population) => population.accepted_version === version);
    return {
      accepted_version: version,
      historical: historical(version, dataset.book.accepted_version),
      unit: COUNTING_UNIT,
      selection: COUNTING_SELECTION,
      pooled_across_targets: mine.length > 1,
      populations: mine.map((population) => population.population_id),
      targets: dataset.targets.filter((target) => target.source_version === version).length,
      responses: kinds(scoped),
      answered: kinds(withAnswers(scoped)),
      readers: kinds(distinct),
      repeated_readers: scoped.length - distinct.length,
      withdrawn: kinds(dataset.responses.filter((entry) => entry.accepted_source_version === version && entry.withdrawn === true))
    };
  });
}

/** Who answered, what the summary counts for them, and what it does not know about their reading. */
function readersOf(dataset, current, questions) {
  const declaredFor = (entry) => questions.filter((question) => question.questionnaire_version === entry.questionnaire_version).length;
  return dataset.readers.map((reader) => {
    const responses = dataset.responses.filter((entry) => entry.reader_id === reader.reader_id);
    const counting = current.filter((entry) => entry.reader_id === reader.reader_id);
    const answered = counting.reduce((total, entry) => total + answerCount(entry), 0);
    const skipped = counting.reduce((total, entry) => total + entry.answers.filter((answer) => answer.value === null).length, 0);
    const latest = counting.at(-1) ?? null;
    const mentioned = latest === null ? 0 : latest.answers.length;
    const declared = latest === null ? questions.length : declaredFor(latest);
    return {
      reader_id: reader.reader_id,
      display_name: reader.display_name,
      kind: reader.kind,
      deleted_at: reader.deleted_at,
      responses: responses.length,
      counting: counting.length,
      // One reader answering three times is still one reader: what counts is their submissions, never
      // a second opinion, and every question row of theirs says which answer was the counted one.
      independent: true,
      answered,
      skipped,
      superseded: responses.filter((entry) => entry.superseded === true).length,
      withdrawn: responses.filter((entry) => entry.withdrawn === true).length,
      of: declared,
      note: counting.length > 0 && mentioned < declared
        ? `answered ${mentioned} of ${declared} questions of the last target; the rest are skipped or left unmentioned, never low`
        : null
    };
  });
}

/** One target and how many independent readers it holds; a single response says so. */
function targetsOf(dataset, current, populations) {
  return dataset.targets.map((target) => {
    const scoped = current.filter((entry) => entry.target_id === target.target_id);
    const distinct = identitiesOf(scoped);
    const population = populations.find((entry) => entry.target_ids.includes(target.target_id)) ?? null;
    return {
      target_id: target.target_id,
      population_id: population?.population_id ?? null,
      scope: target.scope,
      accepted_version: target.source_version,
      historical: target.historical,
      language: target.language,
      questionnaire_version: target.questionnaire_version,
      unit: COUNTING_UNIT,
      selection: COUNTING_SELECTION,
      records: kinds(scoped),
      readers: distinct.length,
      repeated_readers: scoped.length - distinct.length,
      note: scoped.length === 1
        ? 'a single response is stored against this target: the summary reports it and reads nothing more from it'
        : null
    };
  });
}

/** What the summary refuses, and why, with the counts that would be needed to support the claim. */
function refusalsOf(dataset, current, questions, populations) {
  const refusals = [];
  for (const question of questions) {
    const answeredVersions = question.versions.filter((entry) => entry.provenance.team_human.answered > 0);
    if (answeredVersions.length < 2) continue;
    const listed = answeredVersions
      .map((entry) => `${entry.provenance.team_human.answered} against ${entry.accepted_version}${entry.pooled_across_targets ? ' (pooled across targets)' : ''}`)
      .join(', ');
    const short = answeredVersions.filter((entry) => entry.provenance.team_human.answered < MIN_ANSWERED_PER_VERSION);
    refusals.push({
      claim: 'comparison',
      reason_code: short.length > 0 ? 'MIN_ANSWERED_PER_VERSION' : 'ORDINAL_RATINGS',
      subject: question.question_id,
      questionnaire_version: question.questionnaire_version,
      reason: short.length > 0
        ? `comparison not stated: the question ${question.question_id} was answered by ${listed}; at least ${MIN_ANSWERED_PER_VERSION} independent team readers per version are needed before a difference could be read, so these answers are reported per population and never put side by side`
        : `comparison not stated: the question ${question.question_id} was answered by ${listed}, and the two versions are reported side by side; no ordering is asserted, because the answers are ordinal ratings given by different readers to different texts`,
      populations: answeredVersions.flatMap((entry) => entry.populations)
    });
  }
  const team = current.filter((entry) => entry.reader_kind === 'team_human');
  const answeredTeam = withAnswers(team);
  if (answeredTeam.length > 0) {
    const readers = [...new Set(team.map((entry) => entry.reader_id))];
    const versions = [...new Set(team.map((entry) => entry.accepted_source_version))].sort(byText);
    const repeated = readers.filter((readerId) => new Set(team.filter((entry) => entry.reader_id === readerId).map((entry) => entry.accepted_source_version)).size > 1);
    refusals.push({
      claim: 'trend',
      reason_code: 'NEED_REPEATED_READINGS',
      subject: 'book',
      reason: `trend not stated: the store holds ${plural(answeredTeam.length, 'answered team response')} from ${plural(readers.length, 'independent team reader')} over ${plural(versions.length, 'accepted version')}, and ${plural(repeated.length, 'team reader')} answered more than one version; a direction would need the same readers rating the same question against successive versions of the same text, which is a reading this store does not take`
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
function limitationsOf(dataset, current, questions, populations) {
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
  const pooled = [...new Set(populations.map((population) => population.accepted_version))]
    .filter((version) => populations.filter((population) => population.accepted_version === version).length > 1);
  if (pooled.length > 0) {
    limitations.push(`${plural(pooled.length, 'accepted version')} holds more than one population (a book rating, a chapter rating or two questionnaires); the figures of such a version are marked \`pooled_across_targets\` with their unit and their selection named, and a question is read from its own population instead`);
  }
  const declaredFor = (entry) => questions.filter((question) => question.questionnaire_version === entry.questionnaire_version).length;
  const answered = Math.max(0, ...current.map(declaredFor));
  const partial = current.filter((entry) => answerCount(entry) < declaredFor(entry));
  if (partial.length > 0) {
    limitations.push(`${partial.length} of ${plural(current.length, 'response')} answered fewer than all ${answered} questions; an unanswered question is skipped, never a low rating, and the per-question counts say how many`);
  }
  const repeated = populations.reduce((total, population) => total + (recordsOf(population, current).length - identitiesOf(recordsOf(population, current)).length), 0);
  if (repeated > 0) {
    limitations.push(`${plural(repeated, 'repeated submission')} of a reader to a question already answered in the same population: only the latest answer of each reader counts, and the earlier ones are reported as history instead of as a second opinion`);
  }
  const undeclared = questions.reduce((total, question) => total
    + question.versions.reduce((sum, entry) => sum + READER_KINDS.reduce((each, kind) => each + entry.provenance[kind].undeclared, 0), 0), 0);
  if (undeclared > 0) {
    limitations.push(`${plural(undeclared, 'answer')} outside the scale the questionnaire declares: they are counted under their own value in \`undeclared\` and are never folded into the declared options`);
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
 * The summary of one book: how many independent readers answered, what each question received inside
 * each defensible population, how many answers were skipped, the distribution of every answer per
 * accepted version and per provenance, the refusals with their reasons, and the places where a number
 * cannot be known. `404 NOT_FOUND` for a book that does not exist and `404 NO_FEEDBACK` for a book no
 * reader has responded to yet.
 */
export async function buildFeedbackSummary(universeId) {
  const dataset = await buildFeedbackExport(universeId);
  const current = dataset.responses.filter((entry) => entry.withdrawn !== true && entry.superseded !== true);
  const populations = populationsOf(dataset);
  const questions = questionsOf(dataset, current, populations);
  return {
    schema_version: FEEDBACK_SUMMARY_SCHEMA,
    universe_id: dataset.universe_id,
    book: dataset.book,
    unit: COUNTING_UNIT,
    selection: COUNTING_SELECTION,
    counts: {
      responses: dataset.counts.responses,
      active: dataset.counts.active,
      current: dataset.counts.current,
      answered: kinds(withAnswers(current)),
      withdrawn: dataset.counts.withdrawn,
      superseded: dataset.counts.superseded,
      readers: kinds(identitiesOf(dataset.responses)),
      readers_answered: kinds(identitiesOf(withAnswers(current))),
      populations: populations.length,
      identity_deletions: dataset.counts.records.identity_deletions,
      targets: dataset.counts.targets
    },
    populations: populations.map((population) => ({
      population_id: population.population_id,
      label: population.label,
      accepted_version: population.accepted_version,
      historical: population.historical,
      target_ids: population.target_ids,
      scope: population.scope,
      language: population.language,
      questionnaire_version: population.questionnaire_version,
      unit: COUNTING_UNIT,
      selection: COUNTING_SELECTION,
      records: kinds(recordsOf(population, dataset.responses)),
      current: kinds(recordsOf(population, current)),
      readers: kinds(identitiesOf(recordsOf(population, current)))
    })),
    versions: versionsOf(dataset, current, populations),
    questions: questionsOf(dataset, current, populations),
    readers: readersOf(dataset, current, questions),
    targets: targetsOf(dataset, current, populations),
    refusals: refusalsOf(dataset, current, questions, populations),
    limitations: limitationsOf(dataset, current, questions, populations)
  };
}

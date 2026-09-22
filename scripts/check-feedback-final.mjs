// The reader-feedback comparison and revision group of `scripts/check.mjs` (`docs/contracts.md` §8.7).
// It builds a book with two accepted versions, four team readers, a model annotation, a synthetic
// fixture, a correction and a withdrawal, and proves through the public functions and the routes:
//
//  - a comparison the responses support states the two distributions side by side, each with its
//    accepted version and the identities behind it, and describes no ordering and no difference; every
//    number adds up to the responses it claims, and the three provenances are never added together;
//  - a comparison the counts do not support answers with the summary's own reason and the counts that
//    would be needed, and states no distribution, no mean and no difference at all; a version of
//    another book, or one the store holds no evidence of, is refused with its own code;
//  - the gate of a comparison counts independent readers, not submissions: one team member who answered
//    the same question three times against one version is one reader and cannot stand in for three;
//  - the two sides are read from populations that share the scope, the language and the questionnaire
//    version, so a rating taken with a changed questionnaire scale is never put beside the old one: two
//    versions read with different questionnaires answer NO_COMPARABLE_POPULATION, naming the populations
//    each side holds, instead of comparing two scales;
//  - a selection of responses becomes a proposal that names the feedback, the version each item was
//    given against and the scope it was read at; a withdrawn response is refused, a correction is
//    carried in place of the response it replaces, and a model's annotation or a fixture is marked as
//    such and never counted as a reader;
//  - approving that proposal is the decision of §8.4 on the proposal itself, and the request it becomes
//    quotes the readers' words and names the evidence, bound to the version the feedback was about;
//  - with the book moved on, selecting that feedback, deciding it again and asking for the revision are
//    each refused as stale, nothing is queued, and neither the book nor the feedback tree changes;
//  - the two routes of the surface answer the same documents, and a reserved segment is never read as a
//    response identifier;
//  - a comparison session over two immutable targets records the display order it drew, the preference a
//    reader states between the two texts with its rationale and the conditions they read under, and it
//    counts what was recorded by place and by role while the ordinary distributions keep their counts:
//    one member of a team is enough to record an observation, and nothing here claims a measurement.
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { assessmentsRoot, currentVersion } from '../src/assessment-packet.mjs';
import { listApprovals, recordApproval } from '../src/assessments.mjs';
import { buildFeedbackComparison } from '../src/feedback-comparison.mjs';
import { comparisonsRoot, listComparisonSessions, readComparisonSession, recordComparisonPreference, startComparisonSession } from '../src/feedback-comparison-sessions.mjs';
import { listFeedback, submitFeedback, withdrawFeedback } from '../src/feedback-entries.mjs';
import { handleFeedbackRoutes } from '../src/feedback-routes.mjs';
import { buildFeedbackRevisionRequest, selectFeedbackForRevision, startFeedbackRevision } from '../src/feedback-revision.mjs';
import { createFeedbackReader } from '../src/feedback-readers.mjs';
import { MIN_ANSWERED_PER_VERSION, buildFeedbackSummary } from '../src/feedback-summary.mjs';
import { createFeedbackTarget, feedbackRoot, targetDir, targetTextDir } from '../src/feedback-targets.mjs';
import { jobs } from '../src/jobs.mjs';
import { universeDir } from '../src/paths.mjs';
import { writeAncestry } from '../src/universe-state.mjs';
import { bookWithTwoChapters, sha256Hex, turnRecord } from './check-fixtures.mjs';

const CHAPTERS = ['chapters/0001-one.md', 'chapters/0002-two.md'];
const REWRITTEN = '# One\n\nThe ledger was read again, and this time the district hummed a different note.\n\n';
const REWRITTEN_AGAIN = '# One\n\nThe ledger was read a third time, and the district answered with a note nobody had heard before.\n\n';
const ANA_WORDS = 'Read again: the rewrite keeps the voice, but the district is thin after the ledger.';
const CORINA_WORDS = 'The second chapter still carries the register.';
const MODEL_WORDS = 'A model annotation: the district is under-described.';

/** The content identity of a directory tree: what a feature that writes nothing must leave untouched. */
async function treeDigest(dir) {
  const found = await readdir(dir, { recursive: true }).catch(() => null);
  if (found === null) return 'absent';
  const lines = [];
  for (const entry of [...found].sort()) {
    const info = await stat(join(dir, entry)).catch(() => null);
    if (!info?.isFile()) continue;
    lines.push(`${entry}\t${info.size}\t${sha256Hex(await readFile(join(dir, entry)))}`);
  }
  return `${lines.length} file(s)\n${lines.join('\n')}`;
}

/** A response object the routes can write into, and a request that carries one JSON body. */
const capture = () => {
  const state = { status: null, headers: null, body: '' };
  return {
    state,
    res: {
      writeHead(status, headers) {
        state.status = status;
        state.headers = headers;
      },
      end(body) {
        state.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
      }
    }
  };
};

const requestWith = (method, body = null) => ({
  method,
  ...(body === null ? {} : { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8'); } })
});

export async function runFeedbackFinalChecks({ ok, fail, checkSeed = `check-${Date.now().toString(36)}`, tempDirs = [] }) {
  const universe = await bookWithTwoChapters(checkSeed, 'feedback-final');
  const other = await bookWithTwoChapters(checkSeed, 'feedback-final-other');
  tempDirs.push(universe.id, other.id);
  const bookFile = (path) => join(universeDir(universe.id), path);
  // A refusal carries its code, its message and what it says instead of a number, so the checks read all
  // three rather than only the code.
  const attempt = async (work) => {
    try {
      return await work();
    } catch (error) {
      return error;
    }
  };
  const codeOf = async (work) => {
    const outcome = await attempt(work);
    return outcome instanceof Error ? outcome.code ?? String(outcome.message) : 'accepted';
  };
  const turnFiles = async () => (await readdir(join(universeDir(universe.id), 'turns')).catch(() => [])).length;

  try {
    // The store: one target per accepted version, four team readers with a correction and a withdrawal,
    // a model annotation, a synthetic fixture and two questions answered on both sides.
    const version1 = await currentVersion(universe.id);
    const target1 = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } })).target;
    const ana = await createFeedbackReader({ universeId: universe.id, displayName: 'Ana' });
    const bogdan = await createFeedbackReader({ universeId: universe.id, displayName: 'Bogdan' });
    const corina = await createFeedbackReader({ universeId: universe.id, displayName: 'Corina' });
    const dana = await createFeedbackReader({ universeId: universe.id, displayName: 'Dana' });
    const model = await createFeedbackReader({ universeId: universe.id, displayName: 'Annotation model', kind: 'model' });
    const synthetic = await createFeedbackReader({ universeId: universe.id, displayName: 'Fixture pass', kind: 'synthetic' });
    const first = { universeId: universe.id, targetId: target1.target_id };
    await submitFeedback({
      ...first,
      feedbackId: 'fb-final-ana-first',
      readerId: ana.reader_id,
      answers: [{ question_id: 'interest', value: 5, comment: 'The ledger hook works.' }, { question_id: 'clarity', value: 4 }],
      comments: [{ text: 'The opening line does the work.', evidence: [{ file: CHAPTERS[0], start: 0, end: 60 }] }]
    });
    await submitFeedback({
      ...first,
      feedbackId: 'fb-final-ana-correction',
      readerId: ana.reader_id,
      revisionOf: 'fb-final-ana-first',
      answers: [{ question_id: 'interest', value: 4 }, { question_id: 'clarity', value: 4 }]
    });
    await submitFeedback({
      ...first,
      feedbackId: 'fb-final-bogdan',
      readerId: bogdan.reader_id,
      answers: [{ question_id: 'interest', value: 3 }, { question_id: 'clarity', value: 2 }],
      comments: [{ text: 'Firm but plain.', evidence: [{ file: CHAPTERS[1], start: 0, end: 40 }] }]
    });
    await submitFeedback({ ...first, feedbackId: 'fb-final-corina', readerId: corina.reader_id, answers: [{ question_id: 'interest', value: 2 }] });
    await submitFeedback({ ...first, feedbackId: 'fb-final-dana', readerId: dana.reader_id, answers: [{ question_id: 'interest', value: 1 }] });
    await withdrawFeedback({ universeId: universe.id, feedbackId: 'fb-final-dana' });
    for (const [id, reader, value] of [['fb-final-continue-ana', ana, 4], ['fb-final-continue-bogdan', bogdan, 3], ['fb-final-continue-corina', corina, 5]]) {
      await submitFeedback({ ...first, feedbackId: id, readerId: reader.reader_id, answers: [{ question_id: 'continue', value }] });
    }
    await submitFeedback({ ...first, feedbackId: 'fb-final-model', readerId: model.reader_id, answers: [{ question_id: 'interest', value: 1 }] });
    await submitFeedback({ ...first, feedbackId: 'fb-final-synthetic', readerId: synthetic.reader_id, answers: [{ question_id: 'interest', value: 5 }] });

    await writeFile(bookFile(CHAPTERS[0]), REWRITTEN, 'utf8');
    const version2 = await currentVersion(universe.id);
    const target2 = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } })).target;
    const second = { universeId: universe.id, targetId: target2.target_id };
    await submitFeedback({ ...second, feedbackId: 'fb-final-v2-ana-a', readerId: ana.reader_id, answers: [{ question_id: 'interest', value: 3 }, { question_id: 'clarity', value: 4 }] });
    await submitFeedback({
      ...second,
      feedbackId: 'fb-final-v2-ana-b',
      readerId: ana.reader_id,
      revisionOf: 'fb-final-v2-ana-a',
      answers: [{ question_id: 'interest', value: 4 }, { question_id: 'clarity', value: 4 }],
      comments: [{ text: ANA_WORDS, evidence: [{ file: CHAPTERS[0], start: 0, end: 40 }] }]
    });
    await submitFeedback({ ...second, feedbackId: 'fb-final-v2-bogdan', readerId: bogdan.reader_id, answers: [{ question_id: 'interest', value: 5 }] });
    await submitFeedback({
      ...second,
      feedbackId: 'fb-final-v2-corina',
      readerId: corina.reader_id,
      answers: [{ question_id: 'interest', value: 3 }],
      comments: [{ text: CORINA_WORDS, evidence: [{ file: CHAPTERS[1], start: 0, end: 40 }] }]
    });
    await submitFeedback({ ...second, feedbackId: 'fb-final-v2-dana', readerId: dana.reader_id, answers: [{ question_id: 'voice', value: 2 }] });
    await submitFeedback({
      ...second,
      feedbackId: 'fb-final-v2-model',
      readerId: model.reader_id,
      answers: [{ question_id: 'interest', value: 1 }],
      comments: [{ text: MODEL_WORDS, evidence: [{ file: CHAPTERS[0], start: 0, end: 40 }] }]
    });
    await submitFeedback({ ...second, feedbackId: 'fb-final-v2-synthetic', readerId: synthetic.reader_id, answers: [{ question_id: 'interest', value: 5 }] });
    await submitFeedback({ ...second, feedbackId: 'fb-final-v2-taken-back', readerId: corina.reader_id, answers: [{ question_id: 'continue', value: 5 }] });
    await withdrawFeedback({ universeId: universe.id, feedbackId: 'fb-final-v2-taken-back' });

    // Anything the feature writes must be outside these two trees: the book, and the feedback about it.
    const bookStore = await treeDigest(universeDir(universe.id));
    const feedbackStore = await treeDigest(feedbackRoot(universe.id));

    // 1. The supported comparison: two distributions, both versions named, the readers behind each.
    {
      const comparison = await buildFeedbackComparison(universe.id, { questionId: 'interest', from: version1, to: version2 });
      const side = (role) => comparison.versions.find((entry) => entry.role === role);
      const from = side('from');
      const to = side('to');
      const teamFrom = from.provenance.team_human;
      const teamTo = to.provenance.team_human;
      // Every number adds up to the responses it claims: a distribution is counted in independent
      // readers (answered + skipped + unmentioned), the record accounting of that provenance adds the
      // submissions it kept in history, the two never have to be equal, and the records of the three
      // provenances together are the records of the population.
      const addsUp = (group) =>
        ['team_human', 'model', 'synthetic'].every((kind) => {
          const numbers = group.provenance[kind];
          return numbers.responses === numbers.answered + numbers.skipped + numbers.not_mentioned
            && numbers.readers === numbers.responses
            && numbers.records === numbers.answered + numbers.skipped + numbers.earlier_answers + numbers.unmentioned_records
            && numbers.records >= numbers.responses;
        })
        && Object.values(group.provenance).reduce((total, numbers) => total + numbers.records, 0)
          === Object.values(group.records).reduce((total, count) => total + count, 0);
      const readers = (group) => group.readers.map((entry) => entry.display_name).sort().join(', ');
      const annotated = (group) => group.annotations.map((entry) => `${entry.display_name}:${entry.reader_kind}`).sort().join(', ');
      const noDifference = comparison.ordering.stated === false && comparison.ordering.difference === null
        && comparison.ordering.reason_code === 'ORDINAL_RATINGS' && comparison.ordering.reason.includes('interest');
      if (comparison.schema_version === 'reader-feedback-comparison.v1' && comparison.universe_id === universe.id
        && comparison.question.question_id === 'interest' && comparison.question.options.join(',') === '1,2,3,4,5'
        && from.accepted_version === version1 && from.historical === true
        && to.accepted_version === version2 && to.historical === false
        && teamFrom.responses === 3 && teamFrom.answered === 3 && teamFrom.skipped === 0 && teamFrom.not_mentioned === 0
        && teamFrom.records === 6 && teamFrom.readers === 3
        && JSON.stringify(teamFrom.distribution) === JSON.stringify({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 0 }) && teamFrom.mean === 3
        && teamTo.responses === 4 && teamTo.answered === 3 && teamTo.skipped === 0 && teamTo.not_mentioned === 1
        && teamTo.records === 4 && teamTo.readers === 4
        && JSON.stringify(teamTo.distribution) === JSON.stringify({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 }) && teamTo.mean === 4
        && from.records.team_human === 6 && to.records.team_human === 4
        && from.population.scope.kind === 'book' && from.population.accepted_version === version1
        && to.population.accepted_version === version2 && comparison.basis.counted_unit === 'independent reader'
        && comparison.basis.comparable_populations === true && comparison.basis.selection.includes('one comparable population each')
        && comparison.basis.other_populations.length === 0
        && readers(from) === 'Ana, Bogdan, Corina' && readers(to) === 'Ana, Bogdan, Corina, Dana'
        && annotated(from) === 'Annotation model:model, Fixture pass:synthetic'
        && from.provenance.model.answered === 1 && from.provenance.model.mean === null && from.provenance.model.distribution['1'] === 1
        && to.provenance.synthetic.answered === 1 && to.annotations.every((entry) => entry.reader_kind !== 'team_human')
        && comparison.basis.min_answered_per_version === MIN_ANSWERED_PER_VERSION && comparison.basis.current_responses_only === true
        && comparison.basis.provenance_separated === true && comparison.basis.answered[0].answered === 3 && comparison.basis.answered[1].answered === 3
        && addsUp(from) && addsUp(to) && noDifference) {
        ok(`feedback comparison: interest is compared between the two accepted versions with both distributions side by side (${teamFrom.answered} answered on the older text, mean ${teamFrom.mean}; ${teamTo.answered} on the newer, mean ${teamTo.mean}), the readers behind each version are named (${readers(from)}; ${readers(to)}), the model's annotation is reported apart from them, every number adds up to the responses it claims, and no ordering and no difference is stated`);
      } else {
        fail(`feedback comparison/supported: versions=${from?.accepted_version?.slice(0, 14)}/${to?.accepted_version?.slice(0, 14)}, from=${JSON.stringify(teamFrom)}, to=${JSON.stringify(teamTo)}, readers=${readers(from)}|${readers(to)}, annotations=${annotated(from)}, ordering=${JSON.stringify(comparison.ordering)}, basis=${JSON.stringify(comparison.basis)}, addsUp=${addsUp(from)}/${addsUp(to)}`);
      }
    }

    // 2. A comparison the responses do not support: the summary's own reason, and no number at all.
    {
      const summary = await buildFeedbackSummary(universe.id);
      const stated = summary.refusals.find((entry) => entry.claim === 'comparison' && entry.subject === 'clarity');
      const unsupported = await attempt(() => buildFeedbackComparison(universe.id, { questionId: 'clarity', from: version1, to: version2 }));
      const composed = await attempt(() => buildFeedbackComparison(universe.id, { questionId: 'continue', from: version1, to: version2 }));
      const missing = `sha256:${'0'.repeat(64)}`;
      const unknown = await attempt(() => buildFeedbackComparison(universe.id, { questionId: 'interest', from: version1, to: missing }));
      // Another book of the same shape: its own accepted version, which is not a version of this one.
      await writeFile(join(universeDir(other.id), CHAPTERS[0]), '# One\n\nA different book entirely, with a different accepted version.\n\n', 'utf8');
      const otherVersion = await currentVersion(other.id);
      const acrossBooks = await attempt(() => buildFeedbackComparison(universe.id, { questionId: 'interest', from: version1, to: otherVersion }));
      const same = await codeOf(() => buildFeedbackComparison(universe.id, { questionId: 'interest', from: version1, to: version1 }));
      const unanswered = await codeOf(() => buildFeedbackComparison(universe.id, { questionId: 'emotion', from: version1, to: version2 }));
      const nonsense = await codeOf(() => buildFeedbackComparison(universe.id, { questionId: 'no-such-question', from: version1, to: version2 }));
      const details = unsupported?.details ?? {};
      const numbers = JSON.stringify(details);
      const noNumbers = typeof details.distribution === 'undefined' && typeof details.mean === 'undefined'
        && !numbers.includes('"distribution"') && !numbers.includes('"mean"') && !numbers.includes('"difference"');
      if (unsupported?.code === 'COMPARISON_NOT_SUPPORTED' && details.reason_code === 'MIN_ANSWERED_PER_VERSION'
        && details.reason === stated?.reason && unsupported.message === stated?.reason
        && details.min_answered_per_version === MIN_ANSWERED_PER_VERSION
        && details.answered[0].answered === 2 && details.answered[1].answered === 1 && noNumbers
        && composed?.code === 'COMPARISON_NOT_SUPPORTED' && composed.details.reason.includes(`3 against ${version1}`)
        && composed.details.reason.includes(`0 against ${version2}`) && composed.details.reason.includes(' independent team readers per version')
        && composed.details.counted_unit === 'independent reader' && composed.details.answered.length === 2
        && unknown?.code === 'COMPARISON_UNKNOWN_VERSION' && unknown.details.unknown_versions.join(',') === missing
        && acrossBooks?.code === 'COMPARISON_UNKNOWN_VERSION' && acrossBooks.details.unknown_versions.join(',') === otherVersion
        && same === 'BAD_COMPARISON' && nonsense === 'BAD_COMPARISON' && unanswered === 'COMPARISON_NOT_SUPPORTED') {
        ok(`feedback comparison: clarity (${details.answered[0].answered} and ${details.answered[1].answered} answered readers) is refused with the summary's own reason (${details.reason_code}, ${storedLabel(stated)}), continue (3 against one version and 0 against the other) with a reason that names both counts, a version no book holds and another book's version with COMPARISON_UNKNOWN_VERSION, and a malformed request with BAD_COMPARISON — and no refusal carries a distribution, a mean or a difference`);
      } else {
        fail(`feedback comparison/refused: unsupported=${unsupported?.code}/${details.reason_code}/summary=${unsupported?.details?.reason === stated?.reason}/${details.answered ? JSON.stringify(details.answered) : 'none'}/numbers=${noNumbers}, composed=${composed?.code}/${composed?.details?.reason}, unknown=${unknown?.code}/${JSON.stringify(unknown?.details?.unknown_versions)}, acrossBooks=${acrossBooks?.code}, same=${same}, nonsense=${nonsense}, unanswered=${unanswered}`);
      }
    }

    // 3. Selecting feedback becomes a proposal: the version, the scope, the readers' words, and the
    // provenance of each identity, with the correction carried in place of what it replaces.
    const selections = ['fb-final-v2-ana-a', { feedbackId: 'fb-final-v2-corina', commentIndex: 0 }, 'fb-final-v2-model', 'fb-final-v2-synthetic'];
    const proposal = await selectFeedbackForRevision({
      universeId: universe.id,
      selections,
      chapterNumber: 1,
      note: 'The revision the second reading asked for.',
      preserve: ['the flat voice of the keeper']
    });
    {
      const item = (id) => proposal.items.find((entry) => entry.feedback_id === id);
      const anaItem = item('fb-final-v2-ana-b');
      const corinaItem = item('fb-final-v2-corina');
      const modelItem = item('fb-final-v2-model');
      const fixtureItem = item('fb-final-v2-synthetic');
      const withdrawn = await attempt(() => selectFeedbackForRevision({ universeId: universe.id, selections: ['fb-final-v2-taken-back'], chapterNumber: 1 }));
      const unknownResponse = await codeOf(() => selectFeedbackForRevision({ universeId: universe.id, selections: ['fb-final-nothing-here'], chapterNumber: 1 }));
      const tooMany = await codeOf(() => selectFeedbackForRevision({ universeId: universe.id, selections: selections.concat(selections).concat(selections), chapterNumber: 1 }));
      const badComment = await codeOf(() => selectFeedbackForRevision({ universeId: universe.id, selections: [{ feedbackId: 'fb-final-v2-corina', commentIndex: 7 }], chapterNumber: 1 }));
      const noChapter = await codeOf(() => selectFeedbackForRevision({ universeId: universe.id, selections: ['fb-final-v2-corina'] }));
      const noSuchChapter = await codeOf(() => selectFeedbackForRevision({ universeId: universe.id, selections: ['fb-final-v2-corina'], chapterNumber: 99 }));
      const twice = await codeOf(() => selectFeedbackForRevision({ universeId: universe.id, selections: ['fb-final-v2-ana-a', 'fb-final-v2-ana-b'], chapterNumber: 1 }));
      const quoted = (text) => proposal.instructions.includes(`"${text}"`);
      const untouched = (await treeDigest(universeDir(universe.id))) === bookStore && (await treeDigest(feedbackRoot(universe.id))) === feedbackStore;
      if (proposal.schema_version === 'reader-feedback-revision-proposal.v1' && proposal.universe_id === universe.id
        && proposal.version === version2 && proposal.historical === false && proposal.chapter_number === 1
        && proposal.scope.kind === 'book' && proposal.scope.chapters.join(',') === '1,2'
        && proposal.note === 'The revision the second reading asked for.' && proposal.selections.length === 4
        && proposal.items.length === 4 && JSON.stringify(proposal.readers) === JSON.stringify({ team_human: 2, model: 1, synthetic: 1 })
        && anaItem.selected.feedback_id === 'fb-final-v2-ana-a' && anaItem.replaces.join(',') === 'fb-final-v2-ana-a'
        && anaItem.corrected === true && anaItem.version === version2 && anaItem.attribution === 'reader' && anaItem.reader_display_name === 'Ana'
        && corinaItem.selected.comment_index === 0 && corinaItem.comments.length === 1 && corinaItem.answers.length === 0
        && modelItem.reader_kind === 'model' && modelItem.attribution === 'annotation'
        && fixtureItem.reader_kind === 'synthetic' && fixtureItem.attribution === 'fixture'
        && quoted(ANA_WORDS) && quoted(CORINA_WORDS) && quoted(MODEL_WORDS)
        && proposal.instructions.includes('an annotation by a model (not a reader)') && proposal.instructions.includes('a synthetic fixture (not a reader)')
        && proposal.instructions.includes(version2) && proposal.instructions.includes('given against')
        && proposal.preserve.join(',') === 'the flat voice of the keeper'
        && proposal.findings.length === 4 && proposal.findings.map((entry) => entry.id).join(',') === 'fb-final-v2-ana-b,fb-final-v2-corina,fb-final-v2-model,fb-final-v2-synthetic'
        && proposal.findings[0].claim.includes('Ana') && proposal.findings[0].claim.includes(version2.slice(0, 18))
        && withdrawn?.code === 'WITHDRAWN_FEEDBACK' && unknownResponse === 'NOT_FOUND' && tooMany === 'BAD_SELECTION'
        && badComment === 'BAD_SELECTION' && noChapter === 'BAD_SELECTION' && noSuchChapter === 'NOT_FOUND' && twice === 'BAD_SELECTION'
        && untouched) {
        ok(`feedback revision: the selection becomes a proposal on ${version2.slice(0, 18)}… for chapter 1 of a book-wide reading, quoting the readers' words verbatim (${ANA_WORDS.length + CORINA_WORDS.length + MODEL_WORDS.length} characters of them) with the correction carried in place of ${anaItem.replaces.join(', ')} and the model's annotation and the fixture marked as such, refusing a withdrawn response and carrying no reader kind as a reader; the book and the feedback tree are byte-identical afterwards`);
      } else {
        fail(`feedback revision/proposal: version=${proposal.version?.slice(0, 14)}/${version2.slice(0, 14)}, chapter=${proposal.chapter_number}, scope=${JSON.stringify(proposal.scope)}, readers=${JSON.stringify(proposal.readers)}, items=${JSON.stringify(proposal.items.map((entry) => [entry.feedback_id, entry.replaces, entry.reader_kind, entry.attribution, entry.comments.length, entry.answers.length]))}, quoted=${quoted(ANA_WORDS)}/${quoted(CORINA_WORDS)}/${quoted(MODEL_WORDS)}, preserve=${JSON.stringify(proposal.preserve)}, findings=${JSON.stringify(proposal.findings.map((entry) => entry.id))}, refused=${withdrawn?.code}/${unknownResponse}/${tooMany}/${badComment}/${noChapter}/${noSuchChapter}/${twice}, untouched=${untouched}`);
      }
    }

    // 4. Approving the proposal is the decision of §8.4, and the request it becomes is bound to the
    // version the feedback was about.
    let approval = null;
    let request = null;
    {
      approval = await recordApproval({
        universeId: universe.id,
        proposal,
        decision: 'approved',
        reviewer: 'Mircea',
        directions: ['Keep the ledger voice.'],
        version: proposal.version
      });
      request = await buildFeedbackRevisionRequest({ universeId: universe.id, proposal, approval });
      const approvals = await listApprovals(universe.id);
      const decided = await codeOf(() => buildFeedbackRevisionRequest({ universeId: universe.id, proposal, approval: { ...approval, decision: 'declined' } }));
      const undecided = await codeOf(() => buildFeedbackRevisionRequest({ universeId: universe.id, proposal, approval: null }));
      const changed = await codeOf(() => buildFeedbackRevisionRequest({ universeId: universe.id, proposal: { ...proposal, note: 'A different proposal entirely.' }, approval }));
      const unaffected = await buildFeedbackRevisionRequest({ universeId: universe.id, proposal, approval: { ...approval, reviewer: 'Someone else' } });
      const approvedFile = join(assessmentsRoot(), approval.path);
      const onDisk = await readFile(approvedFile, 'utf8').then((raw) => JSON.parse(raw), () => null);
      const untouched = (await treeDigest(universeDir(universe.id))) === bookStore && (await treeDigest(feedbackRoot(universe.id))) === feedbackStore;
      if (approval.schema_version === 'approval.v1' && approval.decision === 'approved' && approval.version === version2
        && approval.proposal_sha256 === sha256Hex(JSON.stringify(proposal, null, 2)) && approval.reviewer === 'Mircea'
        && approval.path.startsWith(`${universe.id}/sha256-${version2.replace(/^sha256:/, '')}/approvals/`)
        && !approvedFile.startsWith(universeDir(universe.id)) && onDisk?.proposal_sha256 === approval.proposal_sha256
        && approvals.some((entry) => entry.proposal_sha256 === approval.proposal_sha256)
        && request.schema_version === 'reader-feedback-revision.v1' && request.chapter_number === 1 && request.source_version === version2
        && request.feedback_ids.join(',') === proposal.findings.map((entry) => entry.id).join(',')
        && request.instructions === proposal.instructions && request.preserve.join(',') === 'the flat voice of the keeper'
        && request.instructions.includes(`"${ANA_WORDS}"`) && request.instructions.includes(`"${CORINA_WORDS}"`)
        && request.findings.map((entry) => entry.id).join(',') === request.feedback_ids.join(',')
        && request.findings[0].claim.includes(ANA_WORDS.slice(0, 40)) && request.approval.proposal_sha256 === approval.proposal_sha256
        && request.approval.version === version2 && request.proposal.sha256 === approval.proposal_sha256
        && decided === 'NOT_APPROVED' && undecided === 'NOT_APPROVED' && changed === 'STALE_REQUEST'
        && unaffected.source_version === version2 && untouched) {
        ok(`feedback revision: approving the proposal records the §8.4 decision outside the book (${approval.path}), and the request it becomes is bound to ${version2.slice(0, 18)}… — its instructions quote the readers' words, its findings name the same evidence, a declined or missing decision is NOT_APPROVED and a proposal changed after the decision is STALE_REQUEST, with the book and the feedback tree byte-identical`);
      } else {
        fail(`feedback revision/approval: approval=${JSON.stringify({ schema: approval.schema_version, decision: approval.decision, version: approval.version?.slice(0, 14), sha: approval.proposal_sha256 === sha256Hex(JSON.stringify(proposal, null, 2)), path: approval.path, onDisk: onDisk?.proposal_sha256 })}), listed=${approvals.length}, request=${JSON.stringify({ schema: request.schema_version, chapter: request.chapter_number, source: request.source_version?.slice(0, 14), ids: request.feedback_ids, quotes: request.instructions.includes(`"${ANA_WORDS}"`), findings: request.findings.map((entry) => entry.id) })}, refused=${decided}/${undecided}/${changed}, untouched=${untouched}`);
      }
    }

    // 5. The routes of the surface answer the same documents, and a reserved segment is never a response.
    {
      const body = (state) => {
        try {
          return JSON.parse(state.body);
        } catch {
          return null;
        }
      };
      // One call per route, with the request and the response the handler expects.
      const call = async (method, sub, extra, requestBody = null, query = '') => {
        const out = capture();
        const handled = await handleFeedbackRoutes({
          req: requestWith(method, requestBody),
          res: out.res,
          segments: ['api', 'universes', universe.id, sub, ...(extra === undefined ? [] : [extra])],
          id: universe.id,
          sub,
          extra,
          url: new URL(`http://localhost/api/universes/${universe.id}/${sub}${extra === undefined ? '' : `/${extra}`}${query}`)
        });
        return { handled, state: out.state, body: body(out.state) };
      };
      const listing = await listFeedback(universe.id);
      const compared = await call('GET', 'feedback', 'comparison', null, `?question=interest&from=${version1}&to=${version2}`);
      const proposed = await call('POST', 'feedback', 'revisions', { selections, chapterNumber: 2, note: 'Through the route.' });
      const reserved = await codeOf(() => call('GET', 'feedback', 'revisions'));
      const roster = await call('GET', 'readers', undefined);
      const responses = await call('GET', 'feedback', undefined);
      const elsewhere = await call('GET', 'chapters', undefined);
      const untouched = (await treeDigest(universeDir(universe.id))) === bookStore
        && (await treeDigest(feedbackRoot(universe.id))) === feedbackStore && listing.feedback.length === 18;
      if (compared.handled === true && compared.state.status === 200 && compared.body?.comparison?.schema_version === 'reader-feedback-comparison.v1'
        && compared.body.comparison.versions[1].accepted_version === version2
        && proposed.handled === true && proposed.state.status === 201 && proposed.body?.proposal?.chapter_number === 2
        && proposed.body.proposal.version === version2 && proposed.body.proposal.selections.length === selections.length
        && reserved === 'METHOD_NOT_ALLOWED' && untouched
        && roster.handled === true && roster.state.status === 200 && roster.body?.readers?.length === 6
        && responses.handled === true && responses.state.status === 200 && responses.body?.feedback?.length === 18
        && elsewhere.handled === false) {
        ok('feedback surface: the comparison route serves the same document as the function (200), the revisions route turns a selection into a proposal (201), the responses and readers routes still answer the same handler, a reserved segment is never read as a response identifier, another segment is left to the router, and none of these calls writes anything');
      } else {
        fail(`feedback surface: compared=${compared.handled}/${compared.state.status}/${compared.body?.comparison?.schema_version}, proposed=${proposed.handled}/${proposed.state.status}/${proposed.body?.proposal?.chapter_number}/${proposed.body?.proposal?.version?.slice(0, 14)}, reserved=${reserved}, readers=${roster.handled}/${roster.state.status}/${roster.body?.readers?.length}, responses=${responses.handled}/${responses.state.status}/${responses.body?.feedback?.length}, elsewhere=${elsewhere.handled}, responses=${listing.feedback.length}, untouched=${untouched}`);
      }
    }

    // 6. While the book is being written the accepted version cannot be read: the comparison reports
    // the stored responses and says `historical` is unknown instead of guessing which text is current.
    {
      await turnRecord(universe.id, 9, { kind: 'export', status: 'queued', request: 'Generate the printed edition' });
      const writing = await attempt(() => buildFeedbackComparison(universe.id, { questionId: 'interest', from: version1, to: version2 }));
      await rm(join(universeDir(universe.id), 'turns', '0009.json'), { force: true });
      const restored = await attempt(() => buildFeedbackComparison(universe.id, { questionId: 'interest', from: version1, to: version2 }));
      if (writing?.schema_version === 'reader-feedback-comparison.v1' && writing.versions.every((side) => side.historical === null)
        && writing.basis.version_stable === false && writing.basis.note.includes('cannot be read right now')
        && writing.versions[0].provenance.team_human.answered === 3
        && restored.versions[0].historical === true && restored.versions[1].historical === false) {
        ok('feedback comparison: while a turn of the book is queued the two distributions are still reported, `historical` is null on both sides and the basis states why, instead of guessing which version is current');
      } else {
        fail(`feedback comparison/unstable: writing=${JSON.stringify(writing?.versions?.map((side) => side.historical))}/${writing?.basis?.version_stable}/${writing?.basis?.note}, answered=${writing?.versions?.[0]?.provenance?.team_human?.answered}, restored=${JSON.stringify(restored?.versions?.map((side) => side.historical))}`);
      }
    }
    // 7. With the book moved on, the same three steps are refused as stale and nothing is queued.
    {
      await writeAncestry(universe.id, 1, 1, null);
      await writeFile(bookFile(CHAPTERS[0]), REWRITTEN_AGAIN, 'utf8');
      const version3 = await currentVersion(universe.id);
      const bookBefore = await treeDigest(universeDir(universe.id));
      const feedbackBefore = await treeDigest(feedbackRoot(universe.id));
      const turnsBefore = await turnFiles();
      const staleSelection = await attempt(() => selectFeedbackForRevision({ universeId: universe.id, selections, chapterNumber: 1 }));
      const staleApproval = await attempt(() => recordApproval({ universeId: universe.id, proposal, decision: 'approved', reviewer: 'Mircea', version: proposal.version }));
      const staleStart = await attempt(() => startFeedbackRevision({ universeId: universe.id, proposal, approval }));
      // The same request handed to the existing rewrite path directly: it reaches its own version
      // binding (the chapter exists and the ancestry is recorded), and refuses there.
      const staleRewrite = await attempt(() => jobs.startRewrite({
        universeId: universe.id,
        chapterNumber: request.chapter_number,
        instructions: request.instructions,
        findings: request.findings,
        preserve: request.preserve,
        sourceVersion: request.source_version
      }));
      const untouched = (await treeDigest(universeDir(universe.id))) === bookBefore && (await treeDigest(feedbackRoot(universe.id))) === feedbackBefore;
      if (version3 !== version2 && version3 !== version1
        && staleSelection?.code === 'STALE_REQUEST' && staleSelection.message.includes(version2.slice(0, 18))
        && staleApproval?.code === 'STALE_REQUEST' && staleStart?.code === 'STALE_REQUEST' && staleRewrite?.code === 'STALE_REQUEST'
        && (await turnFiles()) === turnsBefore && untouched
        && jobs.queuedForUniverse(universe.id).length === 0 && jobs.activeForUniverse(universe.id) === null) {
        ok(`feedback revision: once the book moved to ${version3.slice(0, 18)}…, selecting that feedback, deciding the proposal again and asking for the revision are each refused as STALE_REQUEST (the last one by the existing rewrite path, which reaches its version binding), no turn is queued, and the book and the feedback tree are byte-identical`);
      } else {
        fail(`feedback revision/stale: ${version1.slice(0, 12)}->${version2.slice(0, 12)}->${version3.slice(0, 12)}, selection=${staleSelection?.code}/${staleSelection?.message}, approval=${staleApproval?.code}, start=${staleStart?.code}, rewrite=${staleRewrite?.code}, turns=${turnsBefore}->${await turnFiles()}, queued=${jobs.queuedForUniverse(universe.id).length}, untouched=${untouched},\n${bookBefore}\n${await treeDigest(universeDir(universe.id))}`);
      }
    }

    // 8. A comparison counts independent readers, not submissions: one team member who answered the
    // same question three times against one version cannot stand in for three readers.
    {
      const gate = await bookWithTwoChapters(checkSeed, 'feedback-gate');
      tempDirs.push(gate.id);
      try {
        const rate = (targetId, feedbackId, readerId, value) => submitFeedback({
          universeId: gate.id,
          targetId,
          feedbackId,
          readerId,
          answers: [{ question_id: 'interest', value }]
        });
        const ana = await createFeedbackReader({ universeId: gate.id, displayName: 'Ana' });
        const bogdan = await createFeedbackReader({ universeId: gate.id, displayName: 'Bogdan' });
        const corina = await createFeedbackReader({ universeId: gate.id, displayName: 'Corina' });
        const first = (await createFeedbackTarget({ universeId: gate.id, scope: { kind: 'book' } })).target;
        const firstVersion = await currentVersion(gate.id);
        // One reader, three submissions against the same frozen text: 1, then 5, then 3.
        await rate(first.target_id, 'fb-gate-ana-first', ana.reader_id, 1);
        await rate(first.target_id, 'fb-gate-ana-second', ana.reader_id, 5);
        await rate(first.target_id, 'fb-gate-ana-third', ana.reader_id, 3);
        await writeFile(join(universeDir(gate.id), CHAPTERS[0]), REWRITTEN, 'utf8');
        const secondVersion = await currentVersion(gate.id);
        const second = (await createFeedbackTarget({ universeId: gate.id, scope: { kind: 'book' } })).target;
        await rate(second.target_id, 'fb-gate-v2-ana', ana.reader_id, 4);
        await rate(second.target_id, 'fb-gate-v2-bogdan', bogdan.reader_id, 3);
        await rate(second.target_id, 'fb-gate-v2-corina', corina.reader_id, 5);
        await writeFile(join(universeDir(gate.id), CHAPTERS[0]), REWRITTEN_AGAIN, 'utf8');
        const thirdVersion = await currentVersion(gate.id);
        const third = (await createFeedbackTarget({ universeId: gate.id, scope: { kind: 'book' } })).target;
        await rate(third.target_id, 'fb-gate-v3-ana', ana.reader_id, 2);
        await rate(third.target_id, 'fb-gate-v3-bogdan', bogdan.reader_id, 4);
        await rate(third.target_id, 'fb-gate-v3-corina', corina.reader_id, 3);

        const summary = await buildFeedbackSummary(gate.id);
        const question = summary.questions.find((entry) => entry.question_id === 'interest');
        const of = (version) => question.populations.find((population) => population.accepted_version === version)?.provenance.team_human;
        const one = of(firstVersion);
        const refused = await attempt(() => buildFeedbackComparison(gate.id, { questionId: 'interest', from: firstVersion, to: secondVersion }));
        const supported = await attempt(() => buildFeedbackComparison(gate.id, { questionId: 'interest', from: secondVersion, to: thirdVersion }));
        const sides = Array.isArray(supported?.versions) ? supported.versions.map((side) => side.provenance.team_human) : [];
        const refusedNumbers = JSON.stringify(refused?.details ?? {});
        if (one.answered === 1 && one.readers === 1 && one.repeated_readers === 1 && one.earlier_answers === 2 && one.records === 3
          && JSON.stringify(one.distribution) === JSON.stringify({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 }) && one.mean === null
          && refused?.code === 'COMPARISON_NOT_SUPPORTED' && refused.details.reason_code === 'MIN_ANSWERED_PER_VERSION'
          && refused.details.answered[0].answered === 1 && refused.details.answered[1].answered === 3
          && !refusedNumbers.includes('"distribution"') && !refusedNumbers.includes('"mean"')
          && supported?.schema_version === 'reader-feedback-comparison.v1'
          && sides.length === 2 && sides.every((numbers) => numbers.answered === 3 && numbers.readers === 3 && numbers.records === 3)
          && supported.versions.every((side) => side.population.scope.kind === 'book' && side.unit === 'reader')
          && JSON.stringify(sides[0].distribution) === JSON.stringify({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 })
          && JSON.stringify(sides[1].distribution) === JSON.stringify({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 0 })) {
          ok(`feedback comparison: a team member who answered interest three times against one version counts as one reader (latest answer 3, two earlier submissions in history), so that version answers COMPARISON_NOT_SUPPORTED with ${refused.details.answered[0].answered} reader beside ${refused.details.answered[1].answered}, while two versions answered by three independent readers each are put side by side (${sides[0].answered} and ${sides[1].answered} readers), and the refusal carries no distribution, no mean and no difference`);
        } else {
          fail(`feedback comparison/readers: one=${JSON.stringify(one)}, refused=${refused?.code}/${refused?.details?.reason_code}/${JSON.stringify(refused?.details?.answered)}, supported=${supported?.code}/${JSON.stringify(sides)}, versions=${firstVersion?.slice(0, 12)}/${secondVersion?.slice(0, 12)}/${thirdVersion?.slice(0, 12)}`);
        }
      } finally {
        await rm(join(assessmentsRoot(), gate.id), { recursive: true, force: true });
      }
    }

    // 9. A changed questionnaire is another question: two scales are never pooled into one distribution
    // and two versions read with different questionnaires are never compared as the same reading.
    {
      const scales = await bookWithTwoChapters(checkSeed, 'feedback-scales');
      tempDirs.push(scales.id);
      try {
        const oldVersion = await currentVersion(scales.id);
        const ana = await createFeedbackReader({ universeId: scales.id, displayName: 'Ana' });
        const bogdan = await createFeedbackReader({ universeId: scales.id, displayName: 'Bogdan' });
        const book = (await createFeedbackTarget({ universeId: scales.id, scope: { kind: 'book' } })).target;
        await submitFeedback({ universeId: scales.id, targetId: book.target_id, feedbackId: 'fb-scales-ana-old', readerId: ana.reader_id, answers: [{ question_id: 'interest', value: 5 }] });
        await submitFeedback({ universeId: scales.id, targetId: book.target_id, feedbackId: 'fb-scales-bogdan-old', readerId: bogdan.reader_id, answers: [{ question_id: 'interest', value: 2 }] });
        await writeFile(join(universeDir(scales.id), CHAPTERS[0]), REWRITTEN, 'utf8');
        const newVersion = await currentVersion(scales.id);
        const secondScale = await writeSecondScaleTarget(scales.id, newVersion);
        await submitFeedback({ universeId: scales.id, targetId: secondScale.target_id, feedbackId: 'fb-scales-ana-new', readerId: ana.reader_id, answers: [{ question_id: 'interest', value: 6 }] });

        const summary = await buildFeedbackSummary(scales.id);
        const rows = summary.questions.filter((entry) => entry.question_id === 'interest');
        const oldRow = rows.find((entry) => entry.questionnaire_version === 'reader-questionnaire.v1');
        const newRow = rows.find((entry) => entry.questionnaire_version === 'reader-questionnaire.v2');
        const oldNumbers = oldRow?.populations.find((population) => population.accepted_version === oldVersion)?.provenance.team_human;
        const newPopulation = newRow?.populations.find((population) => population.accepted_version === newVersion);
        const newNumbers = newPopulation?.provenance.team_human;
        const refused = await attempt(() => buildFeedbackComparison(scales.id, { questionId: 'interest', from: oldVersion, to: newVersion }));
        const refusedNumbers = JSON.stringify(refused?.details ?? {});
        if (rows.length === 2 && oldRow.options.join(',') === '1,2,3,4,5' && newRow.options.join(',') === '1,2,3,4,5,6,7'
          && oldRow.declared_by === 'reader-questionnaire.v1' && newRow.declared_by === 'reader-questionnaire.v2'
          && summary.counts.populations === 2
          && oldNumbers && newNumbers
          && newPopulation.target_ids.join(',') === secondScale.target_id
          && JSON.stringify(oldNumbers.distribution) === JSON.stringify({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 })
          && oldNumbers.answered === 2 && oldNumbers.mean === null && !('6' in oldNumbers.distribution)
          && newNumbers.answered === 1 && newNumbers.distribution['6'] === 1 && newNumbers.distribution['7'] === 0 && newNumbers.undeclared === 0
          && refused?.code === 'NO_COMPARABLE_POPULATION' && refused.details.reason_code === 'NO_COMPARABLE_POPULATION'
          && refused.details.from.populations.length === 1 && refused.details.to.populations.length === 1
          && refused.details.from.populations[0].questionnaire_version === 'reader-questionnaire.v1'
          && refused.details.to.populations[0].questionnaire_version === 'reader-questionnaire.v2'
          && refused.details.questionnaire_versions.join(',') === 'reader-questionnaire.v1,reader-questionnaire.v2'
          && !refusedNumbers.includes('"distribution"') && !refusedNumbers.includes('"mean"')
          && refused.message.includes('reader-questionnaire.v2') && refused.message.includes('questionnaire')) {
          ok(`feedback summary: a reading taken with questionnaire reader-questionnaire.v2 declares its own interest scale (1 to 7) beside the reader-questionnaire.v1 one (1 to 5) — ${oldNumbers.answered} readers on the old scale with no 6 or 7 anywhere in its distribution, and one on the new whose 6 is counted under its own declared option — and comparing the two versions answers NO_COMPARABLE_POPULATION naming both populations instead of putting two scales side by side`);
        } else {
          fail(`feedback summary/scales: rows=${JSON.stringify(rows.map((entry) => [entry.questionnaire_version, entry.options.join('/'), entry.versions.length]))}, old=${JSON.stringify(oldNumbers)}, new=${JSON.stringify(newNumbers)}, refused=${refused?.code}/${refused?.details?.reason_code}, populations=${JSON.stringify([refused?.details?.from?.populations?.length, refused?.details?.to?.populations?.length])}, message=${refused?.message?.slice(0, 240)}, summaryPopulations=${summary.counts.populations}`);
        }
      } finally {
        await rm(join(assessmentsRoot(), scales.id), { recursive: true, force: true });
      }
    }

    // 10. The A/B session: two immutable targets, a display order that survives a refresh, and the
    // preference of one member of the team with its rationale and the conditions they read under.
    {
      const sessions = await bookWithTwoChapters(checkSeed, 'feedback-sessions');
      tempDirs.push(sessions.id);
      try {
        const firstVersion = await currentVersion(sessions.id);
        const ana = await createFeedbackReader({ universeId: sessions.id, displayName: 'Ana' });
        const bookOne = (await createFeedbackTarget({ universeId: sessions.id, scope: { kind: 'book' } })).target;
        await writeFile(join(universeDir(sessions.id), CHAPTERS[0]), REWRITTEN, 'utf8');
        const secondVersion = await currentVersion(sessions.id);
        const bookTwo = (await createFeedbackTarget({ universeId: sessions.id, scope: { kind: 'book' } })).target;
        const otherTarget = (await createFeedbackTarget({ universeId: other.id, scope: { kind: 'book' } })).target;
        // One ordinary reading: the descriptive surface stays available with its counts beside the
        // sessions, which is what a small team keeps while it accumulates comparable observations.
        await submitFeedback({
          universeId: sessions.id,
          targetId: bookTwo.target_id,
          feedbackId: 'fb-sessions-ana-reading',
          readerId: ana.reader_id,
          answers: [{ question_id: 'interest', value: 4 }]
        });
        const bookStore = await treeDigest(universeDir(sessions.id));
        const begin = (sessionId, questionId = 'interest') => startComparisonSession({
          universeId: sessions.id,
          questionId,
          targetId: bookOne.target_id,
          otherTargetId: bookTwo.target_id,
          readerId: ana.reader_id,
          sessionId
        });

        // One team member opens a session over the older and the newer book-wide readings, and a
        // refresh reads the same record, with the same two texts in the same places.
        const opened = await begin('cmp-check-first');
        const session = opened.session;
        const refreshed = await readComparisonSession(sessions.id, session.session_id);
        const again = await readComparisonSession(sessions.id, session.session_id);
        const reopened = await begin('cmp-check-first');
        // The ordinary comparison of the same two versions is refused for want of readers; the session
        // records what one reader saw anyway.
        const ordinary = await attempt(() => buildFeedbackComparison(sessions.id, { questionId: 'interest', from: firstVersion, to: secondVersion }));
        const summary = await buildFeedbackSummary(sessions.id);
        const preference = 'B';
        const conditions = { where: 'the office', duration_minutes: 14, device: 'laptop', read: 'complete', seen_before: 'both', saw_report: false };
        const rationale = 'The second reading keeps the ledger voice and the district answers it.';
        const answered = await recordComparisonPreference({
          universeId: sessions.id,
          sessionId: session.session_id,
          preference,
          rationale,
          ratings: { A: 3, B: 5 },
          conditions
        });
        const stored = await readFile(join(comparisonsRoot(sessions.id), session.session_id, 'response.json'), 'utf8').then((raw) => JSON.parse(raw), () => null);
        const repeated = await recordComparisonPreference({ universeId: sessions.id, sessionId: session.session_id, preference, rationale, ratings: { A: 3, B: 5 }, conditions });
        const conflicting = await attempt(() => recordComparisonPreference({ universeId: sessions.id, sessionId: session.session_id, preference: 'A' }));
        const unknownPreference = await attempt(() => recordComparisonPreference({ universeId: sessions.id, sessionId: session.session_id, preference: 'maybe' }));
        const foreignReader = await attempt(() => recordComparisonPreference({ universeId: sessions.id, sessionId: session.session_id, preference: 'A', readerId: 'reader-0000000000000000' }));
        const unknownSession = await attempt(() => readComparisonSession(sessions.id, 'cmp-nothing-here'));
        const sameTarget = await attempt(() => startComparisonSession({ universeId: sessions.id, questionId: 'interest', targetId: bookOne.target_id, otherTargetId: bookOne.target_id, readerId: ana.reader_id }));
        const unknownQuestion = await attempt(() => begin('cmp-check-question', 'no-such-question'));
        const foreignTarget = await attempt(() => startComparisonSession({ universeId: sessions.id, questionId: 'interest', targetId: bookOne.target_id, otherTargetId: otherTarget.target_id, readerId: ana.reader_id }));

        // A tie and an `unable` are answers of their own, and the same pair is opened once with the
        // opposite display order: the order is drawn when the session opens and it never changes again.
        const tie = await begin('cmp-check-tie');
        await recordComparisonPreference({ universeId: sessions.id, sessionId: tie.session.session_id, preference: 'tie', rationale: 'Both readings hold the district equally.' });
        const unable = await begin('cmp-check-unable');
        await recordComparisonPreference({ universeId: sessions.id, sessionId: unable.session.session_id, preference: 'unable', rationale: 'I could not tell the two apart in one sitting.' });
        const wanted = session.display.order[0] === 'A' ? 'B' : 'A';
        let reversed = null;
        for (let index = 0; index < 32 && reversed === null; index += 1) {
          const candidate = await begin(`cmp-rev-${index}`);
          if (candidate.session.display.order[0] === wanted) reversed = candidate.session;
        }
        if (reversed) await recordComparisonPreference({ universeId: sessions.id, sessionId: reversed.session_id, preference: 'A', rationale: 'Read the other way round, the same words land differently.' });
        const reversedAgain = reversed ? await readComparisonSession(sessions.id, reversed.session_id) : null;
        const listed = await listComparisonSessions(sessions.id, { targetId: bookOne.target_id });
        const tally = (await readComparisonSession(sessions.id, session.session_id)).counts;
        const untouched = (await treeDigest(universeDir(sessions.id))) === bookStore;
        const fileOf = (id, name) => stat(join(comparisonsRoot(sessions.id), id, name)).then(() => true, () => false);
        const twoFiles = await fileOf(session.session_id, 'session.json') && await fileOf(session.session_id, 'response.json');
        const countsAnswer = ordinary?.details?.answered;
        const summaryCounts = summary.questions.find((entry) => entry.question_id === 'interest').populations
          .map((population) => population.provenance.team_human.answered);
        if (session.schema_version === 'reader-feedback-comparison-session.v1' && opened.deduplicated === false
          && session.targets.A.target_id === bookOne.target_id && session.targets.B.target_id === bookTwo.target_id
          && session.targets.A.accepted_version === firstVersion && session.targets.B.accepted_version === secondVersion
          && session.targets.A.historical === true && session.targets.B.historical === false
          && session.targets.A.displayed_hash === bookOne.displayed.hash && session.targets.B.displayed_hash === bookTwo.displayed.hash
          && session.targets.A.files.length === 2 && session.targets.B.files.length === 2
          && session.targets.A.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256) && file.bytes > 0 && typeof file.path === 'string')
          && session.targets.A.files[0].path === session.targets.B.files[0].path
          && session.targets.A.scope.kind === 'book' && session.same_questionnaire === true
          && session.question.question_id === 'interest' && session.question.options.join(',') === '1,2,3,4,5'
          && session.reader.reader_id === ana.reader_id && session.reader.display_name === 'Ana' && session.reader.kind === 'team_human'
          && refreshed.display.order.join(',') === session.display.order.join(',') && again.display.order.join(',') === session.display.order.join(',')
          && refreshed.display.left === refreshed.display.order[0] && JSON.stringify(refreshed) === JSON.stringify(again)
          && refreshed.display.note.includes('refresh') && reopened.deduplicated === true
          && session.measurement.claimed === false && session.measurement.reason.includes('not a measurement')
          && session.response === null && session.counts.sessions === 1 && session.counts.responses === 0
          && ordinary?.code === 'COMPARISON_NOT_SUPPORTED' && Array.isArray(countsAnswer)
          && countsAnswer.length === 2 && countsAnswer.every((entry) => entry.answered < MIN_ANSWERED_PER_VERSION)
          && summaryCounts.length >= 1 && summaryCounts.reduce((total, answered) => total + answered, 0) === 1
          && answered.deduplicated === false && answered.response.preference === 'B' && answered.response.rationale === rationale
          && answered.response.ratings.A === 3 && answered.response.ratings.B === 5
          && JSON.stringify(answered.response.conditions) === JSON.stringify(conditions)
          && answered.response.display.order.join(',') === session.display.order.join(',')
          && answered.session.counts.responses === 1 && answered.session.counts.by_role[preference] === 1
          && answered.session.counts.by_position[session.display.order[0] === preference ? 'left' : 'right'] === 1
          && stored?.preference === 'B' && stored?.session_id === session.session_id && stored?.submission_sha256?.length === 64
          && repeated.deduplicated === true && repeated.response.response_id === answered.response.response_id
          && conflicting?.code === 'CONFLICT' && unknownPreference?.code === 'BAD_SESSION'
          && foreignReader?.code === 'BAD_SESSION' && unknownSession?.code === 'NOT_FOUND' && sameTarget?.code === 'BAD_SESSION'
          && unknownQuestion?.code === 'BAD_SESSION' && foreignTarget?.code === 'NOT_FOUND'
          && unable.session.session_id !== tie.session.session_id
          && reversed !== null && reversedAgain.display.order.join(',') === reversed.display.order.join(',')
          && tally.sessions === 4 && tally.responses === 4
          && tally.by_role.A === 1 && tally.by_role.B === 1 && tally.by_role.tie === 1 && tally.by_role.unable === 1
          && tally.by_position.left + tally.by_position.right === 2 && tally.by_position.tie === 1 && tally.by_position.unable === 1
          && tally.orders['A,B'] >= 1 && tally.orders['B,A'] >= 1
          && tally.note.includes('counts of recorded observations') && tally.note.includes('did not say the same thing')
          && listed.length === 4 && listed.every((entry) => entry.targets.A.target_id === bookOne.target_id && entry.counts.sessions === 4)
          && twoFiles && untouched) {
          ok(`feedback session: one team member opened a session over the older and the newer book-wide reading (${session.display.order.join(' then ')}, kept across two reads) and recorded ${answered.response.preference} with its rationale, its ratings and the conditions they read under, while the ordinary comparison of the same versions still answers ${ordinary.code} with its counts (${countsAnswer.map((entry) => entry.answered).join(' and ')} answered); a tie and an unable are counted apart, the same pair was also opened with the opposite display order, the four recorded observations tally ${JSON.stringify(tally.by_role)} by role and ${JSON.stringify(tally.by_position)} by position, and the session and its answer are files under the feedback tree with nothing written inside the book`);
        } else {
          fail(`feedback session: opened=${JSON.stringify({ schema: session.schema_version, order: session.display?.order, targets: Object.fromEntries(Object.entries(session.targets ?? {}).map(([role, side]) => [role, [side.target_id?.slice(0, 12), side.accepted_version?.slice(0, 12), side.historical, side.displayed_hash?.slice(0, 12)]])), measurement: session.measurement, counts: session.counts })}), refresh=${refreshed.display?.order}/${JSON.stringify(refreshed) === JSON.stringify(again)}/${reopened.deduplicated}, ordinary=${ordinary?.code}/${JSON.stringify(countsAnswer)}, summaryCounts=${JSON.stringify(summaryCounts)}, answered=${answered?.response?.preference}/${answered?.response?.rationale}/${JSON.stringify(answered?.response?.ratings)}/${JSON.stringify(answered?.response?.conditions)}/${JSON.stringify(answered?.session?.counts)}, stored=${stored?.preference}, repeated=${repeated?.deduplicated}, refused=${conflicting?.code}/${unknownPreference?.code}/${foreignReader?.code}/${unknownSession?.code}/${sameTarget?.code}/${unknownQuestion?.code}/${foreignTarget?.code}, reversed=${reversed?.display?.order}/${reversedAgain?.display?.order}, tally=${JSON.stringify(tally)}, listed=${listed.length}, files=${twoFiles}, untouched=${untouched}`);
        }
      } finally {
        await rm(join(assessmentsRoot(), sessions.id), { recursive: true, force: true });
      }
    }

  } finally {
    await rm(join(assessmentsRoot(), universe.id), { recursive: true, force: true });
    await rm(join(assessmentsRoot(), other.id), { recursive: true, force: true });
  }
}

/**
 * A target read with a second questionnaire. The questionnaire constant of the store cannot produce one
 * any more, and a store that already holds such a reading must still be summarized without pooling its
 * scale with the old one, so the check writes the target the way the freeze writer writes it: the
 * frozen text copied first, the record last, with the hashes the record names.
 */
async function writeSecondScaleTarget(universeId, version) {
  const path = CHAPTERS[1];
  const bytes = await readFile(join(universeDir(universeId), path));
  const digest = sha256Hex(bytes);
  const targetId = `target-${sha256Hex(`${universeId}|${version}|chapter|2|questionnaire-v2`).slice(0, 16)}`;
  await mkdir(targetTextDir(universeId, targetId), { recursive: true });
  await writeFile(join(targetTextDir(universeId, targetId), basename(path)), bytes);
  const questions = [
    { id: 'interest', label: 'How interesting was this text?', low: 'flat', high: 'gripping', options: [1, 2, 3, 4, 5, 6, 7] },
    { id: 'clarity', label: 'How clearly was this told?', low: 'confusing', high: 'crystal clear', options: [1, 2, 3, 4, 5] },
    { id: 'voice', label: 'How distinct are the voices?', low: 'interchangeable', high: 'each their own', options: [1, 2, 3, 4, 5] },
    { id: 'emotion', label: 'How strongly did this text move you?', low: 'untouched', high: 'moved', options: [1, 2, 3, 4, 5] },
    { id: 'continue', label: 'How much do you want to read what comes next?', low: 'not at all', high: 'at once', options: [1, 2, 3, 4, 5] }
  ];
  const record = {
    schema_version: 'reader-feedback-target.v1',
    target_id: targetId,
    universe_id: universeId,
    source_version: version,
    scope: { kind: 'chapter', chapters: [2] },
    language: 'en',
    created_at: new Date().toISOString(),
    displayed: { hash: `sha256:${digest}`, files: [{ path, sha256: digest, bytes: bytes.length }] },
    chapters: [{ number: 2, title: 'Two', path, sha256: digest }],
    run_id: null,
    finding_ids: [],
    context: { note: 'read with the second questionnaire', display: { files: [path], hash: `sha256:${digest}` } },
    questionnaire: { version: 'reader-questionnaire.v2', questions, reactions: [] }
  };
  await writeFile(join(targetDir(universeId, targetId), 'target.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/** The reason the summary states for a refusal, short enough for a check line. */
function storedLabel(refusal) {
  return refusal ? refusal.reason.slice(0, 60) : 'unnamed';
}

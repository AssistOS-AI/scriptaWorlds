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
//  - a selection of responses becomes a proposal that names the feedback, the version each item was
//    given against and the scope it was read at; a withdrawn response is refused, a correction is
//    carried in place of the response it replaces, and a model's annotation or a fixture is marked as
//    such and never counted as a reader;
//  - approving that proposal is the decision of §8.4 on the proposal itself, and the request it becomes
//    quotes the readers' words and names the evidence, bound to the version the feedback was about;
//  - with the book moved on, selecting that feedback, deciding it again and asking for the revision are
//    each refused as stale, nothing is queued, and neither the book nor the feedback tree changes;
//  - the two routes of the surface answer the same documents, and a reserved segment is never read as a
//    response identifier.
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assessmentsRoot, currentVersion } from '../src/assessment-packet.mjs';
import { listApprovals, recordApproval } from '../src/assessments.mjs';
import { buildFeedbackComparison } from '../src/feedback-comparison.mjs';
import { listFeedback, submitFeedback, withdrawFeedback } from '../src/feedback-entries.mjs';
import { handleFeedbackRoutes } from '../src/feedback-routes.mjs';
import { buildFeedbackRevisionRequest, selectFeedbackForRevision, startFeedbackRevision } from '../src/feedback-revision.mjs';
import { createFeedbackReader } from '../src/feedback-readers.mjs';
import { MIN_ANSWERED_PER_VERSION, buildFeedbackSummary } from '../src/feedback-summary.mjs';
import { createFeedbackTarget, feedbackRoot } from '../src/feedback-targets.mjs';
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
      // Every number adds up to the responses it claims: answered + skipped + unmentioned = the
      // responses of that provenance, and the provenances together are the responses of the version.
      const addsUp = (group) =>
        ['team_human', 'model', 'synthetic'].every((kind) => {
          const numbers = group.provenance[kind];
          return numbers.responses === numbers.answered + numbers.skipped + numbers.not_mentioned;
        })
        && Object.values(group.provenance).reduce((total, numbers) => total + numbers.responses, 0)
          === Object.values(group.responses).reduce((total, count) => total + count, 0);
      const readers = (group) => group.readers.map((entry) => entry.display_name).sort().join(', ');
      const annotated = (group) => group.annotations.map((entry) => `${entry.display_name}:${entry.reader_kind}`).sort().join(', ');
      const noDifference = comparison.ordering.stated === false && comparison.ordering.difference === null
        && comparison.ordering.reason_code === 'ORDINAL_RATINGS' && comparison.ordering.reason.includes('interest');
      if (comparison.schema_version === 'reader-feedback-comparison.v1' && comparison.universe_id === universe.id
        && comparison.question.question_id === 'interest' && comparison.question.options.join(',') === '1,2,3,4,5'
        && from.accepted_version === version1 && from.historical === true
        && to.accepted_version === version2 && to.historical === false
        && teamFrom.responses === 6 && teamFrom.answered === 3 && teamFrom.skipped === 0 && teamFrom.not_mentioned === 3
        && JSON.stringify(teamFrom.distribution) === JSON.stringify({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 0 }) && teamFrom.mean === 3
        && teamTo.responses === 4 && teamTo.answered === 3 && teamTo.skipped === 0 && teamTo.not_mentioned === 1
        && JSON.stringify(teamTo.distribution) === JSON.stringify({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 }) && teamTo.mean === 4
        && from.responses.team_human === 6 && to.responses.team_human === 4
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
        && composed.details.reason.includes(`0 against ${version2}`) && composed.details.reason.includes('3 answered team responses per version')
        && unknown?.code === 'COMPARISON_UNKNOWN_VERSION' && unknown.details.unknown_versions.join(',') === missing
        && acrossBooks?.code === 'COMPARISON_UNKNOWN_VERSION' && acrossBooks.details.unknown_versions.join(',') === otherVersion
        && same === 'BAD_COMPARISON' && nonsense === 'BAD_COMPARISON' && unanswered === 'COMPARISON_NOT_SUPPORTED') {
        ok(`feedback comparison: clarity (2 and 1 answered team responses) is refused with the summary's own reason (${details.reason_code}, ${storedLabel(stated)}), continue (3 against one version and 0 against the other) with a reason that names both counts, a version no book holds and another book's version with COMPARISON_UNKNOWN_VERSION, and a malformed request with BAD_COMPARISON — and no refusal carries a distribution, a mean or a difference`);
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

  } finally {
    await rm(join(assessmentsRoot(), universe.id), { recursive: true, force: true });
    await rm(join(assessmentsRoot(), other.id), { recursive: true, force: true });
  }
}

/** The reason the summary states for a refusal, short enough for a check line. */
function storedLabel(refusal) {
  return refusal ? refusal.reason.slice(0, 60) : 'unnamed';
}

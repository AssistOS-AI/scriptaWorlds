// The reader-feedback group of `scripts/check.mjs` (`docs/contracts.md` §8.7). It proves, with the real
// store in a temporary universe, the properties the team depends on:
//
//  - a target freezes the accepted version, the chapter hashes and the displayed text byte for byte,
//    outside `universes/`, and a second session against the same version and scope reopens it;
//  - a reader identity is issued once and stays stable, and a response naming an unknown reader is
//    refused before anything is written;
//  - a real submission is stored as `team_human`, an identical retry is deduplicated by identifier, a
//    different content under that identifier conflicts, a quote that does not resolve inside the frozen
//    file (or an undeclared rating, or an over-long comment) is refused with nothing written, and a
//    withdrawal keeps the entry and hides its answers;
//  - a rewrite moves the book to a new version: the earlier target and its responses stay listed and
//    are marked historical, they can still receive a response, and a new target can be frozen;
//  - a `feedback/` tree carrying a `run.json` is never enumerated as an assessment run;
//  - a model annotation and a synthetic fixture are stored with their own provenance and are never
//    counted among the readers who said something.
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assessmentsRoot, currentVersion } from '../src/assessment-packet.mjs';
import { listArcEvents, listAssessments } from '../src/assessments.mjs';
import {
  createFeedbackTarget,
  feedbackRoot,
  isTargetId,
  readFeedbackTarget,
  targetDir,
  targetTextDir,
  verifyFrozenText
} from '../src/feedback-targets.mjs';
import { createFeedbackReader, listFeedbackReaders, readFeedbackReader } from '../src/feedback-readers.mjs';
import { entryDir, listFeedback, readFeedback, recordReaderDeletion, submitFeedback, withdrawFeedback } from '../src/feedback-entries.mjs';
import { universeDir } from '../src/paths.mjs';
import { bookWithTwoChapters, sha256Hex } from './check-fixtures.mjs';

const CHAPTERS = ['chapters/0001-one.md', 'chapters/0002-two.md'];
const REWRITTEN = '# One\n\nThe ledger was read again, and this time the district hummed a different note.\n\n';

export async function runFeedbackChecks({ ok, fail, checkSeed = `check-${Date.now().toString(36)}`, tempDirs = [] }) {
  const universe = await bookWithTwoChapters(checkSeed, 'feedback');
  tempDirs.push(universe.id);
  const root = feedbackRoot(universe.id);
  const bookFile = (path) => join(universeDir(universe.id), path);
  const frozenFile = (targetId, path) => join(targetTextDir(universe.id, targetId), path.split('/').pop());
  const countEntries = async () => (await readdir(join(root, 'entries')).catch(() => [])).length;
  const attempt = async (work) => {
    try {
      await work();
      return 'accepted';
    } catch (error) {
      return error?.code ?? String(error?.message ?? error);
    }
  };

  try {
    // 1. A book target freezes the accepted version, the chapter hashes and the displayed text.
    const version = await currentVersion(universe.id);
    const first = await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' }, note: 'The first reading pass.' });
    const target = first.target;
    const identical = [];
    for (const path of CHAPTERS) {
      const bytes = await readFile(bookFile(path));
      const frozen = await readFile(frozenFile(target.target_id, path)).catch(() => null);
      const listed = target.displayed.files.find((file) => file.path === path);
      const chapter = target.chapters.find((entry) => entry.path === path);
      identical.push({
        path,
        copy: frozen !== null && Buffer.compare(bytes, frozen) === 0,
        hashed: listed?.sha256 === sha256Hex(bytes) && listed.bytes === bytes.length && chapter?.sha256 === sha256Hex(bytes)
      });
    }
    const again = await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } });
    const insideBook = await stat(join(universeDir(universe.id), 'feedback')).then(() => true, () => false);
    if (target.schema_version === 'reader-feedback-target.v1' && isTargetId(target.target_id) && target.source_version === version
      && target.scope.kind === 'book' && target.scope.chapters.join(',') === '1,2' && target.language === 'en'
      && target.displayed.files.length === 2 && target.chapters.length === 2 && target.questionnaire?.version === 'reader-questionnaire.v1'
      && target.context.note === 'The first reading pass.' && identical.every((entry) => entry.copy && entry.hashed)
      && targetDir(universe.id, target.target_id).startsWith(assessmentsRoot()) && !insideBook
      && again.target.target_id === target.target_id && again.deduplicated === true) {
      ok(`feedback: a book target freezes the accepted version, the chapter hashes and the displayed files byte for byte under the workspace (${target.target_id}), and a second session reopens it instead of freezing another copy`);
    } else {
      fail(`feedback/target: id=${target.target_id}/${isTargetId(target.target_id)}, version=${target.source_version}/${version}, scope=${target.scope?.kind}:${target.scope?.chapters}, displayed=${target.displayed?.files?.length}, copy=${JSON.stringify(identical)}, insideBook=${insideBook}, again=${again.target?.target_id}/${again.deduplicated}`);
    }

    // The frozen text is what makes a response reopenable: a target whose text cannot be reproduced
    // answers STALE_TARGET instead of attaching a reading to prose that changed.
    {
      const path = frozenFile(target.target_id, CHAPTERS[0]);
      const original = await readFile(path);
      await writeFile(path, `${original.toString('utf8')}\nA line that was never there.\n`, 'utf8');
      const read = await attempt(() => readFeedbackTarget(universe.id, target.target_id));
      const submit = await attempt(() => submitFeedback({ universeId: universe.id, targetId: target.target_id, readerId: 'reader-0000000000000000', answers: [] }));
      await writeFile(path, original);
      const restored = await attempt(() => verifyFrozenText(universe.id, target));
      if (read === 'STALE_TARGET' && submit === 'STALE_TARGET' && restored === 'accepted') {
        ok('feedback: a target whose frozen text no longer reproduces its hashes answers STALE_TARGET to both a read and a response, and reads again once the text is restored');
      } else {
        fail(`feedback/stale: read=${read}, submit=${submit}, restored=${restored}`);
      }
    }

    // 2. Reader identities.
    const reader = await createFeedbackReader({ universeId: universe.id, displayName: 'Ana the reader' });
    const reread = await readFeedbackReader(universe.id, reader.reader_id);
    const beforeUnknown = await countEntries();
    const unknownReader = await attempt(() => submitFeedback({ universeId: universe.id, targetId: target.target_id, readerId: 'reader-0000000000000000', answers: [] }));
    const afterUnknown = await countEntries();
    const roster = await listFeedbackReaders(universe.id);
    if (reread.reader_id === reader.reader_id && reader.schema_version === 'reader-identity.v1' && reader.kind === 'team_human'
      && reader.created_at === reader.last_seen_at && reader.deleted_at === null && roster.length === 1
      && unknownReader === 'READER_NOT_FOUND' && afterUnknown === beforeUnknown) {
      ok(`feedback: a reader is created once with a server-issued stable id (${reader.reader_id}) that survives a re-read, and a response naming an unknown reader answers READER_NOT_FOUND with nothing written`);
    } else {
      fail(`feedback/reader: ${reader.reader_id} vs ${reread.reader_id}, kind=${reader.kind}, roster=${roster.length}, unknown=${unknownReader}, entries ${beforeUnknown}->${afterUnknown}`);
    }

    // 3. A real submission, its retry, a conflicting reuse of the identifier, and refusals.
    const quote = (await readFile(bookFile(CHAPTERS[0]), 'utf8')).slice(0, 120);
    const submission = {
      universeId: universe.id,
      targetId: target.target_id,
      readerId: reader.reader_id,
      feedbackId: 'fb-check-first',
      answers: [
        { question_id: 'interest', value: 5, comment: 'The ledger hook works.' },
        { question_id: 'clarity', value: null }
      ],
      comments: [{ text: 'The opening line does the work.', evidence: [{ file: CHAPTERS[0], start: 0, end: 120 }] }],
      conditions: { where: 'the office', duration_minutes: 12, device: 'laptop', read: 'complete' }
    };
    const written = await submitFeedback(submission);
    const stored = await readFeedback(universe.id, 'fb-check-first');
    const retried = await submitFeedback(submission);
    const conflict = await attempt(() => submitFeedback({ ...submission, comments: [{ text: 'A different opinion, under the same identifier.' }] }));
    const option = await attempt(() => submitFeedback({ ...submission, feedbackId: 'fb-check-option', answers: [{ question_id: 'interest', value: 9 }] }));
    const outside = await attempt(() => submitFeedback({
      ...submission,
      feedbackId: 'fb-check-outside',
      comments: [{ text: 'A passage that is not in the frozen text.', evidence: [{ file: CHAPTERS[0], quote: 'a sentence the book never contained' }] }]
    }));
    const longComment = await attempt(() => submitFeedback({ ...submission, feedbackId: 'fb-check-long', comments: [{ text: 'x'.repeat(4001) }] }));
    const entriesAfter = await countEntries();
    const answer = stored.answers.find((entry) => entry.question_id === 'interest');
    if (written.deduplicated === false && stored.schema_version === 'reader-feedback.v1' && stored.reader_kind === 'team_human'
      && stored.accepted_source_version === target.source_version && stored.scope.kind === 'book' && stored.revision === 1 && stored.revision_of === null
      && stored.historical === false && stored.withdrawn === false && answer?.value === 5 && answer.comment === 'The ledger hook works.'
      && stored.answers.find((entry) => entry.question_id === 'clarity')?.value === null
      && stored.comments[0].evidence[0].quote === quote && stored.conditions.duration_minutes === 12
      && retried.deduplicated === true && retried.feedback.feedback_id === 'fb-check-first' && retried.feedback.created_at === stored.created_at
      && conflict === 'CONFLICT' && option === 'INVALID_FEEDBACK' && outside === 'INVALID_FEEDBACK' && longComment === 'INVALID_FEEDBACK'
      && entriesAfter === 1) {
      ok('feedback: a real submission is stored as team_human with its answers, comments and quoted evidence; an identical retry is deduplicated, different content under the same identifier conflicts, and an undeclared rating, an unresolvable quote and an over-long comment are each refused with nothing written');
    } else {
      fail(`feedback/response: stored=${JSON.stringify({ kind: stored.reader_kind, revision: stored.revision, quote: stored.comments?.[0]?.evidence?.[0]?.quote?.length, answer: answer?.value })} quote=${quote.length}, retried=${retried.deduplicated}, conflict=${conflict}, option=${option}, outside=${outside}, long=${longComment}, entries=${entriesAfter}`);
    }

    // A correction is a new entry that points at the one it replaces; a second correction conflicts.
    const second = await submitFeedback({ ...submission, feedbackId: 'fb-check-second', answers: [{ question_id: 'voice', value: 4 }], comments: [] });
    const correction = await submitFeedback({ ...submission, feedbackId: 'fb-check-correction', revisionOf: 'fb-check-second', answers: [{ question_id: 'voice', value: 3 }], comments: [] });
    const twice = await attempt(() => submitFeedback({ ...submission, feedbackId: 'fb-check-again', revisionOf: 'fb-check-second', answers: [{ question_id: 'voice', value: 2 }] }));
    if (second.feedback.revision === 1 && correction.feedback.revision === 2 && correction.feedback.revision_of === 'fb-check-second'
      && correction.feedback.created_at !== second.feedback.created_at && twice === 'CONFLICT') {
      ok('feedback: a correction is a new entry naming the response it replaces (revision 2 of fb-check-second) and a second correction of the same response answers CONFLICT');
    } else {
      fail(`feedback/revision: first=${second.feedback.revision}, correction=${correction.feedback.revision}/${correction.feedback.revision_of}, twice=${twice}`);
    }

    // A withdrawal keeps the entry, empties its body and is visible in the listing.
    const withdrawn = await withdrawFeedback({ universeId: universe.id, feedbackId: 'fb-check-first' });
    const kept = await readFile(join(entryDir(universe.id, 'fb-check-first'), 'feedback.json'), 'utf8').then((raw) => JSON.parse(raw), () => null);
    const listing = await listFeedback(universe.id);
    const listed = listing.feedback.find((entry) => entry.feedback_id === 'fb-check-first');
    const withdrawnAgain = await withdrawFeedback({ universeId: universe.id, feedbackId: 'fb-check-first' });
    if (withdrawn.withdrawn === true && withdrawn.withdrawn_at && withdrawn.answers.length === 0 && withdrawn.comments.length === 0
      && kept?.withdrawn === true && listed?.withdrawn === true && listed.answers.length === 0 && withdrawnAgain.withdrawn === true
      && listing.counts.withdrawn === 1 && listing.counts.team_human === 2 && listing.counts.active === 2) {
      ok('feedback: a withdrawal keeps the entry on disk, marks it withdrawn with an empty body of answers, is idempotent, and the listing reports it as withdrawn rather than gone');
    } else {
      fail(`feedback/withdraw: withdrawn=${withdrawn.withdrawn}, answers=${withdrawn.answers?.length}, file=${kept?.withdrawn}, listed=${listed?.withdrawn}, counts=${JSON.stringify(listing.counts)}`);
    }

    // 4. A rewrite moves the book to a new version: the old evidence stays readable and historical.
    const beforeRewrite = target.source_version;
    await writeFile(bookFile(CHAPTERS[0]), REWRITTEN, 'utf8');
    const newVersion = await currentVersion(universe.id);
    const oldTarget = await readFeedbackTarget(universe.id, target.target_id);
    const historical = await submitFeedback({ ...submission, feedbackId: 'fb-check-historical', comments: [{ text: 'Read against the older text.', evidence: [{ file: CHAPTERS[0], start: 0, end: 40 }] }] });
    const newTarget = await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } });
    const afterRewrite = await listFeedback(universe.id);
    const newBytes = await readFile(bookFile(CHAPTERS[0]));
    const newChapter = newTarget.target.chapters.find((entry) => entry.path === CHAPTERS[0]);
    const fresh = afterRewrite.targets.find((entry) => entry.target_id === newTarget.target.target_id);
    if (newVersion !== beforeRewrite && oldTarget.historical === true && historical.feedback.historical === true
      && historical.feedback.accepted_source_version === beforeRewrite
      && afterRewrite.feedback.length === 4 && afterRewrite.feedback.every((entry) => entry.historical === true)
      && afterRewrite.targets.length === 2 && afterRewrite.targets.filter((entry) => entry.historical).length === 1 && fresh?.historical === false
      && newTarget.deduplicated === false && newTarget.target.target_id !== target.target_id
      && newTarget.target.source_version === newVersion && newChapter.sha256 === sha256Hex(newBytes)) {
      ok('feedback: after a rewrite the earlier target and its responses are still listed and marked historical, a response to the older text is accepted and marked historical too, and a new target is frozen for the new version with its new hash');
    } else {
      fail(`feedback/historical: ${beforeRewrite?.slice(0, 14)}->${newVersion?.slice(0, 14)}, target=${oldTarget.historical}, response=${historical.feedback.historical}, listed=${afterRewrite.feedback.filter((entry) => entry.historical).length}/${afterRewrite.feedback.length}, targets=${afterRewrite.targets.length}/${afterRewrite.targets.filter((entry) => entry.historical).length}, fresh=${fresh?.historical}, new=${newTarget.target?.target_id}/${newTarget.deduplicated}`);
    }

    // 5. A `feedback/` tree is never enumerated as an assessment run.
    {
      const stray = { schema_version: 'assessment-run.v1', run_id: 'run-inside-feedback', universe_id: universe.id, version: beforeRewrite, status: 'done', created_at: new Date().toISOString() };
      await writeFile(join(root, 'run.json'), JSON.stringify(stray), 'utf8');
      await writeFile(join(targetDir(universe.id, target.target_id), 'run.json'), JSON.stringify(stray), 'utf8');
      const runs = await listAssessments(universe.id);
      const events = await listArcEvents(universe.id);
      const leaked = runs.some((run) => run.run_id === 'run-inside-feedback');
      const stillListed = (await listFeedback(universe.id)).targets.length;
      if (Array.isArray(runs) && !leaked && Array.isArray(events) && events.length === 0 && stillListed === 2) {
        ok(`feedback: a feedback tree carrying a run.json (${runs.length} real runs enumerated) is never listed as an assessment run and never breaks the listing`);
      } else {
        fail(`feedback/enumeration: leaked=${leaked}, runs=${runs.length}, events=${events?.length}, targets=${stillListed}`);
      }
    }

    // 6. Provenance: a model annotation and a synthetic fixture are not team readers.
    {
      const kinds = ['model', 'synthetic'];
      const entries = [];
      for (const kind of kinds) {
        const identity = await createFeedbackReader({ universeId: universe.id, displayName: `${kind} annotation`, kind });
        const entry = await submitFeedback({ ...submission, feedbackId: `fb-check-${kind}`, readerId: identity.reader_id, comments: [] });
        entries.push({ kind, reader: identity.reader_id, readerKind: entry.feedback.reader_kind });
      }
      const counts = (await listFeedback(universe.id)).counts;
      const stored = kinds.every((kind) => entries.some((entry) => entry.kind === kind && entry.readerKind === kind));
      if (stored && counts.model === 1 && counts.synthetic === 1 && counts.team_human === 3 && counts.readers === 1 && counts.responses === 6) {
        ok('feedback: a model annotation and a synthetic fixture are stored with their own reader_kind and neither enters the reader count (1 team reader, 3 team responses)');
      } else {
        fail(`feedback/provenance: kinds=${JSON.stringify(entries)}, counts=${JSON.stringify(counts)}`);
      }
    }

    // A reader asking for deletion: the request is an entry, the identity is marked, and it cannot
    // submit again.
    {
      const deleted = await recordReaderDeletion({ universeId: universe.id, readerId: reader.reader_id, note: 'Please remove my name.' });
      const afterDeletion = await listFeedback(universe.id);
      const refused = await attempt(() => submitFeedback({ ...submission, feedbackId: 'fb-check-after-deletion', readerId: reader.reader_id }));
      const againDeleted = await recordReaderDeletion({ universeId: universe.id, readerId: reader.reader_id });
      if (deleted.entry.request === 'delete_identity' && deleted.entry.reader_id === reader.reader_id && deleted.entry.note === 'Please remove my name.'
        && deleted.reader.deleted_at && deleted.deduplicated === false && againDeleted.deduplicated === true
        && refused === 'READER_NOT_FOUND' && afterDeletion.counts.identity_deletions === 1 && afterDeletion.counts.responses === 6) {
        ok('feedback: asking to be deleted records an entry of its own, marks the identity without erasing it, refuses a later response with READER_NOT_FOUND, and asking twice records nothing twice');
      } else {
        fail(`feedback/deletion: entry=${deleted.entry?.feedback_id}/${deleted.entry?.request}, deleted_at=${deleted.reader?.deleted_at}, again=${againDeleted.deduplicated}, refused=${refused}, counts=${JSON.stringify(afterDeletion.counts)}`);
      }
    }

    // Unknown identifiers never reach the filesystem and never silence the caller.
    {
      const target404 = await attempt(() => readFeedbackTarget(universe.id, 'target-0000000000000000'));
      const traversal = await attempt(() => readFeedbackTarget(universe.id, '../../../universes'));
      const response404 = await attempt(() => withdrawFeedback({ universeId: universe.id, feedbackId: 'fb-check-missing' }));
      const scope = await attempt(() => createFeedbackTarget({ universeId: universe.id, scope: { kind: 'everything' } }));
      if (target404 === 'NOT_FOUND' && traversal === 'NOT_FOUND' && response404 === 'NOT_FOUND' && scope === 'INVALID_FEEDBACK') {
        ok('feedback: an unknown target, an unknown response and a path-like identifier answer NOT_FOUND, and an unknown scope kind answers INVALID_FEEDBACK');
      } else {
        fail(`feedback/not-found: target=${target404}, traversal=${traversal}, response=${response404}, scope=${scope}`);
      }
    }
  } finally {
    await rm(join(assessmentsRoot(), universe.id), { recursive: true, force: true });
  }
}

// The reader-feedback group of `scripts/check.mjs` (`docs/contracts.md` §8.7). It proves, with the real
// store in a temporary universe, the properties the team depends on:
//
//  - a target freezes the accepted version, the chapter hashes and the displayed text byte for byte,
//    outside `universes/`, and a second session against the same version and scope reopens it;
//  - a capture is bound to the version the reader saw: a rewrite between reading and opening the form
//    is refused with `STALE_TARGET` (naming both versions and freezing nothing), the frozen copy of the
//    earlier version is reopened by its own identity, a declared chapter hash that is not the accepted
//    text is refused, and nothing is frozen while a turn is writing;
//  - a reader identity is issued once and stays stable, and a response naming an unknown reader is
//    refused before anything is written;
//  - a real submission is stored as `team_human`, an identical retry is deduplicated by identifier, a
//    different content under that identifier conflicts, a quote that does not resolve inside the frozen
//    file (or an undeclared rating, or an over-long comment) is refused with nothing written, and a
//    withdrawal keeps the entry and hides its answers;
//  - one correction lineage: two simultaneous corrections of one response cannot both commit, an
//    identical retry stays deduplicated, a correction cannot move an answer to another target, and a
//    withdrawal racing a correction leaves exactly one current answer;
//  - a response, not its target, carries the reading session: the report and findings it names, the
//    exposure declarations and the usefulness and defect reactions, with a report of another version
//    or of a scope the target does not display (or a finding that report never published) refused;
//  - a rewrite moves the book to a new version: the earlier target and its responses stay listed and
//    are marked historical, they can still receive a response, and a new target can be frozen;
//  - a `feedback/` tree carrying a `run.json` is never enumerated as an assessment run;
//  - a model annotation and a synthetic fixture are stored with their own provenance and are never
//    counted among the readers who said something.
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assessmentsRoot, currentVersion, universeWorkspace, versionSlug } from '../src/assessment-packet.mjs';
import { cancelAssessment, listArcEvents, listAssessments, reassessAssessment, retryAssessment } from '../src/assessments.mjs';
import {
  createFeedbackTarget,
  feedbackRoot,
  isTargetId,
  readFeedbackTarget,
  readFrozenText,
  targetDir,
  targetFile,
  targetTextDir,
  verifyFrozenText
} from '../src/feedback-targets.mjs';
import { createFeedbackReader, listFeedbackReaders, readFeedbackReader } from '../src/feedback-readers.mjs';
import { entryDir, listFeedback, readFeedback, recordReaderDeletion, submitFeedback, withdrawFeedback } from '../src/feedback-entries.mjs';
import { universeDir } from '../src/paths.mjs';
import { bookWithTwoChapters, sha256Hex, turnRecord } from './check-fixtures.mjs';

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
  // The value a call answered, or the error it refused with: a check reads the refusal's `details`, not
  // only its code, where the machine-readable half of a decision is what the interface acts on.
  const outcome = async (work) => {
    try {
      return { value: await work() };
    } catch (error) {
      return { error };
    }
  };

  try {
    // 1. A book target freezes the accepted version, the chapter hashes and the displayed text.
    const version = await currentVersion(universe.id);
    const first = await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } });
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
    // What one reading session looked at is not part of the shared frozen identity: a target carries the
    // text and the questionnaire, and no report, finding, note or exposure of whoever captured it first.
    const sharedOnly = target.run_id === undefined && target.finding_ids === undefined && target.note === undefined && target.context === undefined
      && target.questionnaire?.reactions?.map((reaction) => `${reaction.id}:${reaction.about}:${reaction.options.join('|')}`).join(',') === 'usefulness:report:1|2|3|4|5,defect_present:text:no|unsure|yes';
    if (target.schema_version === 'reader-feedback-target.v1' && isTargetId(target.target_id) && target.source_version === version
      && target.scope.kind === 'book' && target.scope.chapters.join(',') === '1,2' && target.language === 'en'
      && target.displayed.files.length === 2 && target.chapters.length === 2 && target.questionnaire?.version === 'reader-questionnaire.v1'
      && sharedOnly && identical.every((entry) => entry.copy && entry.hashed)
      && targetDir(universe.id, target.target_id).startsWith(assessmentsRoot()) && !insideBook
      && again.target.target_id === target.target_id && again.deduplicated === true) {
      ok(`feedback: a book target freezes the accepted version, the chapter hashes and the displayed files byte for byte under the workspace (${target.target_id}), keeps only the shared frozen identity and the questionnaire with its two reactions, and a second session reopens it instead of freezing another copy`);
    } else {
      fail(`feedback/target: id=${target.target_id}/${isTargetId(target.target_id)}, version=${target.source_version}/${version}, scope=${target.scope?.kind}:${target.scope?.chapters}, displayed=${target.displayed?.files?.length}, sharedOnly=${sharedOnly}, copy=${JSON.stringify(identical)}, insideBook=${insideBook}, again=${again.target?.target_id}/${again.deduplicated}`);
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

    // 7. A capture is bound to the version the reader actually saw (C77): another client's rewrite
    // between reading and opening the form cannot silently move a whole-text rating onto prose the
    // reader never read, and a turn that is writing freezes nothing at all.
    {
      const versionBefore = await currentVersion(universe.id);
      const shown = [];
      for (const path of CHAPTERS) shown.push({ number: Number(path.slice(9, 13)), sha256: sha256Hex(await readFile(bookFile(path))) });
      const targetCount = async () => (await readdir(join(root, 'targets')).catch(() => [])).length;
      const frozenBefore = await targetCount();
      await writeFile(bookFile(CHAPTERS[1]), '# Two\n\nThe district answered a second time, and the ledger had nothing to say about it.\n\n', 'utf8');
      const versionAfter = await currentVersion(universe.id);
      // The reader read `versionBefore`; the frozen copy of that version still exists, so it is reopened
      // by its own identity instead of freezing today's prose under the reader's answers.
      const reopened = await outcome(() => createFeedbackTarget({
        universeId: universe.id, scope: { kind: 'book' }, sourceVersion: versionBefore, displayed: shown
      }));
      // The same reader, a scope that was never frozen for that version: nothing is frozen under it.
      const unfrozen = await outcome(() => createFeedbackTarget({
        universeId: universe.id, scope: { kind: 'chapter', chapters: [2] }, sourceVersion: versionBefore, displayed: [shown[1]]
      }));
      // The chapter hash the reader displayed is not the accepted text of the chapter it names.
      const hashed = await outcome(() => createFeedbackTarget({
        universeId: universe.id, scope: { kind: 'chapter', chapters: [2] }, displayed: [shown[1]]
      }));
      // A turn is writing this book: the accepted version is not stable, so nothing is frozen for it.
      await turnRecord(universe.id, 9, { status: 'running', kind: 'chapter', chapterNumber: 3 });
      const writing = await outcome(() => createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } }));
      await rm(join(universeDir(universe.id), 'turns', '0009.json'), { force: true });
      const frozenAfter = await targetCount();
      const acceptedHash = sha256Hex(await readFile(bookFile(CHAPTERS[1])));
      const acceptedCapture = await outcome(() => createFeedbackTarget({
        universeId: universe.id, scope: { kind: 'chapter', chapters: [2] }, displayed: [{ number: 2, sha256: acceptedHash }]
      }));
      const frozen = acceptedCapture.value?.target;
      const accepted = frozen?.displayed?.files?.[0];
      // The frozen copy of the version the reader read is still there, byte for byte, and it is not the
      // chapter on screen any more: that is what reopening its text means.
      const earlierCopy = await readFrozenText(universe.id, reopened.value.target, CHAPTERS[1]);
      const currentChapter = await readFile(bookFile(CHAPTERS[1]), 'utf8');
      const historical = earlierCopy?.text ?? null;
      if (reopened.value?.reopened === true && reopened.value.target.target_id === newTarget.target.target_id
        && reopened.value.target.source_version === versionBefore && reopened.value.target.historical === true && reopened.value.deduplicated === true
        && versionAfter !== versionBefore && frozenBefore === 2 && frozenAfter === 2
        && unfrozen.error?.code === 'STALE_TARGET' && unfrozen.error.details?.requested_version === versionBefore
        && unfrozen.error.details?.accepted_version === versionAfter && unfrozen.error.details?.target_id === null
        && hashed.error?.code === 'STALE_TARGET' && hashed.error.details?.chapter === 2
        && writing.error?.code === 'STALE_TARGET'
        && frozen?.source_version === versionAfter && accepted?.path === CHAPTERS[1]
        && accepted?.sha256 === acceptedHash
        && typeof historical === 'string' && sha256Hex(Buffer.from(historical, 'utf8')) === newTarget.target.chapters.find((entry) => entry.path === CHAPTERS[1]).sha256
        && historical !== currentChapter && currentChapter.includes('answered a second time')) {
        ok(`feedback/capture: a rewrite between reading and opening the form froze nothing for the version the reader read (STALE_TARGET naming ${versionBefore.slice(0, 12)}… → ${versionAfter.slice(0, 12)}…), reopened the frozen copy of that version by its own identity instead, refused a displayed chapter hash that is not the accepted text, froze nothing while a turn was writing, and froze the accepted chapter once the reader declared its real hash`);
      } else {
        fail(`feedback/capture: reopened=${reopened.value?.target?.target_id}/${reopened.value?.reopened}/${reopened.value?.target?.source_version?.slice(0, 14)}, unfrozen=${unfrozen.error?.code}/${JSON.stringify(unfrozen.error?.details)}, hashed=${hashed.error?.code}/${JSON.stringify(hashed.error?.details)}, writing=${writing.error?.code}, targets=${frozenBefore}->${frozenAfter}, frozen=${frozen?.source_version?.slice(0, 14)}/${accepted?.sha256?.slice(0, 12)}, reopenedError=${reopened.error?.message}`);
      }
    }

    // 8. One correction lineage (C79): the parent, its reader, its target and the absence of another
    // correction are validated inside the same serialized transaction as the write, so two simultaneous
    // corrections of one response cannot both commit and a correction cannot move an answer elsewhere.
    {
      const corrector = await createFeedbackReader({ universeId: universe.id, displayName: 'A reader correcting' });
      const line = { universeId: universe.id, targetId: target.target_id, readerId: corrector.reader_id };
      await submitFeedback({ ...line, feedbackId: 'fb-lineage-parent', answers: [{ question_id: 'interest', value: 2 }] });
      const [siblingA, siblingB] = await Promise.all([
        outcome(() => submitFeedback({ ...line, feedbackId: 'fb-lineage-a', revisionOf: 'fb-lineage-parent', answers: [{ question_id: 'interest', value: 3 }] })),
        outcome(() => submitFeedback({ ...line, feedbackId: 'fb-lineage-b', revisionOf: 'fb-lineage-parent', answers: [{ question_id: 'interest', value: 4 }] }))
      ]);
      const afterSiblings = (await listFeedback(universe.id)).feedback;
      const children = afterSiblings.filter((entry) => entry.revision_of === 'fb-lineage-parent');
      const winner = siblingA.value ? 'fb-lineage-a' : 'fb-lineage-b';
      const winnerAnswer = winner === 'fb-lineage-a' ? 3 : 4;
      const loser = (siblingA.value ? siblingB.error : siblingA.error)?.code;
      const retried = await outcome(() => submitFeedback({ ...line, feedbackId: winner, revisionOf: 'fb-lineage-parent', answers: [{ question_id: 'interest', value: winnerAnswer }] }));
      const duplicates = (await listFeedback(universe.id)).feedback.filter((entry) => entry.feedback_id === winner).length;
      // A correction answers the reading its parent answered: the same frozen copy and not another one.
      await submitFeedback({ ...line, feedbackId: 'fb-lineage-lonely', answers: [{ question_id: 'interest', value: 1 }] });
      const moved = await outcome(() => submitFeedback({ ...line, targetId: newTarget.target.target_id, feedbackId: 'fb-lineage-moved', revisionOf: 'fb-lineage-lonely', answers: [{ question_id: 'interest', value: 5 }] }));
      // A withdrawal racing a correction: whichever commits first, the lineage keeps one current answer.
      await submitFeedback({ ...line, feedbackId: 'fb-lineage-race', answers: [{ question_id: 'interest', value: 2 }] });
      const [takenBack, corrected] = await Promise.all([
        outcome(() => withdrawFeedback({ universeId: universe.id, feedbackId: 'fb-lineage-race' })),
        outcome(() => submitFeedback({ ...line, feedbackId: 'fb-lineage-race-child', revisionOf: 'fb-lineage-race', answers: [{ question_id: 'interest', value: 3 }] }))
      ]);
      const raced = (await listFeedback(universe.id)).feedback;
      const raceParent = raced.find((entry) => entry.feedback_id === 'fb-lineage-race');
      const raceChildren = raced.filter((entry) => entry.revision_of === 'fb-lineage-race');
      const currentAnswer = raceChildren[0] ?? (raceParent?.withdrawn === true ? null : raceParent ?? null);
      if (children.length === 1 && children[0].feedback_id === winner && children[0].revision === 2 && loser === 'CONFLICT'
        && retried.value?.deduplicated === true && duplicates === 1
        && moved.error?.code === 'INVALID_FEEDBACK' && String(moved.error.message).includes(target.target_id)
        && takenBack.value?.withdrawn === true && raceChildren.length <= 1 && raceParent?.withdrawn === true
        && (corrected.value ? currentAnswer?.feedback_id === 'fb-lineage-race-child' && currentAnswer.withdrawn === false : currentAnswer === null)) {
        ok(`feedback/lineage: two simultaneous corrections of one response (fb-lineage-a, fb-lineage-b) left exactly one child (${winner}, revision 2) with the other answering CONFLICT, an identical retry of ${winner} stayed deduplicated instead of writing twice, a correction naming another target was refused, and a withdrawal racing a correction left one current answer`);
      } else {
        fail(`feedback/lineage: children=${JSON.stringify(children.map((entry) => [entry.feedback_id, entry.revision]))}, loser=${loser}, retried=${retried.value?.deduplicated}, duplicates=${duplicates}, moved=${moved.error?.code}/${moved.error?.message}, takenBack=${takenBack.value?.withdrawn}/${takenBack.error?.code}, race=${raceChildren.length}/${raceParent?.withdrawn}, corrected=${corrected.value?.feedback?.feedback_id ?? corrected.error?.code}, current=${currentAnswer?.feedback_id ?? 'none'}`);
      }
    }

    // 9. What one reading session looked at belongs to its response (C80): the target stays the shared
    // frozen identity while the report, the findings, the exposure declarations and the usefulness and
    // defect reactions are stored on the response that made them.
    {
      const version = await currentVersion(universe.id);
      const writeRun = async (runId, { phase, version: runVersion, scope }, findings) => {
        const directory = join(universeWorkspace(universe.id), versionSlug(runVersion), runId);
        await mkdir(join(directory, 'result'), { recursive: true });
        await writeFile(join(directory, 'result', 'assessment.json'), `${JSON.stringify({ schema_version: 'assessment-report.v1', findings }, null, 2)}\n`, 'utf8');
        await writeFile(join(directory, 'run.json'), `${JSON.stringify({
          schema_version: 'assessment-run.v1',
          run_id: runId,
          universe_id: universe.id,
          phase,
          version: runVersion,
          scope,
          status: 'done',
          result_dir: join(universe.id, versionSlug(runVersion), runId, 'result'),
          outputs: ['assessment.json']
        }, null, 2)}\n`, 'utf8');
      };
      await writeRun('run-feedback-report', { phase: 'metrics', version, scope: { kind: 'partial', chapters: [2], omitted: [1] } }, [{ id: 'f-report-one' }, { id: 'f-report-two' }]);
      await writeRun('run-feedback-wide', { phase: 'continuity', version, scope: { kind: 'complete', chapters: [1, 2] } }, [{ id: 'f-wide' }]);
      await writeRun('run-feedback-old', { phase: 'metrics', version: beforeRewrite, scope: { kind: 'complete', chapters: [1, 2] } }, [{ id: 'f-old' }]);
      const chapterTarget = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'chapter', chapters: [2] } })).target;
      const assisted = await createFeedbackReader({ universeId: universe.id, displayName: 'A reader with a report' });
      const unaided = await createFeedbackReader({ universeId: universe.id, displayName: 'A reader without one' });
      const targetBytes = await readFile(targetFile(universe.id, chapterTarget.target_id), 'utf8');
      const session = {
        universeId: universe.id,
        targetId: chapterTarget.target_id,
        readerId: assisted.reader_id,
        feedbackId: 'fb-session-assisted',
        runId: 'run-feedback-report',
        findingIds: ['f-report-one'],
        note: 'Read after the report.',
        conditions: { where: 'the office', exposure: { model_scores: true, other_comments: false } },
        reactions: { usefulness: { value: 4, comment: 'It named the passage I had marked.' }, defect_present: { value: 'yes' } }
      };
      const assistedSaved = await outcome(() => submitFeedback(session));
      const unaidedSaved = await outcome(() => submitFeedback({
        universeId: universe.id,
        targetId: chapterTarget.target_id,
        readerId: unaided.reader_id,
        feedbackId: 'fb-session-unaided',
        answers: [{ question_id: 'interest', value: 5 }]
      }));
      const refused = {
        unknownFinding: await outcome(() => submitFeedback({ ...session, feedbackId: 'fb-session-finding', findingIds: ['f-report-two', 'f-report-three'] })),
        findingWithoutReport: await outcome(() => submitFeedback({ ...session, feedbackId: 'fb-session-detached', runId: null })),
        otherVersion: await outcome(() => submitFeedback({ ...session, feedbackId: 'fb-session-oldversion', runId: 'run-feedback-old', findingIds: ['f-old'] })),
        widerScope: await outcome(() => submitFeedback({ ...session, feedbackId: 'fb-session-wide', runId: 'run-feedback-wide', findingIds: ['f-wide'] })),
        usefulnessAlone: await outcome(() => submitFeedback({ ...session, feedbackId: 'fb-session-usefulness', runId: null, findingIds: [], reactions: { usefulness: { value: 3 } } })),
        undeclaredOption: await outcome(() => submitFeedback({ ...session, feedbackId: 'fb-session-option', reactions: { defect_present: { value: 'maybe' } } })),
        undeclaredReaction: await outcome(() => submitFeedback({ ...session, feedbackId: 'fb-session-reaction', reactions: { helpfulness: { value: 1 } } }))
      };
      const targetBytesAfter = await readFile(targetFile(universe.id, chapterTarget.target_id), 'utf8');
      const stored = (await listFeedback(universe.id)).feedback;
      const assistedRow = stored.find((entry) => entry.feedback_id === 'fb-session-assisted');
      const unaidedRow = stored.find((entry) => entry.feedback_id === 'fb-session-unaided');
      const sessions = stored.filter((entry) => String(entry.feedback_id).startsWith('fb-session-')).length;
      const refusals = Object.values(refused).map((entry) => entry.error?.code);
      if (assistedSaved.value?.feedback?.run_id === 'run-feedback-report' && assistedSaved.value.feedback.finding_ids.join(',') === 'f-report-one'
        && assistedSaved.value.feedback.note === 'Read after the report.'
        && assistedRow?.language === chapterTarget.language && assistedRow?.accepted_source_version === chapterTarget.source_version
        && assistedSaved.value.feedback.conditions.exposure.model_scores === true && assistedSaved.value.feedback.conditions.exposure.other_comments === false
        && assistedSaved.value.feedback.reactions.usefulness.value === 4 && assistedSaved.value.feedback.reactions.usefulness.comment === 'It named the passage I had marked.'
        && assistedSaved.value.feedback.reactions.defect_present.value === 'yes'
        && unaidedSaved.value?.feedback?.run_id === null && unaidedRow?.finding_ids.length === 0
        && unaidedRow?.conditions.exposure.model_scores === null && unaidedRow.conditions.exposure.other_comments === null
        && unaidedRow?.reactions.usefulness === null && unaidedRow.reactions.defect_present === null
        && targetBytes === targetBytesAfter && sessions === 2
        && refusals.every((code) => code === 'INVALID_FEEDBACK') && String(refused.unknownFinding.error.message).includes('f-report-three')) {
        ok('feedback/session: two readers of one frozen target stored their own sessions — the report and finding one reader was looking at, the usefulness and defect reactions, the note, and the exposure declarations (model scores seen, other comments not) — while the other reader inherits none of it and the target file is byte-identical; a finding that report never published, a finding with no report, a report of another version, a report about a chapter the target does not display, a usefulness reaction with no report, an undeclared option and an undeclared reaction are each refused with nothing written');
      } else {
        fail(`feedback/session: assisted=${JSON.stringify({ run: assistedSaved.value?.feedback?.run_id, findings: assistedSaved.value?.feedback?.finding_ids, note: assistedSaved.value?.feedback?.note, exposure: assistedSaved.value?.feedback?.conditions?.exposure, reactions: assistedSaved.value?.feedback?.reactions, error: assistedSaved.error?.message })}, unaided=${JSON.stringify({ run: unaidedRow?.run_id, findings: unaidedRow?.finding_ids, exposure: unaidedRow?.conditions?.exposure, reactions: unaidedRow?.reactions, error: unaidedSaved.error?.message })}, target=${targetBytes === targetBytesAfter}, sessions=${sessions}, refusals=${JSON.stringify(Object.entries(refused).map(([key, entry]) => [key, entry.error?.code ?? 'accepted']))}`);
      }
    }
    // 10. A published assessment is kept as it was (C76): the retry route refuses it and points at
    // re-evaluation, and the reassessment is a new run over the same frozen packet naming the old one.
    {
      const version = await currentVersion(universe.id);
      const runId = 'run-feedback-published';
      const directory = join(universeWorkspace(universe.id), versionSlug(version), runId);
      const scope = { kind: 'complete', chapters: [1, 2], omitted: [] };
      await mkdir(join(directory, 'input'), { recursive: true });
      await mkdir(join(directory, 'result'), { recursive: true });
      await writeFile(join(directory, 'input', 'manifest.json'), `${JSON.stringify({
        schema_version: 'assessment-input.v2',
        universe_id: universe.id,
        version,
        captured_at: new Date().toISOString(),
        book: { title: 'A published report', language: 'en', last_accepted_chapter: 2 },
        scope,
        files: []
      }, null, 2)}\n`, 'utf8');
      await writeFile(join(directory, 'result', 'assessment.json'), '{"schema_version":"assessment-report.v1","findings":[{"id":"f-kept"}]}\n', 'utf8');
      const published = `${JSON.stringify({
        schema_version: 'assessment-run.v1',
        run_id: runId,
        universe_id: universe.id,
        phase: 'metrics',
        trigger: 'requested',
        version,
        scope,
        status: 'done',
        annotation_mode: 'none',
        input_dir: `${universe.id}/${versionSlug(version)}/${runId}/input`,
        result_dir: `${universe.id}/${versionSlug(version)}/${runId}/result`,
        outputs: ['assessment.json'],
        attempts: 1,
        created_at: new Date().toISOString()
      }, null, 2)}\n`;
      await writeFile(join(directory, 'run.json'), published, 'utf8');
      const resultBefore = await readFile(join(directory, 'result', 'assessment.json'), 'utf8');
      const refused = await outcome(() => retryAssessment(universe.id, runId));
      const resultAfter = await readFile(join(directory, 'result', 'assessment.json'), 'utf8');
      const recordAfter = await readFile(join(directory, 'run.json'), 'utf8');
      const newRun = await outcome(() => reassessAssessment(universe.id, runId, { annotations: 'reuse' }));
      const reassessed = newRun.value;
      // The new run's child is stopped and waited for before this group removes its workspace, so a
      // re-evaluation that already started cannot write into a directory that is being deleted.
      if (reassessed?.run_id) await outcome(() => cancelAssessment(universe.id, reassessed.run_id));
      if (refused.error?.code === 'ALREADY_PUBLISHED' && String(refused.error.message).includes('Re-evaluate')
        && resultAfter === resultBefore && recordAfter === published
        && reassessed?.run_id !== runId && reassessed?.reassesses_run_id === runId && reassessed?.version === version
        && typeof reassessed?.status === 'string' && reassessed?.result_dir !== null
        && (await readFile(join(universeWorkspace(universe.id), versionSlug(version), runId, 'run.json'), 'utf8')) === published) {
        ok(`feedback/immutability: retrying a published assessment (${runId}) answers 409 ALREADY_PUBLISHED and points at re-evaluation, its result directory and run record are byte-identical afterwards, and the reassessment is a new run (${reassessed.run_id}) whose record carries reassesses_run_id=${runId} over the same version`);
      } else {
        fail(`feedback/immutability: refused=${refused.error?.code}/${refused.error?.message}, result=${resultAfter === resultBefore}, record=${recordAfter === published}, reassessed=${reassessed?.run_id}/${reassessed?.reassesses_run_id}/${reassessed?.status}/${reassessed?.version?.slice(0, 14)}, error=${newRun.error?.code}/${newRun.error?.message}`);
      }
    }
  } finally {
    // A re-evaluated run may still be releasing its child; a workspace that cannot be emptied here is
    // removed by the caller's own cleanup instead of failing this group.
    await rm(join(assessmentsRoot(), universe.id), { recursive: true, force: true }).catch(() => {});
  }
}

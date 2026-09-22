// The reader-feedback export and summary group of `scripts/check.mjs` (`docs/contracts.md` §8.7). It
// builds a real feedback store in a temporary universe — readers, two frozen targets, answers with a
// skip, a correction, a withdrawal, an identity deletion, a model response and a synthetic fixture —
// and proves, through the public functions only:
//
//  - the export round-trips through its own bytes and is reproducible: the same book exported twice
//    with nothing changed is byte-identical, and the identifiers, accepted versions, scope,
//    questionnaire version, lineage and provenance are all in the document;
//  - the export carries no prose of the book — no path holds text, only hashes and the reader's own
//    words — and every quoted range in it resolves inside the target it belongs to;
//  - the summary reports how many readers answered, the distribution of every answer per accepted
//    version and per provenance, the answers that were skipped and the ones left unmentioned, and it
//    keeps a model's annotation and a synthetic fixture out of the readers' numbers;
//  - a summary that would have to compare two versions, or to state a trend from a handful of
//    responses, refuses with its reason and the counts it would need, instead of producing a number;
//  - an unknown book answers NOT_FOUND and a book with no response answers NO_FEEDBACK, and neither an
//    export nor a summary writes anything: the feedback tree is byte-identical afterwards;
//  - while a turn of the book is queued the accepted version cannot be read, so both report
//    `version_stable: false` with `historical: null` instead of guessing which text is current.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessmentsRoot, currentVersion } from '../src/assessment-packet.mjs';
import { createFeedbackTarget, feedbackRoot, readFrozenText, targetTextDir } from '../src/feedback-targets.mjs';
import { createFeedbackReader } from '../src/feedback-readers.mjs';
import { recordReaderDeletion, submitFeedback, withdrawFeedback } from '../src/feedback-entries.mjs';
import { buildFeedbackExport, feedbackExportDownload, serializeFeedbackExport } from '../src/feedback-export.mjs';
import { MIN_ANSWERED_FOR_MEAN, MIN_ANSWERED_PER_VERSION, buildFeedbackSummary } from '../src/feedback-summary.mjs';
import { rootDir, universeDir } from '../src/paths.mjs';
import { bookWithTwoChapters, sha256Hex, turnRecord } from './check-fixtures.mjs';

const CHAPTERS = ['chapters/0001-one.md', 'chapters/0002-two.md'];
const REWRITTEN = '# One\n\nThe ledger was read again, and this time the district hummed a different note.\n\n';

/** The content identity of a directory tree: what a read-only feature must leave untouched. */
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

const runCommand = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error.message) }));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

const numbersFor = (question, version) =>
  question?.versions.find((entry) => entry.accepted_version === version)?.provenance ?? null;

export async function runFeedbackExportChecks({ ok, fail, checkSeed = `check-${Date.now().toString(36)}`, tempDirs = [] }) {
  const universe = await bookWithTwoChapters(checkSeed, 'feedback-export');
  const empty = await bookWithTwoChapters(checkSeed, 'feedback-export-empty');
  tempDirs.push(universe.id, empty.id);
  const bookFile = (path) => join(universeDir(universe.id), path);
  const attempt = async (work) => {
    try {
      await work();
      return 'accepted';
    } catch (error) {
      return error?.code ?? String(error?.message ?? error);
    }
  };

  try {
    // The store: two targets (one per accepted version), four team readers, a model annotation, a
    // synthetic fixture, a skip, a correction, a withdrawal and an identity deletion.
    const target1 = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } })).target;
    const version1 = await currentVersion(universe.id);
    const ana = await createFeedbackReader({ universeId: universe.id, displayName: 'Ana' });
    const bogdan = await createFeedbackReader({ universeId: universe.id, displayName: 'Bogdan' });
    const corina = await createFeedbackReader({ universeId: universe.id, displayName: 'Corina' });
    const dana = await createFeedbackReader({ universeId: universe.id, displayName: 'Dana' });
    const model = await createFeedbackReader({ universeId: universe.id, displayName: 'Annotation model', kind: 'model' });
    const synthetic = await createFeedbackReader({ universeId: universe.id, displayName: 'Fixture pass', kind: 'synthetic' });
    const base = { universeId: universe.id, targetId: target1.target_id };
    await submitFeedback({
      ...base,
      feedbackId: 'fb-fx-ana-first',
      readerId: ana.reader_id,
      answers: [
        { question_id: 'interest', value: 5, comment: 'The ledger hook works.' },
        { question_id: 'clarity', value: null },
        { question_id: 'voice', value: 4 }
      ],
      comments: [{ text: 'The opening line does the work.', evidence: [{ file: CHAPTERS[0], start: 0, end: 120 }] }],
      conditions: { where: 'the office', duration_minutes: 12, device: 'laptop', read: 'complete' }
    });
    await submitFeedback({
      ...base,
      feedbackId: 'fb-fx-ana-correction',
      readerId: ana.reader_id,
      revisionOf: 'fb-fx-ana-first',
      answers: [
        { question_id: 'interest', value: 4 },
        { question_id: 'clarity', value: null },
        { question_id: 'voice', value: 4 }
      ],
      comments: [{ text: 'The same opinion, read twice.', evidence: [{ file: CHAPTERS[0], quote: '# One' }] }]
    });
    await submitFeedback({
      ...base,
      feedbackId: 'fb-fx-bogdan',
      readerId: bogdan.reader_id,
      answers: [{ question_id: 'interest', value: 3 }, { question_id: 'clarity', value: 2 }],
      comments: [{ text: 'Firm but plain.', evidence: [{ file: CHAPTERS[1], start: 0, end: 40 }] }]
    });
    await submitFeedback({ ...base, feedbackId: 'fb-fx-corina', readerId: corina.reader_id, answers: [{ question_id: 'interest', value: 2 }] });
    await submitFeedback({ ...base, feedbackId: 'fb-fx-dana', readerId: dana.reader_id, answers: [{ question_id: 'continue', value: 5 }] });
    await submitFeedback({
      ...base,
      feedbackId: 'fb-fx-taken-back',
      readerId: ana.reader_id,
      answers: [{ question_id: 'interest', value: 1 }, { question_id: 'continue', value: 1 }]
    });
    await withdrawFeedback({ universeId: universe.id, feedbackId: 'fb-fx-taken-back' });
    await submitFeedback({ ...base, feedbackId: 'fb-fx-model', readerId: model.reader_id, answers: [{ question_id: 'interest', value: 1 }] });
    await submitFeedback({
      ...base,
      feedbackId: 'fb-fx-synthetic',
      readerId: synthetic.reader_id,
      answers: [{ question_id: 'interest', value: 5 }, { question_id: 'voice', value: 5 }]
    });
    await recordReaderDeletion({ universeId: universe.id, readerId: dana.reader_id, note: 'Please remove my name.' });
    // A rewrite moves the book to a second accepted version, with a target of its own.
    await writeFile(bookFile(CHAPTERS[0]), REWRITTEN, 'utf8');
    const version2 = await currentVersion(universe.id);
    const target2 = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } })).target;
    await submitFeedback({
      universeId: universe.id,
      targetId: target2.target_id,
      feedbackId: 'fb-fx-ana-second-reading',
      readerId: ana.reader_id,
      answers: [{ question_id: 'interest', value: 4 }, { question_id: 'clarity', value: 4 }]
    });
    const before = await treeDigest(feedbackRoot(universe.id));
    const bookBefore = await treeDigest(universeDir(universe.id));

    // 1. The export round-trips through its own bytes and the same store exports identically twice.
    const document = await buildFeedbackExport(universe.id);
    const text = serializeFeedbackExport(document);
    const parsed = JSON.parse(text);
    const again = await buildFeedbackExport(universe.id);
    const download = await feedbackExportDownload(universe.id);
    const anaCorrection = document.responses.find((entry) => entry.feedback_id === 'fb-fx-ana-correction');
    const superseded = document.responses.find((entry) => entry.feedback_id === 'fb-fx-ana-first');
    const takenBack = document.responses.find((entry) => entry.feedback_id === 'fb-fx-taken-back');
    const modelEntry = document.responses.find((entry) => entry.feedback_id === 'fb-fx-model');
    if (document.schema_version === 'reader-feedback-export.v1'
      && JSON.stringify(parsed) === JSON.stringify(document)
      && serializeFeedbackExport(again) === text
      && download.body.equals(Buffer.from(text, 'utf8')) && download.name === `${universe.id}-feedback-export.json`
      && document.universe_id === universe.id && document.book.accepted_version === version2
      && document.book.version_stable === true && document.book.chapters === 2
      && document.counts.records.responses === 9 && document.counts.records.identity_deletions === 1
      && JSON.stringify(document.counts.responses) === JSON.stringify({ team_human: 7, model: 1, synthetic: 1 })
      && JSON.stringify(document.counts.withdrawn) === JSON.stringify({ team_human: 1, model: 0, synthetic: 0 })
      && JSON.stringify(document.counts.superseded) === JSON.stringify({ team_human: 1, model: 0, synthetic: 0 })
      && document.questionnaires.length === 1 && document.questionnaires[0].questions.length === 5
      && document.targets.length === 2 && document.targets.every((target) => target.displayed.files.length === 2)
      && document.targets.filter((target) => target.historical === true).length === 1
      && document.responses.length === 9 && document.identity_deletions.length === 1
      && anaCorrection.revision_of === 'fb-fx-ana-first' && anaCorrection.revision === 2 && anaCorrection.superseded === false
      && superseded.superseded === true && superseded.revision === 1
      && takenBack.withdrawn === true && takenBack.answers.length === 0
      && modelEntry.reader_kind === 'model' && modelEntry.questionnaire_version === 'reader-questionnaire.v1'
      && modelEntry.historical === true && modelEntry.scope.kind === 'book' && modelEntry.language === 'en'
      && document.responses.find((entry) => entry.feedback_id === 'fb-fx-ana-second-reading').historical === false) {
      ok(`feedback export: the dataset of the book round-trips through its own bytes and is byte-identical when exported twice (${text.length} bytes, 2 targets, 9 responses, 1 model annotation, 1 synthetic fixture, 1 withdrawal, 1 correction, 1 deletion request)`);
    } else {
      fail(`feedback export/reproducible: bytes=${text.length}, roundtrip=${JSON.stringify(parsed) === JSON.stringify(document)}, same=${serializeFeedbackExport(again) === text}, counts=${JSON.stringify(document.counts)}, targets=${document.targets.length}, responses=${document.responses.length}, lineage=${anaCorrection.revision_of}/${anaCorrection.superseded}/${superseded.superseded}/${takenBack.withdrawn}`);
    }

    // 2. No prose of the book travels in the export, and every quoted range resolves where it belongs.
    {
      const prose = [];
      for (const path of CHAPTERS) prose.push(await readFile(bookFile(path), 'utf8'));
      for (const name of await readdir(targetTextDir(universe.id, target1.target_id))) {
        prose.push(await readFile(join(targetTextDir(universe.id, target1.target_id), name), 'utf8'));
      }
      const quoted = [];
      let resolved = 0;
      let mismatched = 0;
      for (const response of document.responses) {
        const target = document.targets.find((entry) => entry.target_id === response.target_id);
        for (const comment of response.comments) {
          for (const range of comment.evidence) {
            quoted.push(range);
            const frozen = await readFrozenText(universe.id, target, range.file);
            if (frozen && frozen.text.slice(range.start, range.end) === range.quote && range.quote.length > 0) resolved += 1;
            else mismatched += 1;
          }
        }
      }
      const hashed = document.targets.every((target) => target.displayed.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
      const carriesProse = prose.some((value) => text.includes(value)) || prose.some((value) => text.includes(value.slice(0, 200)));
      if (!carriesProse && resolved === quoted.length && resolved >= 2 && mismatched === 0 && hashed
        && document.targets.every((target) => target.displayed.files.every((file) => file.bytes > 0))) {
        ok(`feedback export: no chapter text, no frozen text and no book prose appears anywhere in the dataset (only paths and hashes), and all ${resolved} quoted ranges resolve at their offsets inside the target they name`);
      } else {
        fail(`feedback export/prose: carriesProse=${carriesProse}, resolved=${resolved}/${quoted.length}, mismatched=${mismatched}, hashed=${hashed}`);
      }
    }

    // 3. The summary reports readers, skips and distributions, and keeps provenance apart.
    const summary = await buildFeedbackSummary(universe.id);
    const question = (id) => summary.questions.find((entry) => entry.question_id === id);
    const interestFirst = numbersFor(question('interest'), version1);
    const clarityFirst = numbersFor(question('clarity'), version1);
    const emotionFirst = numbersFor(question('emotion'), version1);
    const interestSecond = numbersFor(question('interest'), version2);
    const teamOne = summary.questions.some((entry) => entry.versions.some((group) => (group.provenance.team_human.distribution['1'] ?? 0) > 0));
    const ana2 = summary.readers.find((reader) => reader.reader_id === ana.reader_id);
    if (summary.schema_version === 'reader-feedback-summary.v1' && summary.counts.readers.team_human === 4
      && summary.counts.readers_answered.team_human === 4 && summary.counts.readers_answered.model === 1
      && summary.counts.readers_answered.synthetic === 1
      && summary.counts.responses.team_human === 7 && JSON.stringify(summary.counts.current) === JSON.stringify({ team_human: 5, model: 1, synthetic: 1 })
      && summary.counts.withdrawn.team_human === 1
      && summary.counts.superseded.team_human === 1 && summary.counts.identity_deletions === 1
      && summary.versions.length === 2 && summary.targets.length === 2 && summary.questions.length === 5
      && interestFirst.team_human.answered === MIN_ANSWERED_FOR_MEAN && interestFirst.team_human.mean === 3
      && interestFirst.team_human.mean_note === null
      && JSON.stringify(interestFirst.team_human.distribution) === JSON.stringify({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 0 })
      && interestFirst.team_human.not_mentioned === 1
      && interestFirst.model.answered === 1 && interestFirst.model.mean === null
      && interestFirst.model.mean_note.includes(String(MIN_ANSWERED_FOR_MEAN))
      && JSON.stringify(interestFirst.model.distribution) === JSON.stringify({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 })
      && JSON.stringify(interestFirst.synthetic.distribution) === JSON.stringify({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 })
      && clarityFirst.team_human.answered === 1 && clarityFirst.team_human.skipped === 1 && clarityFirst.team_human.not_mentioned === 2
      && clarityFirst.team_human.mean === null && emotionFirst.team_human.answered === 0 && emotionFirst.team_human.not_mentioned === 4
      && interestSecond.team_human.answered === 1 && JSON.stringify(interestSecond.team_human.distribution) === JSON.stringify({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 })
      && question('interest').versions.length === 2 && question('clarity').versions.length === 2
      && teamOne === false && ana2.answered === 4 && ana2.counting === 2 && typeof ana2.note === 'string'
      && summary.readers.find((reader) => reader.reader_id === dana.reader_id)?.deleted_at !== null) {
      ok(`feedback summary: ${summary.counts.readers_answered.team_human} team readers answered (of ${summary.counts.readers.team_human} who submitted), interest is reported per version with its whole distribution (3 answered on the older text, mean ${interestFirst.team_human.mean}), clarity shows 1 answered and 1 skipped, emotion shows nothing answered and 4 unmentioned, and the model's rating is counted apart and never inside a reader's distribution`);
    } else {
      fail(`feedback summary/counts: counts=${JSON.stringify(summary.counts)}, versions=${summary.versions.length}, interest=${JSON.stringify(interestFirst?.team_human)}, model=${JSON.stringify(interestFirst?.model)}, clarity=${JSON.stringify(clarityFirst?.team_human)}, emotion=${JSON.stringify(emotionFirst?.team_human)}, second=${JSON.stringify(interestSecond?.team_human)}, teamOne=${teamOne}`);
    }

    // 4. A comparison between two versions and a trend are refused with their reason, never a number.
    {
      const refusal = (claim, subject) => summary.refusals.find((entry) => entry.claim === claim && (subject === undefined || entry.subject === subject));
      const interest = refusal('comparison', 'interest');
      const clarity = refusal('comparison', 'clarity');
      const trend = refusal('trend');
      const population = refusal('population');
      const numbersStayInVersions = summary.questions.every((entry) => entry.mean === undefined
        && entry.distribution === undefined && entry.provenance === undefined
        && entry.versions.every((group) => group.accepted_version && group.provenance));
      if (interest?.reason_code === 'MIN_ANSWERED_PER_VERSION' && interest.reason.includes(`3 against ${version1}`)
        && interest.reason.includes(String(MIN_ANSWERED_PER_VERSION)) && clarity?.reason_code === 'MIN_ANSWERED_PER_VERSION'
        && interest.reason.includes(version1) && interest.reason.includes(version2)
        && trend?.reason_code === 'NEED_REPEATED_READINGS' && trend.reason.includes('answered team response')
        && population?.reason_code === 'NON_RESPONDENTS_UNKNOWN' && population.reason.includes('4 team readers')
        && summary.refusals.length === 4 && numbersStayInVersions
        && summary.limitations.some((entry) => entry.includes('withdrawn'))
        && summary.limitations.some((entry) => entry.includes('superseded'))
        && summary.limitations.some((entry) => entry.includes('identity deletion'))
        && summary.limitations.some((entry) => entry.includes('single response'))
        && summary.limitations.some((entry) => entry.includes('fewer than all 5 questions'))) {
        ok(`feedback summary: a comparison of interest between the two accepted versions is refused with its reason (${interest.reason_code}: at least ${MIN_ANSWERED_PER_VERSION} answered responses per version, it has ${interest.reason.match(/answered by [^;]*/)?.[0] ?? 'the counts'}), the trend and the claim about the team are refused with theirs, and no number anywhere mixes two versions or two provenances (${summary.refusals.length} refusals, ${summary.limitations.length} stated limits)`);
      } else {
        fail(`feedback summary/refusals: ${JSON.stringify(summary.refusals)}, limits=${JSON.stringify(summary.limitations)}, numbersStayInVersions=${numbersStayInVersions}`);
      }
    }

    // The one command produces the same bytes as the route, and a summary it can keep.
    {
      const printed = await runCommand(['scripts/export-feedback.mjs', '--universe', universe.id]);
      const directory = await mkdtemp(join(tmpdir(), 'scripta-feedback-export-'));
      const out = join(directory, 'feedback.json');
      const written = await runCommand(['scripts/export-feedback.mjs', '--universe', universe.id, '--out', out]);
      const summaryRun = await runCommand(['scripts/export-feedback.mjs', '--universe', universe.id, '--summary']);
      const report = (() => {
        try {
          return JSON.parse(written.stdout.trim().split('\n').pop());
        } catch {
          return null;
        }
      })();
      const fromFile = await readFile(out, 'utf8').catch(() => null);
      const summaryDoc = (() => {
        try {
          return JSON.parse(summaryRun.stdout);
        } catch {
          return null;
        }
      })();
      const missing = await runCommand(['scripts/export-feedback.mjs', '--universe', 'no-such-book-here']);
      const missingReport = (() => {
        try {
          return JSON.parse(missing.stdout.trim().split('\n').pop());
        } catch {
          return null;
        }
      })();
      await rm(directory, { recursive: true, force: true });
      if (printed.code === 0 && printed.stdout === text && printed.stderr === ''
        && written.code === 0 && report?.ok === true && report.bytes === Buffer.byteLength(text, 'utf8')
        && report.sha256 === sha256Hex(text) && report.suggested_name === `${universe.id}-feedback-export.json`
        && fromFile === text && summaryRun.code === 0 && summaryDoc?.schema_version === 'reader-feedback-summary.v1'
        && missing.code === 1 && missingReport?.code === 'NOT_FOUND') {
        ok(`feedback export: the command writes the same bytes as the route (stdout, --out with its byte count and sha256), the summary arrives through --summary, and an unknown book exits 1 with NOT_FOUND`);
      } else {
        fail(`feedback export/command: printed=${printed.code}/${printed.stdout === text}, written=${written.code}/${JSON.stringify(report)}, file=${fromFile === text}, summary=${summaryRun.code}/${summaryDoc?.schema_version}, missing=${missing.code}/${JSON.stringify(missingReport)}, stderr=${printed.stderr.slice(0, 120)}`);
      }
    }

    // 5. An unknown book and a book with no response answer the documented code and write nothing.
    {
      const unknownExport = await attempt(() => buildFeedbackExport(`missing-${checkSeed}`));
      const unknownSummary = await attempt(() => buildFeedbackSummary(`missing-${checkSeed}`));
      const emptyExport = await attempt(() => buildFeedbackExport(empty.id));
      const emptySummary = await attempt(() => buildFeedbackSummary(empty.id));
      const emptyTree = await treeDigest(feedbackRoot(empty.id));
      const unknownTree = await stat(join(assessmentsRoot(), `missing-${checkSeed}`)).then(() => true, () => false);
      const after = await treeDigest(feedbackRoot(universe.id));
      const bookAfter = await treeDigest(universeDir(universe.id));
      const residue = after === before && bookAfter === bookBefore;
      if (unknownExport === 'NOT_FOUND' && unknownSummary === 'NOT_FOUND' && emptyExport === 'NO_FEEDBACK'
        && emptySummary === 'NO_FEEDBACK' && emptyTree === 'absent' && !unknownTree && residue) {
        ok('feedback export: an unknown book answers NOT_FOUND and a book whose readers have not responded answers NO_FEEDBACK for both the dataset and the summary, and neither ever writes: the feedback tree and the book itself are byte-identical after every export, summary and command');
      } else {
        fail(`feedback export/absent: unknown=${unknownExport}/${unknownSummary}, empty=${emptyExport}/${emptySummary}, emptyTree=${emptyTree}, unknownTree=${unknownTree}, feedbackTree=${after === before}, bookTree=${bookAfter === bookBefore},\n${bookBefore}\n${bookAfter}`);
      }
    }

    // 6. A book being written right now: the accepted version cannot be read, so the dataset says so
    // instead of guessing which responses are historical, and the summary states the limit.
    {
      await turnRecord(universe.id, 9, { kind: 'export', status: 'queued', request: 'Generate the printed edition' });
      const writing = await buildFeedbackExport(universe.id).catch((error) => error.code);
      const writingSummary = await buildFeedbackSummary(universe.id).catch((error) => error.code);
      await rm(join(universeDir(universe.id), 'turns', '0009.json'), { force: true });
      const restored = await buildFeedbackExport(universe.id).catch((error) => error.code);
      if (writing?.book?.version_stable === false && writing.book.accepted_version === null
        && writing.responses.every((entry) => entry.historical === null)
        && writing.targets.every((entry) => entry.historical === null)
        && writingSummary?.book?.version_stable === false
        && writingSummary.limitations.some((entry) => entry.includes('being written right now'))
        && restored?.book?.version_stable === true) {
        ok('feedback export: while a turn of the book is queued the accepted version cannot be read, so the dataset reports version_stable false with `historical: null` everywhere and the summary states why, instead of guessing which responses are about the current text');
      } else {
        fail(`feedback export/unstable: writing=${JSON.stringify(writing?.book)}, historical=${JSON.stringify(writing?.responses?.map((entry) => entry.historical))}, summary=${writingSummary?.book?.version_stable}/${JSON.stringify(writingSummary?.limitations)}, restored=${JSON.stringify(restored?.book)}`);
      }
    }
  } finally {
    await rm(join(assessmentsRoot(), universe.id), { recursive: true, force: true });
    await rm(join(assessmentsRoot(), empty.id), { recursive: true, force: true });
  }
}

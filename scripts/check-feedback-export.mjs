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
//  - a distribution states a defensible population: the answers of one reader are counted once, a
//    chapter rating is never pooled with a book rating, and the version-level figure that does pool
//    several targets says so instead of presenting the sum as one text's rating;
//  - a summary that would have to compare two versions, or to state a trend from a handful of
//    responses, refuses with its reason and the counts it would need, instead of producing a number;
//  - an unknown book answers NOT_FOUND and a book with no response answers NO_FEEDBACK, and neither an
//    export nor a summary writes anything: the feedback tree is byte-identical afterwards;
//  - the self-contained snapshot carries the frozen prose itself, so a fresh directory that imports
//    nothing of this store can reproduce both reading targets, resolve every quotation at the offset the
//    store resolved, and still count the repeated readings of one reader as one reader — under a stable
//    pseudonym, with the display names only in the internal snapshot that has to be asked for by name,
//    and with the export refusing to carry prose whose bytes no longer match the hashes of its target;
//  - while a turn of the book is queued the accepted version cannot be read, so both report
//    `version_stable: false` with `historical: null` instead of guessing which text is current.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assessmentsRoot, currentVersion } from '../src/assessment-packet.mjs';
import { createFeedbackTarget, feedbackRoot, readFrozenText, targetTextDir } from '../src/feedback-targets.mjs';
import { createFeedbackReader } from '../src/feedback-readers.mjs';
import { recordReaderDeletion, submitFeedback, withdrawFeedback } from '../src/feedback-entries.mjs';
import { buildFeedbackExport, feedbackExportDownload, serializeFeedbackExport } from '../src/feedback-export.mjs';
import { buildFeedbackDataset, feedbackDatasetDownload, serializeFeedbackDataset } from '../src/feedback-dataset.mjs';
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

const runCommand = (args, cwd = rootDir) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
      && summary.counts.populations === 2 && summary.populations.length === 2
      && summary.populations.every((population) => population.unit === 'reader' && population.selection.length > 0
        && population.target_ids.length === 1 && typeof population.label === 'string' && population.label.includes('questionnaire'))
      && summary.versions.every((entry) => entry.unit === 'reader' && entry.pooled_across_targets === false && entry.populations.length === 1)
      && interestFirst.team_human.answered === MIN_ANSWERED_FOR_MEAN && interestFirst.team_human.mean === 3
      && interestFirst.team_human.mean_note === null
      && JSON.stringify(interestFirst.team_human.distribution) === JSON.stringify({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 0 })
      && interestFirst.team_human.not_mentioned === 1
      && interestFirst.team_human.responses === 4 && interestFirst.team_human.records === 4
      && interestFirst.team_human.unit === 'reader'
      && interestFirst.team_human.distribution['1'] === 0
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

    // 7. The population of a distribution: one reader answering the same question twice, two chapters
    // and the whole book in one accepted version.
    await checkDefensiblePopulations({ ok, fail, checkSeed, tempDirs });

    // 8. The self-contained snapshot: the frozen prose travels, so a fresh directory can reproduce the
    // reading targets without the store, and the store refuses to export prose whose bytes changed.
    await checkPortableDataset({ ok, fail, checkSeed, tempDirs });
  } finally {
    await rm(join(assessmentsRoot(), universe.id), { recursive: true, force: true });
    await rm(join(assessmentsRoot(), empty.id), { recursive: true, force: true });
  }
}

/**
 * C78, the population half: whether a distribution states the population it was computed from. One
 * reader answers the same question twice against the same chapter, once against the other chapter and
 * once against the whole book. A chapter population must hold one answered reader with the earlier
 * submission reported as history; the book population must hold three independent readers; no chapter
 * rating may appear in the book's distribution; and the version-level figure that does pool the three
 * targets must be marked as pooling and still count that reader once.
 */
async function checkDefensiblePopulations({ ok, fail, checkSeed, tempDirs = [] }) {
  const universe = await bookWithTwoChapters(checkSeed, 'feedback-populations');
  tempDirs.push(universe.id);
  try {
    const version = await currentVersion(universe.id);
    const ana = await createFeedbackReader({ universeId: universe.id, displayName: 'Ana' });
    const bogdan = await createFeedbackReader({ universeId: universe.id, displayName: 'Bogdan' });
    const corina = await createFeedbackReader({ universeId: universe.id, displayName: 'Corina' });
    const chapterOne = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'chapter', chapters: [1] } })).target;
    const chapterTwo = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'chapter', chapters: [2] } })).target;
    const whole = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } })).target;
    const answer = (targetId, feedbackId, readerId, value) => submitFeedback({
      universeId: universe.id,
      targetId,
      feedbackId,
      readerId,
      answers: [{ question_id: 'interest', value }]
    });
    // Ana changes her mind about chapter 1 in a second session against the same frozen text, rates
    // chapter 2 in another, and the whole book in a fourth.
    await answer(chapterOne.target_id, 'fb-pop-ana-c1-first', ana.reader_id, 1);
    await answer(chapterOne.target_id, 'fb-pop-ana-c1-again', ana.reader_id, 5);
    await answer(chapterTwo.target_id, 'fb-pop-ana-c2', ana.reader_id, 3);
    await answer(whole.target_id, 'fb-pop-ana-book', ana.reader_id, 4);
    await answer(whole.target_id, 'fb-pop-bogdan-book', bogdan.reader_id, 2);
    await answer(whole.target_id, 'fb-pop-corina-book', corina.reader_id, 5);

    const summary = await buildFeedbackSummary(universe.id);
    const question = summary.questions.find((entry) => entry.question_id === 'interest');
    const populationOf = (targetId) => question.populations.find((population) => population.target_ids.join(',') === targetId);
    const one = populationOf(chapterOne.target_id);
    const two = populationOf(chapterTwo.target_id);
    const book = populationOf(whole.target_id);
    const oneNumbers = one?.provenance.team_human;
    const twoNumbers = two?.provenance.team_human;
    const bookNumbers = book?.provenance.team_human;
    const pooled = question.versions[0]?.provenance.team_human;
    const oneVersionOnly = question.versions.length === 1 && question.versions[0].accepted_version === version;
    if (question.populations.length === 3 && oneVersionOnly
      && one.scope.kind === 'chapter' && one.scope.chapters.join(',') === '1' && two.scope.chapters.join(',') === '2'
      && book.scope.kind === 'book'
      && oneNumbers.answered === 1 && oneNumbers.mean === null && oneNumbers.mean_note.includes(String(MIN_ANSWERED_FOR_MEAN))
      && JSON.stringify(oneNumbers.distribution) === JSON.stringify({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 })
      && oneNumbers.records === 2 && oneNumbers.earlier_answers === 1 && oneNumbers.repeated_readers === 1 && oneNumbers.readers === 1
      && twoNumbers.answered === 1 && JSON.stringify(twoNumbers.distribution) === JSON.stringify({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 })
      && bookNumbers.answered === 3 && bookNumbers.readers === 3 && bookNumbers.mean === 3.67
      && JSON.stringify(bookNumbers.distribution) === JSON.stringify({ 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 })
      // The ratings of one text are nowhere inside another text's distribution.
      && bookNumbers.distribution['3'] === 0 && oneNumbers.distribution['4'] === 0 && twoNumbers.distribution['4'] === 0
      && question.versions[0].pooled_across_targets === true && question.versions[0].populations.length === 3
      && pooled.readers === 3 && pooled.records === 6 && pooled.earlier_answers === 3 && pooled.repeated_readers === 1
      && JSON.stringify(pooled.distribution) === JSON.stringify({ 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 })
      && summary.counts.populations === 3 && summary.counts.targets === 3
      && summary.limitations.some((entry) => entry.includes('pooled_across_targets'))
      && summary.limitations.some((entry) => entry.includes('repeated submission'))) {
      ok(`feedback summary: the three populations of one accepted version are reported apart (chapter 1: one reader, whose latest answer is 5 and whose earlier 1 is history; chapter 2: one reader, 3; the whole book: three independent readers, mean ${bookNumbers.mean}), the version-level figure is marked as pooling three targets and still counts the reader who answered four times once (${pooled.readers} readers from ${pooled.records} records), and no chapter's rating appears in the book's distribution`);
    } else {
      fail(`feedback summary/populations: populations=${JSON.stringify(question.populations.map((population) => [population.scope.kind, population.scope.chapters, population.provenance.team_human.answered, population.provenance.team_human.records, population.provenance.team_human.mean, population.provenance.team_human.distribution]))}, one=${JSON.stringify(oneNumbers)}, two=${JSON.stringify(twoNumbers)}, book=${JSON.stringify(bookNumbers)}, pooled=${JSON.stringify(pooled)}, versions=${JSON.stringify(question.versions.map((entry) => [entry.accepted_version?.slice(0, 12), entry.pooled_across_targets]))}, limitations=${JSON.stringify(summary.limitations)}`);
    }
  } finally {
    await rm(join(assessmentsRoot(), universe.id), { recursive: true, force: true });
  }
}

/**
 * The inspector of `--dataset`. It runs as its own process in a fresh directory, imports nothing of this
 * repository, and reads nothing but the snapshot it is handed: what it can answer is what the snapshot
 * contains, which is the only way to prove that a dataset is portable.
 */
const DATASET_INSPECTOR = `import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const document = JSON.parse(await readFile(process.argv[2], 'utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const texts = document.texts.flatMap((entry) => entry.files.map((file) => ({ targetId: entry.target_id, historical: entry.historical, file })));
const team = document.responses.filter((entry) => entry.reader_kind === 'team_human');
const carried = (targetId) => document.texts.find((entry) => entry.target_id === targetId) ?? null;
const older = document.texts.find((entry) => entry.historical === true) ?? null;
console.log(JSON.stringify({
  schema: document.schema_version,
  identity: document.identity.mode,
  counts: document.manifest.counts,
  texts: texts.length,
  pseudonyms: document.readers.map((reader) => reader.reader),
  names: document.readers.map((reader) => reader.display_name),
  hashesMatch: texts.every((entry) => sha(entry.file.text) === entry.file.sha256 && document.manifest.hashes.texts[entry.targetId + '/' + entry.file.name] === entry.file.sha256),
  everyQuoteResolves: document.responses.every((response) => {
    const text = carried(response.target_id);
    return (response.comments ?? []).every((comment) => comment.evidence.every((range) => text !== null && text.files.some((file) => file.path === range.file && file.text.slice(range.start, range.end) === range.quote)));
  }),
  everyCountedExists: document.selection.counted.every((id) => document.responses.some((entry) => entry.feedback_id === id)),
  supersededNotCounted: document.selection.superseded.every((id) => !document.selection.counted.includes(id) && document.responses.some((entry) => entry.feedback_id === id)),
  withdrawnNotCounted: document.selection.withdrawn.every((id) => !document.selection.counted.includes(id) && document.responses.some((entry) => entry.feedback_id === id)),
  historicalTexts: document.texts.filter((entry) => entry.historical === true).length,
  historicalTextHasOlderProse: older !== null && older.files.some((file) => file.text.includes('Orașul citea registrul')),
  currentTextHasNewerProse: document.texts.filter((entry) => entry.historical !== true).every((entry) => entry.files.some((file) => file.path.endsWith('0002-two.md') || file.text.includes('Orașul reciti registrul'))),
  romania: texts.some((entry) => entry.file.text.includes('Orașul citea registrul')),
  quotesRomania: document.responses.some((response) => (response.comments ?? []).some((comment) => comment.evidence.some((range) => /[ăâîșț]/u.test(range.quote)))),
  unit: document.selection.unit,
  teamReaders: new Set(team.map((entry) => entry.reader)).size,
  teamCountedResponses: document.selection.counted.filter((id) => team.some((entry) => entry.feedback_id === id)).length
}));
`;

/**
 * C81: the self-contained snapshot. One chapter of the book is Romanian and the older version stays a
 * target of its own, so the check proves that a fresh directory — a separate process, importing nothing
 * of this repository — can reproduce every reading target, resolve the passage each reader quoted at the
 * offset the store recorded, and still count the repeated readings of one person as one person, while the
 * display names never leave the store. The internal dataset exists only when it is asked for by name, and
 * the snapshot refuses to carry prose whose bytes no longer match the hashes its target recorded.
 */
async function checkPortableDataset({ ok, fail, checkSeed, tempDirs = [] }) {
  const universe = await bookWithTwoChapters(checkSeed, 'feedback-dataset');
  tempDirs.push(universe.id);
  const directory = await mkdtemp(join(tmpdir(), 'scripta-feedback-dataset-'));
  const attempt = async (work) => {
    try {
      await work();
      return 'accepted';
    } catch (error) {
      return error?.code ?? String(error?.message ?? error);
    }
  };
  try {
    const romaniaOne = '# Unu\n\nOrașul citea registrul cu voce tare, și districtul răspunse în șoaptă.\n\nFiecare piatră își amintea numele celui care o rostise.\n';
    const romaniaTwo = '# Unu\n\nOrașul reciti registrul, iar districtul își schimbă glasul.\n\nFiecare piatră aștepta o altă poveste.\n';
    await writeFile(join(universeDir(universe.id), CHAPTERS[0]), romaniaOne, 'utf8');
    const ana = await createFeedbackReader({ universeId: universe.id, displayName: 'Ana Popescu' });
    const bogdan = await createFeedbackReader({ universeId: universe.id, displayName: 'Bogdan Ionescu' });
    const first = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } })).target;
    await submitFeedback({
      universeId: universe.id,
      targetId: first.target_id,
      feedbackId: 'fb-ds-ana-first',
      readerId: ana.reader_id,
      answers: [{ question_id: 'interest', value: 5 }],
      comments: [{ text: 'Registrul se aude.', evidence: [{ file: CHAPTERS[0], quote: 'districtul răspunse în șoaptă' }] }]
    });
    await submitFeedback({ universeId: universe.id, targetId: first.target_id, feedbackId: 'fb-ds-bogdan', readerId: bogdan.reader_id, answers: [{ question_id: 'interest', value: 3 }] });
    // Ana reads the same text twice and Bogdan corrects himself: the snapshot must keep both, and count
    // neither of them twice.
    await submitFeedback({ universeId: universe.id, targetId: first.target_id, feedbackId: 'fb-ds-ana-again', readerId: ana.reader_id, answers: [{ question_id: 'interest', value: 4 }] });
    await submitFeedback({ universeId: universe.id, targetId: first.target_id, feedbackId: 'fb-ds-bogdan-again', readerId: bogdan.reader_id, revisionOf: 'fb-ds-bogdan', answers: [{ question_id: 'interest', value: 4 }] });
    await writeFile(join(universeDir(universe.id), CHAPTERS[0]), romaniaTwo, 'utf8');
    const second = (await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } })).target;
    await submitFeedback({
      universeId: universe.id,
      targetId: second.target_id,
      feedbackId: 'fb-ds-ana-second',
      readerId: ana.reader_id,
      answers: [{ question_id: 'interest', value: 4 }],
      comments: [{ text: 'Un alt glas.', evidence: [{ file: CHAPTERS[0], quote: 'districtul își schimbă glasul' }] }]
    });
    await submitFeedback({ universeId: universe.id, targetId: second.target_id, feedbackId: 'fb-ds-ana-taken-back', readerId: ana.reader_id, answers: [{ question_id: 'clarity', value: 2 }] });
    await withdrawFeedback({ universeId: universe.id, feedbackId: 'fb-ds-ana-taken-back' });
    const before = await treeDigest(feedbackRoot(universe.id));

    const path = join(directory, 'dataset.json');
    const internalPath = join(directory, 'internal.json');
    const inspectorPath = join(directory, 'inspect.mjs');
    await writeFile(inspectorPath, DATASET_INSPECTOR, 'utf8');
    const document = await buildFeedbackDataset(universe.id);
    const text = serializeFeedbackDataset(document);
    const download = await feedbackDatasetDownload(universe.id);
    const written = await runCommand(['scripts/export-feedback.mjs', '--universe', universe.id, '--dataset', '--out', path]);
    const printed = await runCommand(['scripts/export-feedback.mjs', '--universe', universe.id, '--dataset']);
    const internal = await runCommand(['scripts/export-feedback.mjs', '--universe', universe.id, '--dataset', '--internal', '--out', internalPath]);
    const misuse = await runCommand(['scripts/export-feedback.mjs', '--universe', universe.id, '--internal']);
    const both = await runCommand(['scripts/export-feedback.mjs', '--universe', universe.id, '--dataset', '--summary']);
    const inspected = await runCommand([inspectorPath, path], directory);
    const missingIdentity = await attempt(() => buildFeedbackDataset(universe.id, { identity: 'everyone' }));
    const report = (() => {
      try {
        return JSON.parse(written.stdout.trim().split('\n').pop());
      } catch {
        return null;
      }
    })();
    const inspection = (() => {
      try {
        return JSON.parse(inspected.stdout.trim().split('\n').pop());
      } catch {
        return null;
      }
    })();
    const bytes = await readFile(path, 'utf8').catch(() => null);
    const internalBytes = await readFile(internalPath, 'utf8').catch(() => null);

    // The store's own copy of the frozen prose is changed behind the snapshot's back: the export has to
    // refuse to carry words nobody was shown, and it has to write nothing when it refuses.
    const frozenFile = join(targetTextDir(universe.id, second.target_id), basename(CHAPTERS[0]));
    const pristine = await readFile(frozenFile, 'utf8');
    await writeFile(frozenFile, `${pristine}Un rând adăugat.\n`, 'utf8');
    const tampered = await attempt(() => buildFeedbackDataset(universe.id));
    const tamperedPath = join(directory, 'tampered.json');
    const tamperedRun = await runCommand(['scripts/export-feedback.mjs', '--universe', universe.id, '--dataset', '--out', tamperedPath]);
    const tamperedLeft = await stat(tamperedPath).then(() => true, () => false);
    const tamperedReport = (() => {
      try {
        return JSON.parse(tamperedRun.stdout.trim().split('\n').pop());
      } catch {
        return null;
      }
    })();
    await writeFile(frozenFile, pristine, 'utf8');
    const restored = await attempt(() => buildFeedbackDataset(universe.id));

    const counts = inspection?.counts ?? {};
    const anonymous = bytes !== null && !bytes.includes('Popescu') && !bytes.includes('Ionescu') && !bytes.includes(ana.reader_id);
    const untouched = (await treeDigest(feedbackRoot(universe.id))) === before;
    if (document.schema_version === 'reader-feedback-dataset.v1' && inspection?.schema === 'reader-feedback-dataset.v1'
      && written.code === 0 && report?.ok === true && report.document === 'reader-feedback-dataset.v1' && report.identity === 'pseudonym'
      && report.bytes === Buffer.byteLength(text, 'utf8') && report.sha256 === sha256Hex(text) && report.counted === 4 && report.responses === 6
      && report.suggested_name === `${universe.id}-feedback-dataset.json` && report.files === 4
      && printed.code === 0 && printed.stdout === text && bytes === text
      && download.name === `${universe.id}-feedback-dataset.json` && download.body.equals(Buffer.from(text, 'utf8'))
      && document.identity.mode === 'pseudonym' && document.manifest.identity === 'pseudonym'
      && anonymous && inspection.identity === 'pseudonym' && inspection.names.every((name) => name === null)
      && inspection.pseudonyms.length === 2 && inspection.pseudonyms.every((reader) => /^reader-p[0-9a-f]{12}$/.test(reader))
      && counts.targets === 2 && counts.readers === 2 && counts.responses === 6 && counts.counted === 4
      && counts.superseded === 1 && counts.withdrawn === 1 && counts.files === 4 && counts.bytes > 0
      && inspection.texts === 4 && inspection.hashesMatch === true && inspection.romania === true && inspection.quotesRomania === true
      && inspection.everyQuoteResolves === true && inspection.everyCountedExists === true
      && inspection.supersededNotCounted === true && inspection.withdrawnNotCounted === true
      && inspection.historicalTexts === 1 && inspection.historicalTextHasOlderProse === true && inspection.currentTextHasNewerProse === true
      && inspection.unit === 'reader' && inspection.teamReaders === 2 && inspection.teamCountedResponses === 4
      && internal.code === 0 && internalBytes !== null && internalBytes.includes('Popescu') && internalBytes.includes(ana.reader_id)
      && missingIdentity === 'BAD_DATASET' && misuse.code === 2 && both.code === 2
      && tampered === 'STALE_TARGET' && tamperedRun.code === 1 && tamperedReport?.code === 'STALE_TARGET' && !tamperedLeft
      && restored === 'accepted' && untouched) {
      ok(`feedback dataset: the snapshot carries the frozen prose of both targets (${counts.files} files, ${counts.bytes} bytes, the older version marked historical) and a fresh directory importing nothing of this store reproduces it — every carried text hashes to the value its target recorded, both Romanian quotations resolve at the offset the store resolved (${inspection.quotesRomania}), the withdrawal and the correction are named as not counted (${counts.counted} of ${counts.responses} responses count) and the reader who read twice is one pseudonym among ${inspection.teamReaders} readers; the display names never travel unless --internal is asked for, the command refuses --internal alone and --dataset with --summary (exit 2), and a frozen file whose bytes changed answers STALE_TARGET without writing a snapshot`);
    } else {
      fail(`feedback dataset: report=${JSON.stringify(report)}, printed=${printed.code}/${printed.stdout === text}, download=${download.name}/${download.body.equals(Buffer.from(text, 'utf8'))}, bytesMatch=${bytes === text}, anonymous=${anonymous}, inspection=${JSON.stringify(inspection)}, internal=${internal.code}/${internalBytes?.includes('Popescu')}, misuse=${misuse.code}, both=${both.code}, missingIdentity=${missingIdentity}, tampered=${tampered}/${tamperedRun.code}/${tamperedReport?.code}/left=${tamperedLeft}, restored=${restored}, untouched=${untouched}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(join(assessmentsRoot(), universe.id), { recursive: true, force: true });
  }
}

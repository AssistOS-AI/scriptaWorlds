// The annotation stage of the separate review phase, proven through the host boundary: a real child
// process is installed as `omp` and answers with a document built from the vocabulary the report skill
// publishes. The group proves the three properties the host depends on: the generic mode calls an
// evaluator, what it returns is validated against the frozen packet before it reaches the report, and an
// answer that is not a usable document fails the run instead of becoming a judgement.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cancelAssessment, deleteAssessment, listAssessments, readAssessment, readAssessmentConsole, reassessAssessment, recordApproval, retryAssessment, runOutputPath, settleAssessments, startAssessment } from '../src/assessments.mjs';
import { validateGeneratedAnnotations } from '../src/annotation-stage.mjs';
import { runAnnotationStage } from '../src/annotation-stage.mjs';
import { universeDir } from '../src/paths.mjs';
import { assessmentsRoot, currentVersion, inputFingerprint, runDir } from '../src/assessment-packet.mjs';
import { config } from '../src/config.mjs';
import { extractAnnotationJson } from '../src/annotation-stage.mjs';
import { MAX_OUTPUT_BYTES, MAX_PROMPT_BYTES, readingListBlock } from '../src/annotation-prompt.mjs';
import { planReviewUnits, unitReadingList } from '../src/annotation-units.mjs';
import { CANON, CHAPTER, EMPTY_THREADS, LAW, inventory } from './check-fixtures.mjs';
import { createUniverse } from '../src/universe.mjs';

const FAKE_EVALUATOR = `#!/usr/bin/env node
import { appendFile, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

if (process.argv.includes('--version')) { process.stdout.write('fake-evaluator/0.0.1\\n'); process.exit(0); }
const runDir = process.cwd();
const emit = (payload) => new Promise((resolve) => process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: payload } }) + String.fromCharCode(10), resolve));
process.stdin.resume();
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
await new Promise((resolve) => process.stdin.on('end', resolve));

const manifest = JSON.parse(await readFile(join(runDir, 'input', 'manifest.json'), 'utf8'));
const chapters = manifest.files.filter((file) => file.role === 'chapter').sort((a, b) => a.chapter - b.chapter);
// Which call this is: a bounded unit names the chapter it was asked to read, and the synthesis names the
// observations it must assemble. The evaluator answers about the text it was actually asked about.
const unitId = /THIS UNIT: (\\S+)/.exec(prompt)?.[1] ?? null;
const unitChapters = /THIS UNIT: \\S+ — chapter\\(s\\) ([\\d, ]+?)[,.]/.exec(prompt)?.[1] ?? null;
const synthesis = /THE VERIFIED OBSERVATIONS OF THE UNITS/.test(prompt);
const scopeChapters = /REVIEW SCOPE: [a-z]+ ([\\d, ]+)/.exec(prompt)?.[1] ?? '';
const wanted = Number((unitChapters ?? scopeChapters).split(',')[0].trim() || chapters[0].chapter);
const chapter = chapters.find((file) => file.chapter === wanted) ?? chapters[0];
// A call is observable: the check reads this file to prove which units were read and which were resumed.
await appendFile(join(runDir, 'fake-evaluator.calls'), JSON.stringify({
  call: synthesis ? 'synthesis' : 'unit',
  unit: unitId,
  chapter: chapter.chapter,
  seen: synthesis ? [...prompt.matchAll(/^- (\\S+) — /gm)].map((match) => match[1]) : []
}) + '\\n', 'utf8');
if (process.env.FAKE_EVALUATOR_MODE === 'garbage') { await emit('I read the book and it is good.'); process.exit(0); }
// An evaluator that is still working: it narrates, calls a tool, and then takes its time. The host journals
// what it streams as it arrives, which is what lets a review be watched while it runs.
if (process.env.FAKE_EVALUATOR_MODE === 'narrate-hang') {
  await emit('reading the frozen packet');
  await new Promise((resolve) => process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: chapter.path } }) + String.fromCharCode(10), resolve));
  await new Promise((resolve) => process.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolName: 'read', error: null }) + String.fromCharCode(10), resolve));
  process.on('SIGTERM', () => {});
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  process.exit(0);
}
// A unit that was asked for and could not be answered: the reading is interrupted where the check wants it.
if (process.env.FAKE_UNIT_FAIL && unitId && unitId.includes(process.env.FAKE_UNIT_FAIL)) process.exit(1);
const text = await readFile(join(runDir, 'input', chapter.path), 'utf8');
const bytes = Buffer.from(text, 'utf8');
const quote = bytes.subarray(0, 32).toString('utf8');
const end = Buffer.byteLength(quote, 'utf8');
const vocabulary = JSON.parse(await readFile(join(process.env.SKILL_DIR ?? 'skills', 'scripta-metrics-report', 'schema', 'annotations.v1.json'), 'utf8'));
// The identifiers a synthesis may cite are the ones the prompt listed as verified; a unit declares its own.
const offeredSection = prompt.split('THE EVIDENCE YOU MAY CITE')[1] ?? '';
const offered = [...offeredSection.matchAll(/^- (\\S+) — /gm)].map((match) => match[1]);
const cited = synthesis && offered.length > 0 ? offered[0] : 'm1';
const annotations = {
  schema_version: 'annotations.v1',
  source_version: manifest.version,
  request: null,
  brief: null,
  // The passage is anchored the way the host asks a model to anchor it: the line it is on and the exact text,
  // with no byte offset counted by the child. The host resolves the pair to the bytes of the frozen file.
  evidence: synthesis ? [] : [{ id: 'm1', file: chapter.path, sha256: chapter.sha256, line: 1, quote }],
  segments: [{ id: 'seg1', chapter: chapter.chapter, kind: vocabulary.segment_kinds[0], label: 'the opening', focal_character: null, start: 0, end, story_order: 1 }],
  metrics: {
    CS: { status: vocabulary.metric_statuses[0], evaluator: 'model:fake-evaluator', dimensions: {
      referential_clarity: { rating: 2, rationale: 'the referents are recoverable', evidence: [cited] },
      discourse_connection: { rating: 2, rationale: 'the scene connects to the next', evidence: [cited] },
      causal_support: { rating: 2, rationale: 'the causes are shown', evidence: [cited] },
      temporal_intelligibility: { rating: 2, rationale: 'the order is clear', evidence: [cited] } } },
    OI: { status: 'judged', evaluator: 'model:fake-evaluator', comparison_scope: 'the reviewed chapters',
      dimensions: {
        perspective: { rating: 1, rationale: 'one focal character', evidence: [cited] },
        dramatic_development: { rating: 1, rationale: 'a choice is dramatized', evidence: [cited] },
        expression: { rating: 1, rationale: 'the register holds', evidence: [cited] } } },
    NCS: { status: vocabulary.metric_statuses[0], evaluator: 'model:fake-evaluator', dimensions: {
      novelty: { rating: 3, rationale: 'the ledger scene is fresh', evidence: [cited] },
      cliche_reliance: { rating: 1, rationale: 'one recurring phrase', evidence: [cited] } } },
    EAP: { status: vocabulary.metric_statuses[0], evaluator: 'model:fake-evaluator', ordering: vocabulary.eap_orderings[0],
      trajectory: [
        { segment_id: 'seg1', story_order: 1, focalization: 'internal', valence: 0.5, tension: 2, evidence: [cited], uncertainty: 'one scene only' } ],
      emotional_fit: { status: vocabulary.metric_statuses[0], evaluator: 'model:fake-evaluator', fit: 60,
        rationale: 'the quiet register answers the stated intention', evidence: [cited], intention_binding: 'the stated intention' } }
  },
  indicators: [
    { id: 'narrative_coherence', status: vocabulary.indicator_statuses[0], category: vocabulary.indicators.narrative_coherence.categories[1], evaluator: 'model:fake-evaluator', rationale: 'the scenes return to one image', evidence: [cited], counterevidence: null },
    ...Object.keys(vocabulary.indicators).filter((id) => id !== 'narrative_coherence').map((id) => ({ id, status: vocabulary.indicator_statuses[1], category: null, evaluator: 'model:fake-evaluator', rationale: null, evidence: [], counterevidence: null, missing_reason: 'the selection holds nothing this indicator can read' }))
  ],
  findings: [{ id: 'f1', kind: vocabulary.findings.kinds[1], severity: vocabulary.findings.severities[1], certainty: vocabulary.findings.certainties[1], status: vocabulary.findings.statuses[2], description: 'the opening withholds the stakes', evidence: [cited], repair_suggestion: 'name the stake earlier' }],
  preserved_qualities: { passages: [{ id: 'p1', rationale: 'the quiet opening earns the ending', evidence: [cited] }], reason: 'the restraint is the effect' },
  departures: [{ id: 'd1', status: vocabulary.departures.statuses[0], description: 'the stakes stay unnamed', rationale: 'the reader infers them', evidence: [cited] }]
};
// The rules the host declared for this call, so the fake can report outcomes for some of them — and, when
// asked, try to redefine the rules itself, which the host must refuse.
const declaredRules = [...prompt.matchAll(/^- (\\S+) \\((stg|request|editorial), (hard|soft)\\):/gm)].map((match) => match[1]);
const outcomeMode = process.env.FAKE_OUTCOMES ?? null;
if (outcomeMode && !synthesis && declaredRules.length > 0) {
  const reported = outcomeMode === 'unresolved-rule' ? declaredRules.slice(0, -1) : declaredRules;
  annotations.requirements = {
    outcomes: reported.map((rule) => ({
      rule,
      output: chapter.chapter,
      outcome: outcomeMode === 'fail-last' && rule === declaredRules[declaredRules.length - 1] ? 'fail' : 'pass',
      evidence: [cited],
      reason: null
    }))
  };
  if (outcomeMode === 'invent-rule') {
    annotations.requirements.rules = [{ id: 'invented-1', description: 'a rule the evaluator made up', source: 'stg', classification: 'hard', criterion: 'every declared output', applies_to: 'all' }];
  }
}
// The chatty mode answers with the document and then keeps talking: the host must still take the document.
// Every final write is awaited, because a process exit can drop buffered pipe data that was never flushed.
const answer = process.env.FAKE_EVALUATOR_MODE === 'empty-document'
  ? { schema_version: 'annotations.v1', source_version: manifest.version, metrics: {}, indicators: [] }
  : annotations;
await emit(JSON.stringify(answer) + (process.env.FAKE_EVALUATOR_MODE === 'chatty' ? '\\n\\nI hope this reading is useful. Tell me if you want the next chapter as well.' : ''));
if (process.env.FAKE_EVALUATOR_MODE === 'flood') {
  await emit('x'.repeat(450000));
  process.exit(0);
}
if (process.env.FAKE_EVALUATOR_MODE === 'exit-1-after-answer') {
  process.exit(1);
}
if (process.env.FAKE_EVALUATOR_MODE === 'hang') {
  // Ignores SIGTERM: the controller must escalate to SIGKILL, and a retry must be refused while it lives.
  process.on('SIGTERM', () => {});
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  process.exit(0);
}
if (process.env.FAKE_EVALUATOR_MODE === 'tamper') {
  await writeFile(join(runDir, 'input', chapter.path), 'mutated text\\n', 'utf8');
}
if (process.env.FAKE_EVALUATOR_MODE === 'remove-chapter') {
  await rm(join(runDir, 'input', chapter.path), { force: true });
}
if (process.env.FAKE_EVALUATOR_MODE === 'remove-manifest') {
  await rm(join(runDir, 'input', 'manifest.json'), { force: true });
}
// A published file that is a link to somewhere else: the review output area holds plain files, and a link
// that escapes it is not this run's report.
if (process.env.FAKE_EVALUATOR_MODE === 'symlink-output') {
  await symlink(join(runDir, '..', 'outside-target.json'), join(runDir, 'result', 'escaped-report.json')).catch(() => {});
}
// A write that lands outside the run directory the evaluator was given.
if (process.env.FAKE_EVALUATOR_MODE === 'escape-write') {
  await writeFile(join(runDir, '..', 'escape-attempt.json'), '{"written":"outside the run directory"}\\n', 'utf8');
}
// A write into the frozen packet: an undeclared file is a change to the input.
if (process.env.FAKE_EVALUATOR_MODE === 'packet-write') {
  await writeFile(join(runDir, 'input', 'injected-chapter.md'), '# Injected\\n\\nnot part of the capture\\n', 'utf8');
}
await writeFile(join(runDir, 'fake-evaluator.marker'), JSON.stringify({ prompt_chars: prompt.length, chapter: chapter.path, prompt: prompt.slice(0, 200000), args: process.argv.slice(2).join(' ') }), 'utf8');
process.exit(0);
`;

async function installFakeEvaluator() {
  const dir = await mkdtemp(join(tmpdir(), 'fake-evaluator-'));
  // `omp` is resolved on PATH, so the fake is a shell shim around an ES module: an extensionless copy of
  // the module would be loaded as CommonJS and die on its first import.
  await writeFile(join(dir, 'fake-evaluator.mjs'), FAKE_EVALUATOR.trimStart(), 'utf8');
  process.env.SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
  const path = join(dir, 'omp');
  await writeFile(path, '#!/bin/sh\nexec node "$(dirname "$0")/fake-evaluator.mjs" "$@"\n', 'utf8');
  await chmod(path, 0o755);
  const previousPath = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${previousPath}`;
  return {
    dir,
    restore: async () => {
      process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  };
}

  // The generic mode asks the configured agent for its observations when the caller wants them, and the
  // observations it returns are validated against the packet before they reach the report. The evaluator
  // here is a real child process that reads the packet and answers with quoted passages.
/**
 * A book of `count` accepted chapters, written directly the way an imported book arrives: the chapters are
 * there and no turn of this server ever wrote them, so the review is measuring a book it did not author.
 */
async function bookOfChapters(count, label) {
  const universe = await createUniverse({ title: `${label} ${count}`, law: LAW, language: 'en' });
  const dir = universeDir(universe.id);
  await mkdir(join(dir, 'drafts'), { recursive: true });
  await writeFile(join(dir, 'canon.md'), CANON('a bounded reading'), 'utf8');
  await writeFile(join(dir, 'threads.json'), EMPTY_THREADS, 'utf8');
  await writeFile(join(dir, 'atlas.json'), JSON.stringify({ version: 1, axes: [] }), 'utf8');
  for (let number = 1; number <= count; number += 1) {
    await writeFile(join(dir, 'chapters', `${String(number).padStart(4, '0')}-c${number}.md`), CHAPTER(`Chapter ${number}`, `n${number}`), 'utf8');
  }
  return universe;
}

export async function runAssessmentAnnotationChecks({ ok, fail, universe }) {
  // The extraction of a model answer: a document wrapped in prose, a document followed by chatter, and an
  // answer that was cut off before it ended are three different things, and the record says which one it was.
  {
    const document = { schema_version: 'annotations.v1', source_version: 'sha256:x', evidence: [], segments: [], metrics: {}, findings: [] };
    const json = JSON.stringify(document);
    const wrapped = extractAnnotationJson(`Here is my reading of the chapter.\n\n${json}\n\nI hope it helps.`);
    const after = extractAnnotationJson(`${json}\n\nLet me know if you want more detail about any segment.`);
    const fenced = extractAnnotationJson('```json\n' + json + '\n```');
    const cutOff = extractAnnotationJson(json.slice(0, Math.floor(json.length / 2)));
    // An evaluator that reasons in prose can leave a smaller object behind before it writes the document.
    const stray = extractAnnotationJson(`I first noted {"tone": "quiet", "confidence": 0.4} about the opening.\n\n${json}`);
    const proseOnly = extractAnnotationJson('The chapter reads well and the ledger is convincing throughout.');
    if (wrapped.value?.schema_version === 'annotations.v1' && wrapped.how === 'parsed'
      && after.value?.schema_version === 'annotations.v1'
      && fenced.value?.schema_version === 'annotations.v1'
      && stray.value?.schema_version === 'annotations.v1'
      && cutOff.value === null && cutOff.how === 'truncated'
      && proseOnly.value === null && proseOnly.how === 'no-object') {
      ok('assessments/annotations: a document wrapped in prose, followed by chatter, fenced, or preceded by a smaller stray object is read as the document itself, and an answer cut off before it ended is reported as truncated rather than as prose');
    } else {
      fail(`assessments/annotations/extract: wrapped=${wrapped.how}, after=${after.how}, fenced=${fenced.how}, stray=${stray.how}/${stray.value?.schema_version}, cut=${cutOff.how}, prose=${proseOnly.how}`);
    }
  }
    if (config.ompBin !== 'omp') {
      ok(`assessments/annotations: not exercised here (OMP_BIN pins the agent to ${config.ompBin})`);
    } else {
      const fake = await installFakeEvaluator();
      try {
        let generated = null;
        let startError = null;
        try {
          generated = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', aggregate: false });
        } catch (error) {
          startError = error;
        }
        await settleAssessments();
        if (!generated) {
          const failedRecord = (await listAssessments(universe.id)).find((entry) => entry.status === 'error' && entry.annotation_mode === 'generic');
          fail(`assessments/annotations: the annotation stage failed (${startError?.code}: ${String(startError?.message).slice(0, 80)}), attempts=${JSON.stringify(failedRecord?.annotation_attempts ?? null)}, errors=${JSON.stringify(failedRecord?.annotation_errors ?? null)}`);
          return;
        }
        const run = await readAssessment(universe.id, generated.run_id);
        const bundle = await readFile(join(assessmentsRoot(), run.result_dir, 'assessment.json'), 'utf8').then(
          (text) => JSON.parse(text),
          () => null
        );
        const directory = dirname(join(assessmentsRoot(), run.result_dir));
        const marker = await readFile(join(directory, 'fake-evaluator.marker'), 'utf8').then(
          (text) => JSON.parse(text),
          () => null
        );
        const cs = bundle?.metrics?.CS ?? null;
        const eap = bundle?.metrics?.EAP ?? null;
        const ncs = bundle?.metrics?.NCS ?? null;
        const findingIds = (bundle?.findings ?? []).map((finding) => finding.id);
        const provenance = bundle?.provenance?.annotations ?? null;
        const generatedStored = run.generated_annotations === 'generated/annotations.json'
          && (await stat(join(directory, run.generated_annotations)).then(() => true, () => false));
        const packetIntact = run.packet_intact === true;
        // The generated document lives beside the run, never inside the frozen packet.
        const insidePacket = await stat(join(assessmentsRoot(), run.input_dir, 'annotations.json')).then(() => true, () => false);
        // A reader opens a report through this helper, so every name the run lists must resolve to a real
        // file and nothing else may resolve at all.
        const published = await Promise.all((run.outputs ?? []).map(async (name) => {
          const path = await runOutputPath(universe.id, run.run_id, name).catch(() => null);
          return path ? await stat(path).then(() => true, () => false) : false;
        }));
        const servedEveryOutput = run.status !== 'done' || (published.length > 0 && published.every(Boolean));
        const refusals = await Promise.all(['../manifest.json', 'a/b.md', 'not-published.md'].map((name) =>
          runOutputPath(universe.id, run.run_id, name).then(() => null, (error) => error.code)));
        const refusedPaths = refusals.every((code) => code === 'BAD_FILE' || code === 'NOT_FOUND');
        if (!servedEveryOutput || !refusedPaths) {
          fail(`assessments/annotations/paths: published=${JSON.stringify(published)}, outputs=${JSON.stringify(run.outputs)}, refusals=${JSON.stringify(refusals)}`);
        }
        if (run.status === 'done' && run.annotation_mode === 'generic' && cs?.value_kind === 'components'
          && eap?.value_kind === 'trajectory' && eap?.trajectory?.[0]?.segment_id === 'seg1' && eap?.trajectory?.[0]?.valence === 0.5
          && ncs?.value_kind === 'components' && Object.keys(ncs?.components ?? {}).length === 2
          && findingIds.includes('f1') && provenance !== null && generatedStored && packetIntact && !insidePacket && marker?.chapter) {
          ok(`assessments/annotations: the generic mode calls the evaluator, validates its quoted evidence, feeds the report (CS ${cs.value}, EAP trajectory seg1, NCS novelty+cliche_reliance, findings ${findingIds.join(',')}) and keeps the frozen packet untouched`);
        } else {
          fail(`assessments/annotations: status=${run.status}, mode=${run.annotation_mode}, cs=${cs?.value}/${cs?.value_kind}, eap=${eap?.value_kind}/${eap?.trajectory?.[0]?.segment_id}, ncs=${ncs?.value_kind}/${JSON.stringify(Object.keys(ncs?.components ?? {}))}, findings=${JSON.stringify(findingIds)}, provenance=${JSON.stringify(provenance)?.slice(0, 120)}, stored=${generatedStored}, insidePacket=${insidePacket}, intact=${packetIntact}, marker=${Boolean(marker?.chapter)}, resultDir=${run.result_dir}, errors=${JSON.stringify(run.annotation_errors ?? null)}, attempts=${JSON.stringify((run.annotation_attempts ?? []).map((a) => ({ ok: a.ok, exit: a.exit_code, process_failure: a.process_failure ?? false, stderr: (a.stderr ?? '').slice(0, 200), errors: (a.errors ?? []).slice(0, 3) })))}`);
        }

        // An evaluator that keeps talking after the document is still a usable evaluator: the document is
        // read out of the answer and the run completes in one call.
        process.env.FAKE_EVALUATOR_MODE = 'chatty';
        let chattyRun = null;
        try {
          chattyRun = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', force: true });
          await settleAssessments();
        } catch (error) {
          chattyRun = { run_id: null, error: error.message };
        }
        const chattySettled = chattyRun.run_id ? await readAssessment(universe.id, chattyRun.run_id) : null;
        delete process.env.FAKE_EVALUATOR_MODE;
        const chattyCalls = chattySettled?.annotation_attempts ?? [];
        const chattyReading = chattySettled?.annotation_reading ?? null;
        const chattyComplete = chattySettled?.status === 'done'
          && chattyCalls.length === (chattyReading?.units_planned ?? 0) + 1
          && chattyCalls.every((attempt) => attempt.ok === true && attempt.answer_chars > 0)
          && chattyReading?.complete === true
          && chattyReading?.units_completed === chattyReading?.units_planned;
        if (chattyComplete) {
          ok(`assessments/annotations: an evaluator that answers with the document and then keeps talking reads every unit and assembles them (${chattyCalls.length} call(s), ${chattyReading.units_completed} unit(s), reading complete)`);
        } else {
          fail(`assessments/annotations/chatty: status=${chattySettled?.status}, attempts=${JSON.stringify(chattyCalls.map((attempt) => attempt.ok))}, reading=${JSON.stringify(chattyReading)}, error=${chattySettled?.error ?? chattyRun.error}`);
        }

        // The compliance view of a review that has something to measure against: an approved design brief
        // declares a law of the world and a human accepted a direction, and the host turns both into rules of
        // this request beside the published general set. The evaluator reports outcomes for them; the report
        // then states a real rule failure, leaves an unreported rule unresolved with bounds, and refuses an
        // answer that tries to declare the rules itself.
        const brief = {
          schema_version: 'design.v1',
          design_id: 'check-brief',
          language: 'en',
          central_idea: 'A city that must be spoken to in order to stay standing.',
          premise: 'A keeper who reads the ledger aloud must choose which district to lose.',
          thematic_question: 'What does a city owe the people it forgets?',
          reader_promise: 'A quiet mystery about attention as an obligation.',
          world_assumptions: [
            { id: 'law-silence', epistemic_kind: 'law', text: 'A district that is never named in the accepted prose dissolves.', source: 'the design brief' },
            { id: 'belief-registry', epistemic_kind: 'belief', text: 'The registry believes the ledger is complete.', source: 'the design brief' }
          ]
        };
        const complianceBook = await bookOfChapters(2, 'compliance');
        const approved = await recordApproval({
          universeId: complianceBook.id,
          proposal: brief,
          decision: 'approved',
          reviewer: 'check',
          directions: ['Every chapter names the district it keeps standing.'],
          version: await currentVersion(complianceBook.id)
        });
        const statedIntention = 'a quiet mystery about attention';
        let ruledRun = null;
        process.env.FAKE_OUTCOMES = 'fail-last';
        try {
          const started = await startAssessment({
            universeId: complianceBook.id,
            phase: 'metrics',
            mode: 'generic',
            force: true,
            intention: statedIntention,
            request: 'the request the compliance review was asked about'
          });
          await settleAssessments();
          ruledRun = await readAssessment(complianceBook.id, started.run_id);
        } finally {
          delete process.env.FAKE_OUTCOMES;
        }
        const ruledDir = ruledRun ? dirname(join(assessmentsRoot(), ruledRun.result_dir)) : null;
        const ruledBundle = ruledRun?.result_dir
          ? await readFile(join(assessmentsRoot(), ruledRun.result_dir, 'assessment.json'), 'utf8').then((text) => JSON.parse(text), () => null)
          : null;
        const registryDocument = ruledDir
          ? await readFile(join(ruledDir, 'input', 'rules', 'applicable-rules.v1.json'), 'utf8').then((text) => JSON.parse(text), () => null)
          : null;
        const charterInPacket = ruledDir
          ? await stat(join(ruledDir, 'input', 'rules', 'charter.md')).then(() => true, () => false)
          : false;
        const rules = ruledBundle?.requirements?.rules ?? [];
        const car = ruledBundle?.requirements?.car ?? null;
        const briefRule = rules.find((rule) => rule.id === 'brief-law-silence') ?? null;
        const directionRule = rules.find((rule) => typeof rule.id === 'string' && rule.id.startsWith('direction-')) ?? null;
        const failure = (car?.failures ?? []).find((entry) => entry.rule === directionRule?.id) ?? null;
        const enforcementView = ruledRun?.result_dir
          ? await readFile(join(assessmentsRoot(), ruledRun.result_dir, '02-specification-adherence.md'), 'utf8').then((text) => text, () => '')
          : '';
        const ruleFailureVisible = failure !== null
          && (car?.failing_outputs ?? 0) >= 1
          && (enforcementView.includes(directionRule.id) || enforcementView.includes('CAR'));
        if (ruledRun?.status === 'done'
          && registryDocument?.registry_version === 'stg-rules.v1'
          && registryDocument?.rules?.some((rule) => rule.id === 'brief-law-silence')
          && registryDocument?.authoring?.brief?.present === true
          && registryDocument?.authoring?.request?.present === true
          && (registryDocument?.sources ?? []).some((source) => source.kind === 'charter' && source.sha256 !== null)
          && charterInPacket
          && briefRule !== null && directionRule !== null
          && (ruledRun.applied_rules ?? []).includes('brief-law-silence')
          && ruleFailureVisible
          && enforcementView.includes(brief.central_idea.slice(0, 24))) {
          ok(`assessments/compliance: an approved brief and an accepted direction become rules of this request (${rules.length} declared), the evaluator reports outcomes only, and a reported failure reaches the report (CAR ${car.value}, failing outputs ${car.failing_outputs}, unresolved ${car.unresolved?.length ?? 0})`);
        } else {
          fail(`assessments/compliance/rules: status=${ruledRun?.status}, approval=${approved?.decision}, registry=${registryDocument?.registry_version}, rules=${JSON.stringify(rules.map((rule) => rule.id))}, briefRule=${Boolean(briefRule)}, directionRule=${Boolean(directionRule)}, failure=${JSON.stringify(failure)}, car=${JSON.stringify(car && { value: car.value, failing: car.failing_outputs, unresolved: car.unresolved?.length, coverage: car.coverage })}, charter=${charterInPacket}, applied=${JSON.stringify(ruledRun?.applied_rules ?? null)}, error=${ruledRun?.error}`);
        }

        // A rule nobody reported stays unresolved: the compliance value is held back with its bounds instead
        // of being published as if the unexamined rule had passed.
        let unresolvedRun = null;
        process.env.FAKE_OUTCOMES = 'unresolved-rule';
        try {
          const started = await startAssessment({
            universeId: complianceBook.id,
            phase: 'metrics',
            mode: 'generic',
            force: true,
            intention: statedIntention,
            request: 'the unresolved-rule run'
          });
          await settleAssessments();
          unresolvedRun = await readAssessment(complianceBook.id, started.run_id);
        } finally {
          delete process.env.FAKE_OUTCOMES;
        }
        const unresolvedBundle = unresolvedRun?.result_dir
          ? await readFile(join(assessmentsRoot(), unresolvedRun.result_dir, 'assessment.json'), 'utf8').then((text) => JSON.parse(text), () => null)
          : null;
        const unresolvedCar = unresolvedBundle?.requirements?.car ?? null;
        const unresolvedPairs = (unresolvedCar?.unresolved ?? []).filter((entry) => entry.recorded === false);
        if (unresolvedRun?.status === 'done'
          && unresolvedPairs.length >= 1
          && unresolvedCar?.value === null
          && typeof unresolvedCar?.lower_bound === 'number' && typeof unresolvedCar?.upper_bound === 'number'
          && unresolvedCar.outcome_coverage < 1
          && String(unresolvedCar.missing_reason ?? '').includes('unresolved')) {
          ok(`assessments/compliance: a rule no unit reported is unresolved rather than passed (${unresolvedPairs.length} pair(s), ${unresolvedCar.recorded_outcomes}/${unresolvedCar.expected_outcomes} reported), and CAB holds its value back with the bounds ${Math.round(unresolvedCar.lower_bound)}..${Math.round(unresolvedCar.upper_bound)}`);
        } else {
          fail(`assessments/compliance/unresolved: status=${unresolvedRun?.status}, pairs=${JSON.stringify(unresolvedCar?.unresolved)}, value=${unresolvedCar?.value}, bounds=${unresolvedCar?.lower_bound}/${unresolvedCar?.upper_bound}, coverage=${unresolvedCar?.outcome_coverage}, reason=${unresolvedCar?.missing_reason}, error=${unresolvedRun?.error}`);
        }

        // An answer that declares its own rules is refused: the standard a book is measured against is the
        // one the host froze into the packet, never one an evaluator wrote into its own answer.
        let inventedRun = null;
        process.env.FAKE_OUTCOMES = 'invent-rule';
        try {
          const started = await startAssessment({
            universeId: complianceBook.id,
            phase: 'metrics',
            mode: 'generic',
            force: true,
            intention: statedIntention,
            request: 'the invented-rule run'
          });
          await settleAssessments();
          inventedRun = await readAssessment(complianceBook.id, started.run_id);
        } finally {
          delete process.env.FAKE_OUTCOMES;
        }
        const inventedAttempts = inventedRun?.annotation_attempts ?? [];
        const inventedRefused = inventedRun?.status === 'error'
          && inventedAttempts.length === 2
          && inventedAttempts.every((attempt) => attempt.ok === false)
          && String(inventedRun.error).includes('restates the applicable rules')
          && (inventedRun.outputs ?? []).length === 0;
        if (inventedRefused) {
          ok('assessments/compliance: an answer that restates the applicable rules is refused with the reason, sends the reading back once, and publishes nothing');
        } else {
          fail(`assessments/compliance/invented: status=${inventedRun?.status}, attempts=${JSON.stringify(inventedAttempts.map((attempt) => attempt.ok))}, error=${inventedRun?.error}, outputs=${JSON.stringify(inventedRun?.outputs)}`);
        }

        await rm(universeDir(complianceBook.id), { recursive: true, force: true }).catch(() => {});

        // C86 — a chapter that does not fit one unit is split at paragraph boundaries, and what results is a
        // range of that chapter whose surrounding text is context rather than selection. The planner is pure,
        // so the probe calls it directly under a budget small enough for a small chapter: the default budget is
        // never lowered anywhere.
        {
          const paragraph = `${'The ledger was read aloud so the district would keep standing. '.repeat(4)}\n\n`;
          const text = `# Big\n\n${paragraph.repeat(20)}`;
          const bytes = Buffer.from(text, 'utf8');
          const chapter = { number: 1, path: 'chapters/0001-big.md', bytes: bytes.length, text };
          const budget = { unit_bytes: 600, max_units: 12, total_bytes: 100000 };
          const plan = planReviewUnits({
            chapters: [chapter],
            selection: { kind: 'chapter', chapters: [1] },
            budget,
            contextChapters: [2],
            version: 'sha256:probe'
          });
          const ranges = plan.units.map((unit) => unit.ranges[0]);
          const contiguous = ranges.length > 1
            && ranges[0].start === 0 && ranges[ranges.length - 1].end === bytes.length
            && ranges.every((range, index) => index === 0 || range.start === ranges[index - 1].end);
          // Every split falls where the text breaks: what precedes a range's end is the end of a paragraph.
          const atBoundaries = ranges.slice(0, -1).every((range) => text.slice(0, range.end).endsWith('\n\n'));
          const ownChapterIsContext = plan.units.every((unit) => unit.context_chapters.includes(1) && unit.context_chapters.includes(2));
          const planningWhole = plan.omitted.length === 0 && plan.units.length > 1;
          const reading = unitReadingList(plan.units[0], [chapter], []);
          const listBlock = readingListBlock(reading);
          const contextStated = reading.selected.length === 1
            && reading.selected[0].ranges.length === 1
            && reading.selected[0].whole === false
            && listBlock.includes(
              `The selected bytes of \`chapters/0001-big.md\` are ${ranges[0].start}..${ranges[0].end}; the rest of that file is context, not selection.`
            );
          // The whole book still plans as one unit per small chapter: nothing is split or declared unread when
          // the budget allows it, which is the same book the runtime check reads to `complete: true`.
          const small = planReviewUnits({
            chapters: [{ number: 1, path: 'chapters/0001-one.md', bytes: 400, text: 'x'.repeat(400) }],
            selection: { kind: 'book', chapters: [1] },
            budget,
            contextChapters: [],
            version: 'sha256:probe'
          });
          const unsplit = small.units.length === 1
            && small.units[0].ranges[0].start === 0 && small.units[0].ranges[0].end === 400
            && small.omitted.length === 0;
          // A declared range is enforced on evidence: a quotation from the same file but outside the unit's own
          // bytes is context, and the host refuses it before it can support a judgement.
          const file = {
            path: chapter.path,
            role: 'chapter',
            chapter: 1,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.length,
            text
          };
          const quoteAt = (start) => {
            const quoted = bytes.subarray(start, start + 24).toString('utf8');
            return {
              schema_version: 'annotations.v1',
              source_version: null,
              evidence: [{ id: 'e1', file: chapter.path, sha256: file.sha256, start, end: start + Buffer.byteLength(quoted, 'utf8'), quote: quoted }]
            };
          };
          const rangeScope = { kind: 'chapter', chapters: [1], context_chapters: [2], segments: [], arcs: [], omitted: [], ranges: [ranges[0]] };
          const verdict = (start, scope) => validateGeneratedAnnotations({
            annotations: quoteAt(start),
            manifest: { files: [file] },
            files: [file],
            scope,
            vocabulary: null
          }).errors;
          const outsideErrors = verdict(ranges[0].end, rangeScope);
          const insideErrors = verdict(0, rangeScope);
          const rangeEnforced = outsideErrors.some((error) => error.includes('lies outside the selected bytes of'))
            && !insideErrors.some((error) => error.includes('lies outside the selected bytes of'));
          if (contiguous && atBoundaries && ownChapterIsContext && planningWhole && contextStated && unsplit && rangeEnforced) {
            ok(`assessments/reading/ranges: a chapter larger than the unit budget is split at paragraph boundaries into ${plan.units.length} contiguous range unit(s) (${ranges[0].start}..${ranges[0].end} first), the rest of the chapter and the neighbouring chapter travel as context, a quotation outside a unit's own bytes is refused, and a chapter inside the budget stays one whole unit with nothing declared unread`);
          } else {
            fail(`assessments/reading/ranges: units=${plan.units.length}, ranges=${JSON.stringify(ranges)}, contiguous=${contiguous}, boundaries=${atBoundaries}, context=${ownChapterIsContext}, planned=${planningWhole}, stated=${contextStated}, unsplit=${unsplit}, enforced=${rangeEnforced}, outside=${JSON.stringify(outsideErrors.slice(0, 3))}, inside=${JSON.stringify(insideErrors.slice(0, 3))}`);
          }
        }

        // C86 — a book that does not fit the reading budget is read partially and says so. The plan, with the
        // limits it was made under, is written beside the run before any call; the chapters that do not fit
        // are declared unread, and the published provenance carries that statement into the report.
        {
          const long = await bookOfChapters(14, 'bounded');
          try {
            const started = await startAssessment({
              universeId: long.id,
              phase: 'metrics',
              mode: 'generic',
              force: true,
              request: 'the bounded reading of a long book'
            });
            await settleAssessments();
            const run = await readAssessment(long.id, started.run_id);
            const directory = dirname(join(assessmentsRoot(), run.result_dir));
            const plan = await readFile(join(directory, 'generated', 'units', 'plan.json'), 'utf8').then((text) => JSON.parse(text), () => null);
            const bundle = await readFile(join(assessmentsRoot(), run.result_dir, 'assessment.json'), 'utf8').then((text) => JSON.parse(text), () => null);
            const carried = bundle?.provenance?.evaluator_provenance ?? null;
            const reading = run.annotation_reading ?? null;
            const omittedUnits = (run.annotation_units ?? []).filter((unit) => unit.state === 'omitted');
            const partial = run.status === 'done'
              && plan?.schema_version === 'bounded-reading.v1'
              && plan?.budget?.max_units === config.assessmentMaxUnits
              && plan?.budget?.unit_bytes === config.assessmentUnitBytes
              && plan?.budget?.total_bytes === config.assessmentTotalBytes
              && reading?.complete === false
              && reading?.units_planned === config.assessmentMaxUnits
              && reading?.units_omitted === 2
              && reading?.units_completed === config.assessmentMaxUnits
              && omittedUnits.length === 2
              && omittedUnits.some((unit) => unit.chapters.includes(14))
              && /partial/.test(String(reading?.note ?? ''))
              && carried?.reading?.complete === false
              && carried?.reading?.units_omitted === 2
              && carried?.settings?.unit_budget?.max_units === config.assessmentMaxUnits
              && carried?.calls?.allowed === config.assessmentMaxUnits * 2 + 2
              && typeof bundle?.metrics?.CS?.coverage === 'number' && bundle.metrics.CS.coverage < 1;
            if (partial) {
              ok(`assessments/reading/budget: a book of 14 chapters is planned as ${reading.units_planned} bounded unit(s) under limits stated before the first call, ${reading.units_omitted} chapter(s) stay unread, and the published reading says it is partial (coverage ${bundle.metrics.CS.coverage})`);
            } else {
              fail(`assessments/reading/budget: status=${run.status}, plan=${JSON.stringify(plan?.budget ?? null)}, reading=${JSON.stringify(reading)}, omitted=${JSON.stringify(omittedUnits)}, carried=${JSON.stringify(carried?.reading ?? null)}, budget=${JSON.stringify(carried?.settings?.unit_budget ?? null)}, calls=${JSON.stringify(carried?.calls ?? null)}, coverage=${bundle?.metrics?.CS?.coverage}, error=${run.error}`);
            }
          } finally {
            await rm(universeDir(long.id), { recursive: true, force: true }).catch(() => {});
          }
        }

        // C86 — every chapter is read as its own bounded unit, so a defect in the last chapter of a book is a
        // finding of that unit and not a chapter nobody opened. The per-unit observations are kept.
        {
          const late = await bookOfChapters(3, 'late');
          try {
            const started = await startAssessment({
              universeId: late.id,
              phase: 'metrics',
              mode: 'generic',
              force: true,
              request: 'the late-chapter run'
            });
            await settleAssessments();
            const run = await readAssessment(late.id, started.run_id);
            const directory = dirname(join(assessmentsRoot(), run.result_dir));
            const document = await readFile(join(directory, 'generated', 'annotations.json'), 'utf8').then((text) => JSON.parse(text), () => null);
            const units = run.annotation_units ?? [];
            const lastUnit = units.find((unit) => unit.chapters.includes(3)) ?? null;
            const lastArtifact = lastUnit?.artifact
              ? await readFile(join(directory, lastUnit.artifact), 'utf8').then((text) => JSON.parse(text), () => null)
              : null;
            const lastChapterFile = 'chapters/0003-c3.md';
            const citedLateChapter = (document?.evidence ?? []).some((item) => item.file === lastChapterFile)
              && (document?.evidence ?? []).filter((item) => item.file === lastChapterFile).every((item) => item.start >= 0 && item.end > item.start);
            const perUnit = (document?.unit_observations ?? []);
            const read = run.status === 'done'
              && run.annotation_reading?.complete === true
              && units.length === 3 && units.every((unit) => unit.state === 'completed')
              && lastUnit !== null && lastArtifact?.unit?.chapters?.includes(3)
              && Array.isArray(lastArtifact?.document?.findings) && lastArtifact.document.findings.length >= 1
              && citedLateChapter
              && perUnit.length === 3
              && perUnit.every((entry) => Array.isArray(entry.findings) && entry.findings.length >= 1)
              && run.annotation_reading?.units_completed === 3;
            if (read) {
              ok(`assessments/reading/units: the third chapter is read as its own unit (${lastUnit.id}), its observation and finding are kept in ${lastUnit.artifact}, and its quoted evidence is part of the published document`);
            } else {
              fail(`assessments/reading/units: status=${run.status}, reading=${JSON.stringify(run.annotation_reading)}, units=${JSON.stringify(units)}, artifact=${JSON.stringify(lastArtifact && { unit: lastArtifact.unit, findings: lastArtifact.document?.findings?.length })}, cited=${citedLateChapter}, perUnit=${JSON.stringify(perUnit)}, error=${run.error}`);
            }
          } finally {
            await rm(universeDir(late.id), { recursive: true, force: true }).catch(() => {});
          }
        }

        // C86 — an interrupted middle unit resumes: the units already read are reused from their artifacts
        // instead of being paid for twice, and the reading continues from where it stopped.
        {
          const resume = await bookOfChapters(3, 'resume');
          try {
            process.env.FAKE_UNIT_FAIL = 'u0002';
            let started = null;
            try {
              started = await startAssessment({
                universeId: resume.id,
                phase: 'metrics',
                mode: 'generic',
                force: true,
                request: 'the interrupted reading'
              });
              await settleAssessments();
            } finally {
              delete process.env.FAKE_UNIT_FAIL;
            }
            const interrupted = await readAssessment(resume.id, started.run_id);
            const directory = dirname(join(assessmentsRoot(), interrupted.result_dir));
            const callsBefore = await readFile(join(directory, 'fake-evaluator.calls'), 'utf8').catch(() => '');
            // Nothing is published from partial calls: the interrupted run built no report at all — checked
            // before the retry, which republishes into the same run directory.
            const publishedNothing = (interrupted.outputs ?? []).length === 0
              && interrupted.result_revision === null && interrupted.published_at === null
              && (await stat(join(assessmentsRoot(), interrupted.result_dir, 'assessment.json')).then(() => false, () => true));
            await retryAssessment(resume.id, started.run_id);
            await settleAssessments();
            const settled = await readAssessment(resume.id, started.run_id);
            const calls = (await readFile(join(directory, 'fake-evaluator.calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
            const interruptedUnits = interrupted.annotation_units ?? [];
            const firstUnitCalls = calls.filter((entry) => entry.unit === 'u0001-chapter-0001').length;
            const secondUnitCalls = calls.filter((entry) => entry.unit === 'u0002-chapter-0002').length;
            const failureNamed = (interruptedUnits.find((unit) => unit.id === 'u0002-chapter-0002')?.errors ?? [])
              .some((error) => /exited with code 1/.test(String(error)));
            // A reading claims to be complete only when every declared unit was read: neither the interrupted
            // reading (one failed, one unread) nor any other record of this book may say otherwise.
            const completeMeansComplete = (reading) => reading === null
              || reading.complete !== true
              || (reading.units_failed === 0 && reading.units_omitted === 0 && reading.units_completed === reading.units_planned);
            const bookRuns = await listAssessments(resume.id);
            const completenessHonest = (interrupted.annotation_reading?.complete === false)
              && (interrupted.annotation_reading?.units_failed === 1)
              && bookRuns.every((entry) => completeMeansComplete(entry.annotation_reading));
            const resumed = interrupted.status === 'error'
              && publishedNothing && failureNamed && completenessHonest
              && interruptedUnits.some((unit) => unit.id === 'u0001-chapter-0001' && unit.state === 'completed')
              && interruptedUnits.some((unit) => unit.id === 'u0002-chapter-0002' && unit.state === 'failed')
              && interruptedUnits.some((unit) => unit.id === 'u0003-chapter-0003' && unit.state === 'unread')
              && settled.status === 'done'
              && settled.annotation_reading?.complete === true
              && settled.annotation_reading?.units_reused === 1
              && settled.annotation_reading?.units_completed === 3
              && firstUnitCalls === 1
              && secondUnitCalls >= 2;
            if (resumed) {
              ok(`assessments/reading/resume: an interrupted unit fails the run with ${interruptedUnits.filter((unit) => unit.state === 'completed').length} unit(s) already read, and the retry reuses that unit (${firstUnitCalls} call for chapter 1, ${secondUnitCalls} for the one that failed) and finishes the reading`);
            } else {
              fail(`assessments/reading/resume: interrupted=${interrupted.status}/${JSON.stringify(interruptedUnits)}, publishedNothing=${publishedNothing}, failureNamed=${failureNamed}, completenessHonest=${completenessHonest}, reading=${JSON.stringify(interrupted.annotation_reading)}, callsBefore=${callsBefore.trim().split('\n').length}, settled=${settled.status}, settledReading=${JSON.stringify(settled.annotation_reading)}, unit1Calls=${firstUnitCalls}, unit2Calls=${secondUnitCalls}, error=${settled.error ?? interrupted.error}`);
            }
          } finally {
            await rm(universeDir(resume.id), { recursive: true, force: true }).catch(() => {});
          }
        }

        // An evaluator that answers without JSON is not a review: the run fails, records why, and the
        // packet is still untouched.
        process.env.FAKE_EVALUATOR_MODE = 'garbage';
        // The request must come back at once — the model work belongs to the run, not to the caller's HTTP
        // request — and the run must then fail with the reason the evaluator gave.
        const refusedStarted = Date.now();
        const refusalRun = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', force: true });
        const answeredIn = Date.now() - refusedStarted;
        await settleAssessments();
        delete process.env.FAKE_EVALUATOR_MODE;
        const refusalSettled = await readAssessment(universe.id, refusalRun.run_id);
        // The request answers at once; the run object handed back is live, so its status may already have
        // moved on by the time it is read. What matters is that the caller did not wait for the model.
        const refusedQuickly = answeredIn < 5_000;
        const attempts = refusalSettled.annotation_attempts ?? [];
        const failedCleanly = refusalSettled.status === 'error'
          && /annotation stage/.test(String(refusalSettled.error))
          && attempts.length === 2 && attempts.every((attempt) => attempt.ok === false)
          && (refusalSettled.outputs ?? []).length === 0;
        if (refusedQuickly && failedCleanly) {
          ok(`assessments/annotations: the request answers while the run is queued (${answeredIn} ms) and the run then fails on the evaluator's own words (${String(refusalSettled.error).slice(0, 60)}…) with its two attempts recorded and nothing published`);
        } else {
          fail(`assessments/annotations/refusal: answeredIn=${answeredIn}ms, settled=${refusalSettled.status}, error=${refusalSettled.error}, attempts=${JSON.stringify(attempts.map((attempt) => attempt.ok))}, outputs=${JSON.stringify(refusalSettled.outputs)}`);
        }
      // The model's reading list: a chapter selection reaches the evaluator as the selection, with the rest
      // of the book named as omitted, and the published bundle says the same thing the model was told.
      {
        const selected = await startAssessment({
          universeId: universe.id,
          phase: 'metrics',
          mode: 'generic',
          scope: { kind: 'chapter', chapters: [1] },
          force: true
        });
        await settleAssessments();
        const run = await readAssessment(universe.id, selected.run_id);
        const directory = dirname(join(assessmentsRoot(), run.result_dir));
        const prompt = await readFile(join(directory, 'generated', 'prompt-attempt-1.txt'), 'utf8').catch(() => '');
        const bundle = await readFile(join(assessmentsRoot(), run.result_dir, 'assessment.json'), 'utf8').then((text) => JSON.parse(text), () => null);
        const scopeLine = /REVIEW SCOPE: ([^\n]+)/.exec(prompt)?.[1] ?? '';
        const omittedLine = prompt.includes('Omitted from this review: `chapters/0002-two.md`');
        const selectedLine = prompt.includes('chapters/0001-one.md');
        const evidenceRule = prompt.includes('Evidence must come from the selected text');
        const bundleScope = bundle?.scope ?? null;
        if (run.status === 'done'
          && /chapter 1/.test(scopeLine) && !/complete 1, 2/.test(scopeLine)
          && omittedLine && selectedLine && evidenceRule
          && bundleScope?.kind === 'chapter' && (bundleScope?.chapters ?? []).join(',') === '1') {
          ok('assessments/scope: a chapter-1 selection reaches the evaluator as "REVIEW SCOPE: chapter 1" with chapter 2 named as omitted and evidence restricted to the selection, and the published bundle labels its results chapter 1');
        } else {
          fail(`assessments/scope/prompt: scopeLine=${JSON.stringify(scopeLine)}, omitted=${omittedLine}, selected=${selectedLine}, rule=${evidenceRule}, bundle=${JSON.stringify(bundleScope)}`);
        }
      }

      // The identity of a run covers every effective input: the fingerprint changes with the mode, the
      // evaluator, the request words and the prompt material, and two equivalent requests still dedupe.
      {
        const base = {
          phase: 'metrics',
          version: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          scope: { kind: 'chapter', chapters: [1], segments: [], arcs: [], context_chapters: [], omitted: [2] },
          profileSha256: 'p',
          annotationsSha256: null,
          corpusManifestSha256: null,
          resources: [],
          mode: 'deterministic',
          evaluator: null,
          prompt: 'prompt-material-v1',
          request: 'the opening',
          intention: null,
          brief: null
        };
        const same = inputFingerprint(base);
        const variants = {
          mode: inputFingerprint({ ...base, mode: 'generic', evaluator: 'model:x' }),
          evaluator: inputFingerprint({ ...base, evaluator: 'model:y' }),
          request: inputFingerprint({ ...base, request: 'the ending' }),
          intention: inputFingerprint({ ...base, intention: 'a quiet aftermath' }),
          brief: inputFingerprint({ ...base, brief: 'the charter' }),
          prompt: inputFingerprint({ ...base, prompt: 'prompt-material-v2' }),
          scope: inputFingerprint({ ...base, scope: { ...base.scope, chapters: [2], omitted: [1] } })
        };
        const changed = Object.entries(variants).every(([field, value]) => value !== same);
        const stable = inputFingerprint(base) === same;
        if (changed && stable) {
          ok('assessments/identity/inputs: the run fingerprint changes with the mode, the evaluator, the request, the intention, the brief, the prompt material and the scope, and identical inputs produce the identical fingerprint');
        } else {
          fail(`assessments/identity/inputs: changed=${JSON.stringify(Object.fromEntries(Object.entries(variants).map(([field, value]) => [field, value !== same])))}, stable=${stable}`);
        }

        // Unique inputs, so the only runs these can collide with are each other.
        const probe = { intention: 'identity probe', request: 'the identity probe request' };
        const deterministic = await startAssessment({
          universeId: universe.id,
          phase: 'metrics',
          mode: 'deterministic',
          scope: { kind: 'chapter', chapters: [1] },
          ...probe
        });
        await settleAssessments();
        const generic = await startAssessment({
          universeId: universe.id,
          phase: 'metrics',
          mode: 'generic',
          scope: { kind: 'chapter', chapters: [1] },
          ...probe
        });
        await settleAssessments();
        const genericTwice = await startAssessment({
          universeId: universe.id,
          phase: 'metrics',
          mode: 'generic',
          scope: { kind: 'chapter', chapters: [1] },
          ...probe
        });
        await settleAssessments();
        const deterministicRun = await readAssessment(universe.id, deterministic.run_id);
        const genericRun = await readAssessment(universe.id, generic.run_id);
        if (generic.deduplicated !== true && generic.run_id !== deterministic.run_id
          && genericTwice.deduplicated === true && genericTwice.run_id === generic.run_id
          && deterministicRun.status === 'done' && genericRun.status === 'done') {
          ok('assessments/identity/inputs: a deterministic run and a model run over the same selection are two different reviews, while the same model request repeated deduplicates onto the first');
        } else {
          fail(`assessments/identity/inputs/e2e: deterministic=${deterministic.run_id}/${deterministic.deduplicated}, generic=${generic.run_id}/${generic.deduplicated}, twice=${genericTwice.run_id}/${genericTwice.deduplicated}, statuses=${deterministicRun.status}/${genericRun.status}`);
        }
      }

      // A process failure is not a successful reading: a valid document followed by a failing exit publishes
      // nothing, and an answer that overflows the byte budget is stopped and recorded as an overflow.
      for (const mode of ['exit-1-after-answer', 'flood']) {
        process.env.FAKE_EVALUATOR_MODE = mode;
        const started = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', force: true });
        await settleAssessments();
        const settled = await readAssessment(universe.id, started.run_id);
        delete process.env.FAKE_EVALUATOR_MODE;
        const attempts = settled.annotation_attempts ?? [];
        const first = attempts[0] ?? {};
        const expected = mode === 'flood' ? 'budget' : 'exited with code 1';
        if (settled.status === 'error' && String(settled.error).includes(expected)
          && first.process_failure === true && (settled.outputs ?? []).length === 0) {
          ok(`assessments/annotations/process: an evaluator that ${mode === 'flood' ? 'overflows the answer budget' : 'answers and then exits 1'} fails the run (${String(settled.error).slice(0, 60)}…) with the attempt recorded as a process failure and nothing published`);
        } else {
          fail(`assessments/annotations/process/${mode}: status=${settled.status}, error=${settled.error}, failure=${first.process_failure}, outputs=${JSON.stringify(settled.outputs)}, attempts=${JSON.stringify(attempts.map((entry) => entry.ok))}`);
        }
      }
      {
        const sleeping = await mkdtemp(join(tmpdir(), 'sleeping-evaluator-'));
        await writeFile(join(sleeping, 'fake-evaluator.mjs'), `#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
process.stdin.resume();
await delay(60_000);
`, 'utf8');
        await writeFile(join(sleeping, 'omp'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-evaluator.mjs" "$@"\n', 'utf8');
        await chmod(join(sleeping, 'omp'), 0o755);
        const previousPath = process.env.PATH ?? '';
        process.env.PATH = `${sleeping}:${previousPath}`;
        try {
          const timed = await runAnnotationStage({ runDir: universeDir(universe.id), prompt: 'read the book', timeoutMs: 800 });
          if (timed.ok === false && timed.timedOut === true && timed.overflowed === false) {
            ok('assessments/annotations/process: an evaluator that never answers is timed out and reported as a process failure, not as a wrong answer');
          } else {
            fail(`assessments/annotations/process/timeout: ok=${timed.ok}, timedOut=${timed.timedOut}, code=${timed.code}, signal=${timed.signal}`);
          }
        } finally {
          process.env.PATH = previousPath;
          await rm(sleeping, { recursive: true, force: true });
        }
      }

      // Cancellation during the annotation stage: the run is cancelled, the child is stopped, a late
      // success cannot overwrite it, and a retry is refused while the child still lives.
      {
        process.env.FAKE_EVALUATOR_MODE = 'hang';
        const hanging = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', force: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        const cancelled = await cancelAssessment(universe.id, hanging.run_id);
        let retryRefused = null;
        try {
          await retryAssessment(universe.id, hanging.run_id);
        } catch (error) {
          retryRefused = error.code;
        }
        delete process.env.FAKE_EVALUATOR_MODE;
        await settleAssessments();
        const settled = await readAssessment(universe.id, hanging.run_id);
        if (cancelled.status === 'cancelled' && settled.status === 'cancelled'
          && (settled.outputs ?? []).length === 0 && retryRefused === 'NOT_RETRYABLE') {
          ok('assessments/annotations/cancel: a cancellation during the annotation stage stops the child, keeps the run cancelled even when the child outlives its signal, publishes nothing, and refuses a retry while the child lives');
        } else {
          fail(`assessments/annotations/cancel: cancelled=${cancelled.status}, settled=${settled.status}, outputs=${JSON.stringify(settled.outputs)}, retry=${retryRefused}, error=${settled.error}`);
        }
      }

      // The write boundary is what the child was given, and the integrity claim is over real bytes: a
      // mutation, a removed chapter or a removed manifest fails the run with nothing published.
      {
        const run = await readAssessment(universe.id, generated?.run_id ?? (await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', force: true })).run_id);
        const directory = dirname(join(assessmentsRoot(), run.result_dir));
        const marker = await readFile(join(directory, 'fake-evaluator.marker'), 'utf8').then((text) => JSON.parse(text), () => null);
        const args = String(marker?.args ?? '');
        if (args.includes('--tools read,grep,glob') && !/--tools [^ ]*(write|edit|bash)/.test(args) && !args.includes('write')) {
          ok('assessments/annotations/boundary: the evaluator is launched with the read-only tool list (read, grep, glob) and no writing tool');
        } else {
          fail(`assessments/annotations/boundary: args=${args}`);
        }
        for (const mode of ['tamper', 'remove-chapter', 'remove-manifest']) {
          process.env.FAKE_EVALUATOR_MODE = mode;
          const damaged = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', force: true });
          await settleAssessments();
          const settled = await readAssessment(universe.id, damaged.run_id);
          delete process.env.FAKE_EVALUATOR_MODE;
          if (settled.status === 'error' && settled.packet_intact === false && (settled.outputs ?? []).length === 0
            && /missing|changed/.test(String(settled.error))) {
            ok(`assessments/annotations/integrity: a ${mode} during the evaluator call fails the run with packet_intact false and publishes nothing`);
          } else {
            fail(`assessments/annotations/integrity/${mode}: status=${settled.status}, intact=${settled.packet_intact}, outputs=${JSON.stringify(settled.outputs)}, error=${settled.error}`);
          }
        }
      }

      // The contract the report consumes, checked before the stage accepts or repairs: a disposition for
      // every requested component, honest unavailability as a valid answer, UTF-8 boundaries, and a
      // quotation that occurs more than once accepted at the occurrence it declares.
      {
        const vocab = JSON.parse(await readFile(join('skills', 'scripta-metrics-report', 'schema', 'annotations.v1.json'), 'utf8'));
        const text = 'Ana sagte: „Grüße, Grüße". Ana sagte: „Grüße, Grüße".';
        const bytes = Buffer.from(text, 'utf8');
        const chapterFile = {
          path: 'chapters/0001-x.md',
          role: 'chapter',
          chapter: 1,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
          text
        };
        const scope = { kind: 'chapter', chapters: [1], context_chapters: [], arcs: [], segments: [] };
        const empty = { schema_version: 'annotations.v1', source_version: 'sha256:placeholder', metrics: {}, indicators: [] };
        const version = validateGeneratedAnnotations({ annotations: empty, manifest: { files: [chapterFile] }, files: [chapterFile], scope, vocabulary: vocab }).version;
        const refused = validateGeneratedAnnotations({ annotations: { ...empty, source_version: version }, manifest: { files: [chapterFile] }, files: [chapterFile], scope, vocabulary: vocab });
        const needed = ['CS', 'OI', 'NCS', 'EAP'].every((id) => refused.errors.some((error) => error.includes(`metrics.${id} has no entry`)));
        const indicatorsNeeded = Object.keys(vocab.indicators).every((id) => refused.errors.some((error) => error.includes(`indicator ${JSON.stringify(id)} has no entry`)));
        if (!refused.ok && needed && indicatorsNeeded) {
          ok('assessments/annotations/contract: a document that disposes of nothing is refused, naming every requested metric and indicator');
        } else {
          fail(`assessments/annotations/contract/empty: ok=${refused.ok}, errors=${JSON.stringify(refused.errors.slice(0, 6))}`);
        }
        // An honest unavailable answer is a valid answer; silence is not.
        const honest = {
          schema_version: 'annotations.v1',
          source_version: version,
          metrics: Object.fromEntries(['CS', 'OI', 'NCS', 'EAP'].map((id) => [id, { status: 'not_assessable', missing_reason: 'the selection holds no scene this metric can read' }])),
          indicators: Object.keys(vocab.indicators).map((id) => ({ id, status: 'not_assessable', missing_reason: 'nothing in the selection supports an observation' }))
        };
        const honestResult = validateGeneratedAnnotations({ annotations: honest, manifest: { files: [chapterFile] }, files: [chapterFile], scope, vocabulary: vocab });
        const silent = { ...honest, metrics: { ...honest.metrics, CS: { status: 'not_assessable' } } };
        const silentResult = validateGeneratedAnnotations({ annotations: silent, manifest: { files: [chapterFile] }, files: [chapterFile], scope, vocabulary: vocab });
        if (honestResult.ok && !silentResult.ok && silentResult.errors.some((error) => error.includes('without a reason'))) {
          ok('assessments/annotations/contract: an explicit not_assessable with a reason is accepted, the same status without a reason is refused');
        } else {
          fail(`assessments/annotations/contract/unavailable: honest=${honestResult.ok}, silent=${silentResult.ok}, errors=${JSON.stringify(silentResult.errors.slice(0, 4))}`);
        }
        // A repeated passage is evidence; offsets inside a character are not.
        const quote = 'Ana sagte';
        const first = bytes.indexOf(Buffer.from(quote, 'utf8'));
        const second = bytes.indexOf(Buffer.from(quote, 'utf8'), first + 1);
        const withQuote = (start) => ({
          ...honest,
          evidence: [{ id: 'e1', file: chapterFile.path, sha256: chapterFile.sha256, start, end: start + Buffer.byteLength(quote, 'utf8'), quote }]
        });
        const late = validateGeneratedAnnotations({ annotations: withQuote(second), manifest: { files: [chapterFile] }, files: [chapterFile], scope, vocabulary: vocab });
        const insideChar = bytes.indexOf(Buffer.from('ü', 'utf8'));
        const broken = validateGeneratedAnnotations({ annotations: withQuote(insideChar + 1), manifest: { files: [chapterFile] }, files: [chapterFile], scope, vocabulary: vocab });
        if (late.ok && !broken.ok && broken.errors.some((error) => error.includes('UTF-8 character boundaries'))) {
          ok('assessments/annotations/contract: a quotation at its second occurrence is accepted, while offsets that fall inside a multibyte character are refused');
        } else {
          fail(`assessments/annotations/contract/offsets: late=${late.ok}, broken=${broken.ok}, errors=${JSON.stringify(broken.errors.slice(0, 4))}`);
        }
        // A model cannot count bytes in a file it reads through a paged view, so an answer may name the line a
        // passage is on and quote it: the host resolves the pair to the bytes of the frozen file, refuses a
        // quotation that occurs more than once between the lines it names, and refuses one that is not there.
        const anchoredFile = {
          path: 'chapters/0001-x.md',
          role: 'chapter',
          chapter: 1,
          sha256: createHash('sha256').update(Buffer.from('erste Zeile\nzweite Zeile mit Grüße und Grüße\n', 'utf8')).digest('hex'),
          bytes: Buffer.byteLength('erste Zeile\nzweite Zeile mit Grüße und Grüße\n', 'utf8'),
          text: 'erste Zeile\nzweite Zeile mit Grüße und Grüße\n'
        };
        const base = {
          schema_version: 'annotations.v1',
          source_version: validateGeneratedAnnotations({ annotations: empty, manifest: { files: [anchoredFile] }, files: [anchoredFile], scope, vocabulary: vocab }).version,
          metrics: Object.fromEntries(['CS', 'OI', 'NCS', 'EAP'].map((id) => [id, { status: 'not_assessable', missing_reason: 'nothing in the selection supports an observation' }])),
          indicators: Object.keys(vocab.indicators).map((id) => ({ id, status: 'not_assessable', missing_reason: 'nothing in the selection supports an observation' }))
        };
        const withAnchored = (item) => ({ ...base, evidence: [item] });
        const item = { id: 'e1', file: anchoredFile.path, sha256: anchoredFile.sha256 };
        const uniqueDocument = withAnchored({ ...item, line: 2, quote: 'zweite Zeile mit' });
        const unique = validateGeneratedAnnotations({
          annotations: uniqueDocument,
          manifest: { files: [anchoredFile] }, files: [anchoredFile], scope, vocabulary: vocab
        });
        const resolvedItem = uniqueDocument.evidence[0];
        const ambiguous = validateGeneratedAnnotations({
          annotations: withAnchored({ ...item, line: 2, quote: 'Grüße' }),
          manifest: { files: [anchoredFile] }, files: [anchoredFile], scope, vocabulary: vocab
        });
        const absent = validateGeneratedAnnotations({
          annotations: withAnchored({ ...item, line: 1, quote: 'zweite Zeile' }),
          manifest: { files: [anchoredFile] }, files: [anchoredFile], scope, vocabulary: vocab
        });
        const resolvedBytes = anchoredFile.text.slice(resolvedItem.start, resolvedItem.end);
        const resolvedOk = unique.ok && unique.evidence_resolved === 1
          && resolvedItem.offsets_resolved_by === 'host'
          && resolvedBytes === 'zweite Zeile mit'
          && ambiguous.ok === false && ambiguous.errors.some((error) => error.includes('occurs 2 times'))
          && absent.ok === false && absent.errors.some((error) => error.includes('does not occur on line 1'));
        if (resolvedOk) {
          ok(`assessments/annotations/contract/anchored: a quotation named by line and text is resolved by the host to its exact bytes (${resolvedItem.start}..${resolvedItem.end}, recorded as resolved by the host), while one that occurs twice between the named lines and one that is not on them are both refused`);
        } else {
          fail(`assessments/annotations/contract/anchored: unique=${unique.ok}/${unique.evidence_resolved}/${resolvedItem.start}..${resolvedItem.end}/${JSON.stringify(resolvedItem.offsets_resolved_by)} bytes=${JSON.stringify(resolvedBytes)}, ambiguous=${ambiguous.ok}/${JSON.stringify(ambiguous.errors.slice(0, 2))}, absent=${absent.ok}/${JSON.stringify(absent.errors.slice(0, 2))}`);
        }
      }

      // A document that disposes of nothing goes back to the evaluator once, is refused again, and the run
      // fails with the contract's own words.
      {
        process.env.FAKE_EVALUATOR_MODE = 'empty-document';
        const refusedRun = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', force: true });
        await settleAssessments();
        delete process.env.FAKE_EVALUATOR_MODE;
        const settled = await readAssessment(universe.id, refusedRun.run_id);
        const corpus = JSON.stringify(settled.annotation_errors ?? []);
        if (settled.status === 'error' && Array.isArray(settled.annotation_attempts) && settled.annotation_attempts.length === 2 && /has no entry/.test(corpus) && (settled.outputs ?? []).length === 0) {
          ok('assessments/annotations/contract/repair: a document with no dispositions is sent back once with the contract errors, stays refused, and the run publishes nothing');
        } else {
          fail(`assessments/annotations/contract/repair: status=${settled.status}, attempts=${settled.annotation_attempts}, errors=${corpus.slice(0, 220)}, outputs=${JSON.stringify(settled.outputs)}`);
        }
      }

      // The evaluator is given the material that gives its ratings meaning, and the check reads what the
      // evaluator actually received: the five anchored rating descriptions, the evidence question and the
      // 0..4 answers of every dimension, the indicator definitions and qualifications, a real paired case in
      // the book's language with its alternative readings — and none of the declared regression holdout.
      {
        const run = await readAssessment(universe.id, generated.run_id);
        const directory = dirname(join(assessmentsRoot(), run.result_dir));
        const prompt = await readFile(join(directory, 'generated', 'prompt-attempt-1.txt'), 'utf8').catch(() => '');
        const anchors = JSON.parse(await readFile(join('skills', 'scripta-metrics-report', 'schema', 'rubric-anchors.v1.json'), 'utf8'));
        const index = JSON.parse(await readFile(join('skills', 'scripta-metrics-report', 'fixtures', 'literary-cases', 'index.json'), 'utf8'));
        const scale = (anchors.ratings ?? []).every((entry) => prompt.includes(entry.description));
        const dimensions = Object.entries(anchors.metrics ?? {}).flatMap(([id, metric]) =>
          Object.entries(metric.dimensions ?? {}).map(([name, dimension]) => ({
            name: `${id}.${name}`,
            carried: prompt.includes(`${id}.${name}`)
              && prompt.includes(dimension.evidence_question)
              && Object.values(dimension.ratings ?? {}).every((text) => prompt.includes(text))
          })));
        const indicators = Object.entries(anchors.indicators ?? {}).every(([id, indicator]) =>
          prompt.includes(id)
          && prompt.includes(indicator.definition)
          && (indicator.intended_effect_qualifications ?? []).every((text) => prompt.includes(text)));
        const noDefectRule = prompt.includes(anchors.defaults.statement) && prompt.includes(anchors.defaults.justified_exception);
        const included = [...prompt.matchAll(/^- ([a-z]{2}-[0-9]{2}-[a-z-]+) \[([a-z]{2})\]/gm)].map((match) => ({ id: match[1], language: match[2] }));
        const paired = (await Promise.all(included.map(async (entry) => {
          const caseEntry = (index.cases ?? []).find((candidate) => candidate.id === entry.id);
          if (!caseEntry?.file) return null;
          const document = await readFile(join('skills', 'scripta-metrics-report', 'fixtures', 'literary-cases', caseEntry.file), 'utf8').then(JSON.parse, () => null);
          if (!document) return null;
          const alternative = document.acceptable_alternative_readings?.[0] ?? null;
          return {
            id: document.id,
            language: document.language,
            complete: prompt.includes(document.before.text.slice(0, 200))
              && prompt.includes(document.after.text.slice(0, 200))
              && prompt.includes(document.change.feature)
              && prompt.includes(String(document.expected_evidence?.[0]?.quote ?? '').slice(0, 60))
              && alternative !== null && prompt.includes(alternative)
          };
        }))).filter(Boolean);
        const language = await readFile(join(assessmentsRoot(), run.input_dir, 'manifest.json'), 'utf8').then((text) => JSON.parse(text).book?.language, () => null);
        const realCase = paired.find((entry) => entry.language === language && entry.complete) ?? null;
        const holdoutCases = await Promise.all((index.regression_subset?.case_ids ?? []).map(async (id) => {
          const caseEntry = (index.cases ?? []).find((candidate) => candidate.id === id);
          if (!caseEntry?.file) return null;
          return readFile(join('skills', 'scripta-metrics-report', 'fixtures', 'literary-cases', caseEntry.file), 'utf8').then(JSON.parse, () => null);
        }));
        const holdout = [
          ...(index.regression_subset?.case_ids ?? []).filter((id) => prompt.includes(id)),
          ...holdoutCases.filter(Boolean).flatMap((document) => [document.before.text.slice(0, 120), document.after.text.slice(0, 120)]).filter((text) => prompt.includes(text))
        ];
        const boundsStated = prompt.includes(String(MAX_PROMPT_BYTES)) && prompt.includes(String(MAX_OUTPUT_BYTES));
        const noPlaceholder = !prompt.includes('the feature that changed');
        if (run.status === 'done' && scale && dimensions.length >= 9 && dimensions.every((entry) => entry.carried)
          && indicators && noDefectRule && realCase !== null && holdout.length === 0 && boundsStated && noPlaceholder) {
          ok(`assessments/annotations/prompt-material: the evaluator receives the anchored 0..4 descriptions, the evidence question and answers of all ${dimensions.length} dimensions, the indicator definitions and qualifications, the no-defect rule, a complete paired ${realCase.id} case in the book's language with its alternative readings, and the declared bounds — with the regression holdout and the old placeholder absent`);
        } else {
          fail(`assessments/annotations/prompt-material: status=${run.status}, scale=${scale}, dimensions=${JSON.stringify(dimensions.filter((entry) => !entry.carried).map((entry) => entry.name))}, indicators=${indicators}, rule=${noDefectRule}, cases=${JSON.stringify(paired)}, language=${language}, holdout=${JSON.stringify(holdout)}, bounds=${boundsStated}, placeholder=${!noPlaceholder}, chars=${prompt.length}`);
        }
      }

      // What the evaluator saw and what it produced, kept so another session can establish both: the exact
      // prompt (the bytes the child received), the published rubric and case-selection hashes, the model and
      // the settings, the identity of every attempt, and the hash of the artifact that was published — every
      // one of them checked against the bytes on disk, and the evaluator identity derived from the host's own
      // invocation rather than from the label the document carries.
      {
        const run = await readAssessment(universe.id, generated.run_id);
        const directory = dirname(join(assessmentsRoot(), run.result_dir));
        const marker = await readFile(join(directory, 'fake-evaluator.marker'), 'utf8').then((text) => JSON.parse(text), () => null);
        const documentBytes = await readFile(join(directory, run.generated_annotations ?? 'generated/annotations.json')).catch(() => null);
        const promptBytes = await readFile(join(directory, 'generated', 'prompt.txt')).catch(() => null);
        const standalone = await readFile(join(directory, 'generated', 'provenance.json'), 'utf8').then(JSON.parse, () => null);
        const anchorsBytes = await readFile(join('skills', 'scripta-metrics-report', 'schema', 'rubric-anchors.v1.json'));
        const vocabularyBytes = await readFile(join('skills', 'scripta-metrics-report', 'schema', 'annotations.v1.json'));
        const indexBytes = await readFile(join('skills', 'scripta-metrics-report', 'fixtures', 'literary-cases', 'index.json'));
        const selectorBytes = await readFile(join('skills', 'scripta-metrics-report', 'scripts', 'select-cases.mjs'));
        const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
        const provenance = run.annotation_provenance ?? null;
        const document = documentBytes ? JSON.parse(documentBytes.toString('utf8')) : null;
        const bundle = await readFile(join(assessmentsRoot(), run.result_dir, 'assessment.json'), 'utf8').then((text) => JSON.parse(text), () => null);
        const carried = bundle?.provenance?.evaluator_provenance ?? null;
        const artifactsMatch = Array.isArray(standalone?.artifacts) && standalone.artifacts.length >= 2
          && (await Promise.all(standalone.artifacts.map(async (artifact) => {
            const bytes = await readFile(join(directory, artifact.path)).catch(() => null);
            return bytes !== null && hash(bytes) === artifact.sha256 && bytes.length === artifact.bytes;
          }))).every(Boolean);
        const publishedHashMatchesBytes = documentBytes !== null && run.annotations_sha256 === hash(documentBytes);
        const promptIsWhatTheChildSaw = promptBytes !== null && promptBytes.toString('utf8') === String(marker?.prompt ?? '');
        if (run.status === 'done'
          && publishedHashMatchesBytes
          && promptIsWhatTheChildSaw
          && run.annotation_prompt_sha256 === hash(promptBytes)
          && provenance?.schema_version === 'evaluator-provenance.v1'
          && typeof provenance.evaluator_id === 'string' && provenance.evaluator_id.startsWith('host:')
          && provenance.prompt?.sha256 === run.annotation_prompt_sha256
          && provenance.resources?.rubric_anchors?.sha256 === hash(anchorsBytes)
          && provenance.resources?.vocabulary?.sha256 === hash(vocabularyBytes)
          && provenance.resources?.case_index?.sha256 === hash(indexBytes)
          && provenance.resources?.case_selector?.sha256 === hash(selectorBytes)
          && provenance.settings?.model === run.annotation_model
          && JSON.stringify(provenance.settings?.tools) === JSON.stringify(['read', 'grep', 'glob'])
          && provenance.settings?.no_lsp === true
          && provenance.attempts?.length === provenance.calls?.used
          && provenance.calls?.used === (run.annotation_reading?.unit_calls ?? 0) + provenance.calls?.synthesis_calls
          && provenance.calls?.allowed === (run.annotation_reading?.units_planned ?? 0) * 2 + 2
          && provenance.attempts?.some((entry) => entry.prompt_sha256 === run.annotation_prompt_sha256)
          && provenance.attempts.every((entry) => typeof entry.attempt_id === 'string' && entry.attempt_id.length === 64)
          && provenance.attempts.filter((entry) => entry.call === 'unit').length === (run.annotation_reading?.unit_calls ?? 0)
          && (await Promise.all(provenance.attempts.map(async (entry) => {
            const bytes = await readFile(join(directory, entry.prompt_file)).catch(() => null);
            return bytes !== null && hash(bytes) === entry.prompt_sha256;
          }))).every(Boolean)
          && (provenance.selection?.chapters ?? []).length >= 1
          && provenance.provider_usage === null
          && document?.evaluator_provenance?.evaluator_id === provenance.evaluator_id
          && carried?.evaluator_id === provenance.evaluator_id
          && carried?.prompt?.sha256 === run.annotation_prompt_sha256
          && bundle?.provenance?.annotations?.sha256 === hash(documentBytes)
          && artifactsMatch) {
          ok(`assessments/annotations/provenance: the run keeps the exact prompt the child received (${promptBytes.length} bytes, sha ${run.annotation_prompt_sha256.slice(0, 12)}…), the rubric and case-selection hashes, the model and its read-only settings, the attempt identity, the selection and the artifact hashes; the published hash is the hash of the bytes on disk, and the portable bundle carries the same evaluator provenance and document hash`);
        } else {
          fail(`assessments/annotations/provenance: status=${run.status}, hashMatchesBytes=${publishedHashMatchesBytes}, promptExact=${promptIsWhatTheChildSaw}, promptSha=${String(run.annotation_prompt_sha256).slice(0, 12)}, evaluator=${provenance?.evaluator_id}, resources=${JSON.stringify(provenance?.resources ?? null)?.slice(0, 160)}, settings=${JSON.stringify(provenance?.settings ?? null)}, attempts=${JSON.stringify(provenance?.attempts?.map((entry) => ({ id: String(entry.attempt_id).slice(0, 8), sha: String(entry.prompt_sha256).slice(0, 8), usage: entry.provider_usage })) ?? null)}, selection=${JSON.stringify(provenance?.selection?.chapters ?? null)}, usage=${JSON.stringify(provenance?.provider_usage ?? 'absent')}, embedded=${Boolean(document?.evaluator_provenance)}, carried=${Boolean(carried)}/${carried?.evaluator_id === provenance?.evaluator_id}, bundleHash=${bundle?.provenance?.annotations?.sha256 === hash(documentBytes)}, artifacts=${artifactsMatch}`);
        }
      }

      // A published result is immutable: it is not retried, its bytes do not change, and a re-evaluation is a
      // new run that names the one it re-evaluates — re-rendering the accepted reading without a model call.
      let reassessed = null;
      {
        const published = await readAssessment(universe.id, generated.run_id);
        // Every read of a published file is guarded: the defect this check reproduces is a run whose result
        // directory was replaced, and a missing file has to be reported as that failure, not thrown.
        const digest = async (name) => readFile(join(assessmentsRoot(), published.result_dir, name))
          .then((bytes) => createHash('sha256').update(bytes).digest('hex'), () => null);
        const before = await Promise.all((published.outputs ?? []).map(digest));
        let retryRefusal = null;
        try {
          await retryAssessment(universe.id, published.run_id);
        } catch (error) {
          retryRefusal = error.code;
        }
        const afterRefusal = await readAssessment(universe.id, published.run_id);
        const after = await Promise.all((published.outputs ?? []).map(digest));
        const untouched = before.length > 0 && before.every((value) => value !== null) && before.join(',') === after.join(',')
          && afterRefusal.status === 'done' && afterRefusal.result_revision === published.result_revision;
        reassessed = await reassessAssessment(universe.id, published.run_id, { annotations: 'reuse' })
          .catch((error) => ({ run_id: null, reassesses_run_id: null, refused: error.code, error: error.message }));
        await settleAssessments();
        const newRun = reassessed.run_id ? await readAssessment(universe.id, reassessed.run_id) : { status: 'error', outputs: [], error: reassessed.error };
        const newDir = reassessed.run_id ? dirname(join(assessmentsRoot(), newRun.result_dir)) : null;
        const calledAgain = newDir ? await stat(join(newDir, 'fake-evaluator.marker')).then(() => true, () => false) : null;
        const rendered = newRun.result_dir ? await readFile(join(assessmentsRoot(), newRun.result_dir, 'assessment.json'), 'utf8').then((text) => JSON.parse(text), () => null) : null;
        const original = await readFile(join(assessmentsRoot(), published.result_dir, 'assessment.json'), 'utf8').then((text) => JSON.parse(text), () => null);
        const stillPublished = await readAssessment(universe.id, published.run_id);
        if (retryRefusal === 'ALREADY_PUBLISHED' && untouched
          && reassessed.run_id !== published.run_id && reassessed.reassesses_run_id === published.run_id
          && newRun.status === 'done' && newRun.reused_annotations === true
          && newRun.annotations_sha256 === published.annotations_sha256
          && calledAgain === false
          && rendered?.assessment_id === original?.assessment_id
          && stillPublished.status === 'done' && stillPublished.result_revision === published.result_revision) {
          ok(`assessments/retry/immutable: a published run answers ALREADY_PUBLISHED, its result bytes and revision do not change, and the re-evaluation is a new run (${newRun.run_id} reassesses ${published.run_id}) that re-renders the accepted reading (assessment_id ${String(rendered?.assessment_id).slice(0, 8)}…) with no evaluator call`);
        } else {
          fail(`assessments/retry/immutable: retry=${retryRefusal}, untouched=${untouched} (${before.filter((value) => value === null).length} unreadable), new=${reassessed?.run_id}/${reassessed?.reassesses_run_id}/${reassessed?.refused}, status=${newRun.status}, reused=${newRun.reused_annotations}, hashKept=${newRun.annotations_sha256 === published.annotations_sha256}, calledAgain=${calledAgain}, ids=${rendered?.assessment_id}/${original?.assessment_id}, error=${newRun.error}, outputs=${JSON.stringify(newRun.outputs)}`);
        }
      }

      // A stored reading is verified against the hash and the source it was accepted with: a document that
      // changed is refused, and a run holding one fails instead of publishing a different reading.
      {
        const target = reassessed?.run_id ? await readAssessment(universe.id, reassessed.run_id) : null;
        const directory = target ? dirname(join(assessmentsRoot(), target.result_dir)) : null;
        const stored = target && directory ? join(directory, target.generated_annotations) : null;
        const original = stored ? await readFile(stored, 'utf8').catch(() => null) : null;
        if (stored && original) await writeFile(stored, `${original}\n`, 'utf8');
        let reassessRefusal = null;
        if (target) {
          try {
            await reassessAssessment(universe.id, target.run_id, { annotations: 'reuse' });
          } catch (error) {
            reassessRefusal = error.code;
          }
        }
        // The same changed document on a run whose phase failed: a retry must refuse it, not quietly publish.
        let retried = null;
        let settled = null;
        if (target && stored) {
          const recordPath = join(directory, 'run.json');
          const record = JSON.parse(await readFile(recordPath, 'utf8'));
          await writeFile(recordPath, JSON.stringify({ ...record, status: 'error', error: 'phase failed', result_revision: null, result_files: null }, null, 2), 'utf8');
          retried = await retryAssessment(universe.id, target.run_id).catch((error) => ({ run_id: null, error: error.message }));
          await settleAssessments();
          settled = retried.run_id ? await readAssessment(universe.id, target.run_id) : null;
          if (original) await writeFile(stored, original, 'utf8');
        }
        const refused = reassessRefusal === 'ANNOTATIONS_CHANGED'
          && settled?.status === 'error'
          && /changed since they were accepted/.test(String(settled.error))
          && (settled.outputs ?? []).length === 0;
        if (refused) {
          ok('assessments/retry/stored: a stored reading that changed since it was accepted is refused by a re-evaluation (ANNOTATIONS_CHANGED) and by a retry, which publishes nothing rather than a different reading');
        } else {
          fail(`assessments/retry/stored: reassess=${reassessRefusal}, retried=${JSON.stringify(retried)}, status=${settled?.status}, error=${String(settled?.error).slice(0, 160)}, outputs=${JSON.stringify(settled?.outputs)}`);
        }
      }

      // A supplied continuity result is bound to the packet it came from: the version it names must be this
      // packet's accepted version (the legacy `version` field is a fallback, never a second opinion), and its
      // population must be chapters this version holds and this review covers.
      {
        const version = await currentVersion(universe.id);
        const counts = { eligible_comparisons: 2, consistent: 2, contradicted: 0, unresolved: 0 };
        const attempt = async (continuity) => {
          try {
            const run = await startAssessment({
              universeId: universe.id,
              phase: 'metrics',
              annotations: { schema_version: 'annotations.v1', source_version: version, continuity },
              force: true
            });
            await settleAssessments();
            return { run: await readAssessment(universe.id, run.run_id) };
          } catch (error) {
            return { code: error.code, message: String(error.message) };
          }
        };
        const stale = await attempt({ schema_version: 'continuity-result.v1', version: `sha256:${'b'.repeat(64)}`, counts, findings: [] });
        const twoVersions = await attempt({ schema_version: 'continuity-result.v1', source_version: version, version: `sha256:${'c'.repeat(64)}`, counts, findings: [] });
        const silent = await attempt({ schema_version: 'continuity-result.v1', counts, findings: [] });
        const foreign = await attempt({ schema_version: 'continuity-result.v1', source_version: version, counts, findings: [], scope: { chapters_reviewed: [7] } });
        const partial = await attempt({ schema_version: 'continuity-result.v1', source_version: version, counts, findings: [], scope: { chapters_reviewed: [1] } });
        const bound = await attempt({ schema_version: 'continuity-result.v1', source_version: version, counts, findings: [], scope: { chapters_reviewed: [1, 2] } });
        const recorded = bound.run?.continuity_source ?? null;
        if (stale.code === 'BAD_CONTINUITY_SOURCE' && twoVersions.code === 'BAD_CONTINUITY_SOURCE' && silent.code === 'BAD_CONTINUITY_SOURCE'
          && foreign.code === 'BAD_CONTINUITY_SCOPE' && partial.code === 'BAD_CONTINUITY_SCOPE'
          && bound.run?.status === 'done'
          && recorded?.declared_field === 'source_version' && recorded?.source_version === version
          && (recorded?.population ?? []).join(',') === '1,2' && recorded?.scope_declared === true) {
          ok(`assessments/continuity-source: a result bound to ${'b'.repeat(8)}… instead of the packet, one naming two versions, one naming no source, and a population outside the version or short of the selection are all refused, while a result bound to the accepted version over chapters 1, 2 is recorded as bound to it`);
        } else {
          fail(`assessments/continuity-source: stale=${stale.code}, twoVersions=${twoVersions.code}, silent=${silent.code}, foreign=${foreign.code}, partial=${partial.code}, bound=${bound.run?.status}/${JSON.stringify(recorded)}, error=${bound.run?.error ?? bound.code}`);
        }
      }

      // The review writes inside its own run directory and nowhere else. The host cannot sandbox a child, so
      // it refuses what the child publishes outside the output area and notices the writes that escaped it.
      for (const mode of ['symlink-output', 'escape-write', 'packet-write']) {
        process.env.FAKE_EVALUATOR_MODE = mode;
        const probe = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', force: true });
        await settleAssessments();
        delete process.env.FAKE_EVALUATOR_MODE;
        const settled = await readAssessment(universe.id, probe.run_id);
        const directory = dirname(join(assessmentsRoot(), settled.result_dir));
        const published = (settled.outputs ?? []).length === 0;
        const escapeFile = await stat(join(directory, 'escape-attempt.json')).then(() => true, () => false);
        const notAdopted = await runOutputPath(universe.id, probe.run_id, 'escaped-report.json').then(() => false, (error) => error.code === 'NOT_FOUND');
        const refused = settled.status === 'error' && published;
        if (mode === 'symlink-output') {
          const refusedLink = (settled.output_boundary?.refused ?? []).some((entry) => entry.name === 'escaped-report.json' && /symbolic link/.test(entry.reason));
          if (refused && refusedLink && notAdopted && settled.output_boundary?.ok === false) {
            ok('assessments/annotations/boundary: a report published as a symbolic link into the review output area is refused, the run publishes nothing, and the link is not served as this run\'s file');
          } else {
            fail(`assessments/annotations/boundary/symlink: status=${settled.status}, boundary=${JSON.stringify(settled.output_boundary)}, notAdopted=${notAdopted}, error=${settled.error}`);
          }
        } else if (mode === 'escape-write') {
          const named = (settled.write_boundary?.escapes ?? []).some((path) => path.endsWith('escape-attempt.json'));
          if (refused && named && settled.write_boundary?.ok === false && /wrote outside its own run directory/.test(String(settled.error)) && settled.packet_intact === true) {
            ok('assessments/annotations/boundary: a write that lands outside the run directory is noticed by name, the run publishes nothing, and the frozen packet is still intact');
          } else {
            fail(`assessments/annotations/boundary/escape: status=${settled.status}, boundary=${JSON.stringify(settled.write_boundary)}, escapeFile=${escapeFile}, error=${settled.error}, intact=${settled.packet_intact}`);
          }
        } else {
          const refusedWrite = refused && settled.packet_intact === false && /no declaration names it/.test(String(settled.error));
          if (refusedWrite) {
            ok('assessments/annotations/boundary: a file written into the frozen packet that no declaration names fails the run as a changed input, and nothing is published');
          } else {
            fail(`assessments/annotations/boundary/packet: status=${settled.status}, intact=${settled.packet_intact}, error=${String(settled.error).slice(0, 240)}, errors=${JSON.stringify(settled.annotation_errors)}`);
          }
        }
      }

      // A review is watchable while it runs and readable afterwards: the record names the call in flight, the
      // evaluator's own stream is journaled beside the run as it arrives, the console merges both while the
      // run is live, and it keeps the whole story once the run settles. This is what the sessions dialog reads.
      {
        process.env.FAKE_EVALUATOR_MODE = 'narrate-hang';
        const watched = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'generic', force: true });
        const directory = runDir(universe.id, watched.version, watched.run_id);
        const inFlightAt = async () => (await readAssessment(universe.id, watched.run_id)).in_flight ?? null;
        const until = Date.now() + 15_000;
        let inflight = await inFlightAt();
        while (!inflight?.pid && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          inflight = await inFlightAt();
        }
        const journalOnDisk = async () => stat(join(directory, 'generated', 'evaluator.events.jsonl')).then(() => true, () => false);
        // The journal is appended as the events arrive, so the check waits for the console to show them rather
        // than assuming that a spawned child has already said something.
        let during = null;
        let liveText = '';
        const liveOk = async () => {
          during = await readAssessmentConsole(universe.id, watched.run_id);
          liveText = String(during?.console?.text ?? '');
          return during?.console?.live === true
            && (await journalOnDisk())
            && liveText.includes('created — metrics review')
            && liveText.includes('in flight since')
            && liveText.includes('reading the frozen packet')
            && liveText.includes('→ read')
            && liveText.includes('✓ read');
        };
        let live = await liveOk();
        while (!live && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          live = await liveOk();
        }
        const duringOk = live
          && Number.isInteger(inflight?.pid)
          && typeof inflight?.unit === 'string' && inflight.unit.length > 0
          && typeof inflight?.model === 'string' && inflight.model.length > 0
          && Number.isFinite(inflight?.timeout_ms);
        // A live run is not deletable: its child is reading that directory, and the refusal says what to do.
        let liveRefusal = null;
        try {
          await deleteAssessment(universe.id, watched.run_id);
        } catch (error) {
          liveRefusal = error.code;
        }
        await cancelAssessment(universe.id, watched.run_id);
        await settleAssessments();
        delete process.env.FAKE_EVALUATOR_MODE;
        const settled = await readAssessment(universe.id, watched.run_id);
        const after = await readAssessmentConsole(universe.id, watched.run_id);
        const afterText = String(after?.console?.text ?? '');
        const afterOk = settled.in_flight === null
          && settled.status === 'cancelled'
          && after?.console?.live === false
          && after?.console?.source === 'journal'
          && afterText.includes('✗ cancelled')
          && afterText.includes('reading the frozen packet');
        if (duringOk && afterOk && liveRefusal === 'STILL_LIVE') {
          ok(`review console: the call in flight is in the record (${inflight.unit}, pid ${inflight.pid}), the evaluator's narration and tool calls are journaled while it works, the console answers them live and keeps them after the run settled, and deleting a live run is refused`);
        } else {
          fail(`review console: during=${duringOk} (inflight=${JSON.stringify(inflight)}, live=${during?.console?.live}, source=${during?.console?.source}, journal=${journalOnDisk}, text=${JSON.stringify(liveText.slice(0, 220))}), after=${afterOk} (status=${settled.status}, in_flight=${JSON.stringify(settled.in_flight)}, live=${after?.console?.live}, source=${after?.console?.source}, text=${JSON.stringify(afterText.slice(-220))}), liveRefusal=${liveRefusal}`);
        }
      }

      // A stored review is a report a reader can remove: the refusal while another record names it, the
      // deletion that takes the run directory with it, and the book that is not touched by either.
      {
        const published = await startAssessment({
          universeId: universe.id,
          phase: 'metrics',
          mode: 'deterministic',
          scope: { kind: 'chapter', chapters: [1] },
          intention: 'deletion probe',
          request: 'the deletion probe request'
        });
        await settleAssessments();
        const stored = await readAssessment(universe.id, published.run_id);
        const before = await inventory(universe.id);
        const successor = await reassessAssessment(universe.id, published.run_id, { annotations: 'reuse' });
        await settleAssessments();
        // The newer run names the one it re-evaluates, so that one is evidence a record still refers to.
        let referenced = null;
        try {
          await deleteAssessment(universe.id, published.run_id);
        } catch (error) {
          referenced = error.code;
        }
        const keptWhileNamed = await readAssessment(universe.id, published.run_id).then(() => true, () => false);
        await deleteAssessment(universe.id, successor.run_id);
        const removed = await deleteAssessment(universe.id, published.run_id).catch((error) => ({ error: error.code }));
        const after = await inventory(universe.id);
        const gone = await readAssessment(universe.id, published.run_id).then(() => null, (error) => error.code);
        const goneFromDisk = await stat(runDir(universe.id, stored.version, published.run_id)).then(() => true, () => false);
        // The book is what a review must never change: the deletion is compared against the inventory taken
        // before it, rather than against a file name the fixture may not use.
        const chapterKept = JSON.stringify([...after]) === JSON.stringify([...before]);
        if (stored.status === 'done' && referenced === 'REFERENCED' && keptWhileNamed
          && removed?.run_id === published.run_id && gone === 'NOT_FOUND' && !goneFromDisk && chapterKept) {
          ok('assessments/delete: a report another run re-evaluates is refused while that run exists, the deletion then removes the record and its directory for good, and the book keeps its chapter');
        } else {
          fail(`assessments/delete: stored=${stored.status}, successor=${successor.run_id}, referenced=${referenced}, kept=${keptWhileNamed}, removed=${JSON.stringify(removed).slice(0, 120)}, gone=${gone}, onDisk=${goneFromDisk}, chapter=${chapterKept}`);
        }
      }

      } finally {
        await fake.restore();
      }

    }
  }

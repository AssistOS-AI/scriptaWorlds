// The annotation stage of the separate review phase, proven through the host boundary: a real child
// process is installed as `omp` and answers with a document built from the vocabulary the report skill
// publishes. The group proves the three properties the host depends on: the generic mode calls an
// evaluator, what it returns is validated against the frozen packet before it reaches the report, and an
// answer that is not a usable document fails the run instead of becoming a judgement.
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAssessments, readAssessment, runOutputPath, settleAssessments, startAssessment } from '../src/assessments.mjs';
import { assessmentsRoot } from '../src/assessment-packet.mjs';
import { config } from '../src/config.mjs';
import { extractAnnotationJson } from '../src/annotation-stage.mjs';

const FAKE_EVALUATOR = `#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

if (process.argv.includes('--version')) { process.stdout.write('fake-evaluator/0.0.1\\n'); process.exit(0); }
const runDir = process.cwd();
const emit = (payload) => process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: payload } }) + String.fromCharCode(10));
process.stdin.resume();
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
await new Promise((resolve) => process.stdin.on('end', resolve));

const manifest = JSON.parse(await readFile(join(runDir, 'input', 'manifest.json'), 'utf8'));
const chapter = manifest.files.find((file) => file.role === 'chapter');
if (process.env.FAKE_EVALUATOR_MODE === 'garbage') { emit('I read the book and it is good.'); process.exit(0); }
const text = await readFile(join(runDir, 'input', chapter.path), 'utf8');
const bytes = Buffer.from(text, 'utf8');
const quote = bytes.subarray(0, 32).toString('utf8');
const end = Buffer.byteLength(quote, 'utf8');
const vocabulary = JSON.parse(await readFile(join(process.env.SKILL_DIR ?? 'skills', 'scripta-metrics-report', 'schema', 'annotations.v1.json'), 'utf8'));
const annotations = {
  schema_version: 'annotations.v1',
  source_version: manifest.version,
  request: null,
  brief: null,
  evidence: [{ id: 'm1', file: chapter.path, sha256: chapter.sha256, start: 0, end, quote }],
  segments: [{ id: 'seg1', chapter: chapter.chapter, kind: vocabulary.segment_kinds[0], label: 'the opening', focal_character: null, start: 0, end, story_order: 1 }],
  metrics: {
    CS: { status: vocabulary.metric_statuses[0], evaluator: 'model:fake-evaluator', dimensions: {
      referential_clarity: { rating: 2, rationale: 'the referents are recoverable', evidence: ['m1'] },
      discourse_connection: { rating: 2, rationale: 'the scene connects to the next', evidence: ['m1'] },
      causal_support: { rating: 2, rationale: 'the causes are shown', evidence: ['m1'] },
      temporal_intelligibility: { rating: 2, rationale: 'the order is clear', evidence: ['m1'] } } },
    OI: { status: 'judged', evaluator: 'model:fake-evaluator', comparison_scope: 'the reviewed chapters',
      dimensions: {
        perspective: { rating: 1, rationale: 'one focal character', evidence: ['m1'] },
        dramatic_development: { rating: 1, rationale: 'a choice is dramatized', evidence: ['m1'] },
        expression: { rating: 1, rationale: 'the register holds', evidence: ['m1'] } } },
    EAP: { status: vocabulary.metric_statuses[0], ordering: vocabulary.eap_orderings[0], points: [
      { segment: 'seg1', focalization: 'internal', tone: 'quiet', valence: 0.1, tension: 0.2, intensity: 0.2, evidence: ['m1'], uncertainty: 'one scene only' } ] }
  },
  indicators: [],
  indicators: [{ id: 'narrative_coherence', status: vocabulary.indicator_statuses[0], category: vocabulary.indicators.narrative_coherence.categories[1], evaluator: 'model:fake-evaluator', rationale: 'the scenes return to one image', evidence: ['m1'], counterevidence: null }],
  findings: [{ id: 'f1', kind: vocabulary.findings.kinds[1], severity: vocabulary.findings.severities[1], certainty: vocabulary.findings.certainties[1], status: vocabulary.findings.statuses[2], description: 'the opening withholds the stakes', evidence: ['m1'], repair_suggestion: 'name the stake earlier' }],
  preserved_qualities: { passages: [{ id: 'p1', rationale: 'the quiet opening earns the ending', evidence: ['m1'] }], reason: 'the restraint is the effect' },
  departures: [{ id: 'd1', status: vocabulary.departures.statuses[0], description: 'the stakes stay unnamed', rationale: 'the reader infers them', evidence: ['m1'] }]
};
// The chatty mode answers with the document and then keeps talking: the host must still take the document.
emit(JSON.stringify(annotations) + (process.env.FAKE_EVALUATOR_MODE === 'chatty' ? '\\n\\nI hope this reading is useful. Tell me if you want the next chapter as well.' : ''));
await writeFile(join(runDir, 'fake-evaluator.marker'), JSON.stringify({ prompt_chars: prompt.length, chapter: chapter.path }), 'utf8');
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
          && findingIds.includes('f1') && provenance !== null && generatedStored && packetIntact && !insidePacket && marker?.chapter) {
          ok(`assessments/annotations: the generic mode calls the evaluator, validates its quoted evidence, feeds the report (CS ${cs.value}, findings ${findingIds.join(',')}) and keeps the frozen packet untouched`);
        } else {
          fail(`assessments/annotations: status=${run.status}, mode=${run.annotation_mode}, cs=${cs?.value}/${cs?.value_kind}, findings=${JSON.stringify(findingIds)}, provenance=${JSON.stringify(provenance)?.slice(0, 120)}, stored=${generatedStored}, insidePacket=${insidePacket}, intact=${packetIntact}, marker=${Boolean(marker?.chapter)}, resultDir=${run.result_dir}`);
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
        if (chattySettled?.status === 'done' && chattySettled.annotation_attempts?.length === 1) {
          ok('assessments/annotations: an evaluator that answers with the document and then keeps talking completes the run in one call');
        } else {
          fail(`assessments/annotations/chatty: status=${chattySettled?.status}, attempts=${JSON.stringify(chattySettled?.annotation_attempts?.map((attempt) => attempt.ok))}, error=${chattySettled?.error ?? chattyRun.error}`);
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
      } finally {
        await fake.restore();
      }
    }
  }

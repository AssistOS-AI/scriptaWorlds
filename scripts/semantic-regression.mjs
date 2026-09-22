#!/usr/bin/env node
/**
 * scriptaWorlds — a bounded semantic regression over the teaching cases of `scripta-metrics-report`.
 *
 *   node scripts/semantic-regression.mjs [--languages ro,en] [--max-cases N] [--max-chars N]
 *                                        [--model M] [--timeout-ms N] [--out FILE] [--run]
 *
 * The cases are the ones the skill's own case index declares as its reserved regression subset: pairs
 * of a weaker and a stronger variant of the same passage, each with the distinction it teaches, the
 * weaker half its author named, the passage a judgement was expected to rest on and the readings that
 * are acceptable alternatives. A model is asked which half is weaker and whether it would record a
 * defect; the answer is compared with what the case declares, so a change of model or of prompt wording
 * shows up as a disagreement instead of as an opinion.
 *
 * The default invocation is a **dry run**: it prints exactly what it would send, how many calls and
 * characters that costs and which bounds it enforces, and spends nothing. `--run` is the explicit
 * opt-in for a real, bounded run. The bounds are enforced before every call, never by trusting the
 * model to stop: at most `--max-cases` calls (default 8, hard ceiling 24) and at most `--max-chars`
 * characters of case text sent in total (default 30000). A case that does not fit a bound is reported
 * as not sent rather than silently dropped.
 *
 * This command never runs inside `npm run check`: it spends model budget by design.
 *
 * Environment: `OMP_BIN` (the evaluator, default `omp`) and `SCRIPTAS_MODEL` (the model, default the
 * host's) are read the same way the server reads them, so a run here records the same identities a
 * review would.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from '../src/config.mjs';
import { runAnnotationStage } from '../src/annotation-stage.mjs';

export const SEMANTIC_REGRESSION_SCHEMA = 'semantic-regression.v1';
export const SEMANTIC_REGRESSION_PROMPT_VERSION = 'semantic-regression-prompt.v1';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '..', 'skills', 'scripta-metrics-report');
const CASE_LIBRARY = join(SKILL, 'fixtures', 'literary-cases');
const ANCHORS_FILE = join(SKILL, 'schema', 'rubric-anchors.v1.json');

const MAX_CASES_CEILING = 24;
const USAGE = 'Usage: node scripts/semantic-regression.mjs [--languages ro,en] [--cases declared|justified|all] [--max-cases N] [--max-chars N] [--model M] [--timeout-ms N] [--out FILE] [--run]';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_ARGUMENTS';
  }
}

/* ---------------------------------- input ---------------------------------- */

/** The case index, the cases it names and what the published rubric calls a justified choice. */
export async function loadCaseSet({ languages = ['ro', 'en'], selection = 'declared' } = {}) {
  const index = JSON.parse(await readFile(join(CASE_LIBRARY, 'index.json'), 'utf8'));
  const anchors = JSON.parse(await readFile(ANCHORS_FILE, 'utf8'));
  const noDefectByDefault = new Set(anchors?.defaults?.no_defect_by_default ?? []);
  const declared = index?.regression_subset?.case_ids ?? [];
  const inLanguage = (entry) => entry && languages.includes(entry.language);
  const entries = (index.cases ?? []).filter(inLanguage);
  let chosen;
  if (selection === 'all') {
    chosen = entries.map((entry) => entry.id);
  } else if (selection === 'justified') {
    // The declared subset plus every case whose distinction the published rubric calls a choice that is
    // not a defect by default, so an over-call on a justified exception has cases to show up in.
    chosen = entries
      .filter((entry) => declared.includes(entry.id) || noDefectByDefault.has(entry.target_distinction))
      .map((entry) => entry.id);
  } else {
    chosen = declared.filter((id) => entries.some((entry) => entry.id === id));
  }
  const cases = [];
  for (const id of chosen) {
    cases.push(JSON.parse(await readFile(join(CASE_LIBRARY, 'cases', `${id}.json`), 'utf8')));
  }
  return {
    library: {
      id: index.library_id,
      version: index.version,
      label: index.label,
      human_benchmark: index.human_benchmark === true,
      declared_subset: declared,
      selection
    },
    rubric: {
      anchors_version: anchors?.schema_version ?? null,
      no_defect_by_default: [...noDefectByDefault],
      statement: anchors?.defaults?.statement ?? null
    },
    cases,
    noDefectByDefault
  };
}

/** The characters one case put in front of the model, before the instruction block. */
export function caseCharacters(literaryCase) {
  return Buffer.byteLength(`${literaryCase.before.text}\n${literaryCase.after.text}`, 'utf8');
}

/**
 * The prompt of one case. It states the distinction the case teaches and the intention it was written
 * against, shows the two variants under neutral labels, and asks for one JSON answer. It never says
 * which half is weaker, and it carries the published rule about choices that are not defects.
 */
export function buildCasePrompt({ literaryCase, rubric }) {
  return `You are comparing two variants of the same passage from a book. Variant A and variant B differ in one feature; the rest of the text is the same.

WHAT THE CASE TEACHES: ${literaryCase.distinction_statement}
THE INTENTION THE PASSAGE WAS WRITTEN AGAINST: ${literaryCase.intention}
${rubric.statement ? `PUBLISHED RULE: ${rubric.statement}\n` : ''}
VARIANT A
"""
${literaryCase.before.text}
"""

VARIANT B
"""
${literaryCase.after.text}
"""

Answer with exactly one JSON object and nothing else:
{"weaker": "A" | "B" | "unable",
 "defect_flagged": true | false,
 "evidence": [{"side": "A" | "B", "quote": "<exact words from that variant>"}],
 "rationale": "<one or two sentences>"}

"weaker" names the variant that does the passage's work less well, or "unable" when the two are equal
to you and you cannot choose. "defect_flagged" is true only when you would record one of the variants as
a defect of the book; a choice the published rule above calls justified is not a defect. Quote at most
two passages, exactly as they appear in the variant you name.`;
}

/** The JSON object inside an answer, fenced or wrapped in prose; `null` when there is none. */
export function readAnswer(text) {
  const raw = String(text ?? '');
  const candidates = [];
  const fenced = raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const match of fenced) candidates.push(match[1]);
  candidates.push(raw);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const value = JSON.parse(candidate.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // The next candidate may still hold a complete object.
    }
  }
  return null;
}

/** Compare one answer with what the case declares. */
export function scoreAnswer(literaryCase, answer, { noDefectByDefault }) {
  const side = answer?.weaker === 'A' ? 'before' : answer?.weaker === 'B' ? 'after' : null;
  const declared = literaryCase.weaker_side ?? null;
  const quotes = Array.isArray(answer?.evidence)
    ? answer.evidence.filter((entry) => entry && typeof entry.quote === 'string').map((entry) => ({
        side: entry.side === 'A' ? 'before' : entry.side === 'B' ? 'after' : null,
        quote: entry.quote
      }))
    : [];
  const expected = (literaryCase.expected_evidence ?? []).map((entry) => entry.quote);
  const justified = literaryCase.kind === 'counterexample' || noDefectByDefault.has(literaryCase.target_distinction);
  return {
    verdict: answer?.weaker ?? null,
    judged_side: side,
    declared_weaker_side: declared,
    abstained: side === null,
    agrees: side !== null && declared !== null && side === declared,
    defect_flagged: answer?.defect_flagged === true,
    justified_exception: justified,
    // A defect claimed on a choice the published rule or the case itself calls justified.
    false_positive: justified && answer?.defect_flagged === true,
    quotes,
    quotes_matching_declared: quotes.filter((entry) => expected.includes(entry.quote)).length,
    declared_quotes: expected.length,
    rationale: typeof answer?.rationale === 'string' ? answer.rationale : null
  };
}

/* ---------------------------------- plan ----------------------------------- */

/**
 * The bounded plan: which cases are sent, which are held back by which bound, and what the run would
 * cost in calls and characters. Nothing here calls a model.
 */
export function planRun({ cases, maxCases, maxChars, noDefectByDefault, model }) {
  const calls = Math.min(maxCases, MAX_CASES_CEILING, cases.length);
  const sent = [];
  const withheld = [];
  let characters = 0;
  let callBudget = calls;
  for (const literaryCase of cases) {
    const size = caseCharacters(literaryCase);
    if (sent.length >= calls) {
      withheld.push({ id: literaryCase.id, reason: 'max_cases', characters: size });
      continue;
    }
    if (characters + size > maxChars) {
      withheld.push({ id: literaryCase.id, reason: 'max_chars', characters: size });
      continue;
    }
    characters += size;
    sent.push({ literaryCase, characters: size });
  }
  // A case bound by the character budget still counts against the call bound it was planned under.
  callBudget = sent.length;
  return {
    model,
    prompt_version: SEMANTIC_REGRESSION_PROMPT_VERSION,
    budget: {
      max_cases: maxCases,
      max_chars: maxChars,
      cases_ceiling: MAX_CASES_CEILING,
      calls: callBudget,
      characters,
      estimated_prompt_tokens: Math.ceil(characters / 4),
      price: 'the repository declares no provider price, so the bound is calls and characters, not currency'
    },
    sent,
    withheld,
    no_defect_by_default: [...noDefectByDefault]
  };
}

/* ----------------------------------- run ----------------------------------- */

/** One bounded real run: one call per planned case, the bounds checked before every call. */
export async function runSemanticRegression({ cases, plan, model, timeoutMs, runDir, onProgress = () => {} }) {
  const startedAt = Date.now();
  const results = [];
  let usage = null;
  let calls = 0;
  let characters = 0;
  let stoppedByBudget = false;
  for (const entry of plan.sent) {
    if (calls >= plan.budget.max_cases || characters + entry.characters > plan.budget.max_chars) {
      stoppedByBudget = true;
      results.push({ id: entry.literaryCase.id, status: 'not_sent', reason: 'budget' });
      continue;
    }
    const prompt = buildCasePrompt({ literaryCase: entry.literaryCase, rubric: plan.rubric });
    calls += 1;
    characters += entry.characters;
    onProgress(entry.literaryCase.id, calls, plan.sent.length);
    const outcome = await runAnnotationStage({ runDir, prompt, timeoutMs, model });
    const answer = outcome.ok ? readAnswer(outcome.text) : null;
    const score = answer ? scoreAnswer(entry.literaryCase, answer, { noDefectByDefault: plan.no_defect_by_default_set }) : null;
    if (outcome.usage && typeof outcome.usage === 'object') usage = { ...(usage ?? {}), ...outcome.usage };
    results.push({
      id: entry.literaryCase.id,
      language: entry.literaryCase.language,
      kind: entry.literaryCase.kind,
      target_distinction: entry.literaryCase.target_distinction,
      characters: entry.characters,
      status: answer ? 'answered' : (outcome.ok ? 'unparsed' : 'failed'),
      error: outcome.ok ? (answer ? null : 'the answer held no JSON object') : `the evaluator call failed (${outcome.timedOut ? 'timed out' : `exit ${outcome.code}`})`,
      duration_ms: outcome.durationMs,
      answer_characters: outcome.text?.length ?? 0,
      ...(score ?? {})
    });
  }
  return {
    schema_version: SEMANTIC_REGRESSION_SCHEMA,
    ok: true,
    mode: 'run',
    model,
    prompt_version: SEMANTIC_REGRESSION_PROMPT_VERSION,
    duration_ms: Date.now() - startedAt,
    budget: plan.budget,
    spent: { calls, characters, estimated_prompt_tokens: Math.ceil(characters / 4), provider_usage: usage, stopped_by_budget: stoppedByBudget },
    results,
    ...summarise(results),
    unperformed: [
      'no human benchmark: the library declares itself synthetic teaching material and no person outside the authoring session judged it',
      'false negatives are not estimated: a case a model answers correctly says nothing about the cases it never saw',
      'a single run per case: repeated measurements over time are not part of this bound'
    ]
  };
}

/** The counts a reader of this command needs: what was covered, where it disagreed, what it over-called. */
export function summarise(results) {
  const answered = results.filter((entry) => entry.status === 'answered');
  const disagreements = answered.filter((entry) => entry.judged_side && entry.declared_weaker_side && entry.judged_side !== entry.declared_weaker_side);
  const falsePositives = answered.filter((entry) => entry.false_positive === true);
  return {
    coverage: {
      cases: results.length,
      answered: answered.length,
      unparsed: results.filter((entry) => entry.status === 'unparsed').length,
      failed: results.filter((entry) => entry.status === 'failed').length,
      not_sent: results.filter((entry) => entry.status === 'not_sent').length,
      abstained: answered.filter((entry) => entry.abstained).length,
      quotes_matching_declared: answered.reduce((total, entry) => total + (entry.quotes_matching_declared ?? 0), 0),
      declared_quotes: answered.reduce((total, entry) => total + (entry.declared_quotes ?? 0), 0)
    },
    agreements: {
      cases: answered.filter((entry) => entry.agrees === true).map((entry) => entry.id)
    },
    disagreements: disagreements.map((entry) => ({
      id: entry.id,
      language: entry.language,
      target_distinction: entry.target_distinction,
      judged: entry.judged_side,
      declared: entry.declared_weaker_side
    })),
    false_positives_on_justified_exceptions: falsePositives.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      target_distinction: entry.target_distinction
    })),
    limits: 'A disagreement is a question for a person: the case states which half its author called weaker, and the alternative readings it lists are as acceptable as that answer.'
  };
}

/* ---------------------------------- CLI ------------------------------------ */

function parseArgs(argv) {
  const options = {
    languages: ['ro', 'en'],
    selection: 'declared',
    maxCases: 8,
    maxChars: 30_000,
    model: config.model,
    timeoutMs: config.assessmentTimeoutMs,
    out: null,
    run: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const need = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`option ${name} requires a value\n${USAGE}`);
      index += 1;
      return value;
    };
    if (arg === '--run') options.run = true;
    else if (arg === '--languages') options.languages = need(arg).split(',').map((value) => value.trim()).filter(Boolean);
    else if (arg === '--cases') {
      const value = need(arg);
      if (!['declared', 'justified', 'all'].includes(value)) throw new UsageError(`--cases is declared|justified|all\n${USAGE}`);
      options.selection = value;
    } else if (arg === '--max-cases') {
      const value = Number(need(arg));
      if (!Number.isInteger(value) || value < 1) throw new UsageError(`--max-cases must be a positive integer\n${USAGE}`);
      options.maxCases = value;
    } else if (arg === '--max-chars') {
      const value = Number(need(arg));
      if (!Number.isInteger(value) || value < 1) throw new UsageError(`--max-chars must be a positive integer\n${USAGE}`);
      options.maxChars = value;
    } else if (arg === '--model') options.model = need(arg);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(need(arg));
    else if (arg === '--out') options.out = resolve(need(arg));
    else if (arg === '--help' || arg === '-h') throw new UsageError(USAGE);
    else throw new UsageError(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
  }
  if (options.languages.length === 0) throw new UsageError(`at least one language is required\n${USAGE}`);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new UsageError(`--timeout-ms must be a positive number\n${USAGE}`);
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const { library, rubric, cases, noDefectByDefault } = await loadCaseSet({ languages: options.languages, selection: options.selection });
  const plan = planRun({ cases, maxCases: options.maxCases, maxChars: options.maxChars, noDefectByDefault, model: options.model });
  plan.rubric = rubric;

  let envelope;
  if (!options.run) {
    envelope = {
      schema_version: SEMANTIC_REGRESSION_SCHEMA,
      ok: true,
      mode: 'dry_run',
      model: options.model,
      prompt_version: SEMANTIC_REGRESSION_PROMPT_VERSION,
      library: { ...library, rubric },
      budget: plan.budget,
      would_send: plan.sent.map((entry) => ({
        id: entry.literaryCase.id,
        language: entry.literaryCase.language,
        kind: entry.literaryCase.kind,
        target_distinction: entry.literaryCase.target_distinction,
        characters: entry.characters,
        estimated_prompt_tokens: Math.ceil(entry.characters / 4)
      })),
      withheld: plan.withheld,
      spent: { calls: 0, characters: 0, provider_usage: null },
      note: 'dry run: no model call was made; pass --run to spend the bounded budget above'
    };
  } else {
    plan.no_defect_by_default_set = noDefectByDefault;
    const runDir = await mkdtemp(join(tmpdir(), 'semantic-regression-'));
    try {
      envelope = await runSemanticRegression({ cases, plan, model: options.model, timeoutMs: options.timeoutMs, runDir });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
    envelope.library = { ...library, rubric };
    envelope.withheld = plan.withheld;
  }
  const line = `${JSON.stringify(envelope)}\n`;
  if (options.out) {
    await writeFile(options.out, line, 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: true, out: options.out, mode: envelope.mode, cases: envelope.sent?.length ?? envelope.results.length, calls: envelope.spent.calls })}\n`);
  } else {
    process.stdout.write(line);
  }
  if (options.run && envelope.coverage.answered === 0) process.exitCode = 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const known = error instanceof UsageError;
    process.stdout.write(`${JSON.stringify({
      schema_version: SEMANTIC_REGRESSION_SCHEMA,
      ok: false,
      error: known ? error.message : `Internal error: ${error && error.message ? error.message : String(error)}`,
      code: known ? error.code : 'INTERNAL'
    })}\n`);
    process.exitCode = known ? 2 : 1;
  }
}

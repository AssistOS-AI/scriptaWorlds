// The model annotation stage of the separate review phase: the only place in the product where a review
// asks a model to read a book. It runs in the external workspace against the frozen packet, returns one
// structured `annotations.v1` document, and hands it to the deterministic consumer — the metrics CLI —
// which stays model-free. The host validates the document first: a schema, a source version, evidence
// that resolves to exact bytes, and bounds on every field.
//
// Nothing here writes inside `universes/`. Book prose is data: the prompt says so, the workspace is the
// run directory rather than the book, and the packet hashes are re-checked around the call.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';
import { UniverseError } from './errors.mjs';
import { nowIso, readJson } from './io.mjs';
import { acceptedVersion } from './assessment-packet.mjs';
import { handleOmpEvent } from './omp.mjs';
import { journalEvaluatorEvent } from './turn-console.mjs';

import {
  ANNOTATION_PROMPT_VERSION,
  REQUESTED_JUDGED_METRICS,
  ANNOTATION_SCHEMA,
  MAX_EVIDENCE,
  MAX_OUTPUT_BYTES,
  MAX_PROMPT_BYTES,
  MAX_SEGMENTS,
  buildAnnotationPrompt,
  buildSynthesisPrompt,
  loadAnnotationExamples,
  loadAnnotationVocabulary,
  loadRubricAnchors,
  promptResources
} from './annotation-prompt.mjs';
import {
  CALLS_PER_UNIT,
  composeSelectionDocument,
  namespaceUnitDocument,
  planIdentity,
  planReviewUnits,
  readUnitArtifact,
  readingRecord,
  unitReadingList,
  unitResults,
  writePlan,
  writeUnitArtifact
} from './annotation-units.mjs';
import { RULES_FILE, registryRequirements } from './review-context.mjs';

// Who produces the semantic observations of a review: the caller's document, the configured evaluator, or
// nobody at all. The vocabulary belongs to the host, not to the prompt: a request that names something else
// is refused before any packet is captured.
export const ANNOTATION_MODES = ['generic', 'supplied', 'deterministic'];

// The tools the evaluator is launched with: reading the frozen packet and answering is the whole task, so
// the list is the enforceable half of the review boundary and the provenance records what it was.
export const EVALUATOR_TOOLS = ['read', 'grep', 'glob'];
export const EVALUATOR_PROVENANCE_SCHEMA = 'evaluator-provenance.v1';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** The provider usage a child event reports, or `null` when the provider reported none. */
function usageFromEvent(event) {
  for (const candidate of [event?.usage, event?.result?.usage, event?.message?.usage, event?.assistantMessageEvent?.usage]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

export async function runAnnotationStage({ runDir, prompt, timeoutMs = config.assessmentTimeoutMs, model = config.model, onChild = null }) {
  const startedAt = Date.now();
  // The prompt is bounded before the child exists: a request that already exceeds the answer budget could
  // never produce an answer inside it.
  const input = String(prompt ?? '');
  if (Buffer.byteLength(input, 'utf8') > MAX_PROMPT_BYTES) {
    return {
      ok: false,
      overflowed: false,
      timedOut: false,
      signal: null,
      text: '',
      stdout: '',
      stderr: `the prompt is ${Buffer.byteLength(input, 'utf8')} bytes, above the ${MAX_PROMPT_BYTES}-byte budget`,
      code: null,
      pid: null,
      model,
      usage: null,
      durationMs: Date.now() - startedAt,
      finishedAt: nowIso()
    };
  }
  const outcome = await new Promise((resolve) => {
    const args = [
      '-p', '--mode', 'json', '--no-session', '--no-title', '--auto-approve',
      // The evaluator may read the frozen packet and answer; it may not write. The tool list is the
      // enforceable half of the review boundary: whatever the prompt says, a tool the child does not have
      // is a tool it cannot use.
      '--tools', EVALUATOR_TOOLS.join(','),
      '--no-lsp',
      '--model', model,
      '--cwd', runDir,
      '--max-time', String(Math.max(60, Math.ceil(timeoutMs / 1000)))
    ];
    const child = spawn(config.ompBin, args, {
      cwd: runDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_NO_TITLE: '1' }
    });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let pid = null;
    let overflowed = false;
    let timedOut = false;
    let killedByTimeout = false;
    // Provider usage is recorded only when the provider reported it: an unobserved number is absent from the
    // provenance, never zero.
    let usage = null;
    // The stream of the evaluator is read with the same reader a turn uses, and journaled beside the run as it
    // arrives: a review that needs minutes then shows what the agent is reading while it reads it, instead of
    // a silence a reader cannot tell from a hang.
    const stream = { assistantTexts: [], tools: [], finalAnswer: '', rawLines: [], buffer: '', timedOut: false, spawnError: null };
    const answerText = () => stream.assistantTexts.join('');
    const stopReading = () => {
      if (!overflowed) {
        overflowed = true;
        // An answer past the budget is not a usable document: the child is stopped rather than streamed forever.
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      }
    };
    const readEvent = (event) => {
      usage = usageFromEvent(event) ?? usage;
      handleOmpEvent(event, stream, (consoleEvent) => {
        journalEvaluatorEvent(runDir, consoleEvent);
        if (consoleEvent.type === 'delta' && answerText().length > MAX_OUTPUT_BYTES) stopReading();
      });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (overflowed) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          readEvent(JSON.parse(trimmed));
        } catch {
          // A line that is not an event is kept in the raw log only.
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      killedByTimeout = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('spawn', () => {
      pid = child.pid;
      onChild?.({ kill: (signal = 'SIGTERM') => child.kill(signal), pid });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      onChild?.(null);
      journalEvaluatorEvent(runDir, { type: 'error', message: String(error.message) });
      resolve({ ok: false, text: answerText(), stdout, stderr: String(error.message), code: null, pid, overflowed, timedOut, signal: null, usage: null });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (buffer.trim() && !overflowed) {
        try {
          readEvent(JSON.parse(buffer.trim()));
        } catch {
          // ignore a trailing partial line
        }
      }
      onChild?.(null);
      journalEvaluatorEvent(runDir, {
        type: 'phase',
        text: timedOut
          ? `the evaluator was stopped at its ${Math.round(timeoutMs / 1000)} s deadline`
          : `the evaluator exited with code ${code ?? 'none'}${signal === null ? '' : ` (signal ${signal})`}`
      });
      const processFailed = code !== 0 || signal !== null || timedOut || overflowed;
      resolve({ ok: !processFailed, text: answerText().slice(0, MAX_OUTPUT_BYTES), stdout, stderr, code, pid, overflowed, timedOut, signal, usage });
    });
    // A child that exits without reading its prompt is a failed call, not a host crash: a closed pipe is
    // reported like any other process failure.
    child.stdin.on('error', () => {});
    try {
      child.stdin.end(input);
    } catch {
      // the child is already gone; `close` reports how
    }
  });
  return { ...outcome, model, durationMs: Date.now() - startedAt, finishedAt: nowIso() };
}

/**
 * The JSON object of a model answer. Models wrap it in prose, in a code fence, or write it and then keep
 * talking, so the candidates are tried in order of how much they trust the shape of the answer: a fenced
 * block, the longest *balanced* object starting at the first brace, and finally everything between the
 * first brace and the last one. When none of them parses, the reason says which failure it was, because a
 * truncated answer and an answer that is prose need different repairs.
 */
export function extractAnnotationJson(text) {
  const raw = String(text ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced) {
    const parsed = tryParse(fenced[1]);
    if (parsed) return { value: parsed, how: 'parsed' };
  }
  // Every balanced object is a candidate, not just the first: an evaluator that reasons in prose can leave a
  // small object behind before it writes the document. The one that declares the schema this host asked for
  // wins; failing that, the largest that parses at all.
  const objects = balancedObjects(raw).map(tryParse).filter(Boolean);
  const declared = objects.filter((value) => value.schema_version === ANNOTATION_SCHEMA);
  const chosen = declared.length > 0
    ? declared.reduce((best, value) => (JSON.stringify(value).length > JSON.stringify(best).length ? value : best))
    : objects.reduce((best, value) => (best === null || JSON.stringify(value).length > JSON.stringify(best).length ? value : best), null);
  if (chosen) return { value: chosen, how: 'parsed' };
  const first = raw.indexOf('{');
  if (first < 0) return { value: null, how: 'no-object' };
  // A first brace that never closes is an answer the model did not finish, which is a different problem from
  // an answer that simply is not JSON: the first needs a tighter request, the second a repair.
  return { value: null, how: 'truncated' };
}

function tryParse(candidate) {
  const trimmed = String(candidate ?? '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every balanced `{…}` object in a string, ignoring braces inside strings and escapes. */
function balancedObjects(text) {
  const objects = [];
  let index = text.indexOf('{');
  while (index >= 0) {
    const end = matchingBrace(text, index);
    if (end < 0) break;
    objects.push(text.slice(index, end + 1));
    index = text.indexOf('{', index + 1);
  }
  return objects;
}

/** True when `offset` sits on a UTF-8 character boundary of `bytes` (never inside a multibyte character). */
function isUtf8Boundary(bytes, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) return false;
  if (offset === 0 || offset === bytes.length) return true;
  return (bytes[offset] & 0xc0) !== 0x80;
}

/** The text of a byte range, or `null` when the bytes are not valid UTF-8. */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The index of the brace that closes the object opened at `start`, or -1 when it never closes. */
function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Where a line-anchored quotation points, resolved by the host.
 *
 * A model cannot count bytes in a file it reads through a paged view, and the reader truncates long lines, so
 * an evidence item may name the line the passage is on and quote it; the host resolves that to the byte range
 * the report needs. The search is confined to the lines the item names, so a quotation that occurs elsewhere
 * in the file never silently moves, and a quotation that occurs more than once inside them is an ambiguity the
 * answer has to settle by quoting more, never a guess the host makes.
 */
function resolveQuotedRange({ buffer, line, quote }) {
  const lines = [];
  let offset = 0;
  for (const text of buffer.toString('utf8').split('\n')) {
    const length = Buffer.byteLength(text, 'utf8');
    lines.push({ start: offset, end: offset + length });
    offset += length + 1;
  }
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    return { error: `line ${JSON.stringify(line)} is not a line of this file (it has ${lines.length})` };
  }
  const span = 1 + (quote.match(/\n/g)?.length ?? 0);
  const last = Math.min(lines.length - 1, line - 1 + span - 1);
  const from = lines[line - 1].start;
  const to = lines[last].end;
  const needle = Buffer.from(quote, 'utf8');
  if (needle.length === 0) return { error: 'the quote is empty' };
  const found = [];
  let at = buffer.indexOf(needle, from);
  while (at >= 0 && at + needle.length <= to) {
    found.push(at);
    at = buffer.indexOf(needle, at + 1);
  }
  if (found.length === 0) {
    return { error: `the quote does not occur on line ${line}${span > 1 ? `–${last}` : ''} of this file` };
  }
  if (found.length > 1) {
    return { error: `the quote occurs ${found.length} times between lines ${line} and ${last}; quote a longer passage or name the lines it covers` };
  }
  return { start: found[0], end: found[0] + needle.length, span: { line, to: last } };
}

/**
 * Validate a generated annotation document against the packet it claims to describe. The consumer
 * validates it again when it renders; this pass exists so that fabricated evidence, a stale version, a
 * scope outside the packet, or a document that measures itself against rules of its own making never
 * reaches publication.
 */
export function validateGeneratedAnnotations({ annotations, manifest, files, scope, vocabulary = null, rules = null }) {
  const errors = [];
  const version = acceptedVersion(files.map((file) => ({ path: file.path, role: file.role, sha256: file.sha256, bytes: file.bytes })));
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) {
    return { ok: false, errors: ['the answer is not a JSON object'] };
  }
  if (annotations.schema_version !== ANNOTATION_SCHEMA) {
    errors.push(`schema_version must be ${JSON.stringify(ANNOTATION_SCHEMA)}, got ${JSON.stringify(annotations.schema_version)}`);
  }
  if (annotations.source_version !== version) {
    errors.push(`source_version must be the packet version ${version}, got ${JSON.stringify(annotations.source_version)}`);
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const bytes = new Map(files.map((file) => [file.path, Buffer.from(file.text, 'utf8')]));
  // The chapter each selected file belongs to, so a declared byte range can be matched to the file it
  // constrains without trusting the answer to name both in the same way.
  const chapterPath = new Map(
    (manifest?.files ?? [])
      .filter((file) => file.role === 'chapter' && Number.isInteger(file.chapter))
      .map((file) => [file.chapter, file.path])
  );
  const evidenceIds = new Set();
  const evidence = Array.isArray(annotations.evidence) ? annotations.evidence : [];
  // How many items the host anchored itself: the provenance records it, because an offset the host resolved
  // is a different fact from an offset the answer declared.
  let resolvedOffsets = 0;
  if (evidence.length > MAX_EVIDENCE) errors.push(`at most ${MAX_EVIDENCE} evidence items are accepted, got ${evidence.length}`);
  for (const item of evidence) {
    if (!item || typeof item !== 'object') {
      errors.push('every evidence item is an object');
      continue;
    }
    const id = String(item.id ?? '').trim();
    if (!id) errors.push('an evidence item has no id');
    else if (evidenceIds.has(id)) errors.push(`duplicate evidence id ${JSON.stringify(id)}`);
    else evidenceIds.add(id);
    const file = byPath.get(item.file);
    if (!file) {
      errors.push(`evidence ${JSON.stringify(id)} names ${JSON.stringify(item.file)}, which is not in the packet`);
      continue;
    }
    if (item.sha256 !== file.sha256) {
      errors.push(`evidence ${JSON.stringify(id)} declares sha256 ${String(item.sha256).slice(0, 12)}… but ${item.file} hashes to ${file.sha256.slice(0, 12)}…`);
    }
    const buffer = bytes.get(item.file);
    let start = item.start;
    let end = item.end;
    // A model reads the packet through a paged view and cannot count bytes, so an item may name the line the
    // passage is on and quote it instead of declaring offsets: the host resolves that here and writes the
    // offsets into the item, which is what the report consumes. A declared range is still checked against the
    // bytes exactly as it always was, so a machine that can count keeps the strict form.
    if ((!Number.isInteger(start) || !Number.isInteger(end) || end <= start) && Number.isInteger(item.line) && typeof item.quote === 'string') {
      const resolved = resolveQuotedRange({ buffer, line: item.line, quote: item.quote });
      if (resolved.error) {
        errors.push(`evidence ${JSON.stringify(id)}: ${resolved.error}`);
        continue;
      }
      start = resolved.start;
      end = resolved.end;
      item.start = start;
      item.end = end;
      item.offsets_resolved_by = 'host';
      resolvedOffsets += 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      errors.push(`evidence ${JSON.stringify(id)} needs integer offsets with start < end, or a line and the exact quote of a passage on it`);
      continue;
    }
    if (end > buffer.length) {
      errors.push(`evidence ${JSON.stringify(id)} ends at ${end}, beyond ${item.file} (${buffer.length} bytes)`);
      continue;
    }
    // The declared offsets must fall on character boundaries: a range that starts or ends inside a
    // multibyte character is not a quotation, whatever it decodes to.
    if (!isUtf8Boundary(buffer, start) || !isUtf8Boundary(buffer, end)) {
      errors.push(`evidence ${JSON.stringify(id)} declares offsets that do not fall on UTF-8 character boundaries`);
      continue;
    }
    const slice = decodeUtf8(buffer.subarray(start, end));
    if (slice === null) {
      errors.push(`evidence ${JSON.stringify(id)} is not valid UTF-8 between ${start} and ${end}`);
      continue;
    }
    // The bytes at the declared offsets are what matters. A passage that also occurs earlier in the file is
    // the same passage: a repeated quotation is evidence, not an ambiguity.
    if (slice !== item.quote) {
      errors.push(`evidence ${JSON.stringify(id)} does not match the bytes of ${item.file} at ${start}..${end}: ${JSON.stringify(item.quote?.slice?.(0, 40))} vs ${JSON.stringify(slice.slice(0, 40))}`);
    }
    // A byte range is selected text only inside its own bytes: a quotation from another part of the same
    // chapter is surrounding context, and context explains rather than scores.
    const ranges = (Array.isArray(scope?.ranges) ? scope.ranges : []).filter((range) => range && chapterPath.get(Number(range.chapter)) === item.file);
    if (ranges.length > 0 && !ranges.some((range) => start >= Number(range.start) && end <= Number(range.end))) {
      errors.push(
        `evidence ${JSON.stringify(id)} lies outside the selected bytes of ${item.file} ` +
          `(${ranges.map((range) => `${range.start}..${range.end}`).join(', ')})`
      );
    }
  }
  const segments = Array.isArray(annotations.segments) ? annotations.segments : [];
  if (segments.length > MAX_SEGMENTS) errors.push(`at most ${MAX_SEGMENTS} segments are accepted, got ${segments.length}`);
  const allowedChapters = new Set(scope.kind === 'chapter' && scope.chapters?.length
    ? scope.chapters.map(Number)
    : files.filter((file) => file.role === 'chapter').map((file) => Number(file.path.slice(9, 13))));
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') {
      errors.push('every segment is an object');
      continue;
    }
    if (!String(segment.id ?? '').trim()) errors.push('a segment has no id');
    const chapter = Number(segment.chapter);
    if (!Number.isInteger(chapter) || !allowedChapters.has(chapter)) {
      errors.push(`segment ${JSON.stringify(segment.id)} names chapter ${segment.chapter}, outside the reviewed scope`);
    }
  }
  const metrics = annotations.metrics && typeof annotations.metrics === 'object' ? annotations.metrics : {};
  const citeErrors = (label, list) => {
    for (const id of Array.isArray(list) ? list : []) {
      if (!evidenceIds.has(id)) errors.push(`${label} cites evidence ${JSON.stringify(id)}, which is not declared`);
    }
  };
  for (const [id, metric] of Object.entries(metrics)) {
    if (!metric || typeof metric !== 'object') {
      errors.push(`metrics.${id} must be an object`);
      continue;
    }
    const blocks = Array.isArray(metric.points) ? metric.points : [metric];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      citeErrors(`metrics.${id}`, block.evidence);
      if (block.dimensions && typeof block.dimensions === 'object') {
        for (const [name, dimension] of Object.entries(block.dimensions)) {
          if (!dimension || typeof dimension !== 'object') {
            errors.push(`metrics.${id}.dimensions.${name} must be an object`);
            continue;
          }
          citeErrors(`metrics.${id}.dimensions.${name}`, dimension.evidence);
        }
      }
    }
  }
  for (const [index, indicator] of (Array.isArray(annotations.indicators) ? annotations.indicators : []).entries()) {
    if (!indicator || typeof indicator !== 'object') {
      errors.push(`indicators[${index}] must be an object`);
      continue;
    }
    if (!String(indicator.id ?? '').trim()) errors.push(`indicators[${index}] has no id`);
    citeErrors(`indicators[${index}]`, indicator.evidence);
  }
  // A completed review disposes of every component it was asked about: a judgement it could support, or an
  // explicit reason it could not assess that component. An empty object is not a completed review, and an
  // honest `not_assessable` with a reason is a valid answer — what is refused is silence.
  const reasonOf = (entry) => {
    for (const key of ['missing_reason', 'rationale', 'why', 'reason']) {
      const value = entry?.[key];
      if (typeof value === 'string' && value.trim().length > 0) return true;
    }
    return false;
  };
  for (const id of REQUESTED_JUDGED_METRICS) {
    const entry = metrics[id];
    if (!entry || typeof entry !== 'object') {
      errors.push(`metrics.${id} has no entry: every requested metric needs a judgement or a reason it cannot be assessed`);
      continue;
    }
    const status = typeof entry.status === 'string' ? entry.status : '';
    if (!status) {
      errors.push(`metrics.${id} declares no status`);
      continue;
    }
    if (status !== 'judged' && !reasonOf(entry)) {
      errors.push(`metrics.${id} is ${JSON.stringify(status)} without a reason: say what could not be assessed`);
    }
  }
  const requestedIndicators = Object.keys(vocabulary?.indicators ?? {});
  const indicatorEntries = Array.isArray(annotations.indicators) ? annotations.indicators : [];
  if (requestedIndicators.length > 0) {
    const byId = new Map();
    for (const indicator of indicatorEntries) {
      if (indicator && typeof indicator === 'object' && typeof indicator.id === 'string') byId.set(indicator.id, indicator);
    }
    for (const indicator of indicatorEntries) {
      const id = indicator && typeof indicator === 'object' && typeof indicator.id === 'string' ? indicator.id : null;
      if (id && !requestedIndicators.includes(id)) {
        errors.push(`indicator ${JSON.stringify(id)} is not one of the indicators the profile asked about`);
      }
    }
    for (const id of requestedIndicators) {
      if (!byId.has(id)) {
        errors.push(`indicator ${JSON.stringify(id)} has no entry: every requested indicator needs a judgement or a reason it cannot be assessed`);
        continue;
      }
      const indicator = byId.get(id);
      const status = typeof indicator.status === 'string' ? indicator.status : '';
      if (!status) errors.push(`indicator ${JSON.stringify(id)} declares no status`);
      else if (status !== 'judged' && !reasonOf(indicator)) errors.push(`indicator ${JSON.stringify(id)} is ${JSON.stringify(status)} without a reason: say what could not be assessed`);
    }
  }
  for (const [index, finding] of (Array.isArray(annotations.findings) ? annotations.findings : []).entries()) {
    if (!finding || typeof finding !== 'object') {
      errors.push(`findings[${index}] must be an object`);
      continue;
    }
    if (!String(finding.id ?? '').trim()) errors.push(`findings[${index}] has no id`);
    citeErrors(`findings[${index}]`, finding.evidence);
  }
  // The rule outcomes an answer may report: the rules the host declared, the outputs inside this reading,
  // and nothing else. An answer that restates the rules is refused rather than merged, because the standard
  // a book is measured against has to be a document of the version being reviewed instead of something an
  // evaluator wrote into its own answer.
  if (Array.isArray(rules) && rules.length > 0) {
    const declaredRules = new Set(rules.filter((rule) => rule && typeof rule.id === 'string').map((rule) => rule.id));
    const requirements = annotations.requirements;
    if (requirements !== undefined && requirements !== null) {
      if (typeof requirements !== 'object' || Array.isArray(requirements)) {
        errors.push('requirements must be an object carrying the outcomes of the declared rules');
      } else {
        if (requirements.outcomes !== undefined && !Array.isArray(requirements.outcomes)) {
          errors.push('requirements.outcomes must be an array');
        }
        const seen = new Set();
        for (const [index, outcome] of (Array.isArray(requirements.outcomes) ? requirements.outcomes : []).entries()) {
          if (!outcome || typeof outcome !== 'object') {
            errors.push(`requirements.outcomes[${index}] must be an object`);
            continue;
          }
          const ruleId = typeof outcome.rule === 'string' ? outcome.rule : null;
          if (!ruleId || !declaredRules.has(ruleId)) {
            errors.push(`outcome ${JSON.stringify(String(outcome.rule))} names a rule that was not declared; no outcome may come from an unconfigured rule`);
            continue;
          }
          const output = Number(outcome.output);
          if (!Number.isInteger(output) || !allowedChapters.has(output)) {
            errors.push(`outcome of rule ${JSON.stringify(ruleId)} names output ${JSON.stringify(outcome.output)}, outside the reviewed scope`);
            continue;
          }
          const key = `${ruleId}\u0000${output}`;
          if (seen.has(key)) {
            errors.push(`duplicate outcome for rule ${JSON.stringify(ruleId)} and output ${output}`);
            continue;
          }
          seen.add(key);
          if (typeof outcome.outcome !== 'string' || outcome.outcome.length === 0) {
            errors.push(`outcome of rule ${JSON.stringify(ruleId)} declares no outcome`);
          }
          citeErrors(`outcome of rule ${JSON.stringify(ruleId)}`, outcome.evidence);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, version, evidence_resolved: resolvedOffsets };
}

/**
 * The stage as the run uses it: build the prompt, call the model once in the workspace, extract the JSON,
 * validate it, and store it beside the run (never inside the frozen packet). One bounded repair attempt is
 * allowed, and it is recorded.
 */
/**
 * What an *answer* may not do with the rules: restate them or declare the registry they come from. The rules
 * are the host's to declare from published and accepted sources, so an evaluator reports outcomes only. This
 * is checked on the answer before it is composed into the published document, which legitimately carries the
 * host's registry.
 */
function declaredRulesProblem(annotations) {
  const requirements = annotations?.requirements;
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) return null;
  if (requirements.rules !== undefined) {
    return 'this answer restates the applicable rules; the host declares them from published and accepted sources, so an answer may report outcomes only';
  }
  if (requirements.registry_version !== undefined || requirements.aggregation_policy !== undefined) {
    return "the rule registry version and its aggregation policy are the host's to declare, not the answer's";
  }
  return null;
}

/** The evaluator labels a document declares, so a model-authored name can be compared with the launched one. */
function declaredEvaluatorLabels(annotations) {
  const labels = new Set();
  const collect = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) labels.add(value.trim());
  };
  for (const metric of Object.values(annotations.metrics ?? {})) {
    collect(metric?.evaluator);
    if (metric?.emotional_fit && typeof metric.emotional_fit === 'object') collect(metric.emotional_fit.evaluator);
  }
  for (const indicator of Array.isArray(annotations.indicators) ? annotations.indicators : []) collect(indicator?.evaluator);
  return [...labels].sort();
}

/**
 * The bounded reading of one review, and the synthesis that turns it into conclusions.
 *
 * One call that asks for every chapter does not scale and cannot say what it left out, so the selection is
 * planned as bounded units — a chapter, or a byte range of a chapter with its surrounding text — and each
 * unit is read on its own. The units' verified observations are then assembled by a separate synthesis: a
 * book or arc conclusion is a reading of those observations, never the mean of the per-unit grades. The
 * plan, the per-unit artifacts and the reading record live beside the run, so an interrupted reading
 * resumes the units it already paid for and a partial reading says so.
 *
 * The registry of applicable rules comes from the host: an evaluator reports outcomes for it and can never
 * define it, so nothing an answer invents becomes the standard the book is measured against.
 */
export async function generateAnnotations({
  skillsDir,
  runDir,
  inputDir,
  manifest,
  files,
  scope,
  book,
  request = null,
  intention = null,
  brief = null,
  context = null,
  registry = null,
  continuity = null,
  anchors = null,
  examples = null,
  resources = null,
  packetResources = [],
  timeoutMs = config.assessmentTimeoutMs,
  model = config.model,
  attempts = 2,
  unitBudget = null,
  onChild = null,
  onAttemptStart = null
}) {
  const coverage = {
    version: acceptedVersion(files.map((file) => ({ path: file.path, role: file.role, sha256: file.sha256, bytes: file.bytes }))),
    chapters: files.filter((file) => file.role === 'chapter').map((file) => Number(file.path.slice(9, 13))).sort((a, b) => a - b)
  };
  const generatedDir = join(runDir, 'generated');
  await mkdir(generatedDir, { recursive: true });
  const manifestPath = join(inputDir, 'manifest.json');
  const manifestBytesAtStart = await readFile(manifestPath).then((bytes) => sha256(bytes), () => null);
  // The capture hashed every packet file; the stage re-hashes them after the evaluator runs (see below).
  const history = [];
  const publishedResources = resources ?? await promptResources(skillsDir);
  const attemptLimit = Math.max(1, Math.min(attempts, 2));
  const vocabulary = await loadAnnotationVocabulary(skillsDir);
  const rules = Array.isArray(registry?.rules) ? registry.rules : [];
  const chapters = files
    .filter((file) => file.role === 'chapter' && Number.isInteger(Number(file.path.slice(9, 13))))
    .map((file) => ({ number: Number(file.path.slice(9, 13)), path: file.path, bytes: file.bytes, text: file.text }))
    .sort((a, b) => a.number - b.number);
  // The limits the reading is planned under are decided before anything is asked, written into the plan, and
  // stated in every prompt: a reader can see the bound a reading was made under instead of inferring it.
  const budget = {
    unit_bytes: unitBudget?.unit_bytes ?? config.assessmentUnitBytes,
    max_units: unitBudget?.max_units ?? config.assessmentMaxUnits,
    total_bytes: unitBudget?.total_bytes ?? config.assessmentTotalBytes
  };
  const plan = planReviewUnits({ chapters, selection: scope, budget, contextChapters: scope.context_chapters ?? [], version: coverage.version });
  const planFile = await writePlan(runDir, plan);
  // A unit artifact belongs to the plan, not to the moment it was written: the identity a reuse check
  // compares ignores `planned_at`, so a retry of the same book under the same limits plans the same units
  // and resumes them.
  const planIdentitySource = sha256(JSON.stringify({ ...plan, planned_at: null }));
  const unreadChapters = [...new Set(plan.omitted.flatMap((entry) => entry.chapters))];
  const chapterFile = (number) => chapters.find((chapter) => chapter.number === number)?.path ?? null;

  // Integrity is over the actual bytes, not over the manifest text: every file the manifest declares is
  // read again and hashed, and a file that is missing, unreadable or changed since the capture fails it.
  // It is checked on every exit from this stage — including the exits that end in a failed unit or a refused
  // document — because a run that reports a failure still owes its reader the state of the packet it read.
  const integrityErrors = [];
  let packetVerified = null;
  const verifyPacket = async () => {
    if (packetVerified !== null) return packetVerified;
    // The manifest itself is re-read and re-hashed too, so a packet whose declaration vanished is failed.
    const manifestAfter = await readFile(manifestPath).then((bytes) => sha256(bytes), () => null);
    if (manifestBytesAtStart === null || manifestAfter === null || manifestAfter !== manifestBytesAtStart) {
      integrityErrors.push('the packet manifest is missing or changed after the capture');
    }
    for (const file of manifest.files ?? []) {
      const bytes = await readFile(join(inputDir, file.path)).catch(() => null);
      if (bytes === null) {
        integrityErrors.push(`${file.path} is missing or unreadable`);
        continue;
      }
      const actual = sha256(bytes);
      if (actual !== file.sha256) {
        integrityErrors.push(`${file.path} changed after the capture (${actual.slice(0, 12)}… is not ${file.sha256.slice(0, 12)}…)`);
      }
    }
    // A file the manifest does not declare is a change to the frozen input too: the packet is exactly the
    // files the capture hashed (plus the manifest itself), and the resources the caller supplied with it.
    {
      const declared = new Set(['manifest.json', ...(manifest.files ?? []).map((file) => file.path), ...packetResources.map((file) => file.path)]);
      for (const path of await listPacketFiles(inputDir)) {
        if (!declared.has(path)) integrityErrors.push(`${path} is inside the frozen packet but no declaration names it`);
      }
    }
    packetVerified = integrityErrors.length === 0;
    return packetVerified;
  };
  const results = [];
  let callIndex = 0;
  let lastPrompt = null;
  let acceptedPrompt = null;
  let validation = { ok: false, errors: ['no attempt was made'] };
  let annotations = null;

  /** One evaluator call, recorded in the attempt history whatever it answers. */
  const callOnce = async ({ prompt, call, unit = null, validate }) => {
    callIndex += 1;
    const promptFile = `generated/prompt-attempt-${callIndex}.txt`;
    const promptBytes = Buffer.from(prompt, 'utf8');
    const promptSha = sha256(promptBytes);
    await writeFile(join(runDir, promptFile), prompt, 'utf8');
    const transcript = { sha256: promptSha, bytes: promptBytes.length, file: promptFile, text: prompt };
    lastPrompt = transcript;
    // A call in flight is reported before it answers, so the console of a running review shows what the
    // evaluator is doing while it does it: a silence a reader cannot tell from a hang is the one thing a
    // review that needs minutes must never present.
    onAttemptStart?.({
      attempt: callIndex,
      call,
      unit,
      model,
      prompt_file: promptFile,
      prompt_bytes: promptBytes.length,
      prompt_sha256: promptSha,
      timeout_ms: timeoutMs,
      started_at: new Date().toISOString()
    });
    const outcome = await runAnnotationStage({ runDir, prompt, timeoutMs, model, onChild });
    onAttemptStart?.(null);
    const identity = {
      attempt_id: sha256(`${EVALUATOR_PROVENANCE_SCHEMA}\n${model}\n${promptSha}\n${callIndex}`),
      attempt: callIndex,
      call,
      unit,
      model: outcome.model,
      pid: outcome.pid ?? null,
      prompt_version: ANNOTATION_PROMPT_VERSION,
      prompt_sha256: promptSha,
      prompt_file: promptFile,
      prompt_bytes: promptBytes.length,
      started_at: new Date(Date.now() - outcome.durationMs).toISOString(),
      finished_at: outcome.finishedAt,
      provider_usage: outcome.usage ?? null
    };
    // A process failure is not a schema failure: its output cannot be repaired by asking again, so the call
    // ends with the process reason instead of spending the repair attempt on it.
    if (!outcome.ok) {
      const reason = outcome.overflowed
        ? `the evaluator's answer exceeded the ${MAX_OUTPUT_BYTES}-character budget`
        : outcome.timedOut
          ? `the evaluator did not answer within ${Math.round(timeoutMs / 1000)}s`
          : outcome.signal !== null
            ? `the evaluator was terminated by signal ${outcome.signal}`
            : outcome.code === null
              ? `the evaluator could not be started: ${String(outcome.stderr).slice(0, 160)}`
              : `the evaluator exited with code ${outcome.code}`;
      history.push({
        ...identity,
        duration_ms: outcome.durationMs,
        exit_code: outcome.code,
        signal: outcome.signal ?? null,
        overflowed: outcome.overflowed === true,
        timed_out: outcome.timedOut === true,
        ok: false,
        errors: [reason],
        stderr: (outcome.stderr ?? '').trim().slice(0, 400) || null,
        answer_chars: outcome.text.length,
        process_failure: true
      });
      return { ok: false, processFailure: true, errors: [reason], how: null, transcript };
    }
    const extracted = extractAnnotationJson(outcome.text);
    const verdict = extracted.value
      ? validate(extracted.value)
      : { ok: false, errors: [`the answer contained no JSON object (${extracted.how})`] };
    history.push({
      ...identity,
      duration_ms: outcome.durationMs,
      exit_code: outcome.code,
      signal: outcome.signal ?? null,
      overflowed: false,
      timed_out: false,
      ok: verdict.ok,
      errors: verdict.errors.slice(0, 12),
      // How many quotations of this answer the host anchored itself from the line and the quote it was
      // given, so the record says which offsets were declared and which were resolved.
      evidence_resolved: verdict.evidence_resolved ?? 0,
      // A broken evaluator and a wrong answer look alike in the text: the child's own diagnostics and its
      // exit code are what tell them apart in the record.
      stderr: (outcome.stderr ?? '').trim().slice(0, 400) || null,
      answer_chars: outcome.text.length
    });
    return { ok: verdict.ok, processFailure: false, errors: verdict.errors, how: extracted.how, document: extracted.value, transcript };
  };

  /** The scope of one unit as the validator reads it: its bytes, its context, and nothing else. */
  const unitScope = (unit) => {
    const partial = unit.ranges.some((range) => {
      const chapter = chapters.find((entry) => entry.number === range.chapter);
      return range.start > 0 || (chapter ? range.end < chapter.bytes : false);
    });
    return {
      kind: 'chapter',
      chapters: [...unit.chapters],
      segments: [],
      arcs: [],
      context_chapters: [...unit.context_chapters],
      omitted: [],
      ...(partial ? { ranges: unit.ranges.map((range) => ({ chapter: range.chapter, start: range.start, end: range.end })) } : {})
    };
  };

  // One unit at a time, in plan order. A unit an earlier attempt of this run already read is reused after
  // its stored document is validated again against the packet, so an interrupted reading never pays twice.
  for (const unit of plan.units) {
    const identity = planIdentity({ version: coverage.version, planId: planIdentitySource, unit });
    const readingList = unitReadingList(unit, chapters, scope.omitted ?? []);
    const validate = (value) => {
      const problem = declaredRulesProblem(value);
      if (problem) return { ok: false, errors: [problem] };
      return validateGeneratedAnnotations({ annotations: value, manifest, files, scope: unitScope(unit), vocabulary, rules });
    };
    const stored = await readUnitArtifact(runDir, unit, identity);
    if (stored && validate(stored.document).ok) {
      results.push({
        id: unit.id,
        kind: unit.kind,
        chapters: unit.chapters,
        ranges: unit.ranges,
        selection_bytes: unit.selection_bytes,
        context_chapters: unit.context_chapters,
        state: 'completed',
        calls: 0,
        reused: true,
        document: stored.document,
        artifact: stored.path,
        prompt: stored.prompt ?? null
      });
      continue;
    }
    let previous = null;
    let accepted = null;
    let failure = null;
    let calls = 0;
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      const prompt = buildAnnotationPrompt({
        book,
        scope,
        readingList,
        request,
        intention,
        brief,
        context,
        coverage,
        model,
        anchors,
        examples,
        vocabulary,
        rules,
        unit,
        plan,
        // The second call is a repair: it carries the consumer's own rejection text, so the model is told
        // which field failed instead of being asked once more in the dark.
        repair: previous ? { errors: previous.errors, truncated: previous.how === 'truncated' } : null
      });
      const outcome = await callOnce({ prompt, call: 'unit', unit: unit.id, validate });
      calls += 1;
      if (outcome.processFailure) {
        failure = outcome.errors[0];
        break;
      }
      if (outcome.ok) {
        accepted = outcome;
        break;
      }
      previous = { errors: outcome.errors, how: outcome.how };
      failure = outcome.errors.slice(0, 3).join('; ');
    }
    if (!accepted) {
      // An unreadable answer is not a reading: the run fails with the unit named, and a retry resumes the
      // units that were read instead of paying for them again.
      results.push({
        id: unit.id,
        kind: unit.kind,
        chapters: unit.chapters,
        ranges: unit.ranges,
        selection_bytes: unit.selection_bytes,
        state: 'failed',
        calls,
        reused: false,
        errors: [failure ?? 'the unit could not be read']
      });
      return {
        ok: false,
        validation: { ok: false, errors: [failure ?? `unit ${unit.id} could not be read`], version: coverage.version },
        attempts: history,
        units: unitResults({ plan, results }),
        reading: readingRecord({ plan, results, planFile }),
        plan: planFile,
        packet_intact: await verifyPacket(),
        integrity_errors: integrityErrors,
        prompt_version: ANNOTATION_PROMPT_VERSION,
        model
      };
    }
    const artifact = await writeUnitArtifact(runDir, unit, identity, accepted.document, {
      version: ANNOTATION_PROMPT_VERSION,
      sha256: accepted.transcript.sha256,
      file: accepted.transcript.file
    });
    results.push({
      id: unit.id,
      kind: unit.kind,
      chapters: unit.chapters,
      ranges: unit.ranges,
      selection_bytes: unit.selection_bytes,
      context_chapters: unit.context_chapters,
      state: 'completed',
      calls,
      reused: false,
      document: accepted.document,
      artifact: artifact.path,
      sha256: artifact.sha256,
      prompt: { version: ANNOTATION_PROMPT_VERSION, sha256: accepted.transcript.sha256, file: accepted.transcript.file }
    });
    acceptedPrompt = accepted.transcript;
  }

  // The observations as one document: each unit's identifiers are namespaced so several units can be
  // composed without two of them claiming the same evidence identifier, and the rule outcomes of every unit
  // are kept for the chapter it read.
  const observed = results
    .filter((result) => result.state === 'completed')
    .map((result) => ({ ...result, document: namespaceUnitDocument(result.document, `${result.id}:`) }));
  const outcomes = [];
  const pairs = new Set();
  for (const unit of observed) {
    for (const outcome of Array.isArray(unit.document?.requirements?.outcomes) ? unit.document.requirements.outcomes : []) {
      const key = `${outcome?.rule}\u0000${outcome?.output}`;
      if (!outcome || pairs.has(key)) continue;
      pairs.add(key);
      outcomes.push(outcome);
    }
  }
  const requirements = registry ? registryRequirements(registry, outcomes) : null;
  const registration = {
    context: registry
      ? {
          registry_version: registry.registry_version,
          registry_file: RULES_FILE,
          rules: registry.rules.map((rule) => rule.id),
          authoring: registry.authoring,
          missing: registry.missing
        }
      : null,
    continuity: continuity ?? null
  };
  // A single unit with nothing left unread is the whole selection: its own judgements are already the
  // conclusions of the selection, and asking a model to assemble one observation would add a call and
  // nothing else.
  const synthesisNeeded = observed.length !== 1 || unreadChapters.length > 0;
  if (!synthesisNeeded) {
    const unit = observed[0];
    annotations = {
      ...unit.document,
      requirements,
      continuity: registration.continuity,
      unit_observations: [{
        unit: unit.id,
        chapters: unit.chapters,
        artifact: unit.artifact ?? null,
        findings: (Array.isArray(unit.document?.findings) ? unit.document.findings : []).map((finding) => finding?.id).filter(Boolean),
        evidence: (Array.isArray(unit.document?.evidence) ? unit.document.evidence : []).length
      }]
    };
    validation = validateGeneratedAnnotations({ annotations, manifest, files, scope, vocabulary, rules });
  } else {
    const reading = readingRecord({ plan, results, planFile });
    // What will be published if this synthesis is accepted: the union of the units' verified evidence, the
    // synthesis' own conclusions and the host's registry. It is composed before validation so that the
    // synthesis can cite what the units observed — its citations resolve against bytes a unit really read.
    const composeSynthesis = (value) => composeSelectionDocument({
      synthesis: value,
      units: observed,
      requirements,
      continuity: registration.continuity,
      request,
      brief,
      sourceVersion: coverage.version
    });
    const validateSynthesis = (value) => {
      // The synthesis assembles conclusions; it never reports rule outcomes, because each unit recorded the
      // outcome for the chapter it read and the host keeps them.
      if (value.requirements !== undefined && value.requirements !== null) {
        return {
          ok: false,
          errors: ['the synthesis does not report rule outcomes: each unit records the outcome for the chapter it read, and the host keeps them']
        };
      }
      const problem = declaredRulesProblem(value);
      if (problem) return { ok: false, errors: [problem] };
      return validateGeneratedAnnotations({ annotations: composeSynthesis(value), manifest, files, scope, vocabulary, rules });
    };
    const evidenceIndex = observed
      .flatMap((unit) => (Array.isArray(unit.document?.evidence) ? unit.document.evidence : []).map((item) => ({ unit: unit.id, item })))
      .map(({ unit, item }) => `- ${item.id} — ${item.file} [${item.start},${item.end}) of unit ${unit}`)
      .join('\n');
    const observations = observed
      .map((unit) => `--- UNIT ${unit.id} (chapter(s) ${unit.chapters.join(', ')}, ${unit.selection_bytes} bytes of selected prose)\n${JSON.stringify(unit.document, null, 2)}`)
      .join('\n');
    let previous = null;
    let accepted = null;
    let failure = null;
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      const prompt = buildSynthesisPrompt({
        book,
        scope,
        coverage,
        request,
        intention,
        brief,
        context,
        plan,
        reading,
        observations,
        evidenceIndex,
        model,
        anchors,
        vocabulary,
        repair: previous ? { errors: previous.errors, truncated: previous.how === 'truncated' } : null
      });
      const outcome = await callOnce({ prompt, call: 'synthesis', unit: null, validate: validateSynthesis });
      if (outcome.processFailure) {
        failure = outcome.errors[0];
        break;
      }
      if (outcome.ok) {
        accepted = outcome;
        break;
      }
      previous = { errors: outcome.errors, how: outcome.how };
      failure = outcome.errors.slice(0, 3).join('; ');
    }
    if (!accepted) {
      return {
        ok: false,
        validation: { ok: false, errors: [failure ?? 'the synthesis could not be read'], version: coverage.version },
        attempts: history,
        units: unitResults({ plan, results }),
        reading,
        plan: planFile,
        packet_intact: await verifyPacket(),
        integrity_errors: integrityErrors,
        prompt_version: ANNOTATION_PROMPT_VERSION,
        model
      };
    }
    acceptedPrompt = accepted.transcript;
    annotations = composeSynthesis(accepted.document);
    validation = validateSynthesis(accepted.document);
  }
  if (!validation.ok) {
    return {
      ok: false,
      validation,
      attempts: history,
      units: unitResults({ plan, results }),
      reading: readingRecord({ plan, results, planFile }),
      plan: planFile,
      packet_intact: await verifyPacket(),
      integrity_errors: integrityErrors,
      prompt_version: ANNOTATION_PROMPT_VERSION,
      model
    };
  }

  // What the evaluator saw and what it produced, in one reconstructible record: the exact prompt of every
  // attempt, the published rubric and teaching material with their hashes, the model and the settings it was
  // launched with, the identity of each attempt, the selection it was given and the bytes of the document it
  // produced. The evaluator identity is derived here, from the host's own invocation, and the labels the
  // document declares are recorded beside it so a discrepancy is visible instead of trusted.
  let provenance = null;
  let documentSha = null;
  let documentBytes = null;
  let relativePath = null;
  let publishedDocument = null;
  if (annotations) {
    const transcript = acceptedPrompt ?? lastPrompt;
    const labels = declaredEvaluatorLabels(annotations);
    const expectedLabel = `model:${model}`;
    const acceptedAttempt = [...history].reverse().find((entry) => entry.prompt_sha256 === transcript.sha256) ?? null;
    provenance = {
      schema_version: EVALUATOR_PROVENANCE_SCHEMA,
      evaluator_id: `host:${sha256([
        ANNOTATION_PROMPT_VERSION,
        model,
        transcript.sha256,
        ...Object.values(publishedResources).map((resource) => resource.sha256 ?? 'missing')
      ].join('\n'))}`,
      prompt: {
        version: ANNOTATION_PROMPT_VERSION,
        sha256: transcript.sha256,
        bytes: transcript.bytes,
        file: 'generated/prompt.txt',
        attempts: history.map((entry) => ({ attempt: entry.attempt, prompt_sha256: entry.prompt_sha256, prompt_file: entry.prompt_file, prompt_bytes: entry.prompt_bytes }))
      },
      resources: publishedResources,
      teaching_cases: examples
        ? {
            requested_language: examples.requested_language ?? null,
            max_size: examples.max_size ?? null,
            count: Array.isArray(examples.cases) ? examples.cases.length : 0,
            ids: (examples.cases ?? []).map((entry) => entry.id),
            selection_rule: examples.selection_rule ?? null,
            excluded_regression: examples.excluded_regression ?? []
          }
        : null,
      selection: {
        kind: scope?.kind ?? 'book',
        chapters: [...(scope?.chapters ?? [])],
        segments: [...(scope?.segments ?? [])],
        arcs: [...(scope?.arcs ?? [])],
        context_chapters: [...(scope?.context_chapters ?? [])],
        omitted: [...(scope?.omitted ?? [])],
        reading_list: {
          selected: plan.units.map((unit) => unit.file),
          context: [...new Set(plan.units.flatMap((unit) => unit.context_chapters))].map(chapterFile).filter(Boolean),
          omitted: unreadChapters.map(chapterFile).filter(Boolean)
        }
      },
      // The reading itself, as a reader has to read it: the units the plan declared, how many were read,
      // omitted or failed, the limits the plan was made under, and — in `complete` — whether the claims this
      // document makes cover the whole selection or only the part of it that was read.
      reading: readingRecord({ plan, results, planFile }),
      units: unitResults({ plan, results }),
      // The authoritative documents this review was measured against, and the rules the host declared from
      // them: a reader of the published bundle can see the standard without opening the run directory.
      context: registration.context,
      continuity: continuity ? { source_version: continuity.source_version ?? continuity.version ?? null, scoped_from: continuity.scoped_from ?? null } : null,
      calls: {
        allowed: plan.units.length * CALLS_PER_UNIT + CALLS_PER_UNIT,
        used: history.length,
        unit_calls: history.filter((entry) => entry.call === 'unit').length,
        synthesis_calls: history.filter((entry) => entry.call === 'synthesis').length
      },
      packet: {
        version: coverage.version,
        chapters: coverage.chapters,
        files: (manifest.files ?? []).map((file) => ({ path: file.path, role: file.role, sha256: file.sha256, bytes: file.bytes })),
        resources: packetResources.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
      },
      settings: {
        model,
        timeout_ms: timeoutMs,
        attempts_allowed: attemptLimit,
        unit_budget: budget,
        calls_allowed: plan.units.length * CALLS_PER_UNIT + CALLS_PER_UNIT,
        tools: [...EVALUATOR_TOOLS],
        no_lsp: true,
        prompt_bound_bytes: MAX_PROMPT_BYTES,
        answer_bound_bytes: MAX_OUTPUT_BYTES
      },
      attempts: history,
      answer: { extracted_object: true, questions_asked: REQUESTED_JUDGED_METRICS },
      declared_evaluator_labels: labels,
      evaluator_labels_expected: expectedLabel,
      evaluator_labels_match: labels.every((label) => label === expectedLabel),
      // Usage is what the provider reported for the accepted attempt, and absent when it reported nothing.
      provider_usage: acceptedAttempt?.provider_usage ?? null
    };
    // The document the report consumes is the model's own observation plus this host-written provenance: the
    // report carries it into the portable bundle, so the reading stays auditable outside this workspace.
    publishedDocument = { ...annotations, evaluator_provenance: provenance };
    const serialized = `${JSON.stringify(publishedDocument, null, 2)}\n`;
    await writeFile(join(generatedDir, 'annotations.json'), serialized, 'utf8');
    documentBytes = Buffer.from(serialized, 'utf8');
    documentSha = sha256(documentBytes);
    relativePath = 'generated/annotations.json';
    if (transcript.text !== undefined) await writeFile(join(generatedDir, 'prompt.txt'), transcript.text, 'utf8');
    // The standalone provenance manifest is the artifact hashes: the document's own bytes, the exact prompt
    // and nothing invented. Every hash here is computed from the file on disk, never from a re-serialization.
    const artifacts = [
      { path: relativePath, sha256: documentSha, bytes: documentBytes.length },
      ...(transcript.text !== undefined ? [{ path: 'generated/prompt.txt', sha256: transcript.sha256, bytes: transcript.bytes }] : [])
    ];
    for (const entry of history) {
      const filePath = join(runDir, entry.prompt_file);
      const bytes = await readFile(filePath).then((value) => sha256(value), () => null);
      if (bytes && bytes !== entry.prompt_sha256) integrityErrors.push(`${entry.prompt_file} does not hold the prompt of attempt ${entry.attempt}`);
    }
    await writeFile(
      join(generatedDir, 'provenance.json'),
      `${JSON.stringify({ schema_version: EVALUATOR_PROVENANCE_SCHEMA, document: { path: relativePath, sha256: documentSha, bytes: documentBytes.length }, artifacts, evaluator_provenance: provenance }, null, 2)}\n`,
      'utf8'
    );
  }
  const intact = (await verifyPacket()) && integrityErrors.length === 0;
  const ok = validation.ok && intact;
  return {
    ok,
    annotations: ok ? publishedDocument : null,
    path: ok ? join(generatedDir, 'annotations.json') : null,
    relativePath: ok ? relativePath : null,
    sha256: ok ? documentSha : null,
    document_sha256: documentSha,
    provenance,
    prompt: acceptedPrompt ? { sha256: acceptedPrompt.sha256, bytes: acceptedPrompt.bytes, file: 'generated/prompt.txt' } : null,
    validation,
    attempts: history,
    units: unitResults({ plan, results }),
    reading: readingRecord({ plan, results, planFile }),
    plan: planFile,
    packet_intact: intact,
    integrity_errors: integrityErrors,
    prompt_version: ANNOTATION_PROMPT_VERSION,
    model,
    output_chars: documentBytes ? documentBytes.length : 0,
    output_limit: MAX_OUTPUT_BYTES
  };
}

/**
 * An annotation document a run already holds, verified against the hash and the source it was accepted with.
 * A re-evaluation may re-render an accepted reading without paying for another one, but only the bytes that
 * were accepted and only while they still describe the packet they were validated against: a stored document
 * that changed, or that names another version, is refused instead of being published again.
 */
export async function verifyStoredAnnotations({ skillsDir, directory, inputDir, record }) {
  if (!record?.generated_annotations || !record.annotations_sha256) return { ok: false, reason: 'no stored annotations' };
  const bytes = await readFile(join(directory, record.generated_annotations)).catch(() => null);
  if (bytes === null) return { ok: false, reason: `the stored annotations ${record.generated_annotations} are missing` };
  const actual = sha256(bytes);
  if (actual !== record.annotations_sha256) {
    return {
      ok: false,
      reason: `the stored annotations changed since they were accepted (${actual.slice(0, 12)}… is not ${String(record.annotations_sha256).slice(0, 12)}…)`
    };
  }
  const parsed = (() => {
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      return null;
    }
  })();
  if (!parsed) return { ok: false, reason: `the stored annotations ${record.generated_annotations} are not JSON` };
  const manifest = await readJson(join(inputDir, 'manifest.json'), null);
  if (!manifest) return { ok: false, reason: 'the frozen packet of this run is gone' };
  const files = [];
  for (const file of manifest.files ?? []) {
    const text = await readFile(join(inputDir, file.path), 'utf8').catch(() => null);
    if (text !== null) files.push({ path: file.path, role: file.role, sha256: file.sha256, bytes: file.bytes, text });
  }
  const vocabulary = await loadAnnotationVocabulary(skillsDir).catch(() => null);
  // The rules the document was accepted against are the ones its own packet froze: a stored reading is
  // verified against the standard it was measured by, not against whatever the host declares today.
  const registry = await readFile(join(inputDir, RULES_FILE), 'utf8').then((raw) => JSON.parse(raw), () => null);
  const validation = validateGeneratedAnnotations({
    annotations: parsed,
    manifest,
    files,
    scope: record.requested_scope ?? record.scope ?? { kind: 'book' },
    vocabulary,
    rules: Array.isArray(registry?.rules) ? registry.rules : null
  });
  return { ok: validation.ok, reason: validation.errors.slice(0, 3).join('; '), sha256: actual, annotations: parsed, validation };
}

/** Every file inside a packet input directory, as paths relative to it, deepest first. */
async function listPacketFiles(root, prefix = '') {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await listPacketFiles(join(root, entry.name), path));
    else found.push(path);
  }
  return found;
}

// The prompt family lives in `./annotation-prompt.mjs`; re-exporting it here keeps the module's own surface
// stable for everything that already imports these names from the stage.
export {
  ANNOTATION_PROMPT_VERSION,
  ANNOTATION_SCHEMA,
  MAX_PROMPT_BYTES,
  TEACHING_CASES_LIMIT,
  buildAnnotationPrompt,
  loadAnnotationExamples,
  loadRubricAnchors,
  promptResources
} from './annotation-prompt.mjs';

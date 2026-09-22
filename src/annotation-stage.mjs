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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';
import { UniverseError } from './errors.mjs';
import { nowIso } from './io.mjs';
import { acceptedVersion } from './assessment-packet.mjs';
import {
  ANNOTATION_PROMPT_VERSION,
  ANNOTATION_SCHEMA,
  MAX_EVIDENCE,
  MAX_OUTPUT_BYTES,
  MAX_SEGMENTS,
  buildAnnotationPrompt,
  loadAnnotationExamples,
  loadAnnotationVocabulary
} from './annotation-prompt.mjs';

// Who produces the semantic observations of a review: the caller's document, the configured evaluator, or
// nobody at all. The vocabulary belongs to the host, not to the prompt: a request that names something else
// is refused before any packet is captured.
export const ANNOTATION_MODES = ['generic', 'supplied', 'deterministic'];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export async function runAnnotationStage({ runDir, prompt, timeoutMs = config.assessmentTimeoutMs, model = config.model }) {
  const startedAt = Date.now();
  const outcome = await new Promise((resolve) => {
    const args = [
      '-p', '--mode', 'json', '--no-session', '--no-title', '--auto-approve',
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
    let text = '';
    let buffer = '';
    let pid = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          const delta = event?.assistantMessageEvent?.delta;
          if (event?.type === 'message_update' && typeof delta === 'string') text += delta;
        } catch {
          // A line that is not an event is kept in the raw log only.
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5_000).unref(); }, timeoutMs);
    child.on('spawn', () => { pid = child.pid; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, text, stdout, stderr: String(error.message), code: null, pid }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          const delta = event?.assistantMessageEvent?.delta;
          if (event?.type === 'message_update' && typeof delta === 'string') text += delta;
        } catch {
          // ignore a trailing partial line
        }
      }
      resolve({ ok: code === 0, text, stdout, stderr, code, pid });
    });
    child.stdin.end(prompt);
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
 * Validate a generated annotation document against the packet it claims to describe. The consumer
 * validates it again when it renders; this pass exists so that fabricated evidence, a stale version or a
 * scope outside the packet never reaches publication.
 */
export function validateGeneratedAnnotations({ annotations, manifest, files, scope }) {
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
  const evidenceIds = new Set();
  const evidence = Array.isArray(annotations.evidence) ? annotations.evidence : [];
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
    const start = item.start;
    const end = item.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      errors.push(`evidence ${JSON.stringify(id)} needs integer offsets with start < end`);
      continue;
    }
    const buffer = bytes.get(item.file);
    if (end > buffer.length) {
      errors.push(`evidence ${JSON.stringify(id)} ends at ${end}, beyond ${item.file} (${buffer.length} bytes)`);
      continue;
    }
    const slice = buffer.subarray(start, end).toString('utf8');
    if (slice !== item.quote) {
      errors.push(`evidence ${JSON.stringify(id)} does not match the bytes of ${item.file} at ${start}..${end}: ${JSON.stringify(item.quote?.slice?.(0, 40))} vs ${JSON.stringify(slice.slice(0, 40))}`);
      continue;
    }
    // An unambiguous anchor: the quote must occur at the declared offset and be uniquely locatable there.
    const occurrence = buffer.indexOf(Buffer.from(item.quote, 'utf8'));
    if (occurrence !== start) {
      errors.push(`evidence ${JSON.stringify(id)} is ambiguous: the first occurrence of its quote is at ${occurrence}, not ${start}`);
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
  for (const [index, finding] of (Array.isArray(annotations.findings) ? annotations.findings : []).entries()) {
    if (!finding || typeof finding !== 'object') {
      errors.push(`findings[${index}] must be an object`);
      continue;
    }
    if (!String(finding.id ?? '').trim()) errors.push(`findings[${index}] has no id`);
    citeErrors(`findings[${index}]`, finding.evidence);
  }
  return { ok: errors.length === 0, errors, version };
}

/**
 * The stage as the run uses it: build the prompt, call the model once in the workspace, extract the JSON,
 * validate it, and store it beside the run (never inside the frozen packet). One bounded repair attempt is
 * allowed, and it is recorded.
 */
export async function generateAnnotations({ skillsDir, runDir, inputDir, manifest, files, scope, book, request = null, intention = null, brief = null, examples = [], timeoutMs = config.assessmentTimeoutMs, model = config.model, attempts = 2 }) {
  const coverage = {
    version: acceptedVersion(files.map((file) => ({ path: file.path, role: file.role, sha256: file.sha256, bytes: file.bytes }))),
    chapters: files.filter((file) => file.role === 'chapter').map((file) => Number(file.path.slice(9, 13))).sort((a, b) => a - b)
  };
  const generatedDir = join(runDir, 'generated');
  await mkdir(generatedDir, { recursive: true });
  const packetHashesBefore = manifest.files.map((file) => `${file.path}:${file.sha256}`).join('\n');
  const history = [];
  let previous = null;
  let annotations = null;
  let validation = { ok: false, errors: ['no attempt was made'] };
  const vocabulary = await loadAnnotationVocabulary(skillsDir);
  for (let attempt = 1; attempt <= Math.max(1, Math.min(attempts, 2)); attempt += 1) {
    const prompt = buildAnnotationPrompt({
      book,
      scope,
      request,
      intention,
      brief,
      coverage,
      examples,
      vocabulary,
      // The second call is a repair: it carries the consumer's own rejection text, so the model is told
      // which field failed instead of being asked once more in the dark.
      repair: previous ? { errors: previous.errors, truncated: previous.how === 'truncated' } : null
    });
    const call = await runAnnotationStage({ runDir, prompt, timeoutMs, model });
    const extracted = extractAnnotationJson(call.text);
    validation = extracted.value
      ? validateGeneratedAnnotations({ annotations: extracted.value, manifest, files, scope })
      : { ok: false, errors: [`the answer contained no JSON object (${extracted.how})`], version: coverage.version };
    history.push({
      attempt,
      model: call.model,
      prompt_version: ANNOTATION_PROMPT_VERSION,
      ok: validation.ok,
      duration_ms: call.durationMs,
      exit_code: call.code,
      errors: validation.errors.slice(0, 12),
      // A broken evaluator and a wrong answer look alike in the text: the child's own diagnostics and its
      // exit code are what tell them apart in the record.
      stderr: (call.stderr ?? '').trim().slice(0, 400) || null,
      answer_chars: call.text.length
    });
    if (validation.ok) {
      annotations = extracted.value;
      break;
    }
    previous = { errors: validation.errors, how: extracted.how };
    if (attempt === Math.max(1, Math.min(attempts, 2))) break;
  }
  const packetHashesAfter = await readFile(join(inputDir, 'manifest.json'), 'utf8').then((text) => {
    const again = JSON.parse(text);
    return again.files.map((file) => `${file.path}:${file.sha256}`).join('\n');
  }, () => packetHashesBefore);
  const packetIntact = packetHashesBefore === packetHashesAfter;
  if (annotations) {
    const target = join(generatedDir, 'annotations.json');
    await writeFile(target, `${JSON.stringify(annotations, null, 2)}\n`, 'utf8');
  }
  return {
    ok: validation.ok && packetIntact,
    annotations,
    path: validation.ok && packetIntact ? join(generatedDir, 'annotations.json') : null,
    relativePath: validation.ok && packetIntact ? 'generated/annotations.json' : null,
    sha256: annotations ? sha256(JSON.stringify(annotations)) : null,
    validation,
    attempts: history,
    packet_intact: packetIntact,
    prompt_version: ANNOTATION_PROMPT_VERSION,
    model,
    output_chars: annotations ? JSON.stringify(annotations).length : 0,
    output_limit: MAX_OUTPUT_BYTES
  };
}

// The prompt family lives in `./annotation-prompt.mjs`; re-exporting it here keeps the module's own surface
// stable for everything that already imports these names from the stage.
export { ANNOTATION_PROMPT_VERSION, ANNOTATION_SCHEMA, buildAnnotationPrompt, loadAnnotationExamples } from './annotation-prompt.mjs';

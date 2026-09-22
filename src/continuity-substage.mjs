// The continuity substage of a metrics review.
//
// A metrics report can only say something about continuity when a continuity assessment of the same bytes
// exists: CCI and CAD are computed from a verified `continuity-result.v1` and from nothing else. This
// module runs the continuity skill as a separate, deterministic substage over the run's own frozen packet
// and reads its published result, so a review of a book that was never asked for continuity input still
// reports what the state containers say about the selected chapters.
//
// Two properties are deliberate. The substage is scoped to the selection the run was asked about: the
// population and the counts a metrics report may attribute are recomputed from the comparison records that
// lie in the selected chapters, because counts about other chapters cannot be attributed to this scope.
// And a failing substage never fails the review: continuity is one input among several, its result travels
// as data, and a literary report is not gated by an integrity check that did not run.
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';
import { skillsDir } from './paths.mjs';
import { sha256 } from './assessment-packet.mjs';

export const CONTINUITY_RESULT_FILE = 'continuity-result.json';
export const CONTINUITY_SCHEMA = 'continuity-result.v1';
export const continuitySubstageDir = (directory) => join(directory, 'continuity');

/** The published result of a substage this run already ran, or `null` when there is none or it is unusable. */
async function storedResult(directory, version) {
  const path = join(continuitySubstageDir(directory), CONTINUITY_RESULT_FILE);
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return null;
  const parsed = (() => {
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      return null;
    }
  })();
  if (!parsed || parsed.schema_version !== CONTINUITY_SCHEMA || parsed.version !== version || parsed.ok === false) return null;
  return { result: parsed, sha256: sha256(bytes), path };
}

/**
 * Run the continuity skill over the frozen packet, or reuse the result of an earlier attempt of this run.
 * The outcome is data: a substage that refuses the packet or exits non-zero is reported with its reason and
 * the review continues without a continuity result.
 */
export async function runContinuitySubstage({ directory, inputDir, version, timeoutMs = config.assessmentTimeoutMs, controller = null }) {
  const reused = await storedResult(directory, version);
  if (reused) {
    return { ok: true, reused: true, result: reused.result, sha256: reused.sha256, path: reused.path, reason: null };
  }
  const outDir = continuitySubstageDir(directory);
  // The continuity skill publishes only into a directory that is not there yet, so an unusable earlier
  // result is removed before the substage runs again.
  await rm(outDir, { recursive: true, force: true });
  const script = join(skillsDir, 'scripta-continuity-review', 'scripts', 'review-continuity.mjs');
  const outcome = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--input', inputDir, '--out', outDir], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PI_NO_TITLE: '1' }
    });
    controller?.({ kill: (signal = 'SIGTERM') => child.kill(signal), pid: child.pid });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(error.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      controller?.(null);
      resolve({ code, stdout, stderr });
    });
  });
  const published = await storedResult(directory, version);
  if (outcome.code === 0 && published) {
    return { ok: true, reused: false, result: published.result, sha256: published.sha256, path: published.path, reason: null, exit_code: outcome.code };
  }
  const envelope = (() => {
    try {
      return JSON.parse(outcome.stdout.trim().split('\n').pop());
    } catch {
      return null;
    }
  })();
  const errors = (envelope?.errors ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.message ?? '')).filter(Boolean);
  return {
    ok: false,
    reused: false,
    result: published?.result ?? null,
    sha256: published?.sha256 ?? null,
    path: published?.path ?? null,
    exit_code: outcome.code,
    reason:
      errors.slice(0, 3).join('; ')
      || outcome.stderr.trim().split('\n').pop()
      || `the continuity substage exited with code ${outcome.code}`
  };
}

/**
 * The chapters a comparison can be attributed to. The ledger records its reviewed claims by identifier and
 * its paired baseline/later readings with their own chapter, so a comparison is attributed from those
 * records: one that names no chapter of its own cannot be counted as a comparison of a narrower selection,
 * and it is reported as unattributable rather than folded into the selection's rate.
 */
function comparisonChapters(comparison) {
  const chapters = new Set();
  for (const side of [comparison?.baseline, comparison?.later]) {
    if (Number.isInteger(side?.chapter)) chapters.add(side.chapter);
  }
  return [...chapters];
}

const countsOf = (comparisons) => {
  const counts = { eligible_comparisons: comparisons.length, consistent: 0, contradicted: 0, unresolved: 0 };
  for (const comparison of comparisons) {
    if (comparison.outcome === 'contradicted') counts.contradicted += 1;
    else if (comparison.outcome === 'unresolved') counts.unresolved += 1;
    else counts.consistent += 1;
  }
  return counts;
};

/**
 * The result of the substage, narrowed to the selection the review was asked about. The population is the
 * selection; the counts are recomputed from the comparison records that lie inside it, and a comparison
 * that cannot be attributed to any chapter of the selection is not counted as one of its comparisons; the
 * findings keep their own evidence, and the metrics report applies the same selection rule to them.
 */
export function scopeContinuityToSelection({ result, selection, packetChapters, sourceVersion, sourceSha256, sourcePath }) {
  const all = Array.isArray(result.comparisons) ? result.comparisons : null;
  const selected = new Set(selection);
  const kept = all === null ? null : all.filter((comparison) => {
    const chapters = comparisonChapters(comparison);
    return chapters.length > 0 && chapters.every((number) => selected.has(number));
  });
  const counts = kept === null
    ? { eligible_comparisons: 0, consistent: 0, contradicted: 0, unresolved: 0 }
    : countsOf(kept);
  const declared = result.counts ?? null;
  const scope = result.scope && typeof result.scope === 'object' ? result.scope : {};
  const reviewed = Array.isArray(scope.chapters_reviewed) ? scope.chapters_reviewed.filter(Number.isInteger) : [];
  const same = reviewed.length === selection.length && [...reviewed].sort().every((number, index) => number === [...selection].sort()[index]);
  const resolved = counts.consistent + counts.contradicted;
  return {
    ...result,
    // The authoritative source identity of a continuity result is `source_version` (§8.5); the substage
    // wrote the version it reviewed as `version`, and both are the captured version here.
    version: sourceVersion,
    source_version: sourceVersion,
    counts,
    partition: {
      examined: counts.eligible_comparisons,
      unattributable: all === null ? null : all.length - kept.length,
      declared_eligible: declared?.eligible_comparisons ?? null
    },
    evaluated_from: same ? 'the whole result' : `the comparisons of the selected chapters ${selection.join(', ')}`,
    scope: {
      ...scope,
      universe_id: scope.universe_id ?? null,
      kind: scope.kind ?? null,
      chapters: [...packetChapters],
      omitted: packetChapters.filter((number) => !selected.has(number)),
      chapters_reviewed: [...selection],
      coverage: counts.eligible_comparisons === 0 ? null : resolved / counts.eligible_comparisons,
      coverage_bounds:
        counts.eligible_comparisons === 0
          ? null
          : { lower: resolved / counts.eligible_comparisons, upper: (resolved + counts.unresolved) / counts.eligible_comparisons },
      coverage_note:
        `${scope.coverage_note ?? 'continuity review'} Scoped to the selection (${selection.join(', ') || 'none'}): ` +
        `${counts.eligible_comparisons} of ${declared?.eligible_comparisons ?? all?.length ?? 0} reviewed comparison(s) ` +
        'lie in the selected chapters and only those are counted here.'
    },
    derived: {
      ...(result.derived ?? {}),
      cci: counts.eligible_comparisons === 0 ? null : (100 * counts.consistent) / counts.eligible_comparisons
    },
    scoped_from: {
      path: sourcePath,
      sha256: sourceSha256,
      selection: [...selection],
      unattributable_comparisons: all === null ? null : all.length - kept.length
    }
  };
}

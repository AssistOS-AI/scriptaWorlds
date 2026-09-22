/**
 * The provenance record: what another session needs to re-establish this run.
 *
 * The bundle is portable evidence, not a private log. This module assembles the
 * part of it that answers "what did the run read, under which configuration, and
 * which judgement produced this result":
 *
 *   - the accepted version, the captured scope and one entry per packet file with
 *     its hash and byte count;
 *   - `resources`: every input the run read, with the sha256 of the exact bytes;
 *   - `annotations`: the hash of the judgement document it was given;
 *   - `evaluation`: the hashes of the skill's own published vocabulary, rubric
 *     anchors, study schema and case index, plus the evaluator labels that
 *     authored the judgements and the declared model and settings;
 *   - `evaluator_provenance`: the evaluator's own declaration, carried verbatim
 *     and digested so a reader can tell the copy did not change;
 *   - the corpus comparison with every reference's declared identity, and the
 *     continuity population the counts describe.
 *
 * Nothing here is restated, completed or corrected: a provider usage figure
 * appears only when the evaluator observed it, and an unrecorded model identity
 * stays unrecorded.
 */

import { isPlainObject, sha256Hex } from './errors.mjs';

/**
 * Reproduce a JSON value with its object keys in sorted order, so the digest of a
 * declared provenance record does not depend on the formatting of the file it
 * arrived in. Arrays keep their order: a prompt, a resource list and an attempt
 * sequence are ordered facts.
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The evaluator's own declaration about the run that produced the judgement
 * document: the prompt, the rubric and case hashes, the model and its settings,
 * the attempt identities, the resource selection and the hashes of the artifacts
 * it generated. It is carried verbatim — a report never restates, completes or
 * corrects it — and hashed so a reader can tell that the copy did not change.
 */
export function readEvaluatorProvenance(annotations, fail) {
  const raw = annotations ? annotations.evaluator_provenance : null;
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    fail(
      'annotations.evaluator_provenance must be an object when present; a report carries it verbatim instead of ' +
        'interpreting a string or a list',
      'INVALID_ANNOTATIONS',
    );
  }
  return raw;
}

/** Every evaluator label the published results name, in order. */
export function evaluatorLabels(metrics, indicators) {
  const labels = [
    ...Object.values(metrics).map((metric) => metric.evaluator),
    ...Object.values(indicators).map((indicator) => indicator.evaluator),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  return [...new Set(labels)].sort();
}

export function buildProvenance({
  codeVersion,
  registryVersion,
  tokenizerVersion,
  tokenizerMethod,
  manifest,
  packet,
  selection,
  coverage,
  continuity,
  corpus,
  comparisonScope,
  corpusReferences,
  corpusExclusions,
  candidateIdentity,
  files,
  annotations,
  annotationsRaw,
  annMetrics,
  resources,
  evaluation,
  evaluatorProvenance,
  evaluators,
  profile,
  profileRaw,
  runtime,
}) {
  const declaredModel =
    evaluatorProvenance && typeof evaluatorProvenance.model === 'string' ? evaluatorProvenance.model : null;
  const declaredSettings =
    evaluatorProvenance && isPlainObject(evaluatorProvenance.settings) ? evaluatorProvenance.settings : null;
  return {
    code_version: codeVersion,
    registry_version: registryVersion,
    tokenizer_version: tokenizerVersion,
    tokenizer_method: tokenizerMethod,
    runtime,
    profile_sha256: sha256Hex(profileRaw),
    packet: {
      schema_version: manifest.schema_version,
      universe_id: manifest.universe_id,
      version: packet.version,
      captured_at: manifest.captured_at,
      scope: packet.scope,
      inventory: packet.inventory,
    },
    selection: {
      kind: selection.kind,
      source: 'profile.scope',
      chapters: selection.chapters,
      segments: selection.segmentIds,
      context_chapters: selection.contextChapters,
      output_ids: selection.outputIds,
    },
    continuity: continuity
      ? {
          source_version: continuity.source_version,
          declared_version: continuity.declared_version,
          population: continuity.population,
          chapters: coverage.covered_chapters,
          chapters_reviewed: continuity.chapters_reviewed,
          declared_chapters: continuity.chapters,
          omitted: continuity.omitted,
          coverage_note: continuity.coverage_note,
          declared_coverage: continuity.declared_coverage,
          counts: continuity.counts,
          declared_counts: continuity.declared_counts,
          counts_source: continuity.counts_source,
          partition: continuity.partition,
        }
      : null,
    corpus: corpus
      ? {
          schema_version: corpus.schema_version,
          comparison_scope: comparisonScope,
          candidate_identity: { id: candidateIdentity.id, version: candidateIdentity.version },
          references: corpusReferences,
          exclusions: corpusExclusions,
        }
      : null,
    files: files.map((file) => ({ path: file.path, role: file.role, sha256: file.sha256, bytes: file.bytes })),
    annotations: annotations
      ? {
          source_version: annotations.source_version ?? null,
          continuity_source_version: continuity ? continuity.source_version : null,
          declared_metrics: Object.keys(annMetrics),
          timing_declared: Boolean(annotations.timing),
          sha256: annotationsRaw ? sha256Hex(annotationsRaw) : null,
          bytes: annotationsRaw ? annotationsRaw.length : null,
        }
      : null,
    resources,
    evaluation: {
      ...evaluation,
      rubric_version: profile.rubric.version,
      anchor_scale: profile.rubric.scale,
      registry_version: registryVersion,
      evaluators,
      model_variability: {
        assessed_by: evaluators,
        declared_model: declaredModel,
        declared_settings: declaredSettings,
        note:
          'every judgement in this bundle was authored outside this deterministic run by the evaluator named on its ' +
          'own result; re-running the same inputs against another model or settings may produce different ' +
          'judgements, while re-rendering this saved bundle is byte-identical and adds none',
      },
    },
    evaluator_provenance: evaluatorProvenance,
    evaluator_provenance_sha256:
      evaluatorProvenance === null ? null : sha256Hex(Buffer.from(stableStringify(evaluatorProvenance), 'utf8')),
  };
}

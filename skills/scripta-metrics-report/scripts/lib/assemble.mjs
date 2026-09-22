/**
 * Assessment assembly: compute all metrics, indicators, requirements, findings,
 * preserved qualities and the provenance/evidence records, then return the
 * canonical assessment bundle. Pure aside from reading already-loaded bytes;
 * deterministic for identical inputs.
 *
 * The resolved selection governs every measurement: candidate text, the
 * eligible-token denominator, the SI comparison set, the CAR output population,
 * the continuity input, self-exclusion and the evidence coverage all come from
 * it. Chapters of the packet outside the selection are context: available to
 * explain a fact, never counted as candidate words. A metric keeps a
 * discriminated value kind, so a component profile or an ordered trajectory is
 * never flattened into an invented number.
 */

import { fail, isPlainObject, sha256Hex } from './errors.mjs';
import { parseEvidenceList } from './evidence.mjs';
import { parseSegments, segmentOrder } from './segments.mjs';
import { resolveSelection } from './selection.mjs';
import { buildCandidateUnits } from './candidate.mjs';
import { COMPARISON_SCOPE } from './overlap.mjs';
import { computeLexical, generateTopEvidence } from './lexical.mjs';
import { computeCar, parseRuleSet } from './rules.mjs';
import { buildNqs, NQS_REQUIRES, validateDependencyGraph } from './aggregate.mjs';
import { baseMetric, buildMetrics, computeCad, computeCci } from './metrics.mjs';
import { buildComponentMetric, buildEap } from './rubric.mjs';
import { buildAeg } from './timing.mjs';
import { buildCr } from './contamination.mjs';
import {
  createEvidenceCollector,
  normalizeAnnMetrics,
  normalizeContinuity,
  normalizeDepartures,
  normalizeFindings,
  normalizeIndicators,
  normalizePreserved,
} from './annotations.mjs';
import { TOKENIZER_METHOD, TOKENIZER_VERSION } from './tokenize.mjs';
import { INDICATOR_IDS, METRIC_IDS, REGISTRY_VERSION } from './registry.mjs';

export const CODE_VERSION = 'scripta-metrics-report/1.3.0';
export const ASSESSMENT_SCHEMA_VERSION = 'assessment.v1';

/* ------------------------------ helpers ------------------------------ */

function sameChapterSet(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function chaptersWithEvidence(evidenceList, chapterByPath, selected) {
  const withEvidence = new Set();
  for (const item of evidenceList) {
    const chapter = chapterByPath.get(item.file);
    if (chapter !== undefined && selected.includes(chapter)) withEvidence.add(chapter);
  }
  return withEvidence.size;
}

/**
 * Whether a finding belongs to this assessment. Evidence inside the selection
 * always does; evidence inside a declared context chapter is admitted too,
 * because that material was supplied precisely to explain a fact. Evidence
 * outside both is not attributed to this scope.
 */
function withinScope(finding, chapterByPath, chapters, contextChapters) {
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  const allowed = [...chapters, ...contextChapters];
  for (const item of evidence) {
    if (!isPlainObject(item) || typeof item.file !== 'string') continue;
    const chapter = chapterByPath.get(item.file);
    if (chapter !== undefined && !allowed.includes(chapter)) return false;
  }
  return true;
}

function computeAssessmentId({ manifest, packet, profileRaw, annotationsRaw, corpusRaw }) {
  const manifestFiles = manifest.files.map((f) => `${f.path}:${f.sha256}:${f.bytes}:${f.role}`).join('\n');
  const payload = [
    manifest.schema_version,
    packet.version,
    manifest.captured_at,
    manifest.universe_id,
    manifest.book.title,
    manifest.book.language,
    String(manifest.book.last_accepted_chapter),
    manifestFiles,
    profileRaw.toString('utf8'),
    annotationsRaw ? annotationsRaw.toString('utf8') : '',
    corpusRaw ? corpusRaw.toString('utf8') : '',
  ].join('\n');
  return sha256Hex(Buffer.from(payload, 'utf8')).slice(0, 32);
}

function assertEvidenceIds(ids, collector, what) {
  for (const id of ids) {
    if (!collector.byId.has(id)) fail(`${what} references unknown evidence id ${JSON.stringify(id)}`, 'UNKNOWN_EVIDENCE');
  }
}

/**
 * A semantic annotation declares the accepted version it was judged against.
 * When it declares one, a mismatch is refused instead of being attributed to a
 * book it never saw; evidence items pin the exact bytes in the same way.
 */
function assertSourceVersion(declared, packetVersion, label) {
  if (declared === undefined || declared === null) return null;
  if (typeof declared !== 'string' || declared.length === 0) {
    fail(`${label}.source_version must be a non-empty string when present`, 'INVALID_ANNOTATIONS');
  }
  if (declared !== packetVersion) {
    fail(
      `${label}.source_version ${declared} is stale: the packet version is ${packetVersion}; re-run the judgement ` +
        'against this version instead of attributing it to an older book',
      'STALE_ANNOTATION',
    );
  }
  return declared;
}

function continuityCoverage({ continuity, packet, selection }) {
  if (!continuity) {
    return {
      applicable: false,
      covered_chapters: null,
      reason: 'no continuity-result.v1 supplied in the annotations bundle',
    };
  }
  const covered = continuity.chapters === null ? packet.inventory : continuity.chapters;
  if (!sameChapterSet(covered, selection.chapters)) {
    return {
      applicable: false,
      covered_chapters: covered,
      reason:
        `the supplied continuity result covers chapters ${covered.join(', ') || 'none'}, which does not match the ` +
        `selection (${selection.chapters.join(', ') || 'none'}); its counts cannot be attributed to this scope`,
    };
  }
  return { applicable: true, covered_chapters: covered, reason: null };
}

function getEmotionalFit(annMetrics) {
  const raw = annMetrics.EAP?.emotional_fit ?? annMetrics.NQS?.emotional_fit ?? null;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number') fail('emotional_fit must be a number', 'INVALID_ANNOTATIONS');
  if (raw < 0 || raw > 100) fail('emotional_fit out of range [0, 100]', 'OUT_OF_RANGE');
  return raw;
}

function buildJudgedMetrics({ annMetrics, annotations, profile, metricScope, segmentIds, annotationsDir }) {
  const rubric = profile.rubric;
  return {
    CS: buildComponentMetric('CS', annMetrics.CS, {
      scope: metricScope,
      rubric,
      fallbackReason: 'no CS annotation supplied',
    }),
    OI: buildComponentMetric('OI', annMetrics.OI, {
      scope: metricScope,
      rubric,
      fallbackReason: 'no OI annotation supplied',
    }),
    NCS: buildComponentMetric('NCS', annMetrics.NCS, {
      scope: metricScope,
      rubric,
      fallbackReason: 'no NCS annotation supplied',
    }),
    EAP: buildEap(annMetrics.EAP, {
      scope: metricScope,
      segmentIds,
      fallbackReason: 'no EAP annotation supplied',
    }),
    CR: buildCr(annMetrics.CR, { baseMetricFor: baseMetric, scope: metricScope, annotationsDir }),
    AEG: buildAeg(annotations ? annotations.timing : undefined, {
      baseMetricFor: baseMetric,
      scope: metricScope,
      fallbackReason: 'no opt-in AEG timing annotation supplied',
      legacyAnnotation: annMetrics.AEG,
    }),
  };
}

/* ------------------------------ assembly ------------------------------ */

/**
 * Assemble the full assessment bundle from already-loaded inputs. Throws
 * CliError (exit 2) on any invalid input; never mutates input bytes.
 */
export function assess({
  packet,
  profile,
  profileRaw,
  annotations,
  annotationsRaw,
  corpus,
  corpusRaw,
  annotationsDir,
  trigger = 'request',
  arcId = null,
  studyRoot = null,
  allowTestOnlyStudies = false,
}) {
  if (!['request', 'arc'].includes(trigger)) {
    fail(`trigger must be "request" or "arc", got ${JSON.stringify(trigger)}`, 'INVALID_TRIGGER');
  }
  if (trigger === 'arc' && (typeof arcId !== 'string' || arcId.length === 0)) {
    fail('an arc-triggered assessment needs a non-empty arc id', 'INVALID_TRIGGER');
  }
  const { manifest, files } = packet;
  const language = manifest.book.language;

  const annMetrics = normalizeAnnMetrics(annotations ? annotations.metrics : undefined);
  const continuity = annotations && annotations.continuity ? normalizeContinuity(annotations.continuity) : null;
  const segments = parseSegments(annotations ? annotations.segments : undefined, packet);
  const ruleSet = parseRuleSet(annotations ? annotations.requirements : undefined);
  const selection = resolveSelection({ packet, profile, segments });
  const metricScope = { kind: selection.kind, chapters: selection.chapters, segments: selection.segmentIds };

  // Every declared source version must be the packet's own accepted version.
  assertSourceVersion(annotations ? annotations.source_version : undefined, packet.version, 'annotations');
  for (const [id, annotation] of Object.entries(annMetrics)) {
    if (isPlainObject(annotation)) assertSourceVersion(annotation.source_version, packet.version, `annotations.metrics.${id}`);
  }
  if (continuity) assertSourceVersion(continuity.source_version, packet.version, 'annotations.continuity');

  const chapterByPath = new Map(files.filter((f) => f.role === 'chapter').map((f) => [f.path, f.chapter]));
  const candidateFiles = new Map(files.filter((f) => f.role === 'chapter').map((f) => [f.path, f]));
  const candidate = buildCandidateUnits({ packet, selection, language });
  const candidateHashSet = new Set(candidate.files.map((f) => f.sha256));

  const lexical = computeLexical({ candidate, corpus, candidateHashSet });

  // Continuity-derived metrics (consumed once, and only for the selection).
  const coverage = continuityCoverage({ continuity, packet, selection });
  const continuityFindings =
    continuity && coverage.applicable
      ? continuity.findings.filter((finding) =>
          withinScope(finding, chapterByPath, selection.chapters, selection.contextChapters),
        )
      : [];
  const annotationFindings = annotations && annotations.findings ? annotations.findings : [];
  const cadFindings = [...continuityFindings, ...annotationFindings];
  const cci = continuity && coverage.applicable ? computeCci(continuity.counts) : null;
  const cad = continuity && coverage.applicable ? computeCad(cadFindings) : null;

  // Evidence collection.
  const collector = createEvidenceCollector(files);
  collector.addAll(parseEvidenceList(annotations && annotations.evidence ? annotations.evidence : [], 'annotations.evidence'));
  const findings = normalizeFindings(cadFindings, collector);
  const indicators = normalizeIndicators(annotations ? annotations.indicators : undefined);
  const departures = normalizeDepartures(annotations ? annotations.departures : undefined);
  const preserved = normalizePreserved(annotations ? annotations.preserved_qualities : undefined);

  // Judged metrics with discriminated outputs.
  const assessed = buildJudgedMetrics({
    annMetrics,
    annotations,
    profile,
    metricScope,
    segmentIds: segments.map((segment) => segment.id),
    annotationsDir,
  });

  // NQS from its saved components under the declared aggregation profile.
  const nqsValues = {
    CS: typeof assessed.CS.value === 'number' ? assessed.CS.value : null,
    OI: typeof assessed.OI.value === 'number' ? assessed.OI.value : null,
    EMOTIONAL_FIT: getEmotionalFit(annMetrics),
  };
  const graphCheck = validateDependencyGraph({ NQS: NQS_REQUIRES });
  if (!graphCheck.ok) fail(graphCheck.errors.join('; '), 'INVALID_GRAPH');
  const nqs = buildNqs({
    aggregation: profile.aggregation,
    values: nqsValues,
    scope: metricScope,
    baseMetricFor: baseMetric,
    annotatedValue: isPlainObject(annMetrics.NQS) && typeof annMetrics.NQS.value === 'number' ? annMetrics.NQS.value : null,
    language,
    studyRoot,
    allowTestOnlyStudies,
  });

  const car = computeCar(ruleSet, selection.outputIds);
  const metrics = buildMetrics({
    scope: metricScope,
    assessed,
    nqs,
    car,
    si: lexical.si,
    top: lexical.top,
    cci,
    cad,
    continuityReason: coverage.reason,
    corpusReason: lexical.corpusReason,
  });
  if (lexical.top && lexical.top.status === 'computed') {
    metrics.TOP.evidence = generateTopEvidence(lexical.top, candidateFiles, collector);
  }

  // Verify every evidence reference resolves.
  for (const id of METRIC_IDS) assertEvidenceIds(metrics[id].evidence, collector, `metrics.${id}`);
  for (const outcome of car.pairs) assertEvidenceIds(outcome.evidence, collector, `rules.${outcome.rule}`);
  for (const id of INDICATOR_IDS) assertEvidenceIds(indicators[id].evidence, collector, `indicators.${id}`);
  for (const departure of departures) assertEvidenceIds(departure.evidence, collector, `departures.${departure.id}`);
  for (const passage of preserved.passages) assertEvidenceIds(passage.evidence, collector, `preserved.${passage.id}`);

  const evidenceList = [...collector.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selectedWithEvidence = chaptersWithEvidence(evidenceList, chapterByPath, selection.chapters);
  const assessmentId = computeAssessmentId({ manifest, packet, profileRaw, annotationsRaw, corpusRaw });

  return {
    schema_version: ASSESSMENT_SCHEMA_VERSION,
    assessment_id: assessmentId,
    created_at: manifest.captured_at,
    trigger,
    trigger_ref: trigger === 'arc' ? { kind: 'arc', arc_id: arcId } : { kind: 'request' },
    book: {
      universe_id: manifest.universe_id,
      title: manifest.book.title,
      language: manifest.book.language,
      last_accepted_chapter: manifest.book.last_accepted_chapter,
    },
    version: packet.version,
    scope: {
      kind: selection.kind,
      chapters: selection.chapters,
      population: selection.outputIds,
      segments: selection.segmentIds,
      context_chapters: selection.contextChapters,
      ranges: selection.ranges,
    },
    coverage: {
      packet_scope: packet.scope.kind,
      packet_chapters: packet.inventory,
      omitted_chapters: selection.omitted,
      context_chapters: selection.contextChapters,
      note: selection.note,
      selection: { kind: selection.kind, chapters: selection.chapters, segments: selection.segmentIds },
      evidence: {
        selected_chapters: selection.chapters.length,
        chapters_with_evidence: selectedWithEvidence,
        ratio: selection.chapters.length === 0 ? null : selectedWithEvidence / selection.chapters.length,
      },
      continuity: {
        applicable: coverage.applicable,
        covered_chapters: coverage.covered_chapters,
        reason: coverage.reason,
      },
      tokenizer: {
        version: TOKENIZER_VERSION,
        method: TOKENIZER_METHOD,
        language,
        supported: candidate.supported,
        reason: candidate.reason,
        eligible_tokens: candidate.eligible_tokens,
      },
    },
    profile: {
      profile_id: profile.profile_id,
      schema_version: profile.schema_version,
      scope: profile.scope,
      aggregation: profile.aggregation,
      rubric: profile.rubric,
    },
    specification: {
      request: annotations && typeof annotations.request === 'string' ? annotations.request : null,
      brief: annotations && typeof annotations.brief === 'string' ? annotations.brief : null,
    },
    provenance: {
      code_version: CODE_VERSION,
      registry_version: REGISTRY_VERSION,
      tokenizer_version: TOKENIZER_VERSION,
      tokenizer_method: TOKENIZER_METHOD,
      runtime: process.version,
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
            version: continuity.version,
            source_version: continuity.source_version,
            chapters: coverage.covered_chapters,
            omitted: continuity.omitted,
            coverage_note: continuity.coverage_note,
          }
        : null,
      corpus: corpus
        ? {
            schema_version: corpus.schema_version,
            comparison_scope: COMPARISON_SCOPE,
            references: lexical.references,
            exclusions: lexical.exclusions,
          }
        : null,
      files: files.map((f) => ({ path: f.path, role: f.role, sha256: f.sha256, bytes: f.bytes })),
      annotations: annotations
        ? {
            source_version: annotations.source_version ?? null,
            continuity_source_version: continuity ? continuity.source_version : null,
            declared_metrics: Object.keys(annMetrics),
            timing_declared: Boolean(annotations.timing),
          }
        : null,
    },
    evidence: evidenceList,
    segments,
    segment_order: segmentOrder(segments),
    departures,
    metrics,
    indicators,
    requirements: {
      registry_version: ruleSet.registry_version,
      aggregation_policy: ruleSet.aggregation_policy,
      rules: ruleSet.rules,
      pairs: car.pairs,
      car,
    },
    findings,
    preserved_qualities: preserved,
    execution: { errors: [] },
  };
}

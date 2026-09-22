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
import { parseSegments, segmentOrder } from './segments.mjs';
import { buildEvidenceScope, resolveSelection } from './selection.mjs';
import { buildCandidateUnits } from './candidate.mjs';
import { COMPARISON_SCOPE } from './overlap.mjs';
import { parseEvidenceList } from './evidence.mjs';
import { computeLexical, generateTopEvidence } from './lexical.mjs';
import { computeCar, parseRuleSet } from './rules.mjs';
import { buildNqs, NQS_REQUIRES, validateDependencyGraph } from './aggregate.mjs';
import { baseMetric, buildMetrics, computeCad, computeCci } from './metrics.mjs';
import { buildComponentMetric, buildEap } from './rubric.mjs';
import { buildReview } from './review.mjs';
import { buildProvenance, evaluatorLabels, readEvaluatorProvenance } from './provenance.mjs';
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

/** The refusal code for a citation that points outside the selected text. */
const EVIDENCE_SCOPE_CODE = 'EVIDENCE_OUT_OF_SCOPE';

/**
 * A citation whose passages all lie in the declared context chapters can
 * explain a selected claim but never back a judgement of the selection.
 */
const CONTEXT_ONLY_REASON =
  'every cited passage lies in the declared context chapters; context can explain a selected claim ' +
  'but never backs a judgement of the selection on its own';

/**
 * Resolve one evidence reference — a declared id or an inline evidence item —
 * to its scope. Unknown references resolve to `unknown` and are reported by the
 * existence check, not here.
 */
function evidenceScopeOf(ref, collector, scopeOf) {
  const item =
    typeof ref === 'string'
      ? collector.byId.get(ref)
      : isPlainObject(ref) && typeof ref.file === 'string'
        ? ref
        : null;
  return item ? scopeOf(item) : 'unknown';
}

/** Refuse any citation outside the selection (and outside declared context). */
function assertRefsInScope(refs, collector, scopeOf, what) {
  for (const ref of refs) {
    const scope = evidenceScopeOf(ref, collector, scopeOf);
    if (scope === 'out') {
      const id = typeof ref === 'string' ? ref : ref && ref.id;
      fail(
        `${what} cites evidence ${JSON.stringify(id)} from outside the selection; a quotation outside the ` +
          `selected text (and outside a declared context chapter) cannot support a judgement`,
        EVIDENCE_SCOPE_CODE,
      );
    }
  }
}

/** True when a non-empty evidence list cites only context chapters, never the selection. */
function contextOnlyRefs(refs, collector, scopeOf) {
  let selected = 0;
  let context = 0;
  for (const ref of refs) {
    const scope = evidenceScopeOf(ref, collector, scopeOf);
    if (scope === 'selected') selected += 1;
    else if (scope === 'context') context += 1;
  }
  return refs.length > 0 && selected === 0 && context > 0;
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
      population: null,
      reason: 'no continuity-result.v1 supplied in the annotations bundle',
    };
  }
  // The counts describe the population the reviewed ledger reached, which the producer records as
  // `chapters_reviewed` when its reviewed chapters are narrower than the packet.
  const covered = continuity.population === null ? packet.inventory : continuity.population;
  if (!sameChapterSet(covered, selection.chapters)) {
    return {
      applicable: false,
      covered_chapters: covered,
      population: continuity.population,
      reason:
        `the supplied continuity result was reviewed over chapters ${covered.join(', ') || 'none'}, which does not ` +
        `match the selection (${selection.chapters.join(', ') || 'none'}); its counts cannot be attributed to this scope`,
    };
  }
  return { applicable: true, covered_chapters: covered, population: continuity.population, reason: null };
}

/**
 * Whether a finding belongs to the counted population of the continuity ledger:
 * at least one passage it cites has to lie inside the chapters those counts
 * describe. A finding explained entirely by material outside them is reported,
 * but it is not a candidate of a rate computed over that population.
 */
function countedPopulation(finding, collector, chapterByPath, chapters) {
  if (chapters === null) return { in: true, reason: null };
  const refs = Array.isArray(finding.evidence) ? finding.evidence : [];
  const cited = [];
  for (const ref of refs) {
    const item =
      typeof ref === 'string'
        ? collector.byId.get(ref)
        : isPlainObject(ref) && typeof ref.file === 'string'
          ? ref
          : null;
    if (!item) continue;
    const chapter = chapterByPath.get(item.file);
    if (chapter !== undefined) cited.push(chapter);
  }
  if (cited.length === 0) {
    return { in: false, reason: `no cited passage lies in the counted chapters (${chapters.join(', ') || 'none'})` };
  }
  if (!cited.some((chapter) => chapters.includes(chapter))) {
    return {
      in: false,
      reason: `every cited passage lies outside the counted chapters (${chapters.join(', ') || 'none'})`,
    };
  }
  return { in: true, reason: null };
}

/**
 * The emotional fit of the book against its declared intention, as an input to NQS. It is a judgement of
 * its own: assessability, scale, evaluator, rationale, evidence and the intention it is bound to all belong
 * to the record, and a bare number is unsupported legacy data rather than an eligible value. It may be
 * assessed separately from the EAP trajectory, so an unavailable trajectory does not take it down with it.
 */
export function getEmotionalFit(annMetrics) {
  const raw = annMetrics.EAP?.emotional_fit ?? null;
  if (raw === undefined || raw === null) {
    return { value: null, reason: 'no emotional-fit judgement supplied', evidence: [] };
  }
  if (typeof raw === 'number') {
    fail(
      'emotional_fit must be an assessable judgement with its own evaluator, rationale, evidence and declared intention binding; a bare number is unsupported',
      'INVALID_ANNOTATIONS',
    );
  }
  if (!isPlainObject(raw)) fail('emotional_fit must be an object or null', 'INVALID_ANNOTATIONS');
  const status = raw.status === undefined ? 'judged' : raw.status;
  if (!['judged', 'not_assessable', 'not_applicable', 'error'].includes(status)) {
    fail(`emotional_fit has unknown status ${JSON.stringify(status)}`, 'INVALID_ANNOTATIONS');
  }
  const demote = (reason) => ({ value: null, reason, evidence: [] });
  if (status !== 'judged') return demote(`the emotional fit was not assessed (${status})`);
  if (typeof raw.fit !== 'number' || Number.isNaN(raw.fit) || raw.fit < 0 || raw.fit > 100) {
    fail(`emotional_fit.fit must be a number in 0..100, got ${JSON.stringify(raw.fit)}`, 'OUT_OF_RANGE');
  }
  // The fit cites passages by the same evidence ids the rest of the document uses; resolution against the
  // frozen text happens with every other reference at the end of the assembly.
  const rawEvidence = raw.evidence === undefined || raw.evidence === null ? [] : raw.evidence;
  if (!Array.isArray(rawEvidence) || rawEvidence.some((id) => typeof id !== 'string' || id.length === 0)) {
    fail('annotations.metrics.EAP.emotional_fit.evidence must be an array of evidence ids', 'INVALID_EVIDENCE');
  }
  const evidence = [...new Set(rawEvidence)];
  const missing = [];
  if (typeof raw.evaluator !== 'string' || raw.evaluator.length === 0) missing.push('its evaluator');
  if (typeof raw.rationale !== 'string' || raw.rationale.length === 0) missing.push('a rationale');
  if (evidence.length === 0) missing.push('at least one cited passage');
  if (typeof raw.intention_binding !== 'string' || raw.intention_binding.length === 0) missing.push('the declared intention it is bound to');
  if (missing.length > 0) {
    return demote(`the emotional fit was judged without ${missing.join(', ')}`);
  }
  return { value: raw.fit, reason: null, evidence };
}

function buildJudgedMetrics({ annMetrics, annotations, profile, metricScope, segmentIds, selectedSegmentIds, annotationsDir }) {
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
      selectedSegmentIds,
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
  resources = [],
  evaluation = {},
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
  const continuity = annotations && annotations.continuity ? normalizeContinuity(annotations.continuity, { packetVersion: packet.version }) : null;
  const segments = parseSegments(annotations ? annotations.segments : undefined, packet);
  const ruleSet = parseRuleSet(annotations ? annotations.requirements : undefined);
  const selection = resolveSelection({ packet, profile, segments });
  const metricScope = { kind: selection.kind, chapters: selection.chapters, segments: selection.segmentIds };

  // Every declared source version must be the packet's own accepted version. The continuity result
  // is bound inside normalizeContinuity, which refuses a document naming two versions; here its
  // declared scope is bound to the packet, so a population the packet does not contain is refused
  // instead of being reported as a review of this book.
  assertSourceVersion(annotations ? annotations.source_version : undefined, packet.version, 'annotations');
  for (const [id, annotation] of Object.entries(annMetrics)) {
    if (isPlainObject(annotation)) assertSourceVersion(annotation.source_version, packet.version, `annotations.metrics.${id}`);
  }
  if (continuity) {
    const declaredChapters = [...(continuity.chapters ?? []), ...(continuity.chapters_reviewed ?? []), ...continuity.omitted];
    const unknown = [...new Set(declaredChapters)].filter((chapter) => !packet.inventory.includes(chapter));
    if (unknown.length > 0) {
      fail(
        `annotations.continuity declares chapters ${unknown.join(', ')}, which the packet does not contain ` +
          `(accepted chapters: ${packet.inventory.join(', ') || 'none'}); its counts cannot be attributed to this book`,
        'UNKNOWN_CHAPTER',
      );
    }
  }

  const chapterByPath = new Map(files.filter((f) => f.role === 'chapter').map((f) => [f.path, f.chapter]));
  const candidateFiles = new Map(files.filter((f) => f.role === 'chapter').map((f) => [f.path, f]));
  const candidate = buildCandidateUnits({ packet, selection, language });
  // The candidate's source identity is declared by the packet itself, so a corpus reference can
  // only be recognised as the candidate's own copy by declaring it and matching it — never by hash.
  const candidateIdentity = {
    id: manifest.universe_id,
    version: packet.version,
    hashes: new Set(candidate.files.map((f) => f.sha256)),
  };

  const lexical = computeLexical({ candidate, corpus, candidateIdentity });

  // Evidence collection happens before any semantic judgement is consumed, so
  // a citation's scope (selected, context or out) is knowable while findings,
  // indicators and metrics are demoted or refused.
  const collector = createEvidenceCollector(files);
  collector.addAll(parseEvidenceList(annotations && annotations.evidence ? annotations.evidence : [], 'annotations.evidence'));
  const evidenceScope = buildEvidenceScope({ selection, chapterByPath });

  // Continuity-derived metrics (consumed once, and only for the selection).
  const coverage = continuityCoverage({ continuity, packet, selection });
  const annotationFindings = annotations && annotations.findings ? annotations.findings : [];
  const continuityFindings =
    continuity && coverage.applicable
      ? continuity.findings.filter((finding) =>
          withinScope(finding, chapterByPath, selection.chapters, selection.contextChapters),
        )
      : [];
  const reportFindings = [...continuityFindings, ...annotationFindings];
  for (const finding of reportFindings) {
    const refs = Array.isArray(finding.evidence) ? finding.evidence : [];
    assertRefsInScope(refs, collector, evidenceScope, `finding ${finding.id}`);
    if (finding.status === 'confirmed' && contextOnlyRefs(refs, collector, evidenceScope)) {
      finding.status = 'unresolved';
      finding.alternative_explanation = finding.alternative_explanation
        ? `${finding.alternative_explanation}; ${CONTEXT_ONLY_REASON}`
        : CONTEXT_ONLY_REASON;
    }
  }
  // CAD counts the population the continuity ledger actually attributed: a finding whose every cited
  // passage lies outside those chapters is reported, but it is not a candidate of this rate.
  const cadPopulation = coverage.applicable ? coverage.covered_chapters : null;
  const cadFindings = [];
  const cadExcluded = [];
  for (const finding of reportFindings) {
    const membership = countedPopulation(finding, collector, chapterByPath, cadPopulation);
    if (membership.in) cadFindings.push(finding);
    else cadExcluded.push({ id: finding.id, reason: membership.reason });
  }
  const cci = continuity && coverage.applicable
    ? computeCci(continuity.counts, {
        partition: continuity.partition,
        countsSource: continuity.counts_source,
        declaredCounts: continuity.declared_counts,
      })
    : null;
  const cad = coverage.applicable
    ? computeCad(cadFindings, { populationChapters: cadPopulation, excludedFindings: cadExcluded })
    : null;

  const findings = normalizeFindings(reportFindings, collector);
  // Where each finding came from: a continuity ledger entry or the annotations document. The report
  // states it so an observation can be traced to the document that made it.
  const origins = new Map([
    ...continuityFindings.map((finding) => [finding.id, 'continuity-result']),
    ...annotationFindings.map((finding) => [finding.id, 'annotations']),
  ]);
  const indicators = normalizeIndicators(annotations ? annotations.indicators : undefined);
  const departures = normalizeDepartures(annotations ? annotations.departures : undefined);
  const preserved = normalizePreserved(annotations ? annotations.preserved_qualities : undefined);

  for (const id of INDICATOR_IDS) {
    const indicator = indicators[id];
    assertRefsInScope(indicator.evidence, collector, evidenceScope, `indicators.${id}`);
    if (indicator.status === 'judged' && contextOnlyRefs(indicator.evidence, collector, evidenceScope)) {
      indicator.status = 'not_assessable';
      indicator.category = null;
      indicator.missing_reason = CONTEXT_ONLY_REASON;
    }
  }
  for (const passage of preserved.passages) {
    assertRefsInScope(passage.evidence, collector, evidenceScope, `preserved.${passage.id}`);
    if (contextOnlyRefs(passage.evidence, collector, evidenceScope)) passage.context_only = true;
  }

  // Judged metrics with discriminated outputs.
  const sceneSegments = segments.filter((segment) => segment.kind === 'scene');
  const selectedSegmentIds =
    selection.segmentIds.length > 0
      ? sceneSegments.filter((segment) => selection.segmentIds.includes(segment.id)).map((segment) => segment.id)
      : sceneSegments.filter((segment) => segment.chapter !== null && selection.chapters.includes(segment.chapter)).map((segment) => segment.id);
  const assessed = buildJudgedMetrics({
    annMetrics,
    annotations,
    profile,
    metricScope,
    segmentIds: segments.map((segment) => segment.id),
    selectedSegmentIds,
    annotationsDir,
  });
  for (const id of ['CS', 'OI', 'NCS', 'EAP']) {
    const metric = assessed[id];
    const refs = Array.isArray(metric.evidence) ? metric.evidence : [];
    assertRefsInScope(refs, collector, evidenceScope, `metrics.${id}`);
    if (metric.status === 'judged' && contextOnlyRefs(refs, collector, evidenceScope)) {
      metric.status = 'not_assessable';
      metric.value = null;
      metric.missing_reason = CONTEXT_ONLY_REASON;
      metric.detail = { ...(metric.detail ?? {}), context_only: true };
    }
  }

  // NQS from its saved components under the declared aggregation profile.
  const fit = getEmotionalFit(annMetrics);
  if (fit.value !== null) {
    assertRefsInScope(fit.evidence, collector, evidenceScope, 'metrics.EAP.emotional_fit');
    if (contextOnlyRefs(fit.evidence, collector, evidenceScope)) {
      fit.value = null;
      fit.reason = CONTEXT_ONLY_REASON;
    }
  }
  const nqsValues = {
    CS: typeof assessed.CS.value === 'number' ? assessed.CS.value : null,
    OI: typeof assessed.OI.value === 'number' ? assessed.OI.value : null,
    EMOTIONAL_FIT: fit.value,
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
    emotionalFitReason: fit.reason,
  });
  // The fit's quotations are part of the report's evidence: they must resolve like every other reference.
  nqs.evidence = [...(nqs.evidence ?? []), ...fit.evidence];

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

  // Textual coverage for a judged component metric is the fraction of selected chapters its own
  // evidence actually touches, not the fraction of dimensions supplied: one quote in chapter 1 does
  // not establish that a whole book was assessed. EAP keeps its own coverage, which is measured over
  // the segment population it declares, and records the chapter ratio beside it.
  const textCoverage = (evidenceIds) => {
    if (selection.chapters.length === 0) return null;
    const touched = new Set();
    for (const id of evidenceIds) {
      const item = collector.byId.get(id);
      if (!item) continue;
      const chapter = chapterByPath.get(item.file);
      if (chapter !== undefined && selection.chapters.includes(chapter)) touched.add(chapter);
    }
    return touched.size / selection.chapters.length;
  };
  for (const id of ['CS', 'OI', 'NCS', 'EAP']) {
    if (metrics[id].status !== 'judged') continue;
    if (id === 'EAP') {
      metrics.EAP.detail = { ...(metrics.EAP.detail ?? {}), evidence_coverage: textCoverage(metrics.EAP.evidence) };
      continue;
    }
    metrics[id].coverage = textCoverage(metrics[id].evidence);
  }

  const evidenceList = [...collector.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selectedWithEvidence = chaptersWithEvidence(evidenceList, chapterByPath, selection.chapters);
  const assessmentId = computeAssessmentId({ manifest, packet, profileRaw, annotationsRaw, corpusRaw });

  // The published coverage record: built once, because the review summary leads with the same numbers
  // the bundle publishes instead of restating them.
  const coverageRecord = {
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
      population: coverage.population,
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
  };

  // What the judgements were bound to, as the record declared it, so every observation can be read
  // against the book's stated intention rather than against an implicit standard.
  const declaredIntentions = [];
  const emotionalFit = annMetrics.EAP && isPlainObject(annMetrics.EAP.emotional_fit) ? annMetrics.EAP.emotional_fit : null;
  if (emotionalFit && typeof emotionalFit.intention_binding === 'string' && emotionalFit.intention_binding.length > 0) {
    declaredIntentions.push({ source: 'annotations.metrics.EAP.emotional_fit.intention_binding', statement: emotionalFit.intention_binding });
  }
  if (profile.aggregation && profile.aggregation.emotional_fit && typeof profile.aggregation.emotional_fit.intent === 'string') {
    declaredIntentions.push({ source: 'profile.aggregation.emotional_fit.intent', statement: profile.aggregation.emotional_fit.intent });
  }
  for (const indicator of Object.values(indicators)) {
    if (typeof indicator.intended_effect_fit === 'string' && indicator.intended_effect_fit.length > 0) {
      declaredIntentions.push({ source: `indicators.${indicator.id}.intended_effect_fit`, statement: indicator.intended_effect_fit });
    }
  }

  const review = buildReview({
    metrics,
    indicators,
    findings,
    origins,
    preserved,
    departures,
    specification: {
      request: annotations && typeof annotations.request === 'string' ? annotations.request : null,
      brief: annotations && typeof annotations.brief === 'string' ? annotations.brief : null,
    },
    declaredIntentions,
    selection,
    coverage: coverageRecord,
    collector,
    chapterByPath,
    cadDetail: cad ? cad.detail : null,
    continuityPartition: continuity ? continuity.partition : null,
  });

  // Who authored the judgements this bundle publishes, and what the evaluator declared about its own run.
  const evaluatorProvenance = readEvaluatorProvenance(annotations, fail);
  const evaluators = evaluatorLabels(metrics, indicators);

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
    coverage: coverageRecord,
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
    provenance: buildProvenance({
      codeVersion: CODE_VERSION,
      registryVersion: REGISTRY_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
      tokenizerMethod: TOKENIZER_METHOD,
      manifest,
      packet,
      selection,
      coverage,
      continuity,
      corpus,
      comparisonScope: COMPARISON_SCOPE,
      corpusReferences: lexical.references,
      corpusExclusions: lexical.exclusions,
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
      runtime: process.version,
    }),
    evidence: evidenceList,
    review,
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

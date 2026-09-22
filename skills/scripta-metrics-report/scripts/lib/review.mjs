/**
 * The review summary: what an author needs before any number.
 *
 * A metrics report is read in the first ten seconds or not at all. This module
 * assembles the leading section of every published view from the records the
 * bundle already holds — never by judging anything itself:
 *
 *   - what was assessed, and what could not be assessed and why;
 *   - the intention the selection is read against, as the record declared it;
 *   - the strengths the record observed, with their passages;
 *   - the most consequential supported problems, each with the exact passages it
 *     rests on, the alternative reading that was preserved and the bounded
 *     revision options the record proposed;
 *   - the honest meaning of an empty findings list, which is never a clean bill
 *     of literary health: `not_evaluated`, `insufficient_evidence` and
 *     `no_supported_issue_found` are three different results.
 */

export const READING_STATUSES = [
  'not_evaluated',
  'insufficient_evidence',
  'no_supported_issue_found',
  'problems_recorded',
];

const SEVERITY_ORDER = { major: 0, local: 1, editorial: 2 };

/** The statuses that carry a value: every other result is an unavailability with a reason. */
const VALUE_STATUSES = ['computed', 'judged'];

/** The chapters a finding's cited passages lie in, in order. */
function evidenceChapters(finding, collector, chapterByPath) {
  const chapters = [];
  for (const id of finding.evidence ?? []) {
    const item = collector.byId.get(id);
    if (!item) continue;
    const chapter = chapterByPath.get(item.file);
    if (chapter !== undefined && !chapters.includes(chapter)) chapters.push(chapter);
  }
  return chapters.sort((a, b) => a - b);
}

/**
 * One problem as an author reads it: the statement, the passages it rests on, the
 * reading that was preserved, and what could be revised without losing the
 * passages the same record judged worth keeping.
 */
function problemRecord({ finding, origin, collector, chapterByPath, preserved, scopeKind, intentionStatement }) {
  const chapters = evidenceChapters(finding, collector, chapterByPath);
  const where =
    chapters.length > 0
      ? `chapter${chapters.length === 1 ? '' : 's'} ${chapters.join(', ')}`
      : 'the selection';
  const preservedInScope = preserved.passages
    .filter((passage) =>
      passage.evidence.some((id) => {
        const item = collector.byId.get(id);
        const chapter = item ? chapterByPath.get(item.file) : undefined;
        return chapter !== undefined && chapters.includes(chapter);
      }),
    )
    .map((passage) => passage.id);
  const options = finding.repair_suggestion
    ? [
        {
          statement: finding.repair_suggestion,
          from: `${origin}.repair_suggestion`,
          alternative_reading: finding.alternative_explanation,
          passages: finding.evidence,
          preserved_in_the_same_scope: preservedInScope,
        },
      ]
    : [];
  return {
    id: finding.id,
    origin,
    kind: finding.kind,
    severity: finding.severity,
    certainty: finding.certainty,
    status: finding.status,
    supported: finding.status === 'confirmed',
    contested: finding.status === 'unresolved',
    statement: finding.description,
    passages: finding.evidence,
    chapters,
    relates_to: `the cited passages lie in ${where} of the ${scopeKind} selection`,
    intention_link: intentionStatement,
    alternative_reading: finding.alternative_explanation,
    revision_options: options,
    revision_note:
      options.length > 0
        ? null
        : 'the record proposed no repair for this problem; the passages above are what a revision has to account for',
  };
}

/**
 * Build the leading section of the review.
 *
 * `metrics` are the assembled metric objects, `indicators` the eight literary
 * indicators, `origins` maps a finding id to the document that produced it,
 * `selection`/`coverage` describe the scope the run actually reached, and
 * `declaredIntentions` collects the intentions the judgements were bound to.
 */
export function buildReview({
  metrics,
  indicators,
  findings,
  origins,
  preserved,
  departures,
  specification,
  declaredIntentions,
  selection,
  coverage,
  collector,
  chapterByPath,
  cadDetail = null,
  continuityPartition = null,
}) {
  const evaluated = [];
  const unavailable = [];
  for (const metric of Object.values(metrics)) {
    if (VALUE_STATUSES.includes(metric.status)) evaluated.push(metric);
    else unavailable.push({ id: metric.id, status: metric.status, reason: metric.missing_reason });
  }
  const judgedIndicators = Object.values(indicators).filter((indicator) => indicator.status === 'judged');
  // A selection counts as evaluated when a judgement about it exists: a judged metric or a judged
  // indicator. Deterministic measures alone are measurements of the text, not a reading of it.
  const judgments = [
    ...Object.values(metrics).filter((metric) => metric.status === 'judged').map((metric) => metric.id),
    ...judgedIndicators.map((indicator) => indicator.id),
  ];

  const intention = [
    ...(declaredIntentions ?? []),
    ...(specification.request ? [{ source: 'annotations.request', statement: specification.request }] : []),
    ...(specification.brief ? [{ source: 'annotations.brief', statement: specification.brief }] : []),
  ];
  const intentionStatement =
    intention.length > 0
      ? `read against the declared intention: ${intention.map((entry) => entry.statement).join('; ')}`
      : 'no intention was declared with the judgements, so the observations stand alone';

  const problems = findings
    .map((finding) =>
      problemRecord({
        finding,
        origin: origins.get(finding.id) ?? 'annotations',
        collector,
        chapterByPath,
        preserved,
        scopeKind: selection.kind,
        intentionStatement,
      }),
    )
    .sort((a, b) => {
      if (a.supported !== b.supported) return a.supported ? -1 : 1;
      const severity = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
      if (severity !== 0) return severity;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const strengths = preserved.passages.map((passage) => ({
    id: passage.id,
    source: 'preserved_qualities',
    statement: passage.rationale,
    passages: passage.evidence,
    relates_to: intentionStatement,
  }));

  // An empty findings list means something different when nothing was read, when
  // only part of the selection was read, and when all of it was read without a
  // supported problem. Coverage is what separates the three.
  const segmentCoverage = metrics.EAP ? metrics.EAP.coverage : null;
  const evidenceCoverage = coverage.evidence.ratio;
  const partial =
    selection.omitted.length > 0
    || (segmentCoverage !== null && segmentCoverage < 1)
    || (evidenceCoverage !== null && evidenceCoverage < 1)
    || coverage.continuity.applicable === false;

  let readingStatus;
  let statement;
  if (judgments.length === 0 && problems.length === 0) {
    readingStatus = 'not_evaluated';
    statement =
      'nothing in this selection was judged: no metric or indicator produced a judgement, so an empty findings list ' +
      'here means the text was not read, not that it is sound';
  } else if (problems.length > 0) {
    readingStatus = 'problems_recorded';
    const supported = problems.filter((problem) => problem.supported).length;
    statement =
      `${supported} supported problem${supported === 1 ? '' : 's'} rest${supported === 1 ? 's' : ''} on cited ` +
      `passages, and ${problems.length - supported} further observation${problems.length - supported === 1 ? '' : 's'} ` +
      'remained contested or were dismissed';
  } else if (partial) {
    readingStatus = 'insufficient_evidence';
    statement =
      'no supported problem was found in the part of the selection that was read, and part of it was not read; this ' +
      'is insufficient evidence for a clean verdict, not a clean bill';
  } else {
    readingStatus = 'no_supported_issue_found';
    statement =
      'no supported problem was recorded in the assessed selection and every assessed part reached an outcome; that ' +
      'is the absence of a supported issue in what was measured, not a statement of literary quality';
  }

  return {
    reading_status: readingStatus,
    statement,
    scope: {
      kind: selection.kind,
      chapters: selection.chapters,
      segments: selection.segmentIds,
      context_chapters: selection.contextChapters,
      omitted_chapters: selection.omitted,
    },
    intention: { declared: intention, statement: intentionStatement },
    assessment: {
      evaluated: evaluated.map((metric) => ({ id: metric.id, status: metric.status, coverage: metric.coverage })),
      judged: judgments,
      unavailable,
      judged_indicators: judgedIndicators.map((indicator) => indicator.id),
      measures: {
        evidence_coverage: evidenceCoverage,
        segment_coverage: segmentCoverage,
        eligible_tokens: coverage.tokenizer.eligible_tokens,
        continuity_applicable: coverage.continuity.applicable,
        continuity_reason: coverage.continuity.reason,
        continuity_partition: continuityPartition,
        cad_population_chapters: cadDetail ? cadDetail.population_chapters : null,
      },
    },
    strengths,
    strengths_note:
      strengths.length > 0
        ? null
        : 'nothing was recorded as worth preserving; that is a gap in the record, not a statement that the text has no merit',
    departures: departures.map((departure) => ({
      id: departure.id,
      status: departure.status,
      statement: departure.description,
      passages: departure.evidence,
    })),
    problems,
    problems_note:
      problems.length > 0
        ? null
        : 'no finding was recorded; read this together with the reading status above before treating it as a clean report',
  };
}

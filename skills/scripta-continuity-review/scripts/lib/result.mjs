// continuity-result.v1 envelope assembly (no external dependencies).
//
// The envelope is the review's whole answer: the accepted version it was bound
// to, the scope it covered, the comparison ledger, the counts derived from that
// ledger, the findings and the published paths. Nothing here invents a result;
// a missing measurement is reported as unavailable rather than as a clean one.

const RESULT_SCHEMA_VERSION = 'continuity-result.v1';
export const RESULT_FILE = 'continuity-result.json';

// The envelope used when the input is refused: findings and counts stay empty,
// because nothing was reviewed.
export function rejectionEnvelope(errors) {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    ok: false,
    version: null,
    scope: {
      universe_id: null,
      kind: null,
      chapters: [],
      omitted: [],
      chapters_reviewed: [],
      coverage_note: 'input rejected before review',
      coverage: null,
      coverage_bounds: null,
    },
    reviewed_claims: [],
    comparisons: [],
    counts: { eligible_comparisons: 0, consistent: 0, contradicted: 0, unresolved: 0 },
    derived: { cci: null, cad: null },
    findings: [],
    errors: [...errors],
    warnings: [],
    outputs: [],
  };
}

export function buildResult({
  packet,
  chaptersReviewed,
  coverageNote,
  ledger,
  findings,
  warnings = [],
  outputs = [],
  errors = [],
}) {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    ok: errors.length === 0,
    version: packet.version,
    scope: {
      universe_id: packet.universeId,
      kind: packet.scope.kind,
      chapters: packet.chapterNumbers,
      omitted: packet.omitted,
      chapters_reviewed: chaptersReviewed,
      coverage_note: coverageNote,
      coverage: ledger.coverage,
      coverage_bounds: ledger.coverageBounds,
    },
    reviewed_claims: ledger.reviewedClaims,
    comparisons: ledger.comparisons,
    counts: ledger.counts,
    derived: ledger.derived,
    findings,
    errors,
    warnings,
    outputs,
  };
}

// The claim's own record stays visible in the finding: kind, severity,
// certainty, status, rationale, evaluator, method, category and the paired
// baseline/later reading are all the annotator's, never re-judged here.
export function findingFromClaim(claim, comparisonId) {
  const finding = {
    id: claim.id,
    kind: claim.kind,
    category: claim.category,
    severity: claim.severity,
    certainty: claim.certainty,
    status: claim.status,
    declared_status: claim.declared_status,
    downgraded_to_unresolved: claim.downgraded,
    description: claim.description,
    rationale: claim.rationale,
    evaluator: claim.evaluator,
    method: claim.method,
    subject: claim.subject,
    scope: claim.scope,
    source_version: claim.source_version,
    comparison_id: comparisonId,
    evidence: claim.evidence,
    alternative_explanation: claim.alternative_explanation,
    repair_suggestion: claim.repair_suggestion,
    limitations: claim.limitations,
    confidence: claim.confidence,
  };
  if (claim.attribute !== null) finding.attribute = claim.attribute;
  if (claim.catalyst !== null) finding.catalyst = claim.catalyst;
  return finding;
}

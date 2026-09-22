// annotations.v1 semantic claims (no external dependencies).
//
// A semantic claim is an evidence-bearing record, not an opinion with a label:
// it must name a stable id, the accepted version it was written against, the
// scope it reviewed, its evaluator and method, a declared status, a category
// from the declared set, a severity, a certainty, a rationale and the evidence
// it rests on. A resolved verdict — a confirmed contradiction, or a change the
// annotator declares supported — must additionally carry paired baseline/later
// evidence with the temporal scope between them; without that pairing the claim
// is preserved as declared but demoted to unresolved, so it can inflate neither
// the contradicted nor the consistent count.
//
// Anything malformed refuses the whole file with a coded error list, because a
// judgement resting on bytes that are not in the frozen packet cannot be
// reviewed by anyone downstream.

import { isPlainObject } from './json-spans.mjs';
import { verifyEvidenceItem } from './evidence.mjs';

// Thrown when the annotations file cannot be trusted as input.
export class AnnotationError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(list.join('; '));
    this.name = 'AnnotationError';
    this.errors = list;
  }
}

// Every refusal names its code first, so a host can act on it, and keeps the
// human message next to it.
export function addError(errors, message, code = 'INVALID_ANNOTATIONS') {
  errors.push(`${code}: ${message}`);
}

const CLAIM_KINDS = new Set(['contradiction', 'unsupported_change', 'editorial']);
const CLAIM_STATUSES = new Set(['confirmed', 'unresolved', 'dismissed']);
const CLAIM_SEVERITIES = new Set(['major', 'local', 'editorial']);
const CLAIM_CERTAINTIES = new Set(['deterministic', 'tentative']);
const CLAIM_CATEGORIES = new Set([
  'fact',
  'chronology',
  'character_knowledge',
  'character_attribute',
  'permanent_rule',
  'social_rule',
  'plan',
]);
const CLAIM_SCOPE_KINDS = new Set(['chapter', 'scene', 'arc', 'book']);
export const ELIGIBLE_KINDS = new Set(['contradiction', 'unsupported_change']);

// The fields every semantic claim must carry, in the order a reader meets them.
const REQUIRED_CLAIM_FIELDS = [
  'id',
  'source_version',
  'scope',
  'evaluator',
  'method',
  'kind',
  'category',
  'severity',
  'certainty',
  'status',
  'rationale',
  'evidence',
];


function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function findNonFiniteNumber(value, path) {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path.join('.');
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findNonFiniteNumber(value[index], [...path, String(index)]);
      if (found !== null) return found;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const found = findNonFiniteNumber(child, [...path, key]);
      if (found !== null) return found;
    }
  }
  return null;
}

function looksLikeEvidence(value) {
  return isPlainObject(value) && typeof value.file === 'string' && 'start' in value;
}

function collectEvidence(raw, label, options) {
  const { packet, errors, seenIds } = options;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    addError(errors, `${label} must be an array of evidence items`);
    return null;
  }
  const items = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!isPlainObject(item)) {
      addError(errors, `${label}[${index}] must be an evidence item object`);
      continue;
    }
    if (isNonEmptyString(item.id)) {
      if (seenIds.has(item.id)) {
        addError(errors, `${label} repeats the evidence id ${JSON.stringify(item.id)}`, 'DUPLICATE_ID');
      }
      seenIds.add(item.id);
    }
    const result = verifyEvidenceItem(item, packet.files);
    if (!result.ok) {
      addError(errors, `${label}[${index}] (${String(item.id)}) is invalid: ${result.error}`, 'INVALID_EVIDENCE');
      continue;
    }
    items.push(item);
  }
  return items;
}

// A paired baseline/later record: either an object with a chapter and evidence,
// or a bare evidence item. Returns { chapter, evidence } or null.
function normalizePaired(raw, label, options) {
  const { errors } = options;
  if (raw === undefined || raw === null) return null;
  if (looksLikeEvidence(raw)) {
    const items = collectEvidence([raw], label, options);
    if (items === null || items.length === 0) return null;
    return { chapter: null, evidence: items };
  }
  if (Array.isArray(raw)) {
    const evidence = [];
    let chapter = null;
    for (let index = 0; index < raw.length; index += 1) {
      const element = raw[index];
      if (looksLikeEvidence(element)) {
        const items = collectEvidence([element], `${label}[${index}]`, options);
        if (items) evidence.push(...items);
        continue;
      }
      if (isPlainObject(element) && Array.isArray(element.evidence)) {
        const items = collectEvidence(element.evidence, `${label}[${index}].evidence`, options);
        if (items) evidence.push(...items);
        if (element.chapter !== undefined) {
          if (!Number.isInteger(element.chapter) || element.chapter < 1) {
            addError(errors, `${label}[${index}].chapter must be a positive integer chapter number`);
          } else {
            chapter = element.chapter;
          }
        }
        continue;
      }
      addError(errors, `${label}[${index}] must be an evidence item or an object with an "evidence" array`);
    }
    return { chapter, evidence };
  }
  if (isPlainObject(raw) && Array.isArray(raw.evidence)) {
    const items = collectEvidence(raw.evidence, `${label}.evidence`, options);
    let chapter = null;
    if (raw.chapter !== undefined) {
      if (!Number.isInteger(raw.chapter) || raw.chapter < 1) {
        addError(errors, `${label}.chapter must be a positive integer chapter number`);
      } else {
        chapter = raw.chapter;
      }
    }
    return { chapter, evidence: items ?? [] };
  }
  addError(errors, `${label} must be an evidence item, an array of them, or an object with an "evidence" array`);
  return null;
}

// Temporal context of a comparison. Absent context downgrades a confirmed claim
// to unresolved; a malformed one is invalid input.
function normalizeTemporalScope(raw, label, errors) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    addError(errors, `${label} must be an object`);
    return null;
  }
  const chapterKeys = ['baseline_chapter', 'later_chapter', 'from_chapter', 'to_chapter'];
  let baseline = null;
  let later = null;
  for (const key of chapterKeys) {
    if (raw[key] === undefined) continue;
    if (!Number.isInteger(raw[key]) || raw[key] < 1) {
      addError(errors, `${label}.${key} must be a positive integer chapter number`);
      continue;
    }
    if (key === 'baseline_chapter' || key === 'from_chapter') baseline = raw[key];
    else later = raw[key];
  }
  return { baseline_chapter: baseline, later_chapter: later, declared: raw };
}

// A claim names the scope it reviewed, and that scope is bound to the packet: a
// judgement about a chapter that is not part of the accepted book cannot be a
// reading of this version, while a chapter this packet declares omitted is a
// limitation to disclose rather than a reason to refuse.
function validateScope(raw, label, options) {
  const { errors, warnings, packet } = options;
  if (!isPlainObject(raw)) {
    addError(errors, `${label} must be an object with a scope kind`);
    return null;
  }
  if (!CLAIM_SCOPE_KINDS.has(raw.kind)) {
    addError(errors, 
      `${label}.kind must be one of ${[...CLAIM_SCOPE_KINDS].join('|')}, got ${JSON.stringify(raw.kind)}`,
    );
  }
  if (!Array.isArray(raw.chapters) || raw.chapters.length === 0) {
    addError(errors, `${label}.chapters must be a non-empty array of chapter numbers`);
    return raw;
  }
  const omitted = new Set(packet.omitted);
  for (const number of raw.chapters) {
    if (!Number.isInteger(number) || number < 1) {
      addError(
        errors,
        `${label}.chapters must contain positive integer chapter numbers, got ${JSON.stringify(number)}`,
      );
      continue;
    }
    if (number > packet.lastAcceptedChapter) {
      addError(
        errors,
        `${label}.chapters names chapter ${number}, which is not part of the accepted book ` +
          `(1..${packet.lastAcceptedChapter})`,
      );
      continue;
    }
    if (omitted.has(number)) {
      warnings.push(
        `${label}.chapters names chapter ${number}, which this packet declares omitted: the reading is reported ` +
          'with that limitation and is not a whole-book result',
      );
    }
  }
  return raw;
}

// Validate one semantic claim. Returns a normalized claim or null (with errors).
export function validateClaim(raw, index, options) {
  const { errors, warnings, packet } = options;
  const label = `annotations.findings[${index}]`;
  if (!isPlainObject(raw)) {
    addError(errors, `${label} must be a semantic claim object`);
    return null;
  }
  // Errors are accumulated globally so the refusal lists every problem, but a
  // claim is dropped only when it is itself the offender.
  const errorMark = errors.length;
  for (const field of REQUIRED_CLAIM_FIELDS) {
    if (raw[field] === undefined) addError(errors, `${label}.${field} is required on every semantic claim`);
  }

  const nonFinite = findNonFiniteNumber(raw, [label]);
  if (nonFinite !== null) addError(errors, `${nonFinite} must be a finite number`);

  const id = raw.id;
  if (!isNonEmptyString(id)) addError(errors, `${label}.id must be a non-empty string`);

  if (raw.source_version !== packet.version) {
    addError(errors, 
      `${label}.source_version must equal the packet version ${packet.version}, got ` +
        `${JSON.stringify(raw.source_version)}`,
    );
  }

  const scope = validateScope(raw.scope, `${label}.scope`, { errors, warnings, packet });

  if (!isNonEmptyString(raw.evaluator)) addError(errors, `${label}.evaluator must be a non-empty string`);
  if (!isNonEmptyString(raw.method)) addError(errors, `${label}.method must be a non-empty string`);

  const kind = raw.kind;
  if (!CLAIM_KINDS.has(kind)) {
    addError(errors, `${label}.kind must be one of ${[...CLAIM_KINDS].join('|')}, got ${JSON.stringify(kind)}`);
  }
  const status = raw.status;
  if (!CLAIM_STATUSES.has(status)) {
    addError(errors, `${label}.status must be one of ${[...CLAIM_STATUSES].join('|')}, got ${JSON.stringify(status)}`);
  }
  if (!CLAIM_SEVERITIES.has(raw.severity)) {
    addError(errors, `${label}.severity must be one of ${[...CLAIM_SEVERITIES].join('|')}, got ${JSON.stringify(raw.severity)}`);
  }
  if (!CLAIM_CERTAINTIES.has(raw.certainty)) {
    addError(errors, 
      `${label}.certainty must be one of ${[...CLAIM_CERTAINTIES].join('|')}, got ${JSON.stringify(raw.certainty)}`,
    );
  }

  const eligible = ELIGIBLE_KINDS.has(kind);
  if (eligible) {
    if (!CLAIM_CATEGORIES.has(raw.category)) {
      addError(errors, 
        `${label}.category must be one of ${[...CLAIM_CATEGORIES].join('|')}, got ${JSON.stringify(raw.category)}`,
      );
    }
  } else if (raw.category !== undefined && !CLAIM_CATEGORIES.has(raw.category)) {
    addError(errors, `${label}.category must be one of ${[...CLAIM_CATEGORIES].join('|')}, got ${JSON.stringify(raw.category)}`);
  }

  if (!isNonEmptyString(raw.rationale)) addError(errors, `${label}.rationale must be a non-empty string`);

  if (eligible && !('alternative_explanation' in raw)) {
    addError(errors, `${label}.alternative_explanation is required for a ${kind}: state it or declare it null`);
  } else if (raw.alternative_explanation !== undefined && raw.alternative_explanation !== null && !isNonEmptyString(raw.alternative_explanation)) {
    addError(errors, `${label}.alternative_explanation must be null or a non-empty string`);
  }

  if (raw.confidence !== undefined && raw.confidence !== null) {
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) {
      addError(errors, `${label}.confidence must be a finite number`);
    } else if (raw.confidence < 0 || raw.confidence > 1) {
      addError(errors, `${label}.confidence must lie in [0, 1]`);
    }
  }

  const claimEvidenceIds = new Set();
  const evidence = collectEvidence(raw.evidence, `${label}.evidence`, {
    packet,
    errors,
    seenIds: claimEvidenceIds,
  });

  if (status === 'unresolved' && !isNonEmptyString(raw.limitations)) {
    addError(errors, `${label}.limitations must state the limitation of an unresolved reading`);
  } else if (raw.limitations !== undefined && !isNonEmptyString(raw.limitations)) {
    addError(errors, `${label}.limitations must be a non-empty string when present`);
  }

  const pairedIds = new Set();
  const baseline = normalizePaired(raw.baseline, `${label}.baseline`, {
    packet,
    errors,
    seenIds: pairedIds,
  });
  const later = normalizePaired(raw.later, `${label}.later`, {
    packet,
    errors,
    seenIds: pairedIds,
  });
  const temporalScope = normalizeTemporalScope(raw.temporal_scope, `${label}.temporal_scope`, errors);

  if (raw.category === 'character_attribute') {
    if (!isNonEmptyString(raw.attribute)) {
      addError(errors, `${label}.attribute is required for a character_attribute claim`);
    }
    // A character change names the attribute that changed and the catalyst the
    // text supplies for it; `null` is the explicit statement that the accepted
    // material supplies none, which is itself a reviewable judgement.
    if (!('catalyst' in raw)) {
      addError(errors, `${label}.catalyst is required for a character_attribute claim: name it or declare it null`);
    }
  }
  if (raw.catalyst !== undefined && raw.catalyst !== null && !isNonEmptyString(raw.catalyst)) {
    addError(errors, `${label}.catalyst must be null or a non-empty string`);
  }

  if (errors.length > errorMark) return null;

  const evidenceItems = evidence ?? [];
  if (eligible && status === 'confirmed' && evidenceItems.length === 0) {
    addError(errors, 
      `${label}.evidence must not be empty on a confirmed ${kind}: without support the claim cannot be confirmed`,
    );
    return null;
  }

  // A resolved verdict — a confirmed contradiction, or a change the annotator
  // declares supported — must rest on a baseline reading and a later reading of
  // the same subject together with the temporal scope between them. Without that
  // pairing the verdict is preserved as declared but demoted to unresolved, so
  // it can inflate neither the contradicted nor the consistent count.
  let effectiveStatus = status;
  let downgraded = false;
  if (eligible && status !== 'unresolved') {
    const paired =
      baseline !== null &&
      baseline.evidence.length > 0 &&
      later !== null &&
      later.evidence.length > 0 &&
      temporalScope !== null &&
      temporalScope.baseline_chapter !== null &&
      temporalScope.later_chapter !== null;
    if (!paired) {
      effectiveStatus = 'unresolved';
      downgraded = true;
      warnings.push(
        `annotation claim ${JSON.stringify(id)} is declared ${status} but lacks paired baseline/later evidence ` +
          'with a temporal scope; it is reported as unresolved and excluded from the resolved counts',
      );
    }
  }

  // Symptoms of one underlying defect are grouped only when the annotator links
  // them explicitly with a shared `comparison`; a shared subject is not proof
  // that two findings are the same defect, and merging distinct defects would
  // hide them.
  const comparisonId = isNonEmptyString(raw.comparison) ? raw.comparison : String(id);

  return {
    id: String(id),
    kind: eligible ? kind : 'editorial',
    category: isNonEmptyString(raw.category) ? raw.category : null,
    status: effectiveStatus,
    declared_status: status,
    downgraded,
    severity: raw.severity,
    certainty: raw.certainty,
    description: isNonEmptyString(raw.description) ? raw.description : String(raw.rationale),
    rationale: String(raw.rationale),
    evaluator: String(raw.evaluator),
    method: String(raw.method),
    scope,
    source_version: String(raw.source_version),
    evidence: evidenceItems,
    baseline,
    later,
    temporal_scope: temporalScope,
    alternative_explanation: raw.alternative_explanation ?? null,
    repair_suggestion: isNonEmptyString(raw.repair_suggestion) ? raw.repair_suggestion : null,
    limitations: isNonEmptyString(raw.limitations) ? raw.limitations : null,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
    comparison_id: comparisonId,
    subject: isNonEmptyString(raw.subject) ? raw.subject : comparisonId,
    attribute: isNonEmptyString(raw.attribute) ? raw.attribute : null,
    catalyst: isNonEmptyString(raw.catalyst) ? raw.catalyst : null,
  };
}

// Validate an embedded continuity-result.v1: it must describe this same packet,
// or it is a historical or failed result rather than an input to this review.

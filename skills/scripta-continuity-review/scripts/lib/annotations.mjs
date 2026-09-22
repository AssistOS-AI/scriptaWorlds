// annotations.v1 file envelope: the counts reconciliation and the embedded
// previous result (no external dependencies).
//
// The file names its schema, an optional `counts` object and an optional
// embedded `continuity` result. Nothing here is trusted: a supplied total is
// checked for its own consistency and then reconciled with the ledger this run
// derives, and an embedded result is accepted only when it describes this same
// accepted version and scope. Unrecognized keys are ignored.

import { isPlainObject } from './json-spans.mjs';
import { AnnotationError, addError, validateClaim } from './claims.mjs';

const ANNOTATIONS_SCHEMA = 'annotations.v1';
const CONTINUITY_SCHEMA = 'continuity-result.v1';

export const COUNT_KEYS = ['eligible_comparisons', 'consistent', 'contradicted', 'unresolved'];

function validateCounts(raw, label, errors) {
  if (!isPlainObject(raw)) {
    addError(errors, `${label} must be an object with ${COUNT_KEYS.join(', ')}`);
    return null;
  }
  const counts = {};
  for (const key of COUNT_KEYS) {
    const value = raw[key];
    if (!Number.isInteger(value) || value < 0) {
      addError(errors, `${label}.${key} must be a non-negative integer`);
      return null;
    }
    counts[key] = value;
  }
  const { eligible_comparisons: eligible } = counts;
  for (const key of COUNT_KEYS) {
    if (counts[key] > eligible) {
      addError(errors, `${label}.${key} (${counts[key]}) exceeds ${label}.eligible_comparisons (${eligible})`);
    }
  }
  const total = counts.consistent + counts.contradicted + counts.unresolved;
  if (total > eligible) {
    addError(errors, 
      `${label} declares more outcomes (${total}) than eligible comparisons (${eligible})`,
    );
  }
  return errors.length > 0 ? null : counts;
}

// Verify every item of a list of evidence items against the frozen packet. An
// item whose hash, offsets or quoted bytes do not exist in the frozen packet is
// a fabricated or stale quotation: the file is refused rather than reported,
// because nothing downstream could tell which part of the judgement rested on

function validateEmbedded(raw, options) {
  const { errors, packet, declaredTotals } = options;
  if (raw === undefined || raw === null) return;
  if (!isPlainObject(raw)) {
    addError(errors, 'annotations.continuity must be an object');
    return;
  }
  if (raw.schema_version !== CONTINUITY_SCHEMA) {
    addError(errors, 
      `annotations.continuity.schema_version must be ${JSON.stringify(CONTINUITY_SCHEMA)}, got ` +
        `${JSON.stringify(raw.schema_version)}`,
    );
    return;
  }
  if (raw.ok === false) {
    addError(errors, 'annotations.continuity reports ok:false and cannot be used as an input to this review');
  }
  if (raw.version !== packet.version) {
    addError(errors, 
      `annotations.continuity.version must be the packet version ${packet.version}, got ` +
        `${JSON.stringify(raw.version)}; a result bound to another version is historical, not current`,
    );
  }
  const scope = isPlainObject(raw.scope) ? raw.scope : null;
  if (scope === null) {
    addError(errors, 'annotations.continuity.scope must be an object');
  } else {
    if (scope.universe_id !== packet.universeId) {
      addError(errors, 
        `annotations.continuity.scope.universe_id must be ${JSON.stringify(packet.universeId)}, got ` +
          `${JSON.stringify(scope.universe_id)}`,
      );
    }
    const covered = Array.isArray(scope.chapters)
      ? scope.chapters
      : Array.isArray(scope.chapters_reviewed)
        ? scope.chapters_reviewed
        : null;
    if (covered === null) {
      addError(errors, 'annotations.continuity.scope must name the chapters it covered');
    } else {
      const present = new Set(packet.chapterNumbers);
      const unknown = covered.filter((number) => !present.has(number));
      if (unknown.length > 0) {
        addError(errors, 
          `annotations.continuity.scope covers chapters the packet does not contain: ${unknown.join(', ')}`,
        );
      }
    }
  }
  if (raw.counts !== undefined) {
    const counts = validateCounts(raw.counts, 'annotations.continuity.counts', errors);
    if (counts !== null) declaredTotals.push({ source: 'annotations.continuity.counts', counts });
  }
}

// Parse and validate an annotations.v1 file. Throws AnnotationError when the
// file cannot be trusted as input: a missing or malformed field, an unknown
// enumeration value and an evidence item that does not exist in the frozen
// packet all refuse the whole file, so a judgement resting on absent bytes can
// never be reported as a reviewed comparison. Unrecognized keys are ignored.
export function parseAnnotations(rawText, packet) {
  let document;
  try {
    document = JSON.parse(rawText);
  } catch (cause) {
    throw new AnnotationError([`BAD_JSON: annotations file is not valid JSON: ${cause.message}`]);
  }
  if (!isPlainObject(document)) {
    throw new AnnotationError(['INVALID_ANNOTATIONS: annotations file must be a JSON object']);
  }
  if (document.schema_version !== ANNOTATIONS_SCHEMA) {
    throw new AnnotationError([
      `SCHEMA_VERSION: unsupported annotations schema_version: ${String(document.schema_version)} ` +
        `(expected ${ANNOTATIONS_SCHEMA})`,
    ]);
  }

  const errors = [];
  const warnings = [];
  const declaredTotals = [];

  const rawClaims = document.findings === undefined ? [] : document.findings;
  if (!Array.isArray(rawClaims)) addError(errors, 'annotations.findings must be an array of semantic claims');

  const claims = [];
  const seenClaimIds = new Set();
  if (Array.isArray(rawClaims)) {
    for (let index = 0; index < rawClaims.length; index += 1) {
      const claim = validateClaim(rawClaims[index], index, { errors, warnings, packet });
      if (claim === null) continue;
      if (seenClaimIds.has(claim.id)) {
        addError(errors, `annotations.findings repeats the claim id ${JSON.stringify(claim.id)}`, 'DUPLICATE_ID');
        continue;
      }
      seenClaimIds.add(claim.id);
      claims.push(claim);
    }
  }

  if (document.counts !== undefined) {
    const counts = validateCounts(document.counts, 'annotations.counts', errors);
    if (counts !== null) declaredTotals.push({ source: 'annotations.counts', counts });
  }
  validateEmbedded(document.continuity, { errors, packet, declaredTotals });

  if (errors.length > 0) throw new AnnotationError(errors);

  return { claims, warnings, declaredTotals };
}

/**
 * Deterministic lexical overlap measures.
 *
 * SI  = Jaccard of distinct `SHINGLE_SIZE`-token shingles per eligible pair
 *       (0..1); the reported value is the maximum over the named corpus and the
 *       pair that produced it is always named.
 * TOP = union of every exact matching run of at least `MIN_RUN` tokens across
 *       references, as `100 * matched_positions / eligible_tokens`. Every
 *       eligible candidate token position is counted once, however many
 *       references and however many overlapping runs cover it.
 *
 * Comparison scope is the external corpus only. Internal repetition (the
 * selected units compared with each other) is a different scope and is not
 * folded into either number.
 *
 * Both measures are inapplicable when the eligible text is empty, too short for
 * the configured run/shingle size, or written in a language the tokenizer
 * cannot segment; each such case is reported `not_assessable` with a reason.
 */

export const SHINGLE_SIZE = 5;
export const MIN_RUN = 8;
export const COMPARISON_SCOPE = 'external_corpus';
const SEP = '\u0001';

/** Distinct n-token shingles as a Set of joined strings. */
export function shingleSet(tokens, size = SHINGLE_SIZE) {
  const set = new Set();
  for (let i = 0; i + size <= tokens.length; i++) {
    set.add(tokens.slice(i, i + size).join(SEP));
  }
  return set;
}

/** Jaccard similarity of two shingle sets; null when both are empty. */
export function jaccard(setA, setB) {
  let intersection = 0;
  for (const shingle of setA) {
    if (setB.has(shingle)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return null;
  return intersection / union;
}

/** Whether two shingle sets contain exactly the same shingles. */
export function setsEqual(setA, setB) {
  if (setA.size !== setB.size) return false;
  for (const shingle of setA) if (!setB.has(shingle)) return false;
  return true;
}

/** Union of the shingles of every candidate unit (a unit is one contiguous run). */
export function candidateShingles(units) {
  const set = new Set();
  for (const unit of units) {
    for (const shingle of shingleSet(unit.tokens)) set.add(shingle);
  }
  return set;
}

/**
 * Decide what each reference is to the candidate, from what it declares.
 *
 * `candidate` is `{ id, version, hashes }`: the candidate source identity the
 * packet declares (`universe_id`, accepted version) and the hashes of the
 * selected files. A reference is the candidate's own source version — a
 * self-comparison that must not be compared with itself — only when it declares
 * `source: { id, version }` and both match the candidate. Bytes are never
 * promoted into an identity: a reference whose bytes equal a selected chapter
 * while declaring nothing stays eligible and is reported as duplicate text with
 * an unknown identity, because an independent copy is exactly what overlap
 * measurement is for. `same_source_other_version` and `independent` are kept
 * for the same reason; a declaration is recorded even when it cannot be checked.
 *
 * Returns `{ eligible, exclusions, classified }`: `classified` records what every
 * reference was decided to be, in input order, so the bundle can name each
 * reference's identity and its exclusion reason instead of only listing the
 * removed ones.
 */
export function classifyReferences(references, candidate) {
  const eligible = [];
  const exclusions = [];
  const classified = [];
  for (const reference of references) {
    const identity = classifyIdentity(reference, candidate);
    if (identity.status === 'self_comparison') {
      exclusions.push({ id: reference.id, sha256: reference.sha256, reason: 'same_source_version', identity });
      classified.push({ id: reference.id, identity, eligible: false, reason: 'same_source_version' });
      continue;
    }
    const permitted = reference.permitted_use ?? 'comparison';
    if (permitted === 'none' || permitted === 'prohibited') {
      const reason = `permitted_use:${permitted}`;
      exclusions.push({ id: reference.id, sha256: reference.sha256, reason, identity });
      classified.push({ id: reference.id, identity, eligible: false, reason });
      continue;
    }
    eligible.push({ ...reference, identity });
    classified.push({ id: reference.id, identity, eligible: true, reason: null });
  }
  return { eligible, exclusions, classified };
}

/** The identity of one reference against the candidate, as a record a report can state. */
function classifyIdentity(reference, candidate) {
  const declared = reference.source ?? null;
  const bytesMatch = Boolean(candidate && candidate.hashes && candidate.hashes.has(reference.sha256));
  const base = { declared, bytes_match_candidate: bytesMatch, verified: false, note: null };
  if (declared === null) {
    return {
      ...base,
      status: 'unknown',
      note: bytesMatch
        ? 'the reference declares no source identity; its bytes equal a selected chapter, so it is retained and ' +
          'labelled as duplicate text rather than assumed to be the same source version'
        : 'the reference declares no source identity, so it is treated as an independent reference',
    };
  }
  if (!candidate || typeof candidate.id !== 'string' || typeof candidate.version !== 'string') {
    return {
      ...base,
      status: 'unverified_declaration',
      note: `the reference declares the source ${JSON.stringify(declared.id)} at ${JSON.stringify(declared.version)}, ` +
        'but the candidate has no declared identity to check it against, so the declaration is recorded unverified',
    };
  }
  const sameSource = declared.id === candidate.id;
  const sameVersion = declared.version === candidate.version;
  if (sameSource && sameVersion) {
    return {
      ...base,
      status: 'self_comparison',
      verified: true,
      note: bytesMatch
        ? 'the reference declares the candidate source and version, and its bytes are a selected chapter'
        : 'the reference declares the candidate source and version, though its bytes differ from the selected chapters',
    };
  }
  if (sameSource) {
    return {
      ...base,
      status: 'same_source_other_version',
      verified: true,
      note: `the reference declares the candidate source at ${JSON.stringify(declared.version)}, not the assessed ` +
        `${JSON.stringify(candidate.version)}; another version of the same book stays comparable`,
    };
  }
  return {
    ...base,
    status: 'independent',
    verified: true,
    note: `the reference declares the source ${JSON.stringify(declared.id)}, which is not the candidate source ` +
      `${JSON.stringify(candidate.id)}`,
  };
}

/**
 * candidateShingles: distinct shingles of the candidate units.
 * references: `[{ id, tokens, sha256, language, duplicate_text }]`.
 */
export function computeSi(candidate, references) {
  const pairs = [];
  for (const reference of references) {
    if (reference.tokens.length < SHINGLE_SIZE) continue;
    const value = jaccard(candidate, shingleSet(reference.tokens));
    if (value === null) continue;
    pairs.push({
      reference: reference.id,
      reference_sha256: reference.sha256 ?? null,
      language: reference.language ?? null,
      si: value,
      duplicate_text: reference.duplicate_text === true,
      duplicate_of: reference.duplicate_of ?? null,
      provenance: reference.provenance ?? null,
      identity: reference.identity ?? null,
    });
  }
  if (candidate.size === 0 || pairs.length === 0) {
    return {
      status: 'not_assessable',
      value: null,
      pairs,
      comparison_scope: COMPARISON_SCOPE,
      missing_reason:
        candidate.size === 0
          ? `candidate text is too short for ${SHINGLE_SIZE}-token shingling`
          : references.length === 0
            ? 'no eligible reference texts supplied'
            : `no reference text is long enough for ${SHINGLE_SIZE}-token shingling`,
    };
  }
  pairs.sort((a, b) => (b.si - a.si) || (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0));
  return {
    status: 'computed',
    value: pairs[0].si,
    pairs,
    comparison_scope: COMPARISON_SCOPE,
    maximum_reference: pairs[0].reference,
    missing_reason: null,
  };
}

function buildGramIndex(tokens, size) {
  const map = new Map();
  for (let i = 0; i + size <= tokens.length; i++) {
    const gram = tokens.slice(i, i + size).join(SEP);
    if (!map.has(gram)) map.set(gram, []);
    map.get(gram).push(i);
  }
  return map;
}

/**
 * units: `[{ id, file, chapter, segment_ids, tokens, spans }]` where each unit
 * is one contiguous run of selected candidate tokens.
 * references: `[{ id, tokens, spans }]`.
 *
 * Every eligible matching run is found: the scan never skips a position because
 * an earlier match covered it, so a match that starts inside another run still
 * contributes its uncovered positions. Matching positions are deduplicated
 * across runs, units and references.
 */
export function computeTop(units, references) {
  const eligible = units.reduce((total, unit) => total + unit.tokens.length, 0);
  const base = { comparison_scope: COMPARISON_SCOPE, matched_positions: 0, eligible_tokens: eligible, spans: [] };
  if (eligible === 0) {
    return { ...base, status: 'not_assessable', value: null, missing_reason: 'candidate text is empty' };
  }
  if (eligible < MIN_RUN) {
    return {
      ...base,
      status: 'not_assessable',
      value: null,
      missing_reason: `candidate text has ${eligible} tokens, below the minimum run length of ${MIN_RUN}`,
    };
  }
  if (!references || references.length === 0) {
    return { ...base, status: 'not_assessable', value: null, missing_reason: 'no eligible reference texts supplied' };
  }

  const matchedPositions = new Set();
  const spans = [];
  const seenRuns = new Set();

  for (const unit of units) {
    if (unit.tokens.length < MIN_RUN) continue;
    for (const reference of references) {
      if (reference.tokens.length < MIN_RUN) continue;
      const gramIndex = buildGramIndex(reference.tokens, MIN_RUN);
      for (let i = 0; i + MIN_RUN <= unit.tokens.length; i++) {
        const gram = unit.tokens.slice(i, i + MIN_RUN).join(SEP);
        const starts = gramIndex.get(gram);
        if (!starts) continue;
        for (const start of starts) {
          let length = MIN_RUN;
          while (
            i + length < unit.tokens.length &&
            start + length < reference.tokens.length &&
            unit.tokens[i + length] === reference.tokens[start + length]
          ) {
            length += 1;
          }
          const runKey = `${reference.id}|${i}|${length}`;
          if (seenRuns.has(runKey)) continue;
          seenRuns.add(runKey);
          for (let position = i; position < i + length; position++) {
            matchedPositions.add(`${unit.file}#${unit.indexes[position]}`);
          }
          const referenceSpans = reference.spans;
          spans.push({
            reference: reference.id,
            file: unit.file,
            chapter: unit.chapter,
            unit: unit.id,
            segment_ids: unit.segment_ids,
            token_start: unit.indexes[i],
            token_end: unit.indexes[i + length - 1] + 1,
            byte_start: unit.spans[i].start,
            byte_end: unit.spans[i + length - 1].end,
            reference_token_start: start,
            reference_token_end: start + length,
            reference_byte_start: referenceSpans ? referenceSpans[start].start : null,
            reference_byte_end: referenceSpans ? referenceSpans[start + length - 1].end : null,
          });
        }
      }
    }
  }

  return {
    ...base,
    status: 'computed',
    value: (100 * matchedPositions.size) / eligible,
    matched_positions: matchedPositions.size,
    spans,
    missing_reason: null,
  };
}

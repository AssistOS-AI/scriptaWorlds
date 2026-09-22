/**
 * Lexical comparison orchestration: SI and TOP over the declared corpus.
 *
 * The candidate is the resolved selection (see candidate.mjs). References come
 * only from an explicit `--corpus` manifest; each one is classified before use,
 * so an excluded reference is reported with its reason rather than silently
 * dropped, and the provenance of every reference is carried into the bundle.
 * Everything here is deterministic and reads already-loaded bytes.
 */

import { TextDecoder } from 'node:util';

import {
  COMPARISON_SCOPE,
  candidateShingles,
  classifyReferences,
  computeSi,
  computeTop,
  setsEqual,
  shingleSet,
} from './overlap.mjs';
import { tokenize } from './tokenize.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });

function unavailableSi(reason, exclusions) {
  return {
    status: 'not_assessable',
    value: null,
    pairs: [],
    comparison_scope: COMPARISON_SCOPE,
    exclusions,
    missing_reason: reason,
  };
}

function unavailableTop(reason, eligible, exclusions) {
  return {
    status: 'not_assessable',
    value: null,
    matched_positions: 0,
    eligible_tokens: eligible,
    spans: [],
    comparison_scope: COMPARISON_SCOPE,
    exclusions,
    missing_reason: reason,
  };
}

/**
 * `candidate` is the built candidate-unit set and `candidateIdentity` is
 * `{ id, version, hashes }`, the source identity the packet declares. Returns
 * `{ si, top, corpusReason, exclusions, references }`; `si` and `top` are null
 * when no corpus was supplied at all.
 */
export function computeLexical({ candidate, corpus, candidateIdentity }) {
  const exclusions = [];
  const references = [];
  if (!corpus) {
    return { si: null, top: null, corpusReason: 'no --corpus manifest supplied', exclusions, references };
  }
  const unitShingles = candidate.units.map((unit) => shingleSet(unit.tokens));
  const classified = classifyReferences(corpus.references, candidateIdentity);
  const byId = new Map(classified.classified.map((entry) => [entry.id, entry]));
  for (const exclusion of classified.exclusions) exclusions.push({ ...exclusion, declared: false });
  references.push(
    ...corpus.references.map((reference) => {
      const decision = byId.get(reference.id);
      return {
        id: reference.id,
        path: reference.path,
        sha256: reference.sha256,
        language: reference.language,
        provenance: reference.provenance,
        permitted_use: reference.permitted_use,
        declared_exclusions: reference.declared_exclusions,
        source: reference.source ?? null,
        identity: decision ? decision.identity : null,
        excluded_reason: decision && !decision.eligible ? decision.reason : null,
      };
    }),
  );
  for (const reference of corpus.references) {
    for (const declared of reference.declared_exclusions) {
      exclusions.push({ id: reference.id, sha256: reference.sha256, reason: `declared:${declared}`, declared: true });
    }
  }

  const eligible = [];
  if (candidate.supported) {
    for (const reference of classified.eligible) {
      const tokenized = tokenize(reference.bytes, `corpus file ${reference.path}`, { language: reference.language });
      if (!tokenized.supported) {
        exclusions.push({ id: reference.id, sha256: reference.sha256, reason: 'unsupported_language', declared: false });
        continue;
      }
      eligible.push({
        id: reference.id,
        sha256: reference.sha256,
        language: reference.language,
        provenance: reference.provenance,
        permitted_use: reference.permitted_use,
        identity: reference.identity,
        tokens: tokenized.tokens,
        spans: tokenized.spans,
        shingles: shingleSet(tokenized.tokens),
        duplicate_text: false,
        duplicate_of: null,
      });
    }
  }
  // Genuine duplicate text in another reference is a fact about the corpus and
  // stays eligible; it is never confused with excluding the candidate's own
  // source version, which only a verified declaration can establish.
  for (const reference of eligible) {
    if (reference.shingles.size === 0) continue;
    for (const other of eligible) {
      if (other === reference || other.shingles.size === 0) continue;
      if (setsEqual(reference.shingles, other.shingles)) {
        reference.duplicate_text = true;
        reference.duplicate_of = reference.duplicate_of ?? other.id;
      }
    }
  }
  const candidateMatches = eligible.filter((reference) =>
    unitShingles.some((set) => set.size > 0 && setsEqual(set, reference.shingles)),
  );
  for (const reference of candidateMatches) {
    reference.duplicate_text = true;
    reference.duplicate_of = reference.duplicate_of ?? 'candidate';
  }

  if (!candidate.supported) {
    return {
      si: unavailableSi(candidate.reason, exclusions),
      top: unavailableTop(candidate.reason, candidate.eligible_tokens, exclusions),
      corpusReason: candidate.reason,
      exclusions,
      references,
    };
  }
  if (eligible.length === 0) {
    const reason =
      'every declared reference was excluded for this comparison (same source version, permitted use or ' +
      'unsupported language)';
    return {
      si: unavailableSi(reason, exclusions),
      top: unavailableTop(reason, candidate.eligible_tokens, exclusions),
      corpusReason: reason,
      exclusions,
      references,
    };
  }
  return {
    si: { ...computeSi(candidateShingles(candidate.units), eligible), exclusions },
    top: { ...computeTop(candidate.units, eligible), exclusions },
    corpusReason: null,
    exclusions,
    references,
  };
}

/**
 * Turn every TOP match span into a verified evidence item: the candidate bytes
 * of the run, mapped back through the tokenizer's byte offsets. Returns the
 * evidence ids in span order.
 */
export function generateTopEvidence(topResult, candidateFiles, collector) {
  const ids = [];
  let n = 0;
  for (const span of topResult.spans) {
    n += 1;
    const file = candidateFiles.get(span.file);
    if (!file) continue;
    const quote = decoder.decode(file.buffer.subarray(span.byte_start, span.byte_end));
    let id = `top-match-${String(n).padStart(6, '0')}`;
    while (collector.byId.has(id)) id = `top-match-${String(n).padStart(6, '0')}-${collector.list.length}`;
    ids.push(collector.add({ id, file: span.file, sha256: file.sha256, start: span.byte_start, end: span.byte_end, quote }));
  }
  return ids;
}

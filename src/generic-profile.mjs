// The generic review profile: what a requested or arc-end review uses when nobody handed the host a
// hand-authored JSON. It is a normal `evaluation-profile.v1` with understandable defaults, so the same
// validation, the same report and the same provenance apply — it is a supported application mode, not a
// special case in the metrics skill.
//
// Two things are deliberate. Aggregation (NQS) is off unless the caller asks for it, because a single
// number hides the components. When it is asked for it runs under the `research` policy with declared
// weights and an advisory label: `research` names the formula, not a study, and an aggregate that claims
// calibration must show verifiable study artifacts (see `references/calibration.md` in the skill).
import { UniverseError } from './errors.mjs';

export const GENERIC_PROFILE_SCHEMA = 'evaluation-profile.v1';
export const GENERIC_PROFILE_ID = 'scripta-generic-review';
// The published components are weighted as declared here; the emotional component needs a stated
// intention, and the report explains what is missing rather than scoring an intention nobody stated.
export const GENERIC_WEIGHTS = { cs: 0.4, oi: 0.3, emotional_fit: 0.3 };
export const GENERIC_EMOTIONAL_FIT_PROCEDURE = 'compare the judged emotional fit with the intention the caller stated';

/** A scope the metrics skill accepts: the whole book, or named chapters. */
export function genericScope({ scope = null, chapters = null, packetScope = null } = {}) {
  if (scope && ['book', 'chapter', 'arc', 'scene'].includes(scope.kind)) {
    if (scope.kind === 'chapter') {
      const list = Array.isArray(scope.chapters) ? scope.chapters.filter((n) => Number.isInteger(n)) : [];
      if (list.length === 0) {
        throw new UniverseError('BAD_SCOPE', 'A chapter scope names the chapters it covers.', 400);
      }
      return { kind: 'chapter', chapters: [...new Set(list)].sort((a, b) => a - b), context_chapters: Array.isArray(scope.context_chapters) ? scope.context_chapters : [] };
    }
    if (scope.kind === 'book') return { kind: 'book' };
    // An arc or scene scope needs declared segments, which only an annotations bundle can supply.
    return scope;
  }
  const wanted = Array.isArray(chapters) ? chapters.filter((n) => Number.isInteger(n)) : [];
  if (wanted.length > 0) {
    return { kind: 'chapter', chapters: [...new Set(wanted)].sort((a, b) => a - b), context_chapters: [] };
  }
  if (packetScope?.kind === 'complete') return { kind: 'book' };
  // A partial packet cannot be reviewed as a whole book: name the chapters it does contain.
  const covered = Array.isArray(packetScope?.chapters) ? packetScope.chapters : [];
  if (covered.length > 0) return { kind: 'chapter', chapters: covered, context_chapters: [] };
  throw new UniverseError('BAD_SCOPE', 'The packet contains no chapter to review.', 400);
}

/**
 * The generic profile for one run. `aggregate: true` turns the optional NQS on under the research
 * policy; without an intention the report still produces its components and says why the aggregate is
 * unavailable, so no intention is invented here.
 */
export function genericProfile({ scope = null, chapters = null, packetScope = null, aggregate = false, intention = null, weights = null } = {}) {
  const resolvedScope = genericScope({ scope, chapters, packetScope });
  const profile = {
    schema_version: GENERIC_PROFILE_SCHEMA,
    profile_id: `${GENERIC_PROFILE_ID}-${resolvedScope.kind}`,
    advisory: true,
    scope: resolvedScope
  };
  if (!aggregate) {
    profile.aggregation = { enabled: false };
    return profile;
  }
  const declared = weights ?? GENERIC_WEIGHTS;
  const total = Number(declared.cs ?? 0) + Number(declared.oi ?? 0) + Number(declared.emotional_fit ?? 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new UniverseError('BAD_WEIGHTS', `Generic aggregation weights must sum to 1 (got ${total}).`, 400);
  }
  profile.aggregation = {
    enabled: true,
    policy: 'research',
    weights: { cs: declared.cs, oi: declared.oi, emotional_fit: declared.emotional_fit },
    emotional_fit: {
      procedure: GENERIC_EMOTIONAL_FIT_PROCEDURE,
      intent: intention ? String(intention).slice(0, 400) : null
    },
    scope: resolvedScope.kind === 'chapter' ? `chapters ${resolvedScope.chapters.join(', ')}` : resolvedScope.kind,
    // No wall-clock field: two requests that ask for the same review must produce the same profile,
    // so its identity never depends on when it was built.
    advisory_note: 'research aggregation: the formula is declared here and is not calibrated against readers'
  };
  return profile;
}

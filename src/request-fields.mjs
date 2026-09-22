// The fields a reader or an author can attach to a request: the approved directions of a separate
// design phase, the findings of a review with the qualities to preserve, and their bounds. They are
// validated here, once, so the HTTP route, the queue and the check suite agree on what is acceptable.
import { UniverseError } from './errors.mjs';

// An approved direction is a short instruction a separate design or craft phase produced and a human
// accepted. It travels as input data of a writing request, never as a handbook the agent must read.
const MAX_DIRECTIONS = 8;
const MAX_DIRECTION_CHARS = 400;
// Findings travel from an external review into one bounded revision: each keeps its stable identifier
// and the evidence it came from, so the revision can be checked against what was actually reported.
const MAX_FINDINGS = 8;
const MAX_FINDING_TEXT = 400;
const MAX_PRESERVE = 6;
const FINDING_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** Validate the approved directions of a request: a bounded list of non-empty short strings. */
export function normaliseDirections(directions, approval = null) {
  if (directions === undefined || directions === null) return { directions: [], approval: null };
  if (!Array.isArray(directions)) {
    throw new UniverseError('BAD_DIRECTIONS', '`directions` must be a list of short instructions.', 400);
  }
  if (directions.length > MAX_DIRECTIONS) {
    throw new UniverseError('BAD_DIRECTIONS', `At most ${MAX_DIRECTIONS} approved directions are carried into one turn.`, 400);
  }
  const clean = [];
  for (const entry of directions) {
    const text = String(entry ?? '').trim();
    if (text.length === 0 || text.length > MAX_DIRECTION_CHARS) {
      throw new UniverseError(
        'BAD_DIRECTIONS',
        `Every approved direction must be a non-empty instruction of at most ${MAX_DIRECTION_CHARS} characters.`,
        400
      );
    }
    clean.push(text);
  }
  if (clean.length === 0) return { directions: [], approval: null };
  const record = approval && typeof approval === 'object'
    ? {
        path: typeof approval.path === 'string' ? approval.path.trim().slice(0, 300) : null,
        sha256: typeof approval.sha256 === 'string' ? approval.sha256.trim().slice(0, 80) : null,
        version: typeof approval.version === 'string' ? approval.version.trim().slice(0, 80) : null
      }
    : null;
  return { directions: clean, approval: record };
}

/** Validate the findings and the qualities an author hands to a revision. */
export function normaliseRevision({ findings, preserve } = {}) {
  const cleanFindings = [];
  if (findings !== undefined && findings !== null) {
    if (!Array.isArray(findings)) {
      throw new UniverseError('BAD_FINDINGS', '`findings` must be a list of findings with stable ids.', 400);
    }
    if (findings.length > MAX_FINDINGS) {
      throw new UniverseError('BAD_FINDINGS', `At most ${MAX_FINDINGS} findings are handed to one revision.`, 400);
    }
    for (const entry of findings) {
      const id = String(entry?.id ?? '').trim();
      if (!FINDING_ID_RE.test(id)) {
        throw new UniverseError('BAD_FINDINGS', `Every finding needs a stable identifier (\`${String(entry?.id ?? '')}\` is not one).`, 400);
      }
      const claim = String(entry?.claim ?? '').trim().slice(0, MAX_FINDING_TEXT);
      const evidence = Array.isArray(entry?.evidence)
        ? entry.evidence.map((item) => String(item ?? '').trim().slice(0, MAX_FINDING_TEXT)).filter(Boolean).slice(0, 3)
        : [];
      cleanFindings.push({ id, claim, evidence });
    }
  }
  const cleanPreserve = [];
  if (preserve !== undefined && preserve !== null) {
    if (!Array.isArray(preserve)) {
      throw new UniverseError('BAD_FINDINGS', '`preserve` must be a list of short descriptions.', 400);
    }
    if (preserve.length > MAX_PRESERVE) {
      throw new UniverseError('BAD_FINDINGS', `At most ${MAX_PRESERVE} qualities are named as preserved.`, 400);
    }
    for (const entry of preserve) {
      const text = String(entry ?? '').trim();
      if (!text || text.length > MAX_DIRECTION_CHARS) {
        throw new UniverseError('BAD_FINDINGS', 'Every preserved quality is a non-empty short description.', 400);
      }
      cleanPreserve.push(text);
    }
  }
  return { findings: cleanFindings, preserve: cleanPreserve };
}

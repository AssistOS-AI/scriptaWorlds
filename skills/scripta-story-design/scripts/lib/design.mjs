/**
 * design.mjs — validation logic for the scriptaWorlds story-design brief (schema_version "design.v1").
 *
 * ---------------------------------------------------------------------------
 * Design brief schema — schema_version "design.v1"
 * ---------------------------------------------------------------------------
 * The root must be a plain JSON object.
 *
 * Required keys (each a non-empty trimmed string unless noted):
 *   schema_version      — must equal exactly "design.v1"
 *   design_id           — unique identifier; must not duplicate any arc/entity/assumption id
 *   language            — the fiction language of the narrative strings
 *   central_idea        — the situation or possibility that sustains the inquiry
 *   premise             — a person + want + resistance + consequences
 *   thematic_question   — the open question the story examines
 *   reader_promise      — the expected experience and its meaningful uncertainty
 *
 * Optional keys:
 *   based_on_version           — string; the accepted content identity (`sha256:<hex>`, §8.2)
 *                                the brief was written against. With `--context` it must
 *                                equal the packet's `version`, never `universe_id`.
 *   structural_intent          — string
 *   character_directions       — array of objects
 *   relationship_directions    — array of objects
 *   world_assumptions          — array of objects
 *   arcs                       — array of objects (an empty array is a legal sparse plan)
 *   open_design_questions      — array of non-empty strings
 *
 * character_directions[i] (object):
 *   required: entity_id, want, contradiction (non-empty trimmed strings)
 *   optional: defence, knowledge_limits, direction (non-empty trimmed strings)
 *
 * relationship_directions[i] (object):
 *   required: participants (array of >=2 distinct entity ids), terms, last_change,
 *             evidence (non-empty trimmed strings)
 *
 * world_assumptions[i] (object):
 *   required: id (non-empty trimmed string),
 *             epistemic_kind (one of law|observation|belief|social_rule|hypothesis|plan),
 *             text, source (non-empty trimmed strings)
 *   optional: entity_id — when present it introduces/declares that entity
 *
 * arcs[i] (object):
 *   required: id, pressure (non-empty trimmed strings),
 *             destinations (array of non-empty trimmed strings; may be empty),
 *             status (one of planned|active|completed|abandoned)
 *   optional: chapter_memberships (array of positive integers; a number above the last
 *             accepted chapter is a planned future membership and stays legal),
 *             decision_points (array of non-empty trimmed strings),
 *             planning_status (non-empty trimmed string)
 *
 * Identity rules:
 *   - arc ids, entity ids and world-assumption ids are each unique; no duplicate ids.
 *   - ids are compared after trimming surrounding whitespace and applying Unicode NFC
 *     normalization, so two ids that differ only by that are the same id.
 *   - design_id must not duplicate any arc/entity/world-assumption id.
 *   - declared entities = character_directions[].entity_id plus world_assumptions[]
 *     entries that carry an entity_id. When that set is non-empty (a central entity
 *     list exists), every relationship participant must resolve to a declared entity.
 *     With no central entity list, participant ids are free-form but must still be
 *     non-empty strings.
 *   - `language` must be one of the supported fiction languages (the list mirrors
 *     `src/config.mjs`, which a portable skill may not import).
 *
 * Context (`--context`, `assessment-input.v2`, docs/contracts.md §8.2 and §8.3):
 *   - the manifest is loaded and refused (exit 2) for an unknown schema_version, a
 *     duplicate path or artifact_id, an undeclared role, an absolute or `..` path, a
 *     symlink escape, a missing file, a byte/hash mismatch, bytes that are not valid
 *     UTF-8, a `version` that differs from the recomputed accepted-version identity, and
 *     a `scope.kind` that contradicts the packet.
 *   - `based_on_version` is compared with the packet's `version` (the accepted content
 *     identity). A brief written for version A is refused as stale against version B of
 *     the same book, and accepted for B.
 *   - with no `--context`, a present `based_on_version` is reported as a warning because
 *     the version cannot be checked; it is never silently accepted.
 *
 * Warnings (never failures):
 *   - a world assumption of epistemic_kind "plan" whose text describes a future event
 *     (detected by a heuristic list of future-tense markers). Planned futures are not
 *     canon until accepted prose establishes them.
 *   - an arc whose status is "completed": a design brief is a proposal, so the status
 *     records an intention, not an accepted event. Completion is established by accepted
 *     prose, and an arc with no recorded chapter memberships has nothing in this document
 *     that could show it.
 *
 * This skill defines no prose-profile or evaluation-configuration block and shares no
 * schema identifier with those documents: a profile belongs to `scripta-prose-craft`
 * (`profile.v1`) and an evaluation configuration to `scripta-metrics-report`
 * (`assessment-profile.v1`). Should a design ever need to carry voice-like settings of its
 * own, they must be introduced here under a distinct identifier (a `design-*` schema
 * version), never by reusing `profile.v1`.
 */

import { isPlainObject, loadPacket, nonEmptyString, PACKET_SCHEMA, structuredError } from './packet.mjs';

export const DESIGN_SCHEMA = 'design.v1';

/** Document kinds that are not a design brief; naming the wrong kind is its own refusal. */
const FOREIGN_SCHEMAS = new Map([
  ['profile.v1', 'a prose profile (scripta-prose-craft)'],
  ['assessment-profile.v1', 'an evaluation configuration (scripta-metrics-report)'],
  ['assessment-input.v1', 'an assessment packet manifest'],
  [PACKET_SCHEMA, 'an assessment packet manifest'],
  ['annotations.v1', 'a metrics annotations bundle'],
  ['corpus.v1', 'a corpus manifest'],
  ['continuity-result.v1', 'a continuity result'],
]);

/**
 * Language codes. MUST stay in sync with src/config.mjs LANGUAGES; this skill
 * deliberately does not import src/, so the list is duplicated here.
 */
const LANGUAGES = Object.freeze([
  'ro', 'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'pl',
  'cs', 'hu', 'bg', 'el', 'uk', 'ru', 'tr', 'ja', 'zh',
]);
const LANGUAGE_CODES = new Set(LANGUAGES);

const EPISTEMIC_KINDS = new Set(['law', 'observation', 'belief', 'social_rule', 'hypothesis', 'plan']);
const ARC_STATUSES = new Set(['planned', 'active', 'completed', 'abandoned']);

const REQUIRED_STRING_KEYS = [
  'design_id',
  'language',
  'central_idea',
  'premise',
  'thematic_question',
  'reader_promise',
];
const OPTIONAL_STRING_KEYS = ['based_on_version', 'structural_intent'];

const FUTURE_MARKERS = [
  /\bwill\b/i,
  /\bshall\b/i,
  /\bgoing to\b/i,
  /\bsoon\b/i,
  /\bscheduled\b/i,
  /\bplanned\b/i,
  /\bupcoming\b/i,
  /\beventually\b/i,
  /\bfuture\b/i,
  /\bafterwards\b/i,
  /\bnext\b/i,
  /\blater\b/i,
  /\bva\b/i,
  /\bvor\b/i,
  /\burmeaz[ăa]\b/i,
  /\bviitor\w*\b/i,
];

/**
 * The one identity form of an id: surrounding whitespace trimmed and Unicode NFC applied,
 * so two ids that differ only by that are the same id and collide.
 */
function normalizeId(value) {
  return value.trim().normalize('NFC');
}

function mentionsFutureEvent(text) {
  return FUTURE_MARKERS.some((marker) => marker.test(text));
}

function requireString(obj, path, key, state) {
  if (obj[key] === undefined) {
    state.errors.push(`${path}.${key} is required`);
  } else if (!nonEmptyString(obj[key])) {
    state.errors.push(`${path}.${key} must be a non-empty string`);
  }
}

function optionalString(obj, path, key, state) {
  if (obj[key] !== undefined && obj[key] !== null && !nonEmptyString(obj[key])) {
    state.errors.push(`${path}.${key} must be a non-empty string when present`);
  }
}

function addEntityId(id, state) {
  if (state.entityIds.has(id)) {
    state.errors.push(structuredError('DUPLICATE_ID', `duplicate entity id "${id}"`));
  } else {
    state.entityIds.add(id);
  }
}

function validateCharacterEntry(entry, index, field, state) {
  const path = `${field}[${index}]`;
  if (!isPlainObject(entry)) {
    state.errors.push(`${path} must be an object`);
    return;
  }
  requireString(entry, path, 'entity_id', state);
  requireString(entry, path, 'want', state);
  requireString(entry, path, 'contradiction', state);
  optionalString(entry, path, 'defence', state);
  optionalString(entry, path, 'knowledge_limits', state);
  optionalString(entry, path, 'direction', state);
  if (nonEmptyString(entry.entity_id)) {
    addEntityId(normalizeId(entry.entity_id), state);
  }
}

function validateRelationshipEntry(entry, index, field, state) {
  const path = `${field}[${index}]`;
  if (!isPlainObject(entry)) {
    state.errors.push(`${path} must be an object`);
    return;
  }
  requireString(entry, path, 'terms', state);
  requireString(entry, path, 'last_change', state);
  requireString(entry, path, 'evidence', state);
  if (!Array.isArray(entry.participants)) {
    state.errors.push(`${path}.participants must be an array of at least two entity ids`);
  } else if (entry.participants.length < 2) {
    state.errors.push(`${path}.participants must contain at least two entity ids`);
  } else {
    const local = new Set();
    for (let j = 0; j < entry.participants.length; j += 1) {
      const participant = entry.participants[j];
      if (!nonEmptyString(participant)) {
        state.errors.push(`${path}.participants[${j}] must be a non-empty string`);
        continue;
      }
      const id = normalizeId(participant);
      if (local.has(id)) {
        state.errors.push(
          structuredError('DUPLICATE_ID', `${path}.participants contains the duplicate entity id "${id}"`),
        );
      } else {
        local.add(id);
        state.relationshipReferenced.add(id);
      }
    }
  }
}

function validateAssumptionEntry(entry, index, field, state) {
  const path = `${field}[${index}]`;
  if (!isPlainObject(entry)) {
    state.errors.push(`${path} must be an object`);
    return;
  }
  requireString(entry, path, 'id', state);
  requireString(entry, path, 'text', state);
  requireString(entry, path, 'source', state);
  if (entry.epistemic_kind === undefined) {
    state.errors.push(`${path}.epistemic_kind is required`);
  } else if (typeof entry.epistemic_kind !== 'string' || !EPISTEMIC_KINDS.has(entry.epistemic_kind)) {
    state.errors.push(`${path}.epistemic_kind must be one of: ${[...EPISTEMIC_KINDS].join(', ')}`);
  }
  if (nonEmptyString(entry.id)) {
    const id = normalizeId(entry.id);
    if (state.assumptionIds.has(id)) {
      state.errors.push(structuredError('DUPLICATE_ID', `duplicate world-assumption id "${id}"`));
    } else {
      state.assumptionIds.add(id);
    }
  }
  if (entry.entity_id !== undefined && entry.entity_id !== null) {
    if (!nonEmptyString(entry.entity_id)) {
      state.errors.push(`${path}.entity_id must be a non-empty string when present`);
    } else {
      addEntityId(normalizeId(entry.entity_id), state);
    }
  }
  if (entry.epistemic_kind === 'plan' && nonEmptyString(entry.text) && mentionsFutureEvent(entry.text)) {
    state.warnings.push(
      `${path}: a plan-kind assumption whose text describes a future event; ` +
        'planned futures are not canon until accepted prose establishes them',
    );
  }
}

function validateArcEntry(entry, index, field, state) {
  const path = `${field}[${index}]`;
  if (!isPlainObject(entry)) {
    state.errors.push(`${path} must be an object`);
    return;
  }
  requireString(entry, path, 'id', state);
  requireString(entry, path, 'pressure', state);
  if (entry.status === undefined) {
    state.errors.push(`${path}.status is required`);
  } else if (typeof entry.status !== 'string' || !ARC_STATUSES.has(entry.status)) {
    state.errors.push(`${path}.status must be one of: ${[...ARC_STATUSES].join(', ')}`);
  }
  if (!Array.isArray(entry.destinations)) {
    state.errors.push(`${path}.destinations must be an array`);
  } else {
    for (let j = 0; j < entry.destinations.length; j += 1) {
      if (!nonEmptyString(entry.destinations[j])) {
        state.errors.push(`${path}.destinations[${j}] must be a non-empty string`);
      }
    }
  }
  if (nonEmptyString(entry.id)) {
    const id = normalizeId(entry.id);
    if (state.arcIds.has(id)) {
      state.errors.push(structuredError('DUPLICATE_ID', `duplicate arc id "${id}"`));
    } else {
      state.arcIds.add(id);
    }
  }
  if (entry.chapter_memberships !== undefined && entry.chapter_memberships !== null) {
    if (!Array.isArray(entry.chapter_memberships)) {
      state.errors.push(`${path}.chapter_memberships must be an array of chapter numbers`);
    } else {
      for (let j = 0; j < entry.chapter_memberships.length; j += 1) {
        const membership = entry.chapter_memberships[j];
        if (!Number.isInteger(membership)) {
          state.errors.push(`${path}.chapter_memberships[${j}] must be an integer`);
        } else if (membership < 1) {
          state.errors.push(
            structuredError(
              'INVALID_CHAPTER',
              `${path}.chapter_memberships[${j}] must be a positive chapter number, got ${membership}`,
            ),
          );
        }
      }
    }
  }
  if (entry.status === 'completed') {
    const memberships = Array.isArray(entry.chapter_memberships) ? entry.chapter_memberships : [];
    state.warnings.push(
      `${path}: status "completed" is a proposal, not an accepted event; accepted prose establishes that ` +
        'an arc completed, and ' +
        (memberships.length === 0
          ? 'this document records no chapter_memberships that could show it'
          : 'this document records only the chapters planned for it'),
    );
  }

  if (entry.decision_points !== undefined && entry.decision_points !== null) {
    if (!Array.isArray(entry.decision_points)) {
      state.errors.push(`${path}.decision_points must be an array`);
    } else {
      for (let j = 0; j < entry.decision_points.length; j += 1) {
        if (!nonEmptyString(entry.decision_points[j])) {
          state.errors.push(`${path}.decision_points[${j}] must be a non-empty string`);
        }
      }
    }
  }
  optionalString(entry, path, 'planning_status', state);
}

function validateQuestionEntry(entry, index, field, state) {
  if (!nonEmptyString(entry)) {
    state.errors.push(`${field}[${index}] must be a non-empty string`);
  }
}

function validateArrayField(root, key, state, validateEntry) {
  const value = root[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value)) {
    state.errors.push(`"${key}" must be an array`);
    return;
  }
  for (let i = 0; i < value.length; i += 1) {
    validateEntry(value[i], i, key, state);
  }
}

export function validateDesign(root) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(root)) {
    errors.push('the design document must be a JSON object');
    return { errors, warnings };
  }

  if (root.schema_version !== DESIGN_SCHEMA) {
    const foreign = FOREIGN_SCHEMAS.get(root.schema_version);
    if (foreign !== undefined) {
      errors.push(
        structuredError(
          'SCHEMA_VERSION',
          `schema_version ${JSON.stringify(root.schema_version)} names ${foreign}, not a design brief; ` +
            `this validator only accepts "${DESIGN_SCHEMA}"`,
        ),
      );
    } else {
      errors.push(`schema_version must be "${DESIGN_SCHEMA}", got ${JSON.stringify(root.schema_version)}`);
    }
  }

  for (const key of REQUIRED_STRING_KEYS) {
    const value = root[key];
    if (value === undefined) {
      errors.push(`missing required key "${key}"`);
    } else if (!nonEmptyString(value)) {
      errors.push(`"${key}" must be a non-empty string`);
    }
  }

  if (nonEmptyString(root.language) && !LANGUAGE_CODES.has(root.language)) {
    errors.push(
      structuredError(
        'UNSUPPORTED_LANGUAGE',
        `unsupported language code ${JSON.stringify(root.language)} (supported: ${LANGUAGES.join(', ')})`,
      ),
    );
  }

  for (const key of OPTIONAL_STRING_KEYS) {
    const value = root[key];
    if (value !== undefined && value !== null && !nonEmptyString(value)) {
      errors.push(`"${key}" must be a non-empty string when present`);
    }
  }

  const state = {
    errors,
    warnings,
    arcIds: new Set(),
    entityIds: new Set(),
    assumptionIds: new Set(),
    relationshipReferenced: new Set(),
  };

  validateArrayField(root, 'character_directions', state, validateCharacterEntry);
  validateArrayField(root, 'relationship_directions', state, validateRelationshipEntry);
  validateArrayField(root, 'world_assumptions', state, validateAssumptionEntry);
  validateArrayField(root, 'arcs', state, validateArcEntry);
  validateArrayField(root, 'open_design_questions', state, validateQuestionEntry);

  if (nonEmptyString(root.design_id)) {
    const designId = normalizeId(root.design_id);
    if (state.arcIds.has(designId) || state.entityIds.has(designId) || state.assumptionIds.has(designId)) {
      errors.push(
        structuredError(
          'DUPLICATE_ID',
          `duplicate design_id "${designId}": it collides with an arc, entity or world-assumption id`,
        ),
      );
    }
  }

  if (state.entityIds.size > 0) {
    for (const ref of state.relationshipReferenced) {
      if (!state.entityIds.has(ref)) {
        errors.push(
          `relationship participant "${ref}" references an entity that is not declared ` +
            'as a character or world-assumption entity',
        );
      }
    }
  }

  return { errors, warnings };
}

/**
 * Loads the `--context` packet and compares the brief's `based_on_version` with the
 * packet's accepted version identity (§8.2). A packet refusal or a stale version is an
 * error (exit 2); a brief that names no source version is a warning, never an
 * acceptance of a document whose version was left unchecked.
 */
export async function validateContext(contextPath, design, errors, warnings) {
  const { errors: packetErrors, packet } = await loadPacket(contextPath);
  if (packet === null) {
    errors.push(...packetErrors);
    return;
  }

  const basedOn = nonEmptyString(design.based_on_version) ? design.based_on_version.trim() : null;
  if (basedOn === null) {
    warnings.push(
      '--context was provided but the brief has no based_on_version: the accepted version the brief ' +
        'describes was not cross-checked',
    );
    return;
  }

  if (basedOn !== packet.version) {
    errors.push(
      structuredError(
        'STALE_BASED_ON_VERSION',
        `based_on_version "${basedOn}" does not match the accepted version "${packet.version}" of ` +
          `universe "${packet.universeId}"; the brief was written for a different accepted version of ` +
          'the same book',
      ),
    );
  }
}

/**
 * The warning for a brief whose source version cannot be checked because no packet was
 * supplied. Returning a warning (rather than nothing) is what keeps an unchecked version
 * from passing silently.
 */
export function uncheckedVersionWarning(design) {
  if (!isPlainObject(design) || !nonEmptyString(design.based_on_version)) {
    return null;
  }
  return (
    `based_on_version "${design.based_on_version.trim()}" is set but --context was not provided: the ` +
    'accepted version was not checked; pass --context <assessment-input.v2 packet> to prove the brief ' +
    'is not stale'
  );
}


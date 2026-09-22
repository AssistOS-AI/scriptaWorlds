/**
 * profile.mjs — validation rules for a scriptaWorlds prose profile (`profile.v1`).
 *
 * ---------------------------------------------------------------------------
 * Prose profile schema — schema_version "profile.v1"
 * ---------------------------------------------------------------------------
 * The root must be a plain JSON object.
 *
 * Required keys:
 *   schema_version      — must equal exactly "profile.v1"
 *   profile_id          — non-empty identifier (see the identity rules)
 *   language            — a supported fiction language code
 *   reader_experience   — non-empty string: what the scene should give the reader
 *   narrator            — non-empty string: who speaks
 *
 * Optional keys:
 *   based_on_version    — the accepted content identity of `docs/contracts.md` §8.2
 *                         (`sha256:<64 hex>`); a universe id is not a version and is refused
 *   focalization        — object (mode, limits, focal_character) or a prose string
 *   register            — string
 *   character_voices    — array of { entity_id, notes, speech_habit? }
 *   recurring_devices   — array of { device, purpose }
 *   revision_priorities — array of strings
 *   expressive_components — the evidence-bearing annotations of the craft inspection; each
 *                         entry requires component_id, component (focalization, description,
 *                         dialogue, narration, interior_monologue, rhythm), anchor, status
 *                         (observed | uncertain | unresolved | not_applicable), evaluator,
 *                         rationale, and — unless the status is not_applicable — quoted
 *                         evidence naming its source; an uncertain or unresolved reading
 *                         states its limitation, and alternatives are preserved
 *   calibration         — the recorded readiness of the profile: status (uncalibrated |
 *                         experimental | calibrated), protocol_version and, for a calibrated
 *                         profile, the evidence behind it
 *   intended_use        — draft | review | production; "production" is refused until the
 *                         profile is calibrated, because no calibration evidence exists yet
 *
 * Identity rules:
 *   - `profile_id`, every `character_voices[].entity_id` and every
 *     `recurring_devices[].device` are compared after trimming surrounding whitespace and
 *     applying Unicode NFC normalization, so two identifiers that differ only by that are
 *     the same identifier and collide.
 *   - `profile_id` shares one namespace with the declared entity ids; a `device` repeats
 *     within `recurring_devices`.
 *   - `focalization.focal_character` must name a declared entity id.
 *
 * Distinct document kinds:
 *   - a prose profile and the metrics evaluation configuration are different documents.
 *     `profile.v1` names the prose profile; the evaluation configuration is
 *     `assessment-profile.v1` (scripta-metrics-report). A document that names another
 *     kind, or that carries the evaluation configuration's own fields (`aggregation`, or a
 *     `scope` whose kind is scene/chapter/arc/book) under `profile.v1`, is refused with a
 *     structured error instead of being validated against the wrong rules.
 *
 * Context (`--context`, `assessment-input.v2`, docs/contracts.md §8.2 and §8.3):
 *   - the packet is loaded and refused for an unknown schema_version, a duplicate path or
 *     artifact_id, an absolute or `..` path, a symlink escape, a missing file, a
 *     byte/hash mismatch, a `version` that differs from the recomputed accepted-version
 *     identity, and a `scope.kind` that contradicts the packet.
 *   - `based_on_version` is compared with the packet's `version` (the accepted content
 *     identity), never with `book.universe_id`; a profile written for version A is
 *     refused as stale against version B of the same book.
 *   - the quoted support of every expressive component is located in the packet file it
 *     names, so a fabricated quotation or an undeclared source is refused rather than
 *     reviewed.
 *   - with no `--context`, a present `based_on_version` is a warning because the version
 *     cannot then be checked; it is never silently accepted.
 *
 * A profile is a proposal and never evidence: this module checks the structure and the
 * declared support of a craft proposal, and it cannot make a voice, a device or an
 * observation part of the book. Only an accepted chapter does that. The validator writes
 * nothing and accepts no output path, so a profile can never be written back over its
 * input, the packet or an accepted proposal (`docs/contracts.md` §8.1, §8.4).
 */

import { isPlainObject, loadPacket, nonEmptyString, normalizeId, structuredError } from './packet.mjs';
import {
  validateCalibration,
  validateComponents,
  verifyComponentEvidence,
} from './components.mjs';

export const PROFILE_SCHEMA = 'profile.v1';

/** The accepted content identity of `docs/contracts.md` §8.2: a hash, never a universe id. */
export const ACCEPTED_VERSION_ID = /^sha256:[0-9a-f]{64}$/;

/** The metrics-side evaluation configuration; a different document, not a prose profile. */
export const EVALUATION_PROFILE_SCHEMA = 'assessment-profile.v1';

/** Document kinds a profile must not be mistaken for. */
export const FOREIGN_SCHEMAS = new Map([
  [EVALUATION_PROFILE_SCHEMA, 'an evaluation configuration (scripta-metrics-report)'],
  ['assessment-input.v1', 'an assessment packet manifest'],
  ['assessment-input.v2', 'an assessment packet manifest'],
  ['assessment-result.v1', 'an assessment result'],
  ['design.v1', 'a story-design brief (scripta-story-design)'],
  ['annotations.v1', 'a metrics annotations bundle'],
  ['corpus.v1', 'a corpus manifest'],
  ['continuity-result.v1', 'a continuity result'],
]);

/** `scope.kind` values that belong to the evaluation configuration, not to a prose profile. */
const EVALUATION_SCOPE_KINDS = new Set(['scene', 'chapter', 'arc', 'book']);

/**
 * Language codes. MUST stay in sync with src/config.mjs LANGUAGES; this skill
 * deliberately does not import src/, so the list is duplicated here.
 */
const LANGUAGES = Object.freeze([
  'ro', 'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'pl',
  'cs', 'hu', 'bg', 'el', 'uk', 'ru', 'tr', 'ja', 'zh',
]);
const LANGUAGE_CODES = new Set(LANGUAGES);

/** True when the document carries the evaluation configuration's own fields. */
function looksLikeEvaluationConfiguration(profile) {
  if (profile.aggregation !== undefined && profile.aggregation !== null) {
    return true;
  }
  return isPlainObject(profile.scope) && EVALUATION_SCOPE_KINDS.has(profile.scope.kind);
}

// Validates the profile's structural types and identifier rules, and returns the
// well-formed expressive components whose quoted evidence a packet pass may then locate.
// It performs no aesthetic judgement: any prose description is valid as long as the
// structure holds.
export function validateProfile(profile, errors) {
  const invalid = (text) => structuredError('INVALID_PROFILE', text);
  const components = [];
  if (profile.schema_version !== PROFILE_SCHEMA) {
    const foreign = FOREIGN_SCHEMAS.get(profile.schema_version);
    if (foreign !== undefined) {
      errors.push(
        structuredError(
          'SCHEMA_VERSION',
          `schema_version ${JSON.stringify(profile.schema_version)} names ${foreign}, not a prose profile; ` +
            `this validator only accepts "${PROFILE_SCHEMA}"`,
        ),
      );
    } else {
      errors.push(
        structuredError(
          'SCHEMA_VERSION',
          `schema_version must be "${PROFILE_SCHEMA}" (got ${JSON.stringify(profile.schema_version)})`,
        ),
      );
    }
    return { components };
  }

  if (looksLikeEvaluationConfiguration(profile)) {
    errors.push(
      structuredError(
        'SCHEMA_VERSION',
        `this document carries the evaluation configuration's own fields (aggregation/scope) under ` +
          `"${PROFILE_SCHEMA}"; it is an evaluation configuration ("${EVALUATION_PROFILE_SCHEMA}", ` +
          'scripta-metrics-report), not a prose profile, and was not validated against prose rules',
      ),
    );
    return { components };
  }

  if (typeof profile.profile_id !== 'string' || profile.profile_id.trim() === '') {
    errors.push(invalid(`profile_id must be a non-empty string`));
  }

  if (typeof profile.language !== 'string' || profile.language.trim() === '') {
    errors.push(invalid(`language must be a non-empty string`));
  } else if (!LANGUAGE_CODES.has(profile.language)) {
    errors.push(invalid(`unsupported language code "${profile.language}" (supported: ${LANGUAGES.join(', ')})`));
  }

  if (typeof profile.reader_experience !== 'string' || profile.reader_experience.trim() === '') {
    errors.push(invalid(`reader_experience must be a non-empty string`));
  }

  if (typeof profile.narrator !== 'string' || profile.narrator.trim() === '') {
    errors.push(invalid(`narrator must be a non-empty string`));
  }

  if (profile.based_on_version !== undefined) {
    if (!nonEmptyString(profile.based_on_version)) {
      errors.push(invalid(`based_on_version must be a non-empty string when present`));
    } else if (!ACCEPTED_VERSION_ID.test(profile.based_on_version.trim())) {
      errors.push(
        structuredError(
          'INVALID_BASED_ON_VERSION',
          `based_on_version ${JSON.stringify(profile.based_on_version.trim())} is not an accepted content ` +
            `identity (docs/contracts.md §8.2, "sha256:<64 hex>"); a universe id or a folder name identifies ` +
            'the book, not the accepted version of its content, and cannot be compared with a packet',
        ),
      );
    }
  }

  if (profile.register !== undefined && typeof profile.register !== 'string') {
    errors.push(invalid(`register must be a string when present`));
  }

  // character_voices: each entry declares an entity by entity_id.
  const declaredIds = new Set();
  if (profile.character_voices !== undefined) {
    if (!Array.isArray(profile.character_voices)) {
      errors.push(invalid(`character_voices must be an array`));
    } else {
      profile.character_voices.forEach((entry, idx) => {
        if (!isPlainObject(entry)) {
          errors.push(invalid(`character_voices[${idx}] must be an object`));
          return;
        }
        if (typeof entry.entity_id !== 'string' || entry.entity_id.trim() === '') {
          errors.push(invalid(`character_voices[${idx}].entity_id must be a non-empty string`));
        } else if (declaredIds.has(normalizeId(entry.entity_id))) {
          errors.push(
            structuredError(
              'DUPLICATE_ID',
              `duplicate entity_id "${normalizeId(entry.entity_id)}" in character_voices`,
            ),
          );
        } else {
          declaredIds.add(normalizeId(entry.entity_id));
        }
        if (typeof entry.notes !== 'string' || entry.notes.trim() === '') {
          errors.push(invalid(`character_voices[${idx}].notes must be a non-empty string`));
        }
        if (entry.speech_habit !== undefined && typeof entry.speech_habit !== 'string') {
          errors.push(invalid(`character_voices[${idx}].speech_habit must be a string when present`));
        }
      });
    }
  }

  // recurring_devices: each entry requires device and purpose.
  const devices = new Set();
  if (profile.recurring_devices !== undefined) {
    if (!Array.isArray(profile.recurring_devices)) {
      errors.push(invalid(`recurring_devices must be an array`));
    } else {
      profile.recurring_devices.forEach((entry, idx) => {
        if (!isPlainObject(entry)) {
          errors.push(invalid(`recurring_devices[${idx}] must be an object`));
          return;
        }
        if (typeof entry.device !== 'string' || entry.device.trim() === '') {
          errors.push(invalid(`recurring_devices[${idx}].device must be a non-empty string`));
        } else if (devices.has(normalizeId(entry.device))) {
          errors.push(
            structuredError('DUPLICATE_ID', `duplicate device "${normalizeId(entry.device)}" in recurring_devices`),
          );
        } else {
          devices.add(normalizeId(entry.device));
        }
        if (typeof entry.purpose !== 'string' || entry.purpose.trim() === '') {
          errors.push(invalid(`recurring_devices[${idx}].purpose must be a non-empty string`));
        }
      });
    }
  }

  // revision_priorities: free-form strings.
  if (profile.revision_priorities !== undefined) {
    if (!Array.isArray(profile.revision_priorities)) {
      errors.push(invalid(`revision_priorities must be an array`));
    } else {
      profile.revision_priorities.forEach((item, idx) => {
        if (typeof item !== 'string') {
          errors.push(invalid(`revision_priorities[${idx}] must be a string`));
        }
      });
    }
  }

  // focalization: an object (mode, limits, optional focal_character entity
  // reference) or a plain prose string.
  if (profile.focalization !== undefined) {
    if (isPlainObject(profile.focalization)) {
      const focalization = profile.focalization;
      if (focalization.mode !== undefined && typeof focalization.mode !== 'string') {
        errors.push(invalid(`focalization.mode must be a string when present`));
      }
      if (focalization.limits !== undefined && typeof focalization.limits !== 'string') {
        errors.push(invalid(`focalization.limits must be a string when present`));
      }
      if (focalization.focal_character !== undefined) {
        if (typeof focalization.focal_character !== 'string') {
          errors.push(invalid(`focalization.focal_character must be a string when present`));
        } else if (
          focalization.focal_character.trim() !== '' &&
          !declaredIds.has(normalizeId(focalization.focal_character))
        ) {
          errors.push(
            invalid(
              `focalization.focal_character references undeclared entity_id ` +
                `"${focalization.focal_character.trim()}"`,
            ),
          );
        }
      }
    } else if (typeof profile.focalization !== 'string') {
      errors.push(invalid(`focalization must be an object or a string`));
    }
  }

  // profile_id and entity_ids share one identifier namespace.
  if (typeof profile.profile_id === 'string' && profile.profile_id.trim() !== '') {
    const profileId = normalizeId(profile.profile_id);
    if (declaredIds.has(profileId)) {
      errors.push(
        structuredError(
          'DUPLICATE_ID',
          `duplicate identifier: profile_id "${profileId}" collides with a declared entity_id`,
        ),
      );
    }
  }

  // The evidence-bearing records the profile may carry: expressive component annotations
  // and the calibration readiness that licenses their use.
  components.push(...validateComponents(profile, errors));
  validateCalibration(profile, errors);

  return { components };
}

/**
 * Loads the `--context` packet, compares the profile's `based_on_version` with the packet's
 * accepted version identity (§8.2) and locates the quoted support of every expressive
 * component in the packet file it names. A packet refusal, a stale version or unverified
 * evidence is an error (exit 2); a profile that names no source version is a warning.
 *
 * Returns the record of what the packet covered — its version and its declared scope — so
 * that the result envelope can state which accepted version the profile was checked
 * against; null when no packet could be loaded.
 */
export async function validateContext(contextPath, profile, components, errors, warnings) {
  const { errors: packetErrors, packet } = await loadPacket(contextPath);
  if (packet === null) {
    errors.push(...packetErrors);
    return null;
  }

  await verifyComponentEvidence(components, packet, errors);

  const basedOn = nonEmptyString(profile.based_on_version) ? profile.based_on_version.trim() : null;
  if (basedOn === null) {
    warnings.push(
      '--context was provided but the profile has no based_on_version: the accepted version the profile ' +
        'describes was not cross-checked',
    );
  } else if (basedOn !== packet.version) {
    errors.push(
      structuredError(
        'STALE_BASED_ON_VERSION',
        `based_on_version "${basedOn}" does not match the accepted version "${packet.version}" of ` +
          `universe "${packet.universeId}"; the profile was written for a different accepted version of ` +
          'the same book',
      ),
    );
  }

  return {
    universe_id: packet.universeId,
    version: packet.version,
    scope: {
      kind: packet.scope.kind,
      chapters: Array.isArray(packet.scope.chapters) ? [...packet.scope.chapters] : [],
      omitted: Array.isArray(packet.scope.omitted) ? [...packet.scope.omitted] : [],
      note: nonEmptyString(packet.scope.note) ? packet.scope.note : null,
    },
  };
}

/**
 * The warning for a profile whose source version cannot be checked because no packet was
 * supplied, so an unchecked version never passes silently.
 */
export function uncheckedVersionWarning(profile) {
  if (!isPlainObject(profile) || !nonEmptyString(profile.based_on_version)) {
    return null;
  }
  return (
    `based_on_version "${profile.based_on_version.trim()}" is set but --context was not provided: the ` +
    'accepted version was not checked; pass --context <assessment-input.v2 packet> to prove the profile ' +
    'is not stale'
  );
}

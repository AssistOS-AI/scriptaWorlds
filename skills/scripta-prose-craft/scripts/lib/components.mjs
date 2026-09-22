/**
 * components.mjs — the evidence-bearing records a prose profile may carry: the expressive
 * component annotations of a craft inspection and the profile's calibration readiness
 * (`astra_tasks.md` C13, C17 and C34).
 *
 * A craft observation is not a number and not a bare adjective. Every component an
 * inspection declares names the layer it belongs to, the passage it is anchored to, the
 * evaluator and method that judged it, its status, its rationale and the quoted evidence
 * that supports it; an uncertain or unresolved reading states its limitation, and an
 * alternative reading is preserved instead of being collapsed into the observation. When
 * `--context` supplies a packet, every quote is located verbatim in the packet file it
 * names, so a fabricated quotation is refused instead of being reviewed. Schema validation
 * cannot prove a judgement correct; it ensures that the declared support exists.
 *
 * Calibration readiness is recorded rather than assumed: a profile is uncalibrated unless
 * it states otherwise, a calibrated profile names its protocol version and the evidence
 * behind it, and `intended_use: "production"` is refused until that evidence is present,
 * because completing this code does not establish that a calibration exists.
 */

import { isPlainObject, nonEmptyString, normalizeId, readPacketText, structuredError } from './packet.mjs';

/** The expressive layers of `references/narrative-blocks.md` a profile may annotate. */
export const COMPONENT_KINDS = Object.freeze([
  'focalization',
  'description',
  'dialogue',
  'narration',
  'interior_monologue',
  'rhythm',
]);
const COMPONENT_KIND_SET = new Set(COMPONENT_KINDS);

/** `not_applicable` is the only status that needs no evidence: nothing was observed. */
export const COMPONENT_STATUSES = Object.freeze(['observed', 'uncertain', 'unresolved', 'not_applicable']);
const COMPONENT_STATUS_SET = new Set(COMPONENT_STATUSES);
const LIMITATION_STATUSES = new Set(['uncertain', 'unresolved']);

export const CALIBRATION_STATUSES = Object.freeze(['uncalibrated', 'experimental', 'calibrated']);
const CALIBRATION_STATUS_SET = new Set(CALIBRATION_STATUSES);

export const INTENDED_USES = Object.freeze(['draft', 'review', 'production']);
const INTENDED_USE_SET = new Set(INTENDED_USES);

function message(code, text) {
  return structuredError(code, text);
}

// Validates the structure of `expressive_components` and returns the component entries
// whose quotes a later pass may verify against a packet.
export function validateComponents(profile, errors) {
  const components = [];
  if (profile.expressive_components === undefined) {
    return components;
  }
  if (!Array.isArray(profile.expressive_components)) {
    errors.push(message('INVALID_PROFILE', 'expressive_components must be an array'));
    return components;
  }

  const seenIds = new Set();
  profile.expressive_components.forEach((entry, index) => {
    const at = `expressive_components[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(message('INVALID_PROFILE', `${at} must be an object`));
      return;
    }

    const componentId = nonEmptyString(entry.component_id) ? normalizeId(entry.component_id) : null;
    if (componentId === null) {
      errors.push(message('INVALID_PROFILE', `${at}.component_id must be a non-empty string`));
    } else if (seenIds.has(componentId)) {
      errors.push(message('DUPLICATE_ID', `duplicate component_id "${componentId}" in expressive_components`));
    } else {
      seenIds.add(componentId);
    }

    if (!COMPONENT_KIND_SET.has(entry.component)) {
      errors.push(
        message(
          'INVALID_PROFILE',
          `${at}.component ${JSON.stringify(entry.component)} is not one of: ${COMPONENT_KINDS.join(', ')}`,
        ),
      );
    }
    if (!nonEmptyString(entry.anchor)) {
      errors.push(message('INVALID_PROFILE', `${at}.anchor must name the passage the observation is anchored to`));
    }
    if (!COMPONENT_STATUS_SET.has(entry.status)) {
      errors.push(
        message('INVALID_PROFILE', `${at}.status must be one of: ${COMPONENT_STATUSES.join(', ')}`),
      );
    }
    if (!nonEmptyString(entry.evaluator)) {
      errors.push(message('INVALID_PROFILE', `${at}.evaluator must name who judged the component`));
    }
    if (entry.method !== undefined && !nonEmptyString(entry.method)) {
      errors.push(message('INVALID_PROFILE', `${at}.method must be a non-empty string when present`));
    }
    if (!nonEmptyString(entry.rationale)) {
      errors.push(message('INVALID_PROFILE', `${at}.rationale must be a non-empty string`));
    }
    if (LIMITATION_STATUSES.has(entry.status) && !nonEmptyString(entry.uncertainty)) {
      errors.push(
        message('INVALID_PROFILE', `${at}.uncertainty must state the limitation of a "${entry.status}" reading`),
      );
    }
    if (entry.alternatives !== undefined) {
      if (!Array.isArray(entry.alternatives)) {
        errors.push(message('INVALID_PROFILE', `${at}.alternatives must be an array when present`));
      } else {
        entry.alternatives.forEach((alternative, altIndex) => {
          if (!nonEmptyString(alternative)) {
            errors.push(
              message('INVALID_PROFILE', `${at}.alternatives[${altIndex}] must be a non-empty string`),
            );
          }
        });
      }
    }

    const evidence = entry.evidence;
    if (evidence !== undefined && !Array.isArray(evidence)) {
      errors.push(message('INVALID_PROFILE', `${at}.evidence must be an array when present`));
    } else if (entry.status === 'not_applicable') {
      if (Array.isArray(evidence) && evidence.length > 0) {
        errors.push(
          message(
            'INVALID_PROFILE',
            `${at} is "not_applicable" but declares evidence; a component with no observation has none to cite`,
          ),
        );
      }
    } else if (entry.status !== undefined && Array.isArray(evidence) && evidence.length === 0) {
      errors.push(message('INVALID_PROFILE', `${at}.evidence must not be empty for a "${entry.status}" component`));
    } else if (!Array.isArray(evidence) && entry.status !== undefined && entry.status !== 'not_applicable') {
      errors.push(
        message('INVALID_PROFILE', `${at}.evidence is required for a "${entry.status}" component`),
      );
    } else if (Array.isArray(evidence)) {
      evidence.forEach((item, evidenceIndex) => {
        const evidenceAt = `${at}.evidence[${evidenceIndex}]`;
        if (!isPlainObject(item)) {
          errors.push(message('INVALID_PROFILE', `${evidenceAt} must be an object`));
          return;
        }
        if (!nonEmptyString(item.source)) {
          errors.push(message('INVALID_PROFILE', `${evidenceAt}.source must name the file the quote comes from`));
        }
        if (!nonEmptyString(item.quote)) {
          errors.push(message('INVALID_PROFILE', `${evidenceAt}.quote must be the quoted evidence`));
        }
      });
    }

    if (componentId !== null && Array.isArray(evidence) && evidence.length > 0 && entry.status !== 'not_applicable') {
      components.push({ componentId, at, evidence });
    }
  });

  return components;
}

/**
 * Locates every declared quote in the packet file it names. A source the packet does not
 * declare, or a quote absent from that file, is refused: unverified support must not enter
 * a review as if it had been checked.
 */
export async function verifyComponentEvidence(components, packet, errors) {
  for (const component of components) {
    for (let index = 0; index < component.evidence.length; index += 1) {
      const item = component.evidence[index];
      if (!isPlainObject(item) || !nonEmptyString(item.source) || !nonEmptyString(item.quote)) {
        continue;
      }
      const source = item.source.trim();
      const text = await readPacketText(packet, source);
      if (text === null) {
        errors.push(
          message(
            'UNVERIFIED_EVIDENCE',
            `${component.at}.evidence[${index}].source "${source}" is not a file the packet declares for ` +
              `universe "${packet.universeId}"`,
          ),
        );
        continue;
      }
      const quote = item.quote.trim();
      if (!text.includes(quote)) {
        errors.push(
          message(
            'EVIDENCE_NOT_FOUND',
            `${component.at}.evidence[${index}].quote was not found verbatim in "${source}": ` +
              `${JSON.stringify(quote.slice(0, 80))}`,
          ),
        );
      }
    }
  }
}

/** The warning for a profile whose quoted support cannot be checked without a packet. */
export function uncheckedEvidenceWarning(profile) {
  if (!isPlainObject(profile) || !Array.isArray(profile.expressive_components)) {
    return null;
  }
  const declaresEvidence = profile.expressive_components.some(
    (entry) => isPlainObject(entry) && Array.isArray(entry.evidence) && entry.evidence.length > 0,
  );
  if (!declaresEvidence) {
    return null;
  }
  return (
    'expressive_components declare quoted evidence but --context was not provided: the declared support was ' +
    'not located in a packet, so it is unverified'
  );
}

/** Validates the recorded calibration readiness and the intended use it licenses. */
export function validateCalibration(profile, errors) {
  const calibration = profile.calibration;
  let status = 'uncalibrated';
  let licensed = false;
  if (calibration !== undefined) {
    if (!isPlainObject(calibration)) {
      errors.push(message('INVALID_PROFILE', 'calibration must be an object when present'));
    } else {
      if (!CALIBRATION_STATUS_SET.has(calibration.status)) {
        errors.push(
          message('INVALID_PROFILE', `calibration.status must be one of: ${CALIBRATION_STATUSES.join(', ')}`),
        );
      } else {
        status = calibration.status;
      }
      if (calibration.protocol_version !== undefined && !nonEmptyString(calibration.protocol_version)) {
        errors.push(message('INVALID_PROFILE', 'calibration.protocol_version must be a non-empty string'));
      }
      if (calibration.note !== undefined && !nonEmptyString(calibration.note)) {
        errors.push(message('INVALID_PROFILE', 'calibration.note must be a non-empty string when present'));
      }
      let evidence = calibration.evidence;
      if (evidence !== undefined && !Array.isArray(evidence)) {
        errors.push(message('INVALID_PROFILE', 'calibration.evidence must be an array when present'));
        evidence = undefined;
      } else if (Array.isArray(evidence)) {
        evidence.forEach((item, index) => {
          const at = `calibration.evidence[${index}]`;
          if (!isPlainObject(item)) {
            errors.push(message('INVALID_PROFILE', `${at} must be an object`));
            return;
          }
          if (!nonEmptyString(item.source)) {
            errors.push(message('INVALID_PROFILE', `${at}.source must be a non-empty string`));
          }
          if (!nonEmptyString(item.note)) {
            errors.push(message('INVALID_PROFILE', `${at}.note must be a non-empty string`));
          }
        });
      }

      if (status === 'experimental' && !nonEmptyString(calibration.protocol_version)) {
        errors.push(
          message(
            'CALIBRATION_INCOMPLETE',
            'calibration.status "experimental" must name the protocol_version it follows; it is a research ' +
              'profile and its results are not validated',
          ),
        );
      }
      if (status === 'calibrated') {
        const hasEvidence =
          Array.isArray(evidence) &&
          evidence.length > 0 &&
          evidence.every((item) => isPlainObject(item) && nonEmptyString(item.source) && nonEmptyString(item.note));
        const hasProtocol = nonEmptyString(calibration.protocol_version);
        if (!hasProtocol) {
          errors.push(
            message(
              'CALIBRATION_INCOMPLETE',
              'calibration.status "calibrated" must name the protocol_version it was calibrated under',
            ),
          );
        }
        if (!hasEvidence) {
          errors.push(
            message(
              'CALIBRATION_INCOMPLETE',
              'calibration.status "calibrated" must cite the evidence behind it: a non-empty calibration.evidence ' +
                'whose entries name a source and a note',
            ),
          );
        }
        // Only a calibration that actually carries its protocol and its evidence licenses a
        // production use; a declared status alone licenses nothing.
        licensed = hasProtocol && hasEvidence;
      }
    }
  }

  if (profile.intended_use !== undefined && !INTENDED_USE_SET.has(profile.intended_use)) {
    errors.push(message('INVALID_PROFILE', `intended_use must be one of: ${INTENDED_USES.join(', ')}`));
    return;
  }
  if (profile.intended_use === 'production' && !licensed) {
    errors.push(
      message(
        'UNCALIBRATED_PROFILE',
        `intended_use "production" requires a calibrated profile that names its protocol version and the ` +
          `evidence behind it; this profile records "${status}". Calibration evidence (astra_tasks.md C34) does ` +
          'not exist yet, so the profile stays advisory and cannot authorize a production use',
      ),
    );
  }
}

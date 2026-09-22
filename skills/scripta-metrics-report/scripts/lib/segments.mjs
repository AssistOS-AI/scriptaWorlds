/**
 * Segment records (C12): resolvable scene and arc boundaries.
 *
 * A segment is one narrative unit of the packet: a `scene`, a `sequence`, a
 * whole `chapter`, or an `arc` that selects scenes through an explicit
 * membership list. Every record carries
 *
 *   - a validated byte range `[start, end)` inside one declared chapter file,
 *   - the chapter it belongs to,
 *   - a `provenance` of `declared` (the boundary was given) or `inferred`
 *     (defaulted from the chapter file), which is preserved into the bundle so
 *     an inferred boundary is always reported as inferred,
 *   - an ordered set of expressive labels,
 *   - the disclosure order (declaration order) and, when a `story_order` is
 *     supplied, the story chronology, so a non-linear text keeps the two apart.
 *
 * Ids must be unique, a segment must lie inside the chapter it claims, and an
 * arc must name accepted member scenes.
 */

import { fail, isNonNegativeInteger, isPositiveInteger, isPlainObject } from './errors.mjs';
import { isUtf8Boundary } from './evidence.mjs';

export const SEGMENT_KINDS = ['scene', 'sequence', 'chapter', 'arc'];
export const SEGMENT_PROVENANCE = ['declared', 'inferred'];
const MEMBER_KINDS = ['sequence', 'arc'];

function readLabels(raw, id) {
  const labels = [];
  if (raw.label !== undefined && raw.label !== null) {
    if (typeof raw.label !== 'string') fail(`segment ${JSON.stringify(id)} label must be a string or null`, 'INVALID_SEGMENTS');
    if (raw.label.length > 0) labels.push(raw.label);
  }
  if (raw.labels !== undefined && raw.labels !== null) {
    if (!Array.isArray(raw.labels) || raw.labels.some((l) => typeof l !== 'string' || l.length === 0)) {
      fail(`segment ${JSON.stringify(id)} labels must be an array of non-empty strings`, 'INVALID_SEGMENTS');
    }
    for (const value of raw.labels) if (!labels.includes(value)) labels.push(value);
  }
  return labels;
}

function readRange(raw, id, chapterFile) {
  const hasStart = raw.start !== undefined && raw.start !== null;
  const hasEnd = raw.end !== undefined && raw.end !== null;
  if (hasStart !== hasEnd) {
    fail(`segment ${JSON.stringify(id)} must declare both start and end, or neither`, 'INVALID_SEGMENTS');
  }
  const bytes = chapterFile.buffer.length;
  if (!hasStart) {
    return { start: 0, end: bytes, declared: false };
  }
  if (!isNonNegativeInteger(raw.start) || !isNonNegativeInteger(raw.end)) {
    fail(`segment ${JSON.stringify(id)} start/end must be non-negative integer byte offsets`, 'INVALID_SEGMENTS');
  }
  if (raw.start > raw.end) {
    fail(`segment ${JSON.stringify(id)} has inverted offsets: start ${raw.start} > end ${raw.end}`, 'INVALID_SEGMENTS');
  }
  if (raw.end > bytes) {
    fail(
      `segment ${JSON.stringify(id)} range [${raw.start},${raw.end}) exceeds ${chapterFile.path} (${bytes} bytes)`,
      'INVALID_SEGMENTS',
    );
  }
  for (const offset of [raw.start, raw.end]) {
    if (!isUtf8Boundary(chapterFile.buffer, offset)) {
      fail(`segment ${JSON.stringify(id)} offset ${offset} is not a UTF-8 code-point boundary`, 'INVALID_SEGMENTS');
    }
  }
  return { start: raw.start, end: raw.end, declared: true };
}

function readMembers(raw, id) {
  if (raw.members === undefined || raw.members === null) return null;
  if (!Array.isArray(raw.members) || raw.members.some((m) => typeof m !== 'string' || m.length === 0)) {
    fail(`segment ${JSON.stringify(id)} members must be an array of segment ids`, 'INVALID_SEGMENTS');
  }
  const seen = new Set();
  for (const member of raw.members) {
    if (member === id) fail(`segment ${JSON.stringify(id)} cannot list itself as a member`, 'INVALID_SEGMENTS');
    if (seen.has(member)) fail(`segment ${JSON.stringify(id)} lists member ${JSON.stringify(member)} twice`, 'INVALID_SEGMENTS');
    seen.add(member);
  }
  return [...raw.members];
}

/**
 * Parse and validate `annotations.segments` against the loaded packet. Throws
 * CliError (exit 2) on any invalid record; the packet is never mutated.
 */
export function parseSegments(raw, packet, label = 'annotations.segments') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${label} must be an array`, 'INVALID_SEGMENTS');

  const seen = new Set();
  const records = [];
  raw.forEach((seg, index) => {
    if (!isPlainObject(seg)) fail(`${label} contains a non-object entry`, 'INVALID_SEGMENTS');
    const id = seg.id;
    if (typeof id !== 'string' || id.length === 0) {
      fail(`${label} entry must have a non-empty string id`, 'INVALID_SEGMENTS');
    }
    if (seen.has(id)) fail(`duplicate segment id ${JSON.stringify(id)}`, 'DUPLICATE_ID');
    seen.add(id);
    if (!SEGMENT_KINDS.includes(seg.kind)) {
      fail(
        `segment ${JSON.stringify(id)} has unknown kind ${JSON.stringify(seg.kind)} (expected ${SEGMENT_KINDS.join('|')})`,
        'INVALID_SEGMENTS',
      );
    }

    const isMemberKind = MEMBER_KINDS.includes(seg.kind);
    let chapter = null;
    if (seg.chapter !== undefined && seg.chapter !== null) {
      if (!isPositiveInteger(seg.chapter)) {
        fail(`segment ${JSON.stringify(id)} chapter must be a positive integer`, 'INVALID_SEGMENTS');
      }
      chapter = seg.chapter;
      if (!packet.chapterByNumber.has(chapter)) {
        fail(
          `segment ${JSON.stringify(id)} claims chapter ${chapter}, which the packet does not contain ` +
            `(accepted chapters: ${packet.inventory.join(', ') || 'none'})`,
          'UNKNOWN_CHAPTER',
        );
      }
    } else if (!isMemberKind) {
      fail(`segment ${JSON.stringify(id)} (kind ${seg.kind}) must declare the chapter it belongs to`, 'INVALID_SEGMENTS');
    }

    let file = null;
    let range = null;
    let provenance = null;
    if (chapter === null && (seg.file !== undefined || seg.start !== undefined || seg.end !== undefined)) {
      fail(
        `segment ${JSON.stringify(id)} (kind ${seg.kind}) declares a file range without the chapter it claims`,
        'INVALID_SEGMENTS',
      );
    }
    if (chapter !== null) {
      const chapterFile = packet.chapterByNumber.get(chapter);
      if (seg.file !== undefined && seg.file !== null) {
        if (typeof seg.file !== 'string' || seg.file.length === 0) {
          fail(`segment ${JSON.stringify(id)} file must be a non-empty string`, 'INVALID_SEGMENTS');
        }
        if (seg.file !== chapterFile.path) {
          fail(
            `segment ${JSON.stringify(id)} names file ${JSON.stringify(seg.file)} but claims chapter ${chapter} ` +
              `(${chapterFile.path}); a segment must lie inside the chapter it claims`,
            'INVALID_SEGMENTS',
          );
        }
      }
      file = chapterFile.path;
      range = readRange(seg, id, chapterFile);
    }

    const declaredProvenance = seg.provenance === undefined || seg.provenance === null ? null : seg.provenance;
    if (declaredProvenance !== null && !SEGMENT_PROVENANCE.includes(declaredProvenance)) {
      fail(
        `segment ${JSON.stringify(id)} provenance must be one of ${SEGMENT_PROVENANCE.join('|')}`,
        'INVALID_SEGMENTS',
      );
    }
    if (range !== null) {
      provenance = declaredProvenance ?? (range.declared && seg.file !== undefined ? 'declared' : 'inferred');
      if (provenance === 'declared' && !range.declared) {
        fail(
          `segment ${JSON.stringify(id)} declares provenance "declared" without an explicit file/start/end range`,
          'INVALID_SEGMENTS',
        );
      }
    } else {
      provenance = declaredProvenance ?? 'inferred';
    }

    let storyOrder = null;
    if (seg.story_order !== undefined && seg.story_order !== null) {
      if (!isNonNegativeInteger(seg.story_order)) {
        fail(`segment ${JSON.stringify(id)} story_order must be a non-negative integer`, 'INVALID_SEGMENTS');
      }
      storyOrder = seg.story_order;
    }

    if (seg.focal_character !== undefined && seg.focal_character !== null && typeof seg.focal_character !== 'string') {
      fail(`segment ${JSON.stringify(id)} focal_character must be a string or null`, 'INVALID_SEGMENTS');
    }

    const members = readMembers(seg, id);
    if (seg.kind === 'arc' && (members === null || members.length === 0)) {
      fail(`segment ${JSON.stringify(id)} is an arc and must declare a non-empty members list of scenes`, 'INVALID_SEGMENTS');
    }

    records.push({
      id,
      kind: seg.kind,
      chapter,
      file,
      start: range === null ? null : range.start,
      end: range === null ? null : range.end,
      bytes: range === null ? null : range.end - range.start,
      provenance,
      labels: readLabels(seg, id),
      focal_character: seg.focal_character === undefined ? null : seg.focal_character,
      members,
      story_order: storyOrder,
      disclosure_index: index,
    });
  });

  // Resolve membership after every record is known, then derive chronology.
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    if (record.members === null) {
      record.chapter_span = record.chapter === null ? null : [record.chapter, record.chapter];
      record.crosses_chapters = false;
      continue;
    }
    const chapters = [];
    for (const memberId of record.members) {
      const member = byId.get(memberId);
      if (!member) {
        fail(`segment ${JSON.stringify(record.id)} lists unknown member ${JSON.stringify(memberId)}`, 'UNKNOWN_SEGMENT');
      }
      if (record.kind === 'arc' && member.kind !== 'scene') {
        fail(
          `arc ${JSON.stringify(record.id)} member ${JSON.stringify(memberId)} is a ${member.kind}, not a scene`,
          'INVALID_SEGMENTS',
        );
      }
      if (member.chapter !== null) chapters.push(member.chapter);
    }
    if (chapters.length === 0) {
      fail(`segment ${JSON.stringify(record.id)} has no member inside an accepted chapter`, 'UNKNOWN_CHAPTER');
    }
    record.chapter_span = [Math.min(...chapters), Math.max(...chapters)];
    record.crosses_chapters = record.chapter_span[0] !== record.chapter_span[1];
  }

  return records;
}

/**
 * Disclosure order (declaration) versus story chronology (`story_order`, with
 * the declaration position as the fallback). `differs` is true when a non-linear
 * text orders the two series differently.
 */
export function segmentOrder(records) {
  if (records.length === 0) return { disclosure: [], story: [], differs: false };
  const disclosure = records.map((record) => record.id);
  const story = records
    .map((record) => ({ id: record.id, key: record.story_order ?? record.disclosure_index }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.id);
  const differs = disclosure.some((id, index) => story[index] !== id);
  return { disclosure, story, differs };
}

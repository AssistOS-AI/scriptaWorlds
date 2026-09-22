/**
 * C11/C12: turn the resolved selection into candidate units.
 *
 * A unit is a maximal run of selected tokens that is contiguous in the source
 * bytes. A whole chapter yields one unit; a scene or arc selection yields one
 * unit per contiguous run of its byte ranges, so two selected ranges that are
 * not adjacent never produce a match that straddles the gap, and each match
 * stays inside one source segment's contiguous bytes.
 *
 * Only the selected ranges contribute tokens: earlier chapters supplied as
 * context are never counted as candidate text.
 */

import { tokenize } from './tokenize.mjs';

/**
 * `packet` is a loaded packet, `selection` a resolved selection. `language` is
 * the language of the fiction. Returns
 *   { supported, reason, units, eligible_tokens, files }
 * where `units` are `{ id, file, chapter, segment_ids, tokens, spans, indexes }`
 * and `indexes` are the token positions inside the file's full token list.
 */
export function buildCandidateUnits({ packet, selection, language }) {
  const rangesByFile = new Map();
  for (const range of selection.ranges) {
    if (!rangesByFile.has(range.file)) rangesByFile.set(range.file, []);
    rangesByFile.get(range.file).push(range);
  }

  const files = [];
  const units = [];
  let eligible = 0;
  let unitNumber = 0;

  for (const [file, ranges] of rangesByFile) {
    const entry = packet.fileByPath.get(file);
    files.push({ path: file, chapter: entry.chapter, sha256: entry.sha256, bytes: entry.bytes });
    const tokenized = tokenize(entry.buffer, `chapter ${file}`, { language });
    if (!tokenized.supported) {
      return { supported: false, reason: tokenized.missing_reason, units: [], eligible_tokens: 0, files };
    }
    const selected = [];
    tokenized.spans.forEach((span, index) => {
      if (ranges.some((range) => span.start >= range.start && span.end <= range.end)) selected.push(index);
    });
    eligible += selected.length;

    let group = [];
    const flush = () => {
      if (group.length === 0) return;
      unitNumber += 1;
      const segmentIds = new Set();
      for (const index of group) {
        const span = tokenized.spans[index];
        for (const range of ranges) {
          if (span.start >= range.start && span.end <= range.end && range.segment !== undefined) {
            segmentIds.add(range.segment);
          }
        }
      }
      units.push({
        id: `unit-${unitNumber}`,
        file,
        chapter: entry.chapter,
        segment_ids: [...segmentIds],
        tokens: group.map((index) => tokenized.tokens[index]),
        spans: group.map((index) => ({ start: tokenized.spans[index].start, end: tokenized.spans[index].end })),
        indexes: group.slice(),
      });
      group = [];
    };
    for (const index of selected) {
      if (group.length > 0 && index !== group[group.length - 1] + 1) flush();
      group.push(index);
    }
    flush();
  }

  return { supported: true, reason: null, units, eligible_tokens: eligible, files };
}

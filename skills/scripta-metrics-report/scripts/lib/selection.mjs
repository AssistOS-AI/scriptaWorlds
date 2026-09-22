/**
 * C11/C12: resolve the requested scope against the packet's accepted inventory
 * before anything is measured.
 *
 * The resolved selection is the only source of candidate text: it fixes the
 * chapter set, the byte ranges inside those chapters, the eligible-token
 * population, the CAR output population, the continuity input and the evidence
 * coverage. Chapters of the packet that stay outside the selection are recorded
 * as context: available to explain a fact, never counted as candidate words.
 *
 * A scene scope must name its segments and an arc scope must name arcs whose
 * membership resolves to accepted scenes; neither falls back to every chapter.
 */

import { fail, isPositiveInteger } from './errors.mjs';

function resolveChapterList(raw, label, inventorySet) {
  if (!Array.isArray(raw)) fail(`${label} must be an array of chapter numbers`, 'INVALID_PROFILE');
  const seen = new Set();
  for (const value of raw) {
    if (!isPositiveInteger(value)) {
      fail(`${label} must contain positive chapter numbers, got ${JSON.stringify(value)}`, 'INVALID_PROFILE');
    }
    if (seen.has(value)) fail(`${label} contains duplicate chapter ${value}`, 'INVALID_PROFILE');
    seen.add(value);
    if (!inventorySet.has(value)) {
      fail(
        `${label} names chapter ${value}, which the packet does not contain ` +
          `(accepted chapters: ${[...inventorySet].sort((a, b) => a - b).join(', ') || 'none'})`,
        'UNKNOWN_CHAPTER',
      );
    }
  }
  return [...raw].sort((a, b) => a - b);
}

function resolveByIds(ids, label, kind, byId) {
  const resolved = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      fail(`${label} must contain non-empty segment ids`, 'INVALID_PROFILE');
    }
    const segment = byId.get(id);
    if (!segment) fail(`${label} names unknown segment ${JSON.stringify(id)}`, 'UNKNOWN_SEGMENT');
    if (segment.kind !== kind) {
      fail(`${label} names ${JSON.stringify(id)}, a ${segment.kind}; a ${kind} scope requires ${kind} segments`, 'INVALID_SCOPE');
    }
    resolved.push(segment);
  }
  return resolved;
}

function rangeOf(segment) {
  return { file: segment.file, chapter: segment.chapter, start: segment.start, end: segment.end };
}

function buildNote({ packetScope, selectionChapters, packetInventory }) {
  const parts = [];
  if (packetScope.kind === 'partial') {
    parts.push(
      `packet scope is partial; omitted chapters: ${packetScope.omitted.join(', ') || 'none declared'}`,
    );
  } else if (packetScope.kind === 'textual_only') {
    parts.push('packet carries chapter prose alone (textual_only): no canon, threads or atlas container was available');
  }
  if (packetScope.note) parts.push(packetScope.note);
  const outside = packetInventory.filter((chapter) => !selectionChapters.includes(chapter));
  if (outside.length > 0 && packetScope.kind !== 'partial' && packetScope.kind !== 'textual_only') {
    parts.push(
      `the selection covers chapters ${selectionChapters.join(', ')}; chapters ${outside.join(', ')} of the packet ` +
        'are available as context only and are not counted as candidate text',
    );
  }
  return parts.length === 0 ? null : parts.join('; ');
}

export function resolveSelection({ packet, profile, segments }) {
  const scope = profile.scope;
  const inventory = packet.inventory;
  const inventorySet = new Set(inventory);
  const byId = new Map(segments.map((segment) => [segment.id, segment]));

  let chapters;
  let segmentIds = [];
  let ranges = [];
  let outputIds;
  const derivedContext = [];

  if (scope.kind === 'book') {
    if (packet.scope.kind !== 'complete') {
      fail(
        `a book scope requires a complete packet; the packet declares scope.kind ` +
          `${JSON.stringify(packet.scope.kind)}`,
        'INCOMPLETE_PACKET',
      );
    }
    if (inventory.length === 0) fail('a book scope requires at least one accepted chapter', 'INCOMPLETE_PACKET');
    if (scope.chapters.length > 0) {
      resolveChapterList(scope.chapters, 'profile.scope.chapters', inventorySet);
    }
    chapters = [...inventory];
    outputIds = chapters.map(String);
    ranges = chapters.map((chapter) => {
      const file = packet.chapterByNumber.get(chapter);
      return { chapter, file: file.path, start: 0, end: file.buffer.length };
    });
  } else if (scope.kind === 'chapter') {
    if (scope.chapters.length === 0) {
      fail('a chapter scope must name the chapters it covers in profile.scope.chapters', 'INVALID_PROFILE');
    }
    chapters = resolveChapterList(scope.chapters, 'profile.scope.chapters', inventorySet);
    outputIds = chapters.map(String);
    ranges = chapters.map((chapter) => {
      const file = packet.chapterByNumber.get(chapter);
      return { chapter, file: file.path, start: 0, end: file.buffer.length };
    });
  } else {
    const isScene = scope.kind === 'scene';
    const wanted = isScene ? profile.scope.segments : profile.scope.arcs;
    const label = isScene ? 'profile.scope.segments' : 'profile.scope.arcs';
    if (!Array.isArray(wanted) || wanted.length === 0) {
      fail(
        `a ${scope.kind} scope must name what it covers in ${label}; it must not fall back to every chapter`,
        'INVALID_SCOPE',
      );
    }
    const named = resolveByIds(wanted, label, isScene ? 'scene' : 'arc', byId);
    const sceneIds = [];
    for (const record of named) {
      const memberIds = isScene ? [record.id] : record.members;
      if (!Array.isArray(memberIds) || memberIds.length === 0) {
        fail(`${label} names ${JSON.stringify(record.id)}, which has no member scene`, 'INVALID_SCOPE');
      }
      for (const memberId of memberIds) {
        const member = byId.get(memberId);
        if (!member) fail(`segment ${JSON.stringify(record.id)} lists unknown member ${JSON.stringify(memberId)}`, 'UNKNOWN_SEGMENT');
        if (!inventorySet.has(member.chapter)) {
          fail(
            `segment ${JSON.stringify(record.id)} selects ${JSON.stringify(memberId)} from chapter ${member.chapter}, ` +
              'which the packet does not contain',
            'UNKNOWN_CHAPTER',
          );
        }
        if (!sceneIds.includes(member.id)) sceneIds.push(member.id);
      }
    }
    if (sceneIds.length === 0) {
      fail(`a ${scope.kind} scope resolved to no accepted member scene`, 'INVALID_SCOPE');
    }
    const scenes = sceneIds.map((id) => byId.get(id));
    segmentIds = isScene ? scenes.map((scene) => scene.id) : [...wanted, ...sceneIds];
    chapters = [...new Set(scenes.map((scene) => scene.chapter))].sort((a, b) => a - b);
    outputIds = [...new Set([...wanted, ...sceneIds])];
    ranges = scenes.map(rangeOf);
    const earliest = Math.min(...chapters);
    for (const chapter of inventory) if (chapter < earliest) derivedContext.push(chapter);
  }

  const declaredContext = scope.context_chapters.length > 0
    ? resolveChapterList(scope.context_chapters, 'profile.scope.context_chapters', inventorySet)
    : [];
  for (const chapter of declaredContext) {
    if (chapters.includes(chapter)) {
      fail(
        `profile.scope.context_chapters names chapter ${chapter}, which the selection already covers; ` +
          'context is the material outside the selection',
        'INVALID_PROFILE',
      );
    }
  }
  const contextChapters = [...new Set([...declaredContext, ...derivedContext])]
    .filter((chapter) => !chapters.includes(chapter))
    .sort((a, b) => a - b);

  return {
    kind: scope.kind,
    chapters,
    segmentIds,
    ranges,
    outputIds,
    contextChapters,
    omitted: [...packet.scope.omitted],
    note: buildNote({ packetScope: packet.scope, selectionChapters: chapters, packetInventory: inventory }),
  };
}

// Deterministic integrity checks over a loaded packet (no external dependencies,
// no model). Every finding is `certainty: "deterministic"` and `status:
// "confirmed"` with evidence.v1 items that cite the offending packet bytes.
//
// Chapter references are checked field by field rather than by a generic
// `_chapter` scan, because the fields do not mean the same thing:
//
//   - `asked_chapter`, `created_chapter`, `closed_chapter`, `occurrence_chapter`
//     and an atlas occurrence must name a chapter the packet contains, because
//     they assert accepted material;
//   - `due_chapter` is a deadline of an open thread, and a blueprint destination
//     (`target_chapter`, `destination_chapter`, `chapter_memberships`,
//     `planned_chapters`) is a plan, so both may point forward inside their own
//     contract; only their shape is checked.
//
// A score declared `partial` is honoured: a chapter present in `scope.omitted`
// is a declared omission rather than a missing reference, while a `complete`
// packet that lacks an interior chapter is refused by the loader before this
// module runs.
//
// Evidence is built from the span tree of the parsed file, so a key that repeats
// across objects cites the object that actually offends rather than the first
// occurrence of its key, and every offset lands on a UTF-8 code-point boundary.

import { memberNamed, parseJsonSpans } from './json-spans.mjs';
import { buildEvidence, locateMemberEvidence } from './evidence.mjs';
import { chapterNumberFromPath } from './manifest.mjs';
import { REQUIRED_STATE_ROLES } from './scope.mjs';

const CHAPTER_FILE_RE = /^chapters\/\d{4}-[a-z0-9-]+\.md$/;

// Chapter references that must name accepted material.
const MUST_EXIST_KEYS = new Set(['asked_chapter', 'created_chapter', 'closed_chapter', 'occurrence_chapter']);

// Chapter references that may point forward inside their own contract. Their
// distance from the last accepted chapter is never a defect; a value that is not
// a chapter number still is.
const FORWARD_KEYS = new Set(['due_chapter', 'target_chapter', 'destination_chapter']);

// Lists of planned chapter memberships of a blueprint.
const PLANNED_LIST_KEYS = new Set(['chapter_memberships', 'planned_chapters']);

// Collection keys of the state containers that must be arrays.
const THREADS_COLLECTIONS = ['open', 'closed', 'promises', 'deferred_answers'];

// Roles that hold a proposal: a story design or a prose profile. A proposal is
// not accepted book, so nothing in it is reported as an accepted occurrence.
const BLUEPRINT_ROLES = new Set(['design', 'profile']);

function makeFindingFactory() {
  let counter = 0;
  return (kind, severity, description, evidence, repairSuggestion = null) => {
    counter += 1;
    return {
      id: `continuity.${kind}.${counter}`,
      kind,
      severity,
      certainty: 'deterministic',
      status: 'confirmed',
      description,
      evidence,
      alternative_explanation: null,
      repair_suggestion: repairSuggestion,
    };
  };
}

// Chapter files identified by role or by the chapters/NNNN-slug.md convention.
// The second path matters: a chapter-numbered file that the manifest classified
// as something else is exactly how a stale copy of an accepted chapter survives
// in a packet, and it is a duplicate active chapter rather than a new file.
function extractChapters(files) {
  const chapters = [];
  for (const entry of files.values()) {
    if (entry.role === 'chapter' || CHAPTER_FILE_RE.test(entry.path)) {
      const number = chapterNumberFromPath(entry.path);
      if (number !== null) chapters.push({ number, entry });
    }
  }
  return chapters;
}

function headEvidence(entry) {
  return buildEvidence(entry, 0, Math.min(160, entry.data.length));
}

function parseContainer(entry) {
  try {
    return { root: parseJsonSpans(entry.data), error: null };
  } catch (cause) {
    return { root: null, error: cause };
  }
}

function invalidJsonFinding(entry, error, makeFinding) {
  const offset = Number.isInteger(error.offset) ? error.offset : 0;
  return makeFinding(
    'integrity',
    'major',
    `${entry.path} is not valid JSON: ${error.message}`,
    [buildEvidence(entry, Math.max(0, offset - 40), Math.min(entry.data.length, offset + 120))],
    `Correct the JSON syntax of ${entry.path}; nothing in it was reviewed.`,
  );
}

function duplicateChapterFindings(files, makeFinding) {
  const findings = [];
  const bySlot = new Map();
  for (const { number, entry } of extractChapters(files)) {
    if (!bySlot.has(number)) bySlot.set(number, []);
    bySlot.get(number).push(entry);
  }
  for (const [number, entries] of bySlot) {
    if (entries.length <= 1) continue;
    findings.push(
      makeFinding(
        'integrity',
        'major',
        `Duplicate active chapter number ${String(number).padStart(4, '0')}: ${entries.map((e) => e.path).join(', ')}`,
        entries.map((entry) => headEvidence(entry)),
        'Keep a single canonical file for this chapter number; the other is stale.',
      ),
    );
  }
  return findings;
}

function futureChapterFileFindings(files, lastAccepted, makeFinding) {
  const findings = [];
  for (const { number, entry } of extractChapters(files)) {
    if (number > lastAccepted) {
      findings.push(
        makeFinding(
          'future_reference',
          'major',
          `${entry.path} is numbered ${number}, beyond book.last_accepted_chapter ${lastAccepted}`,
          [headEvidence(entry)],
          'Remove the unaccepted chapter file or advance last_accepted_chapter only through the normal acceptance flow.',
        ),
      );
    }
  }
  return findings;
}

// Walk a span tree, reporting (node, path, member, containerEnd) for every
// value, where `member` is the nearest enclosing object member (so an array
// element can cite the key that introduced it) and `containerEnd` is the end of
// the enclosing object or array, which bounds the evidence window.
function walkSpans(node, path, owner, containerEnd, visit) {
  visit(node, path, owner, containerEnd);
  if (node.type === 'object') {
    for (const member of node.members) {
      walkSpans(member.value, [...path, member.key], member, node.end, visit);
    }
  } else if (node.type === 'array') {
    for (let index = 0; index < node.items.length; index += 1) {
      walkSpans(node.items[index], [...path, index], owner, node.end, visit);
    }
  }
}

function describeValue(node) {
  if (node.type === 'string') return `the string ${JSON.stringify(node.value)}`;
  if (node.type === 'number') return `the number ${node.value}`;
  return `the ${node.type} value`;
}

// Field-specific chapter-reference check over one parsed JSON file.
//
// `mode: 'state'` checks a state container (`threads.json`, `atlas.json`), where
// the listed keys describe accepted material. `mode: 'blueprint'` checks a
// proposal (a story design or a prose profile), where every reference is a plan:
// only the shape of a chapter number is verifiable there, never its existence.
function referenceFindings(entry, root, options) {
  const findings = [];
  const { packet, mode, isAtlas = false, makeFinding } = options;
  const present = new Set(packet.chapterNumbers);
  const omitted = new Set(packet.omitted);
  const lastAccepted = packet.lastAcceptedChapter;
  const blueprint = mode === 'blueprint';

  const shapeFinding = (node, keyStart, end, context, key) =>
    makeFinding(
      'integrity',
      'local',
      `${entry.path} ${context} "${key}" must be a positive integer chapter reference, got ` +
        `${describeValue(node)}`,
      [locateMemberEvidence(entry, keyStart, end, undefined)],
      `Write "${key}" as the number of a chapter, at or above 1.`,
    );

  const existenceFinding = (node, keyStart, end, containerEnd, context, key) => {
    const beyond = node.value > lastAccepted;
    return makeFinding(
      beyond ? 'future_reference' : 'missing_reference',
      'major',
      beyond
        ? `${entry.path} ${context} "${key}" references chapter ${node.value}, beyond ` +
          `book.last_accepted_chapter ${lastAccepted} and outside every chapter in the packet`
        : `${entry.path} ${context} "${key}" references chapter ${node.value}, but the packet contains no ` +
          `chapter ${node.value}`,
      [locateMemberEvidence(entry, keyStart, end, containerEnd)],
      'Point the reference at an accepted chapter present in the packet, or declare the omission in scope.omitted.',
    );
  };

  walkSpans(root, [], null, root.end, (node, path, member, containerEnd) => {
    if (member === null) return;
    const key = member.key;
    const context = `entry ${path.slice(0, -1).join('.')}`;

    if (blueprint) {
      if (FORWARD_KEYS.has(key)) {
        if (!Number.isInteger(node.value) || node.value < 1) {
          findings.push(
            shapeFinding(node, member.keyStart, node.end, context, key),
          );
        }
        return;
      }
      if (PLANNED_LIST_KEYS.has(key) && node.type === 'array') {
        for (let index = 0; index < node.items.length; index += 1) {
          const item = node.items[index];
          if (item.type !== 'number' || !Number.isInteger(item.value) || item.value < 1) {
            findings.push(
              shapeFinding(item, member.keyStart, Math.max(item.end, member.keyStart + 1), context, `${key}[${index}]`),
            );
          }
        }
      }
      // A blueprint names chapters that do not exist yet on purpose, so no
      // existence is ever required of it.
      return;
    }

    if (MUST_EXIST_KEYS.has(key)) {
      if (!Number.isInteger(node.value) || node.value < 1) {
        findings.push(shapeFinding(node, member.keyStart, node.end, context, key));
        return;
      }
      if (omitted.has(node.value) || present.has(node.value)) return;
      findings.push(existenceFinding(node, member.keyStart, node.end, containerEnd, context, key));
      return;
    }

    if (FORWARD_KEYS.has(key)) {
      if (!Number.isInteger(node.value) || node.value < 1) {
        findings.push(shapeFinding(node, member.keyStart, node.end, context, key));
      }
      return;
    }

    if (isAtlas && key === 'chapters' && node.type === 'array') {
      for (let index = 0; index < node.items.length; index += 1) {
        const item = node.items[index];
        const itemLabel = `${key}[${index}]`;
        const keyStart = member.keyStart;
        const end = Math.max(item.end, keyStart + 1);
        if (item.type !== 'number' || !Number.isInteger(item.value) || item.value < 1) {
          findings.push(shapeFinding(item, keyStart, end, context, itemLabel));
          continue;
        }
        if (omitted.has(item.value) || present.has(item.value)) continue;
        findings.push(existenceFinding(item, keyStart, end, containerEnd, context, itemLabel));
      }
    }
  });

  return findings;
}

// Validate a JSON state container: parse, top-level shape and collection keys.
function containerFindings(entry, arrayKeys, makeFinding) {
  const findings = [];
  const { root, error } = parseContainer(entry);
  if (error !== null) {
    findings.push(invalidJsonFinding(entry, error, makeFinding));
    return { findings, root: null };
  }
  if (root.type !== 'object') {
    findings.push(
      makeFinding(
        'integrity',
        'major',
        `${entry.path} must be a JSON object, got ${root.type === 'array' ? 'array' : root.type}`,
        [headEvidence(entry)],
      ),
    );
    return { findings, root: null };
  }
  for (const key of arrayKeys) {
    const member = memberNamed(root, key);
    if (member === null) continue;
    if (member.value.type !== 'array') {
      findings.push(
        makeFinding(
          'integrity',
          'major',
          `${entry.path}.${key} must be an array, got ${member.value.type === 'null' ? 'null' : member.value.type}`,
          [locateMemberEvidence(entry, member.keyStart, member.value.end)],
          `Change "${key}" to an array of entries.`,
        ),
      );
    }
  }
  return { findings, root };
}

function entryFor(files, role, fallbackPath) {
  for (const entry of files.values()) {
    if (entry.role === role) return entry;
  }
  return files.get(fallbackPath) ?? null;
}

// Run every deterministic check. Returns { findings, warnings, chapters }.
export function runDeterministicChecks(packet) {
  const makeFinding = makeFindingFactory();
  const files = packet.files;
  const findings = [];
  const warnings = [];
  const scopeKind = packet.scope.kind;

  findings.push(...duplicateChapterFindings(files, makeFinding));
  findings.push(...futureChapterFileFindings(files, packet.lastAcceptedChapter, makeFinding));

  const threadsEntry = entryFor(files, 'threads', 'threads.json');
  if (threadsEntry) {
    const { findings: shape, root } = containerFindings(threadsEntry, THREADS_COLLECTIONS, makeFinding);
    findings.push(...shape);
    if (root !== null) {
      findings.push(...referenceFindings(threadsEntry, root, { packet, mode: 'state', makeFinding }));
    }
  }

  const atlasEntry = entryFor(files, 'atlas', 'atlas.json');
  if (atlasEntry) {
    const { findings: shape, root } = containerFindings(atlasEntry, ['axes'], makeFinding);
    findings.push(...shape);
    if (root !== null) {
      findings.push(...referenceFindings(atlasEntry, root, { packet, mode: 'state', isAtlas: true, makeFinding }));
    }
  }

  const metaEntry = entryFor(files, 'meta', 'universe.json');
  if (metaEntry) {
    findings.push(...containerFindings(metaEntry, [], makeFinding).findings);
  }

  for (const entry of files.values()) {
    if (!BLUEPRINT_ROLES.has(entry.role)) continue;
    // A story design or a prose profile is a JSON document (`story-design.json`,
    // `prose-profile.json`); a Markdown note an author attached under the same
    // role holds no chapter references to check and is not read as JSON.
    if (!entry.path.endsWith('.json')) continue;
    const { root, error } = parseContainer(entry);
    if (error !== null) {
      findings.push(invalidJsonFinding(entry, error, makeFinding));
    } else if (root !== null) {
      findings.push(...referenceFindings(entry, root, { packet, mode: 'blueprint', makeFinding }));
    }
  }

  const omitList = packet.omitted.length > 0 ? `: ${packet.omitted.join(', ')}` : '';
  if (scopeKind === 'complete') {
    // A complete packet is rejected by the loader when a required role is
    // absent, so this is the defensive twin of that rejection: the review never
    // reports a complete book while quietly missing its canon, threads or atlas.
    const roles = new Set(packet.entries.map((entry) => entry.role));
    for (const role of REQUIRED_STATE_ROLES) {
      if (!roles.has(role)) {
        findings.push(
          makeFinding(
            'integrity',
            'major',
            `the packet claims scope.kind "complete" but carries no ${role} entry`,
            [],
            `Include the ${role} file in the packet, or declare the packet partial.`,
          ),
        );
      }
    }
  } else {
    if (scopeKind === 'partial') {
      warnings.push(
        `The packet is partial${omitList}; chapters declared omitted have no continuity context in this review.`,
      );
    }
    if (scopeKind === 'textual_only') {
      warnings.push(
        'The packet is textual_only: it carries chapter prose and no canon, threads or atlas, so no continuity ' +
          'context was available and nothing here implies a clean book.',
      );
    }
    const presentRoles = new Set(packet.entries.map((entry) => entry.role));
    for (const role of REQUIRED_STATE_ROLES) {
      if (!presentRoles.has(role)) {
        warnings.push(`state container "${role}" is not part of this packet, so it was not checked.`);
      }
    }
  }

  return { findings, warnings, chapters: extractChapters(files) };
}

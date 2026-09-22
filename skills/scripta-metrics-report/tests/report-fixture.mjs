/**
 * A complete, valid v2 assessment fixture for the report suites.
 *
 * Two Romanian chapters, a declared scene and an arc, component-based CS/OI/
 * NCS annotations, an EAP trajectory, a CR training-dataset record with a
 * locally verifiable file, an opt-in timing study (10 -> 12 minutes), a rule
 * registry with outcomes keyed by (rule, output), a continuity result with one
 * finding in the selection and one explained by the context chapter, an
 * indicator, preserved qualities and a small reference corpus.
 */

import { join } from 'node:path';

import { buildPacket, sha256, writeFile as writeFileSync, writeJson } from './helpers.mjs';

export const CHAPTER_1 =
  'Aceasta este o scenă scurtă despre o planetă îndepărtată și un marinar tăcut care privește marea de dimineață.';
export const CHAPTER_2 =
  'Dimineața, marinarul scrie în jurnal despre furtuna care a trecut peste insulă și despre lumina de pe mare.';
export const REFERENCE_TEXT = 'An unrelated English reference with twelve tokens for the lexical comparison here.';
export const REQUEST_TEXT = 'Add a quiet ending | keep the <script> out; use `code` and # headings sparingly.';

function span(bytes, needle, id, file) {
  const start = bytes.indexOf(Buffer.from(needle, 'utf8'));
  if (start < 0) throw new Error(`fixture text does not contain ${needle}`);
  const end = start + Buffer.byteLength(needle);
  return { id, file, sha256: sha256(bytes), start, end, quote: needle };
}

/** Split a chapter buffer into words, so a fixture can anchor on real text. */
function wordsOf(bytes) {
  const text = bytes.toString('utf8');
  const words = text.split(/\s+/).filter((word) => word.length > 1);
  // A script without separators (for example Chinese) has no words to split:
  // the whole text is the anchor, and the tokenizer declares it unsupported.
  return words.length > 0 ? words : [text];
}

/** Prefer a named phrase, else fall back to a word the supplied text really has. */
function pick(bytes, preferred, words, index) {
  for (const candidate of preferred) {
    if (bytes.indexOf(Buffer.from(candidate, 'utf8')) >= 0) return candidate;
  }
  const word = words[Math.max(0, Math.min(index, words.length - 1))];
  if (!word) throw new Error('fixture text needs at least one word to anchor evidence on');
  return word;
}

/** Byte offset just after the `count`th word of the buffer (a segment boundary). */
function afterWord(bytes, count) {
  const text = bytes.toString('utf8');
  let seen = 0;
  let index = 0;
  for (const match of text.matchAll(/\S+/g)) {
    index = match.index + match[0].length;
    seen += 1;
    if (seen >= count) break;
  }
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

export function buildReportFixture(root, options = {}) {
  const text1 = options.chapter1 ?? options.chapters?.[1] ?? CHAPTER_1;
  const text2 = options.chapter2 ?? options.chapters?.[2] ?? CHAPTER_2;
  const chapter1 = Buffer.from(text1, 'utf8');
  const chapter2 = Buffer.from(text2, 'utf8');
  const packetDir = join(root, 'packet');
  const packet = buildPacket(packetDir, {
    chapters: options.chapters ?? { 1: text1, 2: text2 },
    lastAccepted: options.lastAccepted ?? 2,
    scopeKind: options.scopeKind ?? 'complete',
    omitted: options.omitted,
    stateRoles: options.stateRoles,
    language: options.language,
  });

  // Evidence items, with real byte ranges inside the chapter files. The needles
  // prefer the default fixture text and fall back to a word the supplied text
  // really contains, so a test can supply its own chapters.
  const words1 = wordsOf(chapter1);
  const words2 = wordsOf(chapter2);
  const evidence = [
    span(chapter1, pick(chapter1, ['planetă'], words1, 7), 'ev1', 'chapters/0001.md'),
    span(chapter1, pick(chapter1, ['marea'], words1, words1.length - 2), 'ev2', 'chapters/0001.md'),
    span(chapter2, pick(chapter2, ['jurnal'], words2, 3), 'ev3', 'chapters/0002.md'),
    span(chapter1, pick(chapter1, ['marinar'], words1, 11), 'ev4', 'chapters/0001.md'),
  ];
  const firstSentenceEnd = afterWord(chapter1, 5);
  const secondSentenceEnd = afterWord(chapter2, 5);

  const profile = {
    schema_version: 'profile.v1',
    profile_id: 'fixture-profile',
    scope: {
      kind: options.profileScopeKind ?? (options.scopeKind === 'book' ? 'book' : 'chapter'),
      chapters: options.scopeChapters ?? [1],
      context_chapters: options.contextChapters ?? [2],
      ...(options.segments ? { segments: options.segments } : {}),
      ...(options.arcs ? { arcs: options.arcs } : {}),
    },
    aggregation: { enabled: false },
  };
  if (options.profile) Object.assign(profile, options.profile);

  const datasetFile = options.datasetContent ?? 'one training record per line\n';
  writeFileSync(root, 'dataset/corpus.txt', datasetFile);

  const ruleOutputs = options.ruleOutputs ?? [1];
  const annotations = {
    schema_version: 'annotations.v1',
    source_version: packet.version,
    request: REQUEST_TEXT,
    brief: 'Prefer restraint over escalation.',
    evidence,
    segments: [
      { id: 'seg1', chapter: 1, kind: 'scene', label: 'the dock', focal_character: 'marinarul', start: 0, end: firstSentenceEnd, story_order: 1 },
      { id: 'seg2', chapter: 2, kind: 'scene', label: 'the journal', focal_character: 'marinarul', start: 0, end: secondSentenceEnd, story_order: 0 },
      { id: 'arc1', kind: 'arc', label: 'the vigil', members: ['seg1', 'seg2'] },
    ],
    metrics: {
      CS: {
        status: 'judged',
        evaluator: 'human-1',
        dimensions: {
          referential_clarity: { rating: 3, rationale: 'Every referent is recoverable.', evidence: ['ev1'] },
          discourse_connection: { rating: 3, rationale: 'The two sentences connect through the sea.', evidence: ['ev2'] },
          causal_support: { rating: 3, rationale: 'The watching causes the stillness.', evidence: ['ev1'] },
          temporal_intelligibility: { rating: 3, rationale: 'The morning order stays clear after the rearrangement.', evidence: ['ev4'] },
        },
      },
      OI: {
        status: 'judged',
        evaluator: 'human-1',
        comparison_scope: 'declared genre references (none supplied)',
        dimensions: {
          perspective: { rating: 2, rationale: 'A familiar outsider viewpoint, precisely held.', evidence: ['ev1'] },
          dramatic_development: { rating: 2, rationale: 'The scene turns on a small recognition.', evidence: ['ev2'] },
          expression: { rating: 2, rationale: 'Plain diction with one careful image.', evidence: ['ev4'] },
        },
      },
      NCS: {
        status: 'judged',
        evaluator: 'human-1',
        dimensions: {
          novelty: { rating: 3, rationale: 'The dock is described through sound rather than sight.', evidence: ['ev4'] },
          cliche_reliance: { rating: 1, rationale: 'One weathered-mariner figure is conventional but earned.', evidence: ['ev1'] },
        },
      },
      EAP: {
        status: 'judged',
        evaluator: 'human-1',
        emotional_fit: 55,
        ordering: 'story',
        trajectory: [
          {
            segment_id: 'seg2',
            story_order: 0,
            focalization: 'marinarul',
            valence: -1,
            tension: 0,
            uncertainty: 'The quiet register could also read as exhaustion.',
            evidence: ['ev3'],
          },
          {
            segment_id: 'seg1',
            story_order: 1,
            focalization: 'marinarul',
            valence: 1,
            tension: 2,
            uncertainty: 'The lift may be relief rather than hope.',
            evidence: ['ev1'],
          },
        ],
      },
      CR: {
        status: 'judged',
        evaluator: 'author',
        training_dataset: {
          model_identity: 'deepseek/deepseek-v4-flash (provider card)',
          corpus: {
            description: 'documented open subset mirrored locally',
            files: [{ path: 'dataset/corpus.txt', sha256: sha256(Buffer.from(datasetFile, 'utf8')) }],
          },
          evaluation_population: { description: 'twenty held-out probe items', items: 20 },
          overlap_criterion: 'exact eight-token overlap with any mirrored record',
          access: 'available',
          provenance: 'provider dataset card plus a local mirror of the open subset',
          coverage: 1,
          checked_items: 20,
          matched_items: options.matchedItems ?? 0,
        },
      },
    },
    timing: {
      schema_version: 'timing-study.v1',
      consent: 'opt_in',
      studies: [
        {
          id: 'study-1',
          task_id: 'chapter-1-draft',
          scope: 'chapter 1 of the fixture book',
          aggregation: 'paired_gains',
          baseline: { active_minutes: 10, revision_minutes: 0, interruptions: 1, accepted: true, criterion: 'accepted after one review pass' },
          assisted: {
            active_minutes: 11,
            revision_minutes: 1,
            interruptions: 0,
            accepted: true,
            criterion: 'accepted after one review pass',
            model_wait_minutes: 30,
          },
          server_elapsed_minutes: 45,
        },
      ],
    },
    indicators: [
      {
        id: 'narrative_coherence',
        status: 'judged',
        category: 'High',
        evidence: ['ev1'],
        rationale: 'The scene recovers its causal relations.',
        evaluator: 'human-1',
      },
    ],
    requirements: {
      registry_version: 'stg-rules.v1',
      aggregation_policy: 'all_applicable_pass',
      rules: [
        {
          id: 'stg-structure-1',
          description: 'Every chapter opens with a level-one title.',
          source: 'stg',
          classification: 'hard',
          criterion: 'every declared output',
          applies_to: 'all',
        },
        {
          id: 'stg-language-1',
          description: 'No interface language leaks into the prose.',
          source: 'stg',
          classification: 'soft',
          criterion: 'every declared output',
          applies_to: 'all',
        },
        {
          id: 'req-ending',
          description: 'The scene ends on the sea.',
          source: 'request',
          classification: 'hard',
          criterion: 'this request',
          applies_to: [ruleOutputs[0]],
        },
        {
          id: 'ed-tone',
          description: 'Prefer a restrained register.',
          source: 'editorial',
          classification: 'soft',
          criterion: 'editorial preference',
          applies_to: 'all',
        },
      ],
      outcomes: [
        ...ruleOutputs.flatMap((output) => [
          { rule: 'stg-structure-1', output, outcome: 'pass', evidence: ['ev1'] },
          { rule: 'stg-language-1', output, outcome: 'pass', evidence: ['ev1'] },
        ]),
        { rule: 'req-ending', output: ruleOutputs[0], outcome: 'pass', evidence: ['ev2'] },
      ],
    },
    preserved_qualities: {
      passages: [{ id: 'p1', evidence: ['ev1'], rationale: 'The opening image is worth keeping.' }],
    },
  };
  if (!options.noContinuity) {
    annotations.continuity = {
      schema_version: 'continuity-result.v1',
      version: 'continuity-result.v1',
      source_version: packet.version,
      counts: { eligible_comparisons: 2, consistent: 1, contradicted: 1, unresolved: 0 },
      scope: options.continuityScope ?? { chapters: [1], omitted: [] },
      findings: [
        {
          id: 'find-1',
          kind: 'contradiction',
          severity: 'local',
          certainty: 'deterministic',
          status: 'confirmed',
          description: 'The sea is described twice with different light.',
          evidence: ['ev1', 'ev2'],
          temporal: { baseline: ['ev1'], later: ['ev2'] },
          alternative_explanation: 'The two references may describe different moments.',
          repair_suggestion: 'Align the two descriptions.',
        },
        {
          id: 'find-2',
          kind: 'unsupported_change',
          severity: 'major',
          certainty: 'tentative',
          status: 'confirmed',
          description: 'The mariner stops watching the sea without a cause in the selected chapter.',
          evidence: ['ev3', 'ev4'],
          temporal: { baseline: ['ev3'], later: ['ev4'] },
          alternative_explanation: 'The cause may be in the omitted material.',
          repair_suggestion: 'Name the cause before the change.',
        },
      ],
    };
  }
  if (options.annotations) options.annotations(annotations, { chapter1, chapter2, evidence });
  const annotationsPath = join(root, 'annotations.json');
  writeJson(root, 'annotations.json', annotations);

  const corpusDir = join(root, 'corpus');
  writeFileSync(corpusDir, 'reference.txt', Buffer.from(options.referenceText ?? REFERENCE_TEXT, 'utf8'));
  const corpusPath = join(corpusDir, 'manifest.json');
  writeJson(corpusDir, 'manifest.json', {
    schema_version: 'corpus.v1',
    references: [
      {
        id: 'ref1',
        path: 'reference.txt',
        sha256: sha256(Buffer.from(options.referenceText ?? REFERENCE_TEXT, 'utf8')),
        language: 'en',
        provenance: 'fixture reference',
        permitted_use: 'comparison',
      },
    ],
  });

  const profilePath = join(root, 'profile.json');
  writeJson(root, 'profile.json', profile);

  return {
    root,
    packet,
    packetDir: packet.packetDir,
    profilePath,
    annotationsPath,
    corpusPath,
    chapter1Bytes: chapter1,
    chapter2Bytes: chapter2,
    evidence,
  };
}

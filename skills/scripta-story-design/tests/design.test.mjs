/**
 * design.test.mjs — the design brief itself: required keys and types, the schema of its
 * collections, identifier and entity-reference rules, sparse and future arcs, languages and
 * documents of another kind. The packet and staleness cases live in context.test.mjs, and
 * the command-line surface in cli.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { envelope, minimalBrief, run, useWorkspace } from './helpers/fixtures.mjs';

const ws = useWorkspace('story-design-brief-');

test('accepts a minimal new-book brief', async () => {
  const file = await ws.design('minimal.json', minimalBrief());
  const result = run(['--input', file]);
  assert.equal(result.status, 0);
  const env = envelope(result);
  assert.equal(env.schema_version, 'design.v1');
  assert.equal(env.ok, true);
  assert.deepEqual(env.errors, []);
  assert.deepEqual(env.warnings, []);
});

test('accepts a full brief with arc, characters, relationships and world entries, and leaves the input byte-identical', async () => {
  const brief = minimalBrief({
    design_id: 'full-1',
    based_on_version: 'universe-night-74',
    structural_intent: 'Alternating discovery and confrontation.',
    character_directions: [
      {
        entity_id: 'mara',
        want: 'privacy',
        contradiction: 'she enforces a law she secretly resents',
        defence: 'sarcasm',
        knowledge_limits: 'does not know who reported her',
        direction: 'toward honesty',
      },
      { entity_id: 'ion', want: 'to be forgiven', contradiction: 'he hides pain behind duty' },
    ],
    relationship_directions: [
      {
        participants: ['mara', 'ion'],
        terms: 'mentor and reluctant heir',
        last_change: 'ion asked for the truth',
        evidence: 'chapter 3, their argument',
      },
    ],
    world_assumptions: [
      {
        id: 'law-1',
        epistemic_kind: 'law',
        text: 'The plant recognizes only names spoken aloud.',
        source: 'canon, chapter 2',
      },
      {
        id: 'obs-1',
        epistemic_kind: 'observation',
        text: 'The plant grows toward the morning voice.',
        source: 'chapter 1',
        entity_id: 'the-plant',
      },
    ],
    arcs: [
      {
        id: 'arc-1',
        pressure: 'The water ration shrinks each week.',
        destinations: ['the reservoir', 'the greenhouse'],
        status: 'active',
        chapter_memberships: [1, 2],
        decision_points: ['who drinks first'],
        planning_status: 'revising after the vote',
      },
    ],
    open_design_questions: ['Can the plant be moved?'],
  });
  const file = await ws.design('full.json', brief);
  const beforeBytes = await readFile(file);
  const result = run(['--input', file]);
  assert.equal(result.status, 0);
  assert.equal(envelope(result).ok, true);
  const afterBytes = await readFile(file);
  assert.deepEqual(afterBytes, beforeBytes);
});

test('accepts an intentionally non-linear, static-arc brief', async () => {
  const brief = minimalBrief({
    design_id: 'static-1',
    structural_intent: 'Non-linear; a stable character exposes a changing institution.',
    arcs: [
      {
        id: 'arc-still',
        pressure: 'The institution changes around an unchanged woman.',
        destinations: [],
        status: 'completed',
        planning_status: 'deliberately static',
      },
    ],
    open_design_questions: ['Does stability itself carry dramatic tension here?'],
  });
  const file = await ws.design('static.json', brief);
  const result = run(['--input', file]);
  assert.equal(result.status, 0);
  assert.equal(envelope(result).ok, true);
});

test('rejects a duplicate design_id that collides with an arc id', async () => {
  const brief = minimalBrief({
    design_id: 'dup-1',
    arcs: [{ id: 'dup-1', pressure: 'a rationed spring', destinations: [], status: 'planned' }],
  });
  const file = await ws.design('dup-design.json', brief);
  const result = run(['--input', file]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.errors.some((e) => e.includes('duplicate design_id')));
});

test('rejects a duplicate arc id', async () => {
  const brief = minimalBrief({
    arcs: [
      { id: 'arc-x', pressure: 'a', destinations: [], status: 'planned' },
      { id: 'arc-x', pressure: 'b', destinations: [], status: 'active' },
    ],
  });
  const file = await ws.design('dup-arc.json', brief);
  const result = run(['--input', file]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.errors.some((e) => e.includes('duplicate arc id')));
});

test('rejects a relationship participant that is not a declared entity', async () => {
  const brief = minimalBrief({
    character_directions: [
      { entity_id: 'mara', want: 'privacy', contradiction: 'enforces a law she resents' },
    ],
    relationship_directions: [
      { participants: ['mara', 'ghost'], terms: 'old debts', last_change: 'a letter', evidence: 'none' },
    ],
  });
  const file = await ws.design('undeclared.json', brief);
  const result = run(['--input', file]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.errors.some((e) => e.includes('"ghost"') && e.includes('not declared')));
});

test('reports a structured error for a non-object world assumption instead of crashing', async () => {
  const brief = minimalBrief({ world_assumptions: ['not an object'] });
  const file = await ws.design('bad-assumption.json', brief);
  const result = run(['--input', file]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.errors.some((e) => e.includes('world_assumptions[0] must be an object')));
});

test('rejects a brief missing the required key reader_promise', async () => {
  const { reader_promise, ...rest } = minimalBrief();
  const file = await ws.design('missing-promise.json', rest);
  const result = run(['--input', file]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.errors.some((e) => e.includes('reader_promise')));
});

test('accepts an empty arcs array', async () => {
  const brief = minimalBrief({ arcs: [] });
  const file = await ws.design('empty-arcs.json', brief);
  const result = run(['--input', file]);
  assert.equal(result.status, 0);
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.deepEqual(env.errors, []);
});

test('warns on a plan-kind assumption describing a future event while staying ok', async () => {
  const brief = minimalBrief({
    world_assumptions: [
      {
        id: 'plan-1',
        epistemic_kind: 'plan',
        text: 'The crew will reroute the river next spring.',
        source: 'design note',
      },
    ],
  });
  const file = await ws.design('future-plan.json', brief);
  const result = run(['--input', file]);
  assert.equal(result.status, 0);
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.errors.length, 0);
  assert.ok(env.warnings.some((w) => w.includes('future event')));
});

test('keeps a legitimate future arc plan legal while rejecting a negative chapter membership', async () => {
  const packet = await ws.packet('ctx-future-plan');
  const futureBrief = await ws.design(
    'future-plan.json',
    minimalBrief({
      based_on_version: packet.version,
      arcs: [
        {
          id: 'arc-harvest',
          pressure: 'The reservoir empties before the harvest.',
          destinations: ['the drained reservoir'],
          status: 'planned',
          chapter_memberships: [7],
          planning_status: 'scheduled for a later chapter',
        },
      ],
      world_assumptions: [
        {
          id: 'plan-1',
          epistemic_kind: 'plan',
          text: 'The crew will reroute the river next spring.',
          source: 'design note',
        },
      ],
    }),
  );
  const future = run(['--input', futureBrief, '--context', packet.dir]);
  assert.equal(future.status, 0, future.stderr);
  const futureEnv = envelope(future);
  assert.equal(futureEnv.ok, true);
  assert.deepEqual(futureEnv.errors, []);
  assert.ok(futureEnv.warnings.some((warning) => warning.includes('future event')));

  const negativeBrief = await ws.design(
    'negative-membership.json',
    minimalBrief({
      arcs: [
        {
          id: 'arc-broken',
          pressure: 'A pressure with an impossible membership.',
          destinations: [],
          status: 'planned',
          chapter_memberships: [-1, 0],
        },
      ],
    }),
  );
  const negative = run(['--input', negativeBrief]);
  assert.equal(negative.status, 2);
  const negativeEnv = envelope(negative);
  assert.ok(
    negativeEnv.errors.some((error) => error.startsWith('INVALID_CHAPTER') && error.includes('positive chapter number')),
    negativeEnv.errors.join('; '),
  );
});

test('rejects identifiers that collide after trimming or Unicode normalization', async () => {
  const spaced = await ws.design(
    'collide-space.json',
    minimalBrief({
      character_directions: [
        { entity_id: 'mara', want: 'privacy', contradiction: 'she enforces a law she resents' },
        { entity_id: '  mara  ', want: 'company', contradiction: 'she trusts the wrong person' },
      ],
    }),
  );
  const spacedRun = run(['--input', spaced]);
  assert.equal(spacedRun.status, 2);
  const spacedEnv = envelope(spacedRun);
  assert.ok(
    spacedEnv.errors.some((error) => error.startsWith('DUPLICATE_ID') && error.includes('mara')),
    spacedEnv.errors.join('; '),
  );

  const composed = 'Ren\u00e9e';
  const decomposed = 'Rene\u0301e';
  const normalized = await ws.design(
    'collide-normalization.json',
    minimalBrief({
      character_directions: [
        { entity_id: composed, want: 'privacy', contradiction: 'she enforces a law she resents' },
        { entity_id: decomposed, want: 'company', contradiction: 'she trusts the wrong person' },
      ],
    }),
  );
  const normalizedRun = run(['--input', normalized]);
  assert.equal(normalizedRun.status, 2);
  assert.ok(envelope(normalizedRun).errors.some((error) => error.startsWith('DUPLICATE_ID')));
});

test('rejects an unsupported language code and a document of another kind', async () => {
  const language = await ws.design('bad-language.json', minimalBrief({ language: 'klingon' }));
  const languageRun = run(['--input', language]);
  assert.equal(languageRun.status, 2);
  assert.ok(envelope(languageRun).errors.some((error) => error.startsWith('UNSUPPORTED_LANGUAGE')));

  const wrongKind = await ws.design('wrong-kind.json', { ...minimalBrief(), schema_version: 'profile.v1' });
  const wrongKindRun = run(['--input', wrongKind]);
  assert.equal(wrongKindRun.status, 2);
  const wrongKindEnv = envelope(wrongKindRun);
  const kindError = wrongKindEnv.errors.find((error) => error.startsWith('SCHEMA_VERSION'));
  assert.ok(kindError, wrongKindEnv.errors.join('; '));
  assert.ok(kindError.includes('prose profile'));
});

test('refuses the metrics evaluation configuration under its own identifier', async () => {
  const evaluation = await ws.design('evaluation-config.json', {
    schema_version: 'assessment-profile.v1',
    profile_id: 'eval-1',
    scope: { kind: 'book', chapters: [1, 2] },
    aggregation: { enabled: false },
  });
  const result = run(['--input', evaluation]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  assert.equal(env.ok, false);
  const refusal = env.errors.find((error) => error.startsWith('SCHEMA_VERSION'));
  assert.ok(refusal, env.errors.join('; '));
  assert.ok(refusal.includes('evaluation configuration'), refusal);
  assert.ok(refusal.includes('scripta-metrics-report'), refusal);
});

test('warns that a completed arc is a proposal instead of an accepted event', async () => {
  const asserted = await ws.design(
    'completed-arc.json',
    minimalBrief({
      arcs: [
        {
          id: 'arc-done',
          pressure: 'The reservoir empties.',
          destinations: [],
          status: 'completed',
          chapter_memberships: [1, 2],
        },
      ],
    }),
  );
  const withMembers = run(['--input', asserted]);
  assert.equal(withMembers.status, 0, withMembers.stderr);
  const withMembersEnv = envelope(withMembers);
  assert.equal(withMembersEnv.ok, true);
  assert.deepEqual(withMembersEnv.errors, []);
  assert.ok(
    withMembersEnv.warnings.some(
      (warning) => warning.includes('arcs[0]') && warning.includes('proposal, not an accepted event'),
    ),
    withMembersEnv.warnings.join('; '),
  );

  const bare = await ws.design(
    'completed-arc-no-members.json',
    minimalBrief({
      arcs: [{ id: 'arc-done', pressure: 'The reservoir empties.', destinations: [], status: 'completed' }],
    }),
  );
  const withoutMembers = run(['--input', bare]);
  assert.equal(withoutMembers.status, 0, withoutMembers.stderr);
  const withoutMembersEnv = envelope(withoutMembers);
  assert.equal(withoutMembersEnv.ok, true);
  assert.deepEqual(withoutMembersEnv.errors, []);
  assert.ok(
    withoutMembersEnv.warnings.some((warning) => warning.includes('no chapter_memberships')),
    withoutMembersEnv.warnings.join('; '),
  );
});

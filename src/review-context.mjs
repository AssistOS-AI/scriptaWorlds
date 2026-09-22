// The authoring context of one review, and the rules that follow from it.
//
// A compliance view can only report something when the review knows what the book was asked to be: the
// permanent charter of the universe, the request the chapters were written from, an approved design brief
// and the directions a human accepted. This module finds those documents, records where each one came from
// with its hash, and turns only the machine-readable parts of them into rules — the published general rule
// set of the report skill, the accepted directions, and the world laws an approved brief declares.
//
// Two decisions are deliberate. Absence is not a violation: an imported book has no authoring request and
// no brief, and that is recorded as a missing input with its reason rather than turned into a requirement
// the book could fail. And the rules are the host's to state: a model is asked for outcomes per (rule,
// output) pair and never for the rule definitions themselves, so nothing an evaluator invents can become
// the standard the book is measured against.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { UniverseError } from './errors.mjs';
import { nowIso } from './io.mjs';
import { universeDir } from './paths.mjs';
import { scanTurns } from './universe-chapters.mjs';
import { assessmentsRoot, universeWorkspace, versionSlug } from './assessment-packet.mjs';

/** The published general rule set of the report skill, relative to the skills directory. */
export const PUBLISHED_RULES_RESOURCE = ['scripta-metrics-report', 'schema', 'rules.v1.json'];

export const APPLICABLE_RULES_SCHEMA = 'applicable-rules.v1';
/** Where the registry and the charter it derives its rules from live inside the frozen packet. */
export const RULES_FILE = 'rules/applicable-rules.v1.json';
export const CHARTER_FILE = 'rules/charter.md';

export const RULE_SOURCES = ['stg', 'request', 'editorial'];
export const RULE_CLASSES = ['hard', 'soft'];
export const AGGREGATION_POLICIES = ['all_applicable_pass', 'no_applicable_fail'];
/** The design assumptions that state a rule of the world rather than an observation about it. */
const RULE_ASSUMPTION_KINDS = ['law', 'social_rule'];
/** The design document an approved proposal must be, before it can be the brief of a book. */
const DESIGN_SCHEMA = 'design.v1';

const MAX_TEXT_CHARS = 2_000;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const bytesOf = (value) => Buffer.byteLength(value, 'utf8');
const text = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

/**
 * The versioned general rule set of the report skill. There is no default here, for the same reason the
 * annotation vocabulary has none: the host must not measure a book against rules it invented, so a missing
 * or malformed publication fails the run by name instead of silently shrinking the standard.
 */
const publishedCache = new Map();

export async function loadPublishedRuleSet(skillsDir) {
  const key = String(skillsDir);
  if (!publishedCache.has(key)) {
    publishedCache.set(key, (async () => {
      const path = join(skillsDir, ...PUBLISHED_RULES_RESOURCE);
      const bytes = await readFile(path).catch(() => null);
      const raw = bytes ? JSON.parse(bytes.toString('utf8')) : null;
      const version = text(raw?.registry_version);
      const rules = Array.isArray(raw?.rules) ? raw.rules : null;
      if (!bytes || !version || !rules || rules.length === 0) {
        throw new UniverseError(
          'RULE_SET_MISSING',
          `The report skill does not publish its general rule set (${path}); a review cannot measure compliance against rules it invented.`,
          500
        );
      }
      const policy = text(raw.aggregation_policy) ?? AGGREGATION_POLICIES[0];
      if (!AGGREGATION_POLICIES.includes(policy)) {
        throw new UniverseError('RULE_SET_MISSING', `The published rule set declares an unknown aggregation policy ${JSON.stringify(policy)}.`, 500);
      }
      return {
        registry_version: version,
        aggregation_policy: policy,
        rules: rules.map((rule) => ({
          id: text(rule?.id),
          description: text(rule?.description),
          source: RULE_SOURCES.includes(rule?.source) ? rule.source : 'stg',
          classification: RULE_CLASSES.includes(rule?.classification) ? rule.classification : 'hard',
          criterion: text(rule?.criterion) ?? 'every declared output',
          applies_to: rule?.applies_to === 'all' || !Array.isArray(rule?.applies_to) ? 'all' : rule.applies_to.map(String)
        })),
        path: PUBLISHED_RULES_RESOURCE.join('/'),
        sha256: sha256(bytes)
      };
    })());
  }
  return publishedCache.get(key);
}

/** The newest finished chapter turn of the selection that carries the request it was written from. */
function originatingRequest(turns, chapters) {
  const selected = new Set(chapters);
  const candidates = turns.filter((turn) => {
    if (!text(turn?.request)) return false;
    if (turn.kind !== 'chapter') return false;
    if (turn.status === 'running' || turn.status === 'queued') return false;
    return Number.isInteger(turn.chapterNumber) && selected.has(turn.chapterNumber);
  });
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/** What one authoritative document contributed, as the packet records it. */
function provenance({ kind, path, value, extra = {} }) {
  const present = value !== null && value !== undefined;
  return { kind, path: path ?? null, present, sha256: present ? sha256(value) : null, bytes: present ? bytesOf(value) : null, ...extra };
}

/**
 * The proposal an approval decided on. The host writes a decision beside the proposal it carries, and the
 * file is verified against the hash the decision recorded, so an approval can never be read as deciding on
 * a document that changed after the decision.
 */
async function readApprovedProposal(universeId, version, record) {
  const hash = text(record?.proposal_sha256);
  if (!hash) return null;
  const slug = hash.slice(0, 16);
  const directory = join(universeWorkspace(universeId), versionSlug(version), 'approvals');
  const path = join(directory, `proposal-${slug}.json`);
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null || sha256(raw) !== hash) return null;
  const document = (() => {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();
  if (!document) return null;
  return {
    path: relative(assessmentsRoot(), path),
    approval_path: relative(assessmentsRoot(), join(dirname(path), `approval-${slug}.json`)),
    sha256: hash,
    document
  };
}

/**
 * Read the authoring context of one review from the universe and from the accepted decisions of the
 * captured version. Nothing here is inferred from prose: a document is either present with its hash, or
 * absent with a reason a reader can check.
 */
export async function collectAuthoringContext({
  universeId,
  version,
  chapters = [],
  request = null,
  brief = null,
  intention = null,
  approvals = []
}) {
  const dir = universeDir(universeId);
  const charter = await readFile(join(dir, 'charter.md'), 'utf8').then(text, () => null);
  const turns = await scanTurns(universeId).catch(() => []);

  const explicitRequest = text(request);
  const turn = explicitRequest ? null : originatingRequest(turns, chapters);
  const requestText = explicitRequest ?? (turn ? text(turn.request) : null);
  const requestSource = explicitRequest
    ? { source: 'assessment-request', turn: null, path: null }
    : turn
      ? { source: 'turn', turn: turn.number, path: `turns/${String(turn.number).padStart(4, '0')}.json` }
      : { source: null, turn: null, path: null };

  // The approved decisions of this version, with the proposal each one decided on. A proposal that carries
  // a `design.v1` brief is the brief this book was written against; its directions are the requirements a
  // human accepted.
  const decisions = [];
  for (const record of approvals) {
    if (record?.decision !== 'approved' || record.version !== version) continue;
    decisions.push({ record, proposal: await readApprovedProposal(universeId, version, record) });
  }
  const design = decisions.map((decision) => decision.proposal).find((proposal) => proposal?.document?.schema_version === DESIGN_SCHEMA) ?? null;

  const explicitBrief = text(brief);
  const briefText = explicitBrief ?? (design ? JSON.stringify(design.document).slice(0, MAX_TEXT_CHARS) : null);
  const briefSource = explicitBrief
    ? { source: 'assessment-request', path: null, approval: null }
    : design
      ? { source: 'approved-design', path: design.path, approval: design.approval_path }
      : { source: null, path: null, approval: null };

  const intentionText = text(intention);

  const directions = [];
  for (const decision of decisions) {
    for (const direction of Array.isArray(decision.record.directions) ? decision.record.directions : []) {
      const value = text(direction);
      if (!value) continue;
      directions.push({
        text: value,
        source: 'approval',
        path: decision.proposal?.approval_path ?? null,
        sha256: decision.record.proposal_sha256 ?? null,
        reviewer: decision.record.reviewer ?? null,
        decided_at: decision.record.decided_at ?? null
      });
    }
  }
  // Directions a writing request carried are accepted instructions too: the turn that followed them records
  // which ones it was given.
  for (const accepted of turns) {
    if (!Array.isArray(accepted?.directions) || accepted.directions.length === 0) continue;
    if (!Number.isInteger(accepted.chapterNumber) || !chapters.includes(accepted.chapterNumber)) continue;
    for (const direction of accepted.directions) {
      const value = text(direction);
      if (!value) continue;
      directions.push({
        text: value,
        source: 'turn',
        path: `turns/${String(accepted.number).padStart(4, '0')}.json`,
        sha256: null,
        reviewer: null,
        decided_at: accepted.createdAt ?? null
      });
    }
  }

  const missing = [];
  if (charter === null) missing.push('charter: this universe has no charter.md, so no permanent rule could be read from one');
  if (requestText === null) {
    missing.push('request: no authoring request was recorded for the selected chapters (an imported book has none), so absence is not a violation');
  }
  if (briefText === null) {
    missing.push('brief: no approved design brief was recorded for this version (an imported book has none), so absence is not a violation');
  }
  if (intentionText === null) missing.push('intention: the review was asked for without a stated intention');

  return {
    schema_version: 'authoring-context.v1',
    version,
    charter: { present: charter !== null, path: charter === null ? null : CHARTER_FILE, text: charter },
    request: { present: requestText !== null, text: requestText, ...requestSource },
    brief: { present: briefText !== null, text: briefText, ...briefSource },
    intention: { present: intentionText !== null, text: intentionText, source: intentionText === null ? null : 'assessment-request' },
    directions,
    design: design
      ? { present: true, path: design.path, approval: design.approval_path, sha256: design.sha256, document: design.document }
      : { present: false },
    missing,
    provenance: [
      provenance({ kind: 'charter', path: 'charter.md', value: charter }),
      provenance({ kind: 'request', path: requestSource.path, value: requestText, extra: { turn: requestSource.turn, source: requestSource.source } }),
      provenance({ kind: 'brief', path: briefSource.path, value: briefText, extra: { source: briefSource.source, approval: briefSource.approval } }),
      provenance({ kind: 'intention', path: null, value: intentionText }),
      ...decisions.map((decision) => provenance({
        kind: 'approval',
        path: decision.proposal?.approval_path ?? null,
        value: JSON.stringify(decision.record),
        extra: { reviewer: decision.record.reviewer ?? null, decided_at: decision.record.decided_at ?? null }
      }))
    ]
  };
}

/**
 * The applicable rules of one review: the published general set, one rule per world law an approved brief
 * declares, and one per accepted direction. Each rule carries the origin the packet records; the
 * definitions handed to the report keep only the fields its validator accepts.
 */
export function buildApplicableRules({ published, context }) {
  const rules = [];
  const seen = new Set();
  const add = (rule) => {
    if (!rule.id || !rule.description || seen.has(rule.id)) return;
    seen.add(rule.id);
    rules.push(rule);
  };
  for (const rule of published.rules) {
    add({ ...rule, origin: { kind: 'published-rule-set', path: published.path, sha256: published.sha256 } });
  }
  const assumptions = Array.isArray(context.design?.document?.world_assumptions) ? context.design.document.world_assumptions : [];
  for (const assumption of assumptions) {
    const id = text(assumption?.id);
    const body = text(assumption?.text);
    const kind = text(assumption?.epistemic_kind);
    if (!id || !body || !RULE_ASSUMPTION_KINDS.includes(kind)) continue;
    add({
      id: `brief-${id}`,
      description: body,
      source: 'request',
      classification: 'hard',
      criterion: 'every declared output',
      applies_to: 'all',
      origin: { kind: 'approved-brief', path: context.design.path, sha256: context.design.sha256, assumption: kind }
    });
  }
  for (const direction of context.directions) {
    add({
      id: `direction-${sha256(direction.text).slice(0, 8)}`,
      description: direction.text,
      source: 'request',
      classification: 'hard',
      criterion: 'every declared output',
      applies_to: 'all',
      origin: { kind: 'accepted-direction', path: direction.path, sha256: direction.sha256, source: direction.source }
    });
  }
  return rules;
}

/**
 * The registry document one run freezes into its packet: the rules that apply, the documents they came
 * from, and what was absent with its reason. It is written before any evaluator exists, so the standard a
 * report measures against is a file a reader can inspect rather than a decision made inside a prompt.
 */
export function buildRegistryDocument({ published, context, rules }) {
  return {
    schema_version: APPLICABLE_RULES_SCHEMA,
    registry_version: published.registry_version,
    aggregation_policy: published.aggregation_policy,
    captured_at: nowIso(),
    version: context.version,
    sources: [
      { kind: 'published-rule-set', path: published.path, sha256: published.sha256 },
      ...context.provenance,
      ...context.directions.map((direction) => ({
        kind: 'accepted-direction',
        path: direction.path,
        sha256: direction.sha256,
        source: direction.source,
        text: direction.text
      }))
    ],
    missing: context.missing,
    authoring: {
      charter: { present: context.charter.present, path: context.charter.path },
      request: {
        present: context.request.present,
        source: context.request.source,
        turn: context.request.turn,
        path: context.request.path,
        text: context.request.text
      },
      brief: {
        present: context.brief.present,
        source: context.brief.source,
        path: context.brief.path,
        approval: context.brief.approval,
        text: context.brief.text
      },
      intention: { present: context.intention.present, text: context.intention.text },
      directions: context.directions.map((direction) => ({ text: direction.text, source: direction.source, path: direction.path })),
      design: context.design.present ? { path: context.design.path, approval: context.design.approval, sha256: context.design.sha256 } : null
    },
    rules
  };
}

/** The `requirements` block the report consumes: definitions, aggregation policy and observed outcomes. */
export function registryRequirements(document, outcomes = []) {
  return {
    registry_version: document.registry_version,
    aggregation_policy: document.aggregation_policy,
    rules: document.rules.map(({ id, description, source, classification, criterion, applies_to }) => ({
      id,
      description,
      source,
      classification,
      criterion,
      applies_to
    })),
    outcomes
  };
}

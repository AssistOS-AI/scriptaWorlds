#!/usr/bin/env node
/**
 * scripta-metrics-report — evidence-backed narrative metrics and five readable
 * evaluation reports for an accepted scene, chapter, arc or book.
 *
 *   node build-report.mjs --input <packet-dir> --out <result-dir> \
 *     --profile <profile.json> [--annotations <annotations.json>] [--corpus <manifest.json>]
 *
 * Default = deterministic measures plus supplied annotations. It never starts a
 * model, downloads a corpus or hits the network. Missing semantic inputs
 * produce explicit `not_assessable` results, not fabricated scores.
 *
 * Output: exactly ONE JSON envelope on stdout. The whole bundle is staged in a
 * sibling directory, inventory-verified, and published with a single rename;
 * the destination is refused when it is the packet, lives inside it, contains
 * it, collides with a supplied input, or is a non-empty directory.
 *
 * Exit codes: 0 completed (unavailable metrics are results, not failures),
 *             2 invalid input/arguments/schema, 1 execution failure.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CliError,
  EXIT_PROCESSING,
  fail,
  isNonNegativeInteger,
  isPlainObject,
  readBytesChecked,
} from './lib/errors.mjs';
import { loadPacket } from './lib/input.mjs';
import { loadCorpusManifest } from './lib/corpus.mjs';
import { renderViews, VIEW_FILES } from './lib/render.mjs';
import { publishBundle } from './lib/workspace.mjs';
import { assess } from './lib/assemble.mjs';
import { parseAggregation } from './lib/aggregate.mjs';
import { parseRubricProfile } from './lib/rubric.mjs';

const RESULT_SCHEMA_VERSION = 'assessment-result.v1';
/**
 * Canonical identifier of this skill's evaluation configuration. The peer
 * skills recognize `evaluation-profile.v1` as the metrics-report evaluation
 * configuration, so a profile cannot be handed to the wrong validator.
 */
const PROFILE_SCHEMA_VERSION = 'evaluation-profile.v1';
/** Documents written before the identifier was settled keep working. */
const PROFILE_SCHEMA_ALIASES = ['assessment-profile.v1', 'profile.v1'];
const ANNOTATIONS_SCHEMA_VERSION = 'annotations.v1';

const USAGE =
  'Usage: node build-report.mjs --input <packet-dir> --out <result-dir> --profile <profile.json> ' +
  '[--annotations <annotations.json>] [--corpus <manifest.json>] [--study-root <dir>] [--allow-test-only-studies] ' +
  '[--trigger <request|arc>] [--arc-id <id>]';

/** The events that may cause a run. The host maps its own `requested` to `request`. */
const TRIGGERS = ['request', 'arc'];

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function parseArgs(argv) {
  const options = {
    input: null,
    out: null,
    profile: null,
    annotations: null,
    corpus: null,
    studyRoot: null,
    allowTestOnlyStudies: false,
    trigger: 'request',
    arcId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const need = (name) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`option ${name} requires a value. ${USAGE}`, 'USAGE');
      i += 1;
      return value;
    };
    if (arg === '--input') options.input = need(arg);
    else if (arg === '--out') options.out = need(arg);
    else if (arg === '--profile') options.profile = need(arg);
    else if (arg === '--annotations') options.annotations = need(arg);
    else if (arg === '--corpus') options.corpus = need(arg);
    else if (arg === '--study-root') options.studyRoot = need(arg);
    else if (arg === '--allow-test-only-studies') options.allowTestOnlyStudies = true;
    else if (arg === '--trigger') options.trigger = need(arg);
    else if (arg === '--arc-id') options.arcId = need(arg);
    else fail(`unknown argument: ${arg}. ${USAGE}`, 'USAGE');
  }
  if (!options.input) fail(`missing --input. ${USAGE}`, 'USAGE');
  if (!options.out) fail(`missing --out. ${USAGE}`, 'USAGE');
  if (!options.profile) fail(`missing --profile. ${USAGE}`, 'USAGE');
  if (!TRIGGERS.includes(options.trigger)) {
    fail(`--trigger must be one of ${TRIGGERS.join('|')}, got ${JSON.stringify(options.trigger)}. ${USAGE}`, 'USAGE');
  }
  if (options.trigger === 'arc' && !options.arcId) {
    fail(`--trigger arc requires --arc-id <id>. ${USAGE}`, 'USAGE');
  }
  if (options.trigger !== 'arc' && options.arcId) {
    fail(`--arc-id is only valid with --trigger arc. ${USAGE}`, 'USAGE');
  }
  return options;
}

function parseJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
  }
  return value;
}

function readStringArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    fail(`${label} must be an array of non-empty strings`, 'INVALID_PROFILE');
  }
  return [...value];
}

function parseProfile(bytes) {
  const profile = parseJson(bytes, 'profile');
  if (!isPlainObject(profile)) fail('profile must be an object', 'INVALID_PROFILE');
  const accepted = [PROFILE_SCHEMA_VERSION, ...PROFILE_SCHEMA_ALIASES];
  if (!accepted.includes(profile.schema_version)) {
    fail(
      `unsupported profile schema_version ${JSON.stringify(profile.schema_version)}; ` +
        `expected ${JSON.stringify(PROFILE_SCHEMA_VERSION)}`,
      'SCHEMA_VERSION',
    );
  }
  if (typeof profile.profile_id !== 'string' || profile.profile_id.length === 0) {
    fail('profile.profile_id must be a non-empty string', 'INVALID_PROFILE');
  }
  const scope = profile.scope;
  if (!isPlainObject(scope)) fail('profile.scope must be an object', 'INVALID_PROFILE');
  if (!['scene', 'chapter', 'arc', 'book'].includes(scope.kind)) {
    fail('profile.scope.kind must be one of scene|chapter|arc|book', 'INVALID_PROFILE');
  }
  const chapters = scope.chapters === undefined ? [] : scope.chapters;
  if (!Array.isArray(chapters) || chapters.some((c) => !isNonNegativeInteger(c))) {
    fail('profile.scope.chapters must be an array of non-negative integers', 'INVALID_PROFILE');
  }
  const contextChapters = scope.context_chapters === undefined ? [] : scope.context_chapters;
  if (!Array.isArray(contextChapters) || contextChapters.some((c) => !isNonNegativeInteger(c))) {
    fail('profile.scope.context_chapters must be an array of non-negative integers', 'INVALID_PROFILE');
  }
  return {
    profile_id: profile.profile_id,
    schema_version: profile.schema_version,
    scope: {
      kind: scope.kind,
      chapters,
      segments: readStringArray(scope.segments, 'profile.scope.segments'),
      arcs: readStringArray(scope.arcs, 'profile.scope.arcs'),
      context_chapters: contextChapters,
    },
    aggregation: parseAggregation(profile.aggregation),
    rubric: parseRubricProfile(profile.rubric),
  };
}

function parseAnnotations(bytes) {
  const ann = parseJson(bytes, 'annotations');
  if (!isPlainObject(ann)) fail('annotations must be an object', 'INVALID_ANNOTATIONS');
  if (ann.schema_version !== ANNOTATIONS_SCHEMA_VERSION) {
    fail(`unsupported annotations schema_version ${JSON.stringify(ann.schema_version)}; expected "annotations.v1"`, 'SCHEMA_VERSION');
  }
  return ann;
}

function main(argv) {
  const options = parseArgs(argv);
  const packetDir = resolve(options.input);
  const outDir = resolve(options.out);
  const profilePath = resolve(options.profile);
  const studyRoot = options.studyRoot === null ? null : resolve(options.studyRoot);
  // A declared study root is where the profile's calibration artifacts must
  // resolve; a typo must not silently turn a production claim into an
  // unverifiable one.
  if (studyRoot !== null && !(existsSync(studyRoot) && statSync(studyRoot).isDirectory())) {
    fail(`--study-root is not a readable directory: ${options.studyRoot}. ${USAGE}`, 'USAGE');
  }

  const packet = loadPacket(packetDir);

  const profileRaw = readBytesChecked(profilePath, 'profile');
  const profile = parseProfile(profileRaw);

  let annotations = null;
  let annotationsRaw = null;
  let annotationsDir = null;
  if (options.annotations) {
    const annotationsPath = resolve(options.annotations);
    annotationsDir = dirname(annotationsPath);
    annotationsRaw = readBytesChecked(annotationsPath, 'annotations');
    annotations = parseAnnotations(annotationsRaw);
  }

  let corpus = null;
  let corpusRaw = null;
  if (options.corpus) {
    const corpusPath = resolve(options.corpus);
    corpusRaw = readBytesChecked(corpusPath, 'corpus manifest');
    corpus = loadCorpusManifest(corpusPath);
  }

  const bundle = assess({
    packet,
    profile,
    profileRaw,
    annotations,
    annotationsRaw,
    corpus,
    corpusRaw,
    annotationsDir,
    trigger: options.trigger,
    arcId: options.arcId,
    studyRoot,
    allowTestOnlyStudies: options.allowTestOnlyStudies,
  });
  const views = renderViews(bundle);

  const files = [
    { name: 'assessment.json', data: `${JSON.stringify(bundle, null, 2)}\n` },
    { name: 'index.md', data: views['index.md'] },
    ...VIEW_FILES.map((name) => ({ name, data: views[name] })),
  ];

  const published = publishBundle({
    out: outDir,
    files,
    protect: [
      { label: 'input packet', path: packetDir },
      { label: 'profile', path: profilePath },
      ...(options.annotations ? [{ label: 'annotations', path: resolve(options.annotations) }] : []),
      ...(options.corpus ? [{ label: 'corpus manifest', path: resolve(options.corpus) }] : []),
    ],
  });

  emit({
    schema_version: RESULT_SCHEMA_VERSION,
    ok: true,
    assessment_id: bundle.assessment_id,
    output_dir: outDir,
    outputs: published,
    errors: [],
  });
}

function runCli() {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const known = error instanceof CliError;
    emit({
      schema_version: RESULT_SCHEMA_VERSION,
      ok: false,
      error: known ? error.message : `Internal error: ${error && error.message ? error.message : String(error)}`,
      code: known ? error.code : 'INTERNAL',
    });
    process.exitCode = known ? error.exitCode : EXIT_PROCESSING;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) runCli();

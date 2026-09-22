#!/usr/bin/env node
// scripta-continuity-review — deterministic + annotation-driven continuity review
// of a frozen assessment-input.v2 packet. Never edits narrative state.
//
// Usage:
//   node review-continuity.mjs --input <packet-dir> --out <result-dir> [--annotations <annotations.json>]
//
// Exit codes: 0 completed review (findings are result data), 2 invalid
// input/arguments/manifest/schema/annotations or an unusable result directory,
// 1 execution failure.
//
// The input packet is opened read-only and stays byte-identical. The result is
// staged in a sibling directory, verified there and published with a single
// rename, so a reader never sees a half-written result directory.
//
// Every refusal names a code first, so a host can act on it without parsing a
// sentence: the packet codes of contracts §8.3 (`MISSING_CONTEXT`,
// `MISSING_MANIFEST`, `BAD_JSON`, ...), `OUTPUT_INSIDE_INPUT` and
// `OUTPUT_CONTAINS_INPUT` from §8.1's input/output separation, `USAGE` for the
// command line itself, `MISSING_ANNOTATIONS`, `INVALID_ANNOTATIONS`,
// `DUPLICATE_ID` and `INVALID_EVIDENCE` for the semantic annotations, and
// `IO_ERROR` or `INCOMPLETE_BUNDLE` when publication fails.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PacketError, loadPacket, structuredError } from './lib/manifest.mjs';
import { COUNT_KEYS, parseAnnotations } from './lib/annotations.mjs';
import { AnnotationError } from './lib/claims.mjs';
import { runDeterministicChecks } from './lib/checks.mjs';
import { buildLedger } from './lib/ledger.mjs';
import { SeparationError, assertOutputSeparate, isInside, realDestination } from './lib/paths.mjs';
import {
  EXIT_USAGE,
  PublishError,
  discardAbandonedStaging,
  discardStaging,
  inspectOutDirectory,
  publishStaging,
  stageFiles,
} from './lib/publish.mjs';
import {
  RESULT_FILE,
  buildResult,
  findingFromClaim,
  rejectionEnvelope,
} from './lib/result.mjs';

const USAGE =
  'usage: review-continuity.mjs --input <packet-dir> --out <result-dir> [--annotations <annotations.json>]';

function parseArgs(argv) {
  const args = { input: null, out: null, annotations: null };
  const fail = (code, message) => {
    throw new Error(structuredError(code, message));
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--input' || flag === '--out' || flag === '--annotations') {
      const key = flag.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail('USAGE', `missing value for ${flag}. ${USAGE}`);
      if (args[key] !== null) fail('USAGE', `duplicate flag ${flag}`);
      args[key] = value;
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      fail('USAGE', USAGE);
    } else {
      fail('USAGE', `unknown argument ${flag}. ${USAGE}`);
    }
  }
  if (!args.input) fail('MISSING_CONTEXT', `no packet was supplied. ${USAGE}`);
  if (!args.out) fail('USAGE', `--out <result-dir> is required. ${USAGE}`);
  return args;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

// A refusal of the input: nothing was reviewed, so findings and counts stay empty.
function reject(errors) {
  printJson(rejectionEnvelope(errors));
  process.exitCode = 2;
}

// A failure of this run rather than of its input: the envelope reports the error
// and, crucially, names no published bundle.
function failExecution(result, message) {
  result.errors.push(message);
  result.ok = false;
  result.outputs = [];
  printJson(result);
  process.exitCode = 1;
}

function buildCoverageNote(packet, chapterCount, annotations, claimCount, comparisonCount) {
  const { kind, omitted } = packet.scope;
  const chapters = `${chapterCount} chapter file(s)`;
  const head =
    kind === 'complete'
      ? `Deterministic integrity review over ${chapters} and the packet state of a complete book ` +
        `(chapters 1..${packet.lastAcceptedChapter}).`
      : kind === 'partial'
        ? `Deterministic integrity review over ${chapters} of a partial packet` +
          `${omitted.length > 0 ? ` (chapters declared omitted: ${omitted.join(', ')})` : ''}` +
          '; the omitted chapters have no continuity context here, so this is not a whole-book result.'
        : `Deterministic integrity review over ${chapters} of a textual-only packet; it carries prose alone, ` +
          'so no canon, threads or atlas were available and nothing here implies a clean book.';
  if (!annotations) {
    return `${head} No annotations supplied, so no semantic continuity comparisons were performed.`;
  }
  return (
    `${head} Semantic continuity sourced from annotations (${claimCount} claim(s), ` +
    `${comparisonCount} reviewed comparison(s)); no model was invoked.`
  );
}

// Reconcile a total supplied by the annotations — or by an embedded previous
// result — with the counts derived from the reviewed ledger. A total that
// disagrees is wrong input, not a second opinion: the ledger is the authority.
function reconcileTotals(declaredTotals, counts) {
  const errors = [];
  for (const { source, counts: declared } of declaredTotals) {
    for (const key of COUNT_KEYS) {
      if (declared[key] !== counts[key]) {
        errors.push(
          structuredError(
            'INVALID_ANNOTATIONS',
            `${source}.${key} declares ${declared[key]} but the reviewed ledger derives ${counts[key]}`,
          ),
        );
      }
    }
  }
  return errors;
}

function claimFindings(claims, comparisons) {
  const comparisonByClaim = new Map();
  for (const comparison of comparisons) {
    for (const claimId of comparison.claim_ids) comparisonByClaim.set(claimId, comparison);
  }
  return claims.map((claim) => {
    const comparison = comparisonByClaim.get(claim.id) ?? null;
    return findingFromClaim(claim, comparison === null ? null : comparison.id);
  });
}

// The packets and files this run may not write into: the packet directory and
// every separately supplied input file.
function protectedInputs(packetDir, annotationsPath) {
  const protect = [{ label: 'input packet directory', path: packetDir }];
  if (annotationsPath) protect.push({ label: 'supplied annotations file', path: annotationsPath });
  return protect;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (cause) {
    reject([cause.message]);
    return;
  }

  const outDir = resolve(args.out);

  let packet;
  try {
    packet = await loadPacket(args.input);
  } catch (cause) {
    if (cause instanceof PacketError) reject(cause.errors);
    else {
      printJson(rejectionEnvelope([structuredError('IO_ERROR', `cannot read the packet: ${cause.message}`)]));
      process.exitCode = 1;
    }
    return;
  }

  const annotationsPath = args.annotations ? resolve(args.annotations) : null;
  const protect = protectedInputs(packet.packetDir, annotationsPath);

  // The destination must be really separate from every input, not merely a
  // different string: the decision uses the real path of the nearest existing
  // ancestor, so a symlink alias (or a not-yet-existing child beneath one) is
  // caught before a single byte is written.
  let destinationReal;
  try {
    destinationReal = await assertOutputSeparate({ out: outDir, protect });
  } catch (cause) {
    if (cause instanceof SeparationError) reject(cause.errors);
    else {
      printJson(
        rejectionEnvelope([structuredError('IO_ERROR', `cannot resolve the result directory: ${cause.message}`)]),
      );
      process.exitCode = 1;
    }
    return;
  }

  // A run owns its own result directory: an existing file, or an existing
  // non-empty directory (with or without an accepted result in it), is refused
  // rather than overwritten file by file.
  try {
    await inspectOutDirectory(outDir);
  } catch (cause) {
    if (cause instanceof PublishError && cause.exitCode === EXIT_USAGE) reject([cause.message]);
    else {
      printJson(rejectionEnvelope([cause instanceof PublishError ? cause.message : String(cause.message)]));
      process.exitCode = 1;
    }
    return;
  }

  let annotations = null;
  if (annotationsPath) {
    let text;
    try {
      text = await readFile(annotationsPath, 'utf8');
    } catch (cause) {
      reject([structuredError('MISSING_ANNOTATIONS', `cannot read --annotations ${annotationsPath}: ${cause.message}`)]);
      return;
    }
    try {
      annotations = parseAnnotations(text, packet);
    } catch (cause) {
      if (cause instanceof AnnotationError) reject(cause.errors);
      else {
        printJson(
          rejectionEnvelope([
            structuredError('IO_ERROR', `cannot validate the annotations: ${cause.message}`),
          ]),
        );
        process.exitCode = 1;
      }
      return;
    }
  }

  const claims = annotations === null ? [] : annotations.claims;
  const ledger = buildLedger(claims);
  const totalErrors = reconcileTotals(annotations === null ? [] : annotations.declaredTotals, ledger.counts);
  if (totalErrors.length > 0) {
    reject(totalErrors);
    return;
  }

  const deterministic = runDeterministicChecks(packet);
  const findings = [...deterministic.findings, ...claimFindings(claims, ledger.comparisons)];

  const chaptersReviewed = [...new Set(deterministic.chapters.map((chapter) => chapter.number))].sort(
    (a, b) => a - b,
  );
  const result = buildResult({
    packet,
    chaptersReviewed,
    coverageNote: buildCoverageNote(
      packet,
      chaptersReviewed.length,
      annotations !== null,
      claims.length,
      ledger.comparisons.length,
    ),
    ledger,
    findings,
    warnings: [...deterministic.warnings, ...(annotations === null ? [] : annotations.warnings)],
    outputs: [join(outDir, RESULT_FILE)],
  });

  const content = `${JSON.stringify(result, null, 2)}\n`;
  let stagingDir;
  try {
    await discardAbandonedStaging(outDir);
    stagingDir = await stageFiles(outDir, [{ name: RESULT_FILE, content }]);
  } catch (cause) {
    failExecution(result, cause instanceof PublishError ? cause.message : `cannot stage the result: ${cause.message}`);
    return;
  }

  // Recheck the destination now that the staging directory exists: a parent
  // replaced by a symlink between the first check and the write must not slip the
  // result into an input, and the parent must be the one that was approved.
  try {
    const stagedReal = await realDestination(stagingDir);
    const problems = [];
    for (const { label, path } of protect) {
      const inputReal = await realDestination(path);
      if (isInside(stagedReal, inputReal)) {
        problems.push(
          structuredError('OUTPUT_INSIDE_INPUT', `the staged result ${stagedReal} resolves inside the ${label}`),
        );
      } else if (isInside(inputReal, stagedReal)) {
        problems.push(
          structuredError('OUTPUT_CONTAINS_INPUT', `the staged result ${stagedReal} contains the ${label}`),
        );
      }
    }
    if (dirname(stagedReal) !== dirname(destinationReal)) {
      problems.push(
        structuredError(
          'PATH_ESCAPE',
          `the staging directory parent changed while the run was staging: ${stagedReal} is not under ` +
            `${dirname(destinationReal)}`,
        ),
      );
    }
    if (problems.length > 0) {
      await discardStaging(stagingDir);
      reject(problems);
      return;
    }
  } catch (cause) {
    await discardStaging(stagingDir);
    failExecution(
      result,
      cause instanceof SeparationError
        ? cause.errors.join('; ')
        : structuredError('IO_ERROR', `cannot recheck the staged result directory: ${cause.message}`),
    );
    return;
  }

  try {
    await publishStaging(stagingDir, outDir);
  } catch (cause) {
    failExecution(
      result,
      cause instanceof PublishError ? cause.message : structuredError('IO_ERROR', `cannot publish the result: ${cause.message}`),
    );
    return;
  }

  printJson(result);
  process.exitCode = 0;
}

main().catch((cause) => {
  printJson(rejectionEnvelope([structuredError('IO_ERROR', `unexpected execution failure: ${cause.message}`)]));
  process.exitCode = 1;
});

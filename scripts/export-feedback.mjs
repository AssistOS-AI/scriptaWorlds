#!/usr/bin/env node
/**
 * Writes the reader-feedback dataset of one book, its summary (`docs/contracts.md` §8.7), or the
 * self-contained snapshot with the frozen text inside it, so a team can keep it, diff one export against
 * the next, hand it to another tool, or hand it to an analysis that has no access to this store at all.
 * The same store produces the same bytes, and nothing is ever written inside `universes/`.
 *
 *   node scripts/export-feedback.mjs --universe <universe-id>                 # the lightweight dataset
 *   node scripts/export-feedback.mjs --universe <id> --out feedback.json      # the dataset, in a file
 *   node scripts/export-feedback.mjs --universe <id> --summary                # the summary, on stdout
 *   node scripts/export-feedback.mjs --universe <id> --dataset [--out x.json] # the snapshot, pseudonymous
 *   node scripts/export-feedback.mjs --universe <id> --dataset --internal     # the named internal snapshot
 *
 * The lightweight dataset carries paths, hashes and the readers' own words and stays where the prose was
 * frozen; `--dataset` carries the frozen text itself and pseudonyms for the readers, and only `--internal`
 * names the real identities, because the internal export is the one that must not leave the workspace by
 * accident. With `--out` one JSON line names the file that was written; without it the document itself is
 * on stdout, so it can be piped. Exit code 0 on success, 2 on a usage error, 1 on a refusal.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { FEEDBACK_DATASET_SCHEMA, buildFeedbackDataset, feedbackDatasetName, serializeFeedbackDataset } from '../src/feedback-dataset.mjs';
import { FEEDBACK_EXPORT_SCHEMA, buildFeedbackExport, feedbackExportName, serializeFeedbackExport } from '../src/feedback-export.mjs';
import { buildFeedbackSummary } from '../src/feedback-summary.mjs';

const USAGE = 'usage: node scripts/export-feedback.mjs --universe <universe-id> [--out <file>] [--summary | --dataset [--internal]]';

function readArgs(argv) {
  const args = { universe: null, out: null, summary: false, dataset: false, internal: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--summary') {
      args.summary = true;
      continue;
    }
    if (flag === '--dataset') {
      args.dataset = true;
      continue;
    }
    if (flag === '--internal') {
      args.internal = true;
      continue;
    }
    if (flag === '--universe' || flag === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value. ${USAGE}`);
      args[flag === '--universe' ? 'universe' : 'out'] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${flag}. ${USAGE}`);
  }
  if (!args.universe) throw new Error(`--universe is required. ${USAGE}`);
  if (args.summary && args.dataset) throw new Error(`--summary and --dataset are two different documents; ask for one of them. ${USAGE}`);
  // The internal snapshot carries the reader identities, so it is only produced when the caller names
  // both flags: a pseudonymous dataset is the default and `--internal` alone means nothing.
  if (args.internal && !args.dataset) throw new Error(`--internal names the internal snapshot and needs --dataset. ${USAGE}`);
  return args;
}

let args;
try {
  args = readArgs(process.argv.slice(2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message, code: 'USAGE' }));
  process.exit(2);
}

try {
  const identity = args.internal ? 'internal' : 'pseudonym';
  const document = args.summary
    ? await buildFeedbackSummary(args.universe)
    : args.dataset
      ? await buildFeedbackDataset(args.universe, { identity })
      : await buildFeedbackExport(args.universe);
  const text = args.summary
    ? `${JSON.stringify(document, null, 2)}\n`
    : args.dataset
      ? serializeFeedbackDataset(document)
      : serializeFeedbackExport(document);
  const report = {
    ok: true,
    universe_id: args.universe,
    document: args.summary ? 'feedback-summary' : args.dataset ? FEEDBACK_DATASET_SCHEMA : FEEDBACK_EXPORT_SCHEMA,
    path: args.out,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    responses: args.dataset ? document.manifest.counts.responses : document.counts.responses,
    suggested_name: args.dataset ? feedbackDatasetName(args.universe, identity) : feedbackExportName(args.universe)
  };
  if (args.dataset) {
    report.identity = identity;
    report.counted = document.manifest.counts.counted;
    report.files = document.manifest.counts.files;
  }
  if (args.out === null) {
    process.stdout.write(text);
    process.exit(0);
  }
  await writeFile(args.out, text, 'utf8');
  console.log(JSON.stringify(report));
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error?.message ?? String(error), code: error?.code ?? 'INTERNAL' }));
  process.exit(1);
}

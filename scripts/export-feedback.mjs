#!/usr/bin/env node
/**
 * Writes the reader-feedback dataset of one book, or its summary (`docs/contracts.md` §8.7), so a team
 * can keep it, diff one export against the next, or hand it to another tool. The same store produces
 * the same bytes, and nothing is ever written inside `universes/`.
 *
 *   node scripts/export-feedback.mjs --universe <universe-id>                 # the dataset, on stdout
 *   node scripts/export-feedback.mjs --universe <id> --out feedback.json      # the dataset, in a file
 *   node scripts/export-feedback.mjs --universe <id> --summary                # the summary, on stdout
 *
 * With `--out` one JSON line names the file that was written; without it the document itself is on
 * stdout, so it can be piped. Exit code 0 on success, 2 on a usage error, 1 on a refusal.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { FEEDBACK_EXPORT_SCHEMA, buildFeedbackExport, feedbackExportName, serializeFeedbackExport } from '../src/feedback-export.mjs';
import { buildFeedbackSummary } from '../src/feedback-summary.mjs';

const USAGE = 'usage: node scripts/export-feedback.mjs --universe <universe-id> [--out <file>] [--summary]';

function readArgs(argv) {
  const args = { universe: null, out: null, summary: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--summary') {
      args.summary = true;
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
  const document = args.summary
    ? await buildFeedbackSummary(args.universe)
    : await buildFeedbackExport(args.universe);
  const text = args.summary ? `${JSON.stringify(document, null, 2)}\n` : serializeFeedbackExport(document);
  if (args.out === null) {
    process.stdout.write(text);
    process.exit(0);
  }
  await writeFile(args.out, text, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    universe_id: args.universe,
    document: args.summary ? 'feedback-summary' : FEEDBACK_EXPORT_SCHEMA,
    path: args.out,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    responses: document.counts.responses,
    suggested_name: feedbackExportName(args.universe)
  }));
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error?.message ?? String(error), code: error?.code ?? 'INTERNAL' }));
  process.exit(1);
}

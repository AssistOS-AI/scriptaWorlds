// The import pipeline of the host, proved end to end without a model: a real upload is streamed into the
// workspace, its text is extracted, a universe is created for it, one bounded import turn writes that
// range of chapters through a stand-in agent, and the host verifies the turn with the import skill's own
// validator. The incremental case is the point: a book of three chapters is imported in one turn of two,
// the second turn carries the rest, and the import reports itself complete only when every chapter is in
// the store.
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { skillsDir, universeDir } from '../src/paths.mjs';
import {
  createUniverseFromImport,
  extractImport,
  listImports,
  loadImportContract,
  planTurnWindow,
  readImport,
  receiveImport
} from '../src/imports.mjs';
import { readUniverseMeta } from '../src/universe.mjs';
import { acceptedChapters } from '../src/universe-chapters.mjs';
import { waitForTurn } from './check-fixtures.mjs';

/**
 * The stand-in import agent: it reads the extraction staged in its working directory, writes the chapters
 * of the range the prompt names, and records the progress marker the import skill keeps. It is a real
 * child process spawned by the job machinery, so what this group proves is the pipeline rather than a
 * function call.
 */
const FAKE_IMPORT_AGENT = `#!/usr/bin/env node
// A stand-in for ALA during the host check: it reads the extraction staged in the universe, writes the
// chapters of the range the prompt names, and keeps the import record the way the import skill requires it
// — including the turns it did not run, so a second turn continues the first instead of overwriting it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (process.argv.includes('--version')) { process.stdout.write('fake-import/0.0.1\\n'); process.exit(0); }
process.stdin.resume();
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
await new Promise((resolve) => process.stdin.on('end', resolve));

const root = process.cwd();
const range = /chapters (\\d+) to (\\d+)/.exec(prompt);
const from = range ? Number(range[1]) : 1;
const to = range ? Number(range[2]) : 1;
const slugOf = (value) => String(value ?? 'chapter').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'chapter';

const extracted = JSON.parse(await readFile(join(root, '.agents', 'import', 'extracted.json'), 'utf8'));
const meta = JSON.parse(await readFile(join(root, 'universe.json'), 'utf8'));
const covered = extracted.chapters.filter((chapter) => chapter.number >= from && chapter.number <= to);
await mkdir(join(root, 'chapters'), { recursive: true });
await mkdir(join(root, 'drafts'), { recursive: true });
// The previous record tells this turn which universe chapter number to continue at: an extraction chapter
// that carries no prose is skipped, so the two numberings diverge and only the record knows how.
const earlier = JSON.parse(await readFile(join(root, 'drafts', 'import-progress.json'), 'utf8').catch(() => 'null'));
let nextChapterNumber = (earlier?.chapters ?? []).length + 1;
const written = [];
const skipped = [];
for (const chapter of covered) {
  const title = chapter.title ?? 'Chapter ' + chapter.number;
  if (String(chapter.text ?? '').trim().length === 0) {
    skipped.push({ source_chapter: chapter.number, reason: 'the extraction found a heading and no prose for this chapter' });
    continue;
  }
  const number = nextChapterNumber;
  await writeFile(join(root, 'chapters', String(number).padStart(4, '0') + '-' + slugOf(title) + '.md'), '# ' + title + '\\n\\n' + chapter.text + '\\n', 'utf8');
  await writeFile(join(root, 'drafts', String(number).padStart(4, '0') + '-plan.md'), 'what this chapter does\\n', 'utf8');
  written.push({ chapter: number, source_chapter: chapter.number, segment: null, file: 'chapters/' + String(number).padStart(4, '0') + '-' + slugOf(title) + '.md', title });
  nextChapterNumber += 1;
}
// The state files carry the vocabulary the import skill checks: the canon sections the narrative skill
// writes, the four thread containers and the published atlas axes.
const canon = [
  '# Canon',
  '',
  '## Fundamental laws',
  '',
  'The law of this imported book, as its own text establishes it: what the district owes is recorded, and what is not recorded is not owed. The keeper reads the entries aloud so that the square can hear the difference.',
  '',
  '## World',
  '',
  'The district, its square and its ledger.',
  '',
  '## Recurring characters',
  '',
  'The keeper of the ledger.',
  '',
  '## Timeline',
  '',
  'The mornings the ledger was read.',
  '',
  '## Stable facts',
  '',
  'An entry exists or it does not.',
  '',
  '## Mysteries with a fixed cause',
  '',
  'None established yet by the chapters imported so far.',
  ''
].join('\\n');
await writeFile(join(root, 'canon.md'), canon, 'utf8');
await writeFile(join(root, 'threads.json'), JSON.stringify({ version: 1, open: [], closed: [], promises: [], deferred_answers: [] }, null, 2) + '\\n', 'utf8');
await writeFile(join(root, 'atlas.json'), JSON.stringify({ version: 1, axes: [] }, null, 2) + '\\n', 'utf8');

// The import record: what this turn wrote, appended to what earlier turns wrote.
const chapters = (earlier?.chapters ?? []).concat(written);
// The record's turn range follows the extraction chapters this turn actually wrote, so an interior
// heading-only chapter is listed under skipped and never inside the range.
const turns = (earlier?.turns ?? []).concat([{
  number: (earlier?.turns ?? []).length + 1,
  imported_at: new Date().toISOString(),
  from_source_chapter: written.length > 0 ? written[0].source_chapter : from,
  to_source_chapter: written.length > 0 ? written[written.length - 1].source_chapter : to,
  chapters: written.map((entry) => entry.chapter)
}]);
const allSkipped = (earlier?.skipped ?? []).concat(skipped);
const next = extracted.chapters.find((chapter) => chapter.number > to);
await writeFile(join(root, 'drafts', 'import-progress.json'), JSON.stringify({
  schema_version: 'book-import.v1',
  import_id: extracted.import_id,
  source: { sha256: extracted.source.sha256 },
  segmentation: 'host',
  start_chapter: 1,
  language: { book: meta.language, state: meta.language, universe: meta.language, match: true },
  updated_at: new Date().toISOString(),
  chapters,
  skipped: allSkipped,
  turns,
  next_source_chapter: next ? next.number : null,
  complete: next === undefined
}, null, 2) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'imported chapters ' + from + '-' + to } }) + String.fromCharCode(10));
process.exit(0);
`;


async function installFakeImportAgent() {
  const dir = await mkdtemp(join(tmpdir(), 'fake-import-'));
  await writeFile(join(dir, 'fake-import.mjs'), FAKE_IMPORT_AGENT, 'utf8');
  const shim = join(dir, 'omp');
  await writeFile(shim, '#!/bin/sh\nexec node "$(dirname "$0")/fake-import.mjs" "$@"\n', 'utf8');
  await chmod(shim, 0o755);
  const previousPath = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${previousPath}`;
  return {
    dir,
    restore: async () => {
      process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  };
}

// A chapter long enough that the published word bound — not the chapter count — decides the window: five
// chapters of this size cannot all travel in one turn.
const CHAPTER_TEXT = (index) =>
  `The district kept its ledger in the old way, and on the ${index}th morning the keeper read the entries aloud so that the square could hear what it owed. Nobody spoke of the debt without an entry. `.repeat(160).trim();

const FIXTURE_CHAPTERS = 5;

// The same prose, short enough that three chapters fit in one turn's published word bound: the skipped
// chapter then sits between two written ones, inside a single turn's range.
const SHORT_TEXT = (index) =>
  `The district kept its ledger in the old way, and on the ${index}th morning the keeper read the entries aloud. `.repeat(30).trim();

export async function runImportTurnChecks({ ok, fail, checkSeed, tempDirs = [] }) {
  // A text-only deployment can read a DOCX package without a system library, which is what this pipeline
  // assumes; a host that pins its agent binary keeps that binary (as the other groups do).
  const fakeAgentUsable = config.ompBin === 'omp';
  const fixtureDir = await mkdtemp(join(tmpdir(), 'import-fixture-'));
  let fixturePath = null;
  // The DOCX fixture is the extractor's own: its group builds a package its reader accepts, and this group
  // uploads it rather than inventing a second one.
  const fixtureBuilder = await import('./check-imports.mjs').then((module) => module.writeDocxFixture, () => null);
  if (typeof fixtureBuilder !== 'function') {
    ok('imports: not exercised here (the extractor does not export a DOCX fixture builder yet)');
    return;
  }
  try {
    fixturePath = await fixtureBuilder({
      dir: fixtureDir,
      filename: `book-${checkSeed}.docx`,
      chapters: Array.from({ length: FIXTURE_CHAPTERS }, (unused, index) => ({
        title: `Chapter ${index + 1}`,
        paragraphs: [CHAPTER_TEXT(index + 1)]
      }))
    });
  } catch (error) {
    fail(`imports: the DOCX fixture could not be built (${error.message})`);
    return;
  }

  // 1. The upload: bytes off a stream, hashed and bounded while they arrive.
  const bytes = await readFile(fixturePath);
  const received = await receiveImport({ stream: Readable.from([bytes]), filename: `book-${checkSeed}.docx` });
  const listed = await listImports();
  if (received.state === 'received' && received.bytes === bytes.length && received.format === 'docx' && /^[0-9a-f]{64}$/.test(received.sha256)) {
    ok(`imports: an uploaded book is streamed into the workspace with its hash and size (${received.import_id}, ${received.bytes} bytes)`);
  } else {
    fail(`imports/upload: state=${received.state}, bytes=${received.bytes}/${bytes.length}, format=${received.format}, sha256=${received.sha256?.slice(0, 12)}`);
    return;
  }
  if (listed.some((entry) => entry.import_id === received.import_id)) {
    ok('imports: the upload appears in the import list');
  } else {
    fail(`imports/list: ${JSON.stringify(listed.map((entry) => entry.import_id))}`);
  }

  // 2. The extraction: deterministic text, written beside the upload with a readable twin.
  let ready = null;
  try {
    ready = await extractImport(received.import_id);
  } catch (error) {
    fail(`imports/extract: ${error.code ?? ''} ${error.message}`);
    return;
  }
  const extractedRaw = await readFile(join(config.assessmentWorkspace, 'imports', received.import_id, 'extracted.json'), 'utf8').then(JSON.parse, () => null);
  const bookText = await readFile(join(config.assessmentWorkspace, 'imports', received.import_id, 'book.md'), 'utf8').then((text) => text, () => '');
  const chapters = extractedRaw?.chapters ?? [];
  if (ready.state === 'ready' && chapters.length === FIXTURE_CHAPTERS && chapters.every((chapter) => chapter.words > 0) && bookText.includes('Chapter 2')) {
    ok(`imports: the uploaded book is extracted into ${chapters.length} chapters (${chapters.map((chapter) => chapter.words).join('/')} words) with a readable twin`);
  } else {
    fail(`imports/extract: state=${ready.state}, chapters=${chapters.length}, words=${JSON.stringify(chapters.map((chapter) => chapter.words))}, book=${bookText.length}`);
    return;
  }

  // 3. The window one turn covers: the skill publishes the bound, and the host plans inside it.
  const contract = await loadImportContract(skillsDir);
  const firstNumber = chapters[0].number;
  const lastNumber = chapters[chapters.length - 1].number;
  const wordBound = planTurnWindow(chapters, firstNumber, { maxChapters: 99, maxWords: chapters[0].words + 1 });
  const chapterBound = planTurnWindow(chapters, firstNumber, { maxChapters: 2, maxWords: 10_000_000 });
  const published = planTurnWindow(chapters, firstNumber, contract.limits);
  const beyond = planTurnWindow(chapters, lastNumber + 5, contract.limits);
  // The expected window is computed here from the word counts rather than read from the function under
  // test: the longest prefix that stays inside the published bounds, and never shorter than one chapter.
  let expected = 0;
  let total = 0;
  for (const chapter of chapters) {
    if (expected >= contract.limits.maxChapters) break;
    if (expected > 0 && total + chapter.words > contract.limits.maxWords) break;
    total += chapter.words;
    expected += 1;
  }
  const properties = published?.chapters.length === expected
    && published.words === total
    && published.to === chapters[expected - 1].number
    && (published.chapters.length <= 1 || published.words <= contract.limits.maxWords)
    && published.chapters.length <= contract.limits.maxChapters
    && wordBound?.to === firstNumber
    && chapterBound?.chapters.length === 2
    && beyond === null;
  if (properties) {
    ok(`imports: the window of one turn is the longest prefix inside the published bounds (${published.chapters.length} of ${chapters.length} chapters, ${published.words} words, limits ${contract.limits.maxChapters}/${contract.limits.maxWords}), and a pointer past the extraction yields no window`);
  } else {
    fail(`imports/window: published=${JSON.stringify(published)}, expected=${expected}/${total}, word=${JSON.stringify(wordBound)}, chapters=${JSON.stringify(chapterBound)}, beyond=${JSON.stringify(beyond)}, limits=${JSON.stringify(contract.limits)}`);
  }

  // 4. The universe: created for the book, with the extraction staged inside it and one import turn queued.
  if (!fakeAgentUsable) {
    ok(`imports/turn: not exercised here (OMP_BIN pins the agent binary to ${config.ompBin})`);
    return;
  }
  const fake = await installFakeImportAgent();
  try {
    const created = await createUniverseFromImport({ importId: received.import_id });
    tempDirs.push(created.universe.id);
    const meta = await readUniverseMeta(created.universe.id);
    const record = await readImport(received.import_id);
    const staged = await readFile(join(universeDir(created.universe.id), '.agents', 'import', 'extracted.json'), 'utf8').then(JSON.parse, () => null);
    if (record.universe_id === created.universe.id && created.turn?.kind === 'import' && created.range?.from === 1
      && created.range.to >= 1 && staged?.chapters?.length === FIXTURE_CHAPTERS && meta.title.length > 0) {
      ok(`imports: a universe is created for the upload ("${meta.title}"), the extraction is staged inside it and the first import turn covers chapters ${created.range.from}-${created.range.to}`);
    } else {
      fail(`imports/universe: record.universe_id=${record.universe_id}, turn=${created.turn?.kind}, range=${JSON.stringify(created.range)}, staged=${staged?.chapters?.length}, title=${meta.title}`);
      return;
    }

    const settled = await waitForTurn(created.universe.id, created.turn.turnNumber, (entry) => entry.status !== 'queued' && entry.status !== 'running');
    const written = await acceptedChapters(created.universe.id);
    if (settled?.status === 'done' && written.length === created.range.to) {
      ok(`imports: the import turn writes chapters ${created.range.from}-${created.range.to} and the skill's validator accepts them (turn ${created.turn.turnNumber}, status ${settled.status})`);
    } else {
      fail(`imports/turn: status=${settled?.status}, error=${settled?.error}, chapters=${written.map((chapter) => chapter.number).join(',')}, warnings=${JSON.stringify(settled?.warnings)}`);
      return;
    }

    // 5. The rest of the book arrives in the next turns, and the import reports itself complete.
    let guard = 0;
    let status = await createUniverseFromImport({ importId: received.import_id });
    while (status.turn && guard < 5) {
      await waitForTurn(status.universe.id, status.turn.turnNumber, (entry) => entry.status !== 'queued' && entry.status !== 'running');
      status = await createUniverseFromImport({ importId: received.import_id });
      guard += 1;
    }
    const complete = status.progress ?? null;
    const total = (await acceptedChapters(status.universe.id)).length;
    if (status.turn === null && complete?.complete === true && complete.imported === complete.total && total === FIXTURE_CHAPTERS) {
      ok(`imports: a book longer than one turn is imported in ${guard} further turn${guard === 1 ? '' : 's'} and the import reports itself complete (${complete.imported}/${complete.total} chapters)`);
    } else {
      fail(`imports/complete: turn=${status.turn?.turnNumber}, complete=${complete?.complete}, imported=${complete?.imported}/${complete?.total}, chapters=${total}`);
    }
    // 6. A chapter that carries a heading and no prose is skipped, so extraction numbering and chapter
    // numbering diverge: the turn must be accepted on the strength of its own record, not of arithmetic.
    const headingOnlyDir = await mkdtemp(join(tmpdir(), 'import-heading-only-'));
    const headingOnly = await fixtureBuilder({
      dir: headingOnlyDir,
      filename: `heading-only-${checkSeed}.docx`,
      chapters: [
        { title: 'Chapter One', paragraphs: [SHORT_TEXT(1)] },
        { title: 'Part Two', paragraphs: [] },
        { title: 'Chapter Three', paragraphs: [SHORT_TEXT(3)] }
      ]
    });
    const second = await receiveImport({ stream: Readable.from([await readFile(headingOnly)]), filename: `heading-only-${checkSeed}.docx` });
    const secondReady = await extractImport(second.import_id).catch((error) => ({ state: 'error', error: error.message }));
    const secondExtracted = await readFile(join(config.assessmentWorkspace, 'imports', second.import_id, 'extracted.json'), 'utf8').then(JSON.parse, () => null);
    const declaredEmpty = (secondExtracted?.chapters ?? []).some((chapter) => String(chapter.text ?? '').trim().length === 0);
    if (secondReady.state !== 'ready' || !declaredEmpty) {
      fail(`imports/skipped: state=${secondReady.state}, chapters=${JSON.stringify((secondExtracted?.chapters ?? []).map((chapter) => ({ number: chapter.number, words: chapter.words })))}`);
    } else {
      const created2 = await createUniverseFromImport({ importId: second.import_id });
      tempDirs.push(created2.universe.id);
      // All three extraction chapters fit one window, so one turn must carry the book to its end while
      // writing one chapter fewer than the extraction declares.
      const settled2 = await waitForTurn(created2.universe.id, created2.turn.turnNumber, (entry) => entry.status !== 'queued' && entry.status !== 'running');
      const status2 = await createUniverseFromImport({ importId: second.import_id });
      const marker2 = await readFile(join(universeDir(created2.universe.id), 'drafts', 'import-progress.json'), 'utf8').then(JSON.parse, () => null);
      const turns2 = marker2?.turns ?? [];
      const lastTurn = turns2[turns2.length - 1] ?? null;
      const written2 = await acceptedChapters(created2.universe.id);
      // The last turn starts at extraction chapter 3 and writes the second chapter of the book: extraction
      // numbering and chapter numbering have diverged, and only the record says so.
      if (settled2?.status === 'done'
        && turns2.length === 1
        && status2.turn === null
        && lastTurn?.from_source_chapter === 1
        && lastTurn?.to_source_chapter === 3
        && lastTurn?.chapters?.join(',') === '1,2'
        && (marker2?.skipped ?? []).some((entry) => entry.source_chapter === 2)
        && (marker2?.next_source_chapter ?? null) === null
        && marker2?.complete === true
        && written2.map((chapter) => chapter.number).join(',') === '1,2') {
        ok(`imports/skipped: a heading-only chapter in the middle of a book is skipped (extraction 1-3 → chapters ${lastTurn.chapters.join(',')}), the turn is verified against its own record rather than against extraction numbering, and the import completes`);
      } else {
        fail(`imports/skipped: status=${settled2?.status}, error=${settled2?.error}, turns=${JSON.stringify(turns2)}, skipped=${JSON.stringify(marker2?.skipped)}, pointer=${marker2?.next_source_chapter}, complete=${marker2?.complete}, chapters=${written2.map((chapter) => chapter.number).join(',')}`);
      }
    }
  } finally {
    await fake.restore();
  }
}

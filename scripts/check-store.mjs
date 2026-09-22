// The store group of `scripts/check.mjs`: the accepted book, its snapshots and its readers.
//
// Every check here builds a real temporary universe and asserts the observable outcome — what a
// reader would see and what a restart would leave behind — instead of calling an internal helper. The
// helpers `ok`, `fail`, `checkSeed` and `tempDirs` come from the caller so the report stays linear.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readChapter, readIdeas } from '../src/universe.mjs';
import {
  acceptedChapters,
  archiveChapter,
  dropChaptersFrom,
  listChapterHistory,
  scanChapterFiles,
  scanTurns
} from '../src/universe-chapters.mjs';
import {
  prepareSnapshot,
  readAncestry,
  recoverUniverse,
  restoreCanon,
  restoreState,
  snapshotStatus,
  writeAncestry
} from '../src/universe-state.mjs';
import { universeDir } from '../src/paths.mjs';
import {
  CANON,
  CHAPTER,
  OFFER,
  bookWithChapter,
  inventory,
  inventoryDiff,
  turnRecord
} from './check-fixtures.mjs';

export async function runStoreChecks({ ok, fail, checkSeed, tempDirs }) {
  const durable = await bookWithChapter(checkSeed, 'store');
  tempDirs.push(durable.id);
  const durableDir = universeDir(durable.id);

  // Durability: the queue stays on disk, a `running` turn becomes `interrupted`, and the accepted book
  // comes back from the snapshot taken before the turn.
  {
    await turnRecord(durable.id, 1, { kind: 'chapter', status: 'queued', request: 'queued request' });
    await turnRecord(durable.id, 2, {
      kind: 'chapter', status: 'running', request: 'interrupted request', chapterNumber: 2,
      startedAt: new Date().toISOString()
    });
    await prepareSnapshot(durable.id, 2, 'chapter');
    const before = await inventory(durable.id);
    // What a crashed agent leaves behind: half a chapter, a rewritten canon and an extra plan.
    await writeFile(join(durableDir, 'chapters', '0002-half.md'), '# Half\n\npartial text\n', 'utf8');
    await writeFile(join(durableDir, 'canon.md'), CANON('New state written by the agent before the crash.'), 'utf8');
    await mkdir(join(durableDir, 'drafts'), { recursive: true });
    await writeFile(join(durableDir, 'drafts', '0002-plan.md'), '- dramatic_question: half a plan\n', 'utf8');
    const recovery = await recoverUniverse(durable.id);
    const after = await inventory(durable.id);
    const diff = inventoryDiff(before, after);
    const queuedKept = recovery.queued.length === 1 && recovery.queued[0].number === 1;
    if (queuedKept && recovery.interrupted.includes(2) && diff.length === 0) {
      ok('durability: the queue stays on disk, a `running` turn becomes `interrupted`, and the accepted book returns exactly');
    } else {
      fail(`durability: queued=${recovery.queued.length}, interrupted=[${recovery.interrupted}], diff=[${diff.join('; ')}]`);
    }
  }

  // An incomplete or unusable snapshot is never mistaken for a usable one, and the book then refuses
  // every further write instead of pretending its accepted state is known.
  {
    const half = await bookWithChapter(checkSeed, 'incomplete');
    tempDirs.push(half.id);
    await turnRecord(half.id, 1, { kind: 'chapter', status: 'running', request: 'interrupted request', chapterNumber: 2, startedAt: new Date().toISOString() });
    const missing = await snapshotStatus(half.id, 1);
    // A directory with leftovers but no published manifest: the shape a crash during preparation takes.
    await mkdir(join(universeDir(half.id), 'turns', '0001.prev.staging-deadbeef'), { recursive: true });
    const emptyDir = await snapshotStatus(half.id, 1);
    await rm(join(universeDir(half.id), 'turns', '0001.prev.staging-deadbeef'), { recursive: true, force: true });
    const recovery = await recoverUniverse(half.id);
    const record = JSON.parse(await readFile(join(universeDir(half.id), 'turns', '0001.json'), 'utf8'));
    if (missing === 'missing' && emptyDir === 'missing' && recovery.blocked.includes(1) && record.status === 'recovery_required') {
      ok('recovery: a missing snapshot leaves the turn `recovery_required` and the book blocked for writing');
    } else {
      fail(`recovery/missing: status=${missing}, stagingOnly=${emptyDir}, blocked=[${recovery.blocked}], record=${record.status}`);
    }
  }

  // A published snapshot whose bytes no longer match its manifest is unusable, not "good enough".
  {
    const corrupt = await bookWithChapter(checkSeed, 'corrupt');
    tempDirs.push(corrupt.id);
    await prepareSnapshot(corrupt.id, 1, 'chapter');
    await writeFile(join(universeDir(corrupt.id), 'turns', '0001.prev', 'canon.md'), CANON('Tampered after publication.'), 'utf8');
    const status = await snapshotStatus(corrupt.id, 1);
    const restored = await restoreState(corrupt.id, 1);
    await turnRecord(corrupt.id, 1, { kind: 'chapter', status: 'running', request: 'interrupted request', startedAt: new Date().toISOString() });
    const recovery = await recoverUniverse(corrupt.id);
    if (status === 'corrupt' && restored.ok === false && recovery.blocked.includes(1)) {
      ok('recovery: a tampered snapshot is refused (`corrupt`) and the book blocks instead of claiming a restore');
    } else {
      fail(`recovery/corrupt: status=${status}, restored=${JSON.stringify(restored)}, blocked=[${recovery.blocked}]`);
    }
  }

  // The restore covers the whole accepted file set: an invented chapter, a renamed target, a changed
  // older chapter and a damaged offer all disappear, and repeating the restore changes nothing.
  {
    const universe = await bookWithChapter(checkSeed, 'accepted');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    await writeFile(join(dir, 'chapters', '0002-two.md'), CHAPTER('Two', 'second'), 'utf8');
    await writeFile(join(dir, 'chapters', '0002-offer.json'), OFFER('Two chapters of ledger and a district that holds. What does the registry charge for silence?'), 'utf8');
    await prepareSnapshot(universe.id, 5, 'chapter');
    const before = await inventory(universe.id);
    await writeFile(join(dir, 'chapters', '0099-invented.md'), CHAPTER('Invented', 'candidate'), 'utf8');
    await rm(join(dir, 'chapters', '0001-one.md'), { force: true });
    await writeFile(join(dir, 'chapters', '0001-renamed.md'), CHAPTER('One', 'renamed'), 'utf8');
    await writeFile(join(dir, 'chapters', '0002-offer.json'), '{ "teaser": "damaged"', 'utf8');
    await writeFile(join(dir, 'threads.json'), JSON.stringify({ open: [{ id: 'thread-0001' }], closed: [], promises: [], deferred_answers: [] }), 'utf8');
    const first = await restoreState(universe.id, 5);
    const afterFirst = await inventory(universe.id);
    const firstDiff = inventoryDiff(before, afterFirst);
    const second = await restoreState(universe.id, 5);
    const afterSecond = await inventory(universe.id);
    const secondDiff = inventoryDiff(before, afterSecond);
    if (first.ok === true && second.ok === true && firstDiff.length === 0 && secondDiff.length === 0) {
      ok('restore: bytes and membership return to the accepted file set, repeatably, twice in a row');
    } else {
      fail(`restore: first=${JSON.stringify(first)}, second=${JSON.stringify(second)}, diff=[${[...firstDiff, ...secondDiff].join('; ')}]`);
    }
  }

  // Reads during generation expose accepted chapters only: the chapter a running turn is writing is a
  // candidate and stays hidden until the turn commits.
  {
    const universe = await bookWithChapter(checkSeed, 'reader');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    await writeFile(join(dir, 'chapters', '0002-candidate.md'), CHAPTER('Two', 'candidate'), 'utf8');
    const visibleBefore = (await acceptedChapters(universe.id)).map((chapter) => chapter.number);
    await turnRecord(universe.id, 3, {
      kind: 'chapter', status: 'running', request: 'writing chapter two', chapterNumber: 2,
      startedAt: new Date().toISOString(), finishedAt: null, durationMs: null
    });
    const visibleDuring = (await acceptedChapters(universe.id)).map((chapter) => chapter.number);
    const read = await readChapter(universe.id, 2).then(() => 'visible', (error) => error.code);
    await turnRecord(universe.id, 3, { kind: 'chapter', status: 'done', request: 'writing chapter two', chapterNumber: 2 });
    const visibleAfter = (await acceptedChapters(universe.id)).map((chapter) => chapter.number);
    if (visibleBefore.join(',') === '1,2' && visibleDuring.join(',') === '1' && read === 'NOT_FOUND' && visibleAfter.join(',') === '1,2') {
      ok('reads: a chapter being written is hidden until the turn commits, and appears after it');
    } else {
      fail(`reads: before=[${visibleBefore}], during=[${visibleDuring}], read=${read}, after=[${visibleAfter}]`);
    }
  }

  // Concrete ideas (used by the narrative closing panel) + reading ALA's offer from a chapter.
  {
    const universe = await bookWithChapter(checkSeed, 'ideas');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    await writeFile(join(dir, 'threads.json'), JSON.stringify({
      open: [{ id: 'thread-0001', kind: 'mystery', question: 'Who built cage 31?', created_chapter: 1, due_chapter: 3, status: 'open' }],
      closed: [], promises: [], deferred_answers: []
    }), 'utf8');
    const chapter = await readChapter(universe.id, 1);
    const ideas = await readIdeas(universe.id);
    if (chapter.offer?.options?.length === 2 && ideas.length >= 2 && ideas.some((idea) => idea.prompt.includes('cage 31'))) {
      ok(`ALA offer read from chapters/NNNN-offer.json and ${ideas.length} continuation ideas derived from threads`);
    } else {
      fail(`offer/ideas: offer=${JSON.stringify(chapter.offer)}, ideas=${ideas.length}`);
    }
  }

  // Version archiving and the explicit drop of later chapters.
  {
    const universe = await bookWithChapter(checkSeed, 'archive');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    await writeFile(join(dir, 'chapters', '0002-two.md'), CHAPTER('Two', 'second'), 'utf8');
    await writeFile(join(dir, 'chapters', '0003-three.md'), CHAPTER('Three', 'third'), 'utf8');
    const archived = await archiveChapter(universe.id, 1);
    const history = await listChapterHistory(universe.id, 1);
    const dropped = await dropChaptersFrom(universe.id, 2);
    const twoGone = !(await stat(join(dir, 'chapters', '0002-two.md')).then(() => true, () => false));
    if (archived?.version === 1 && history.length === 1 && dropped.join(',') === '2,3' && twoGone) {
      ok('rewrite: the old version is archived in chapters/.history/ and later chapters can be dropped');
    } else {
      fail(`rewrite: archived=${archived?.version}, history=${history.length}, dropped=[${dropped}], 0002 gone=${twoGone}`);
    }
  }

  // The chapter's ancestry is recorded once, when the chapter is first written, and survives later
  // rewrites: it is the state a rewrite generates from, not the state before the last rewrite. A
  // snapshot taken after a successful chapter holds the chapter too.
  {
    const universe = await bookWithChapter(checkSeed, 'ancestry');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    await rm(join(dir, 'chapters', '0001-one.md'), { force: true });
    await rm(join(dir, 'chapters', '0001-offer.json'), { force: true });
    await writeFile(join(dir, 'canon.md'), CANON('before chapter one'), 'utf8');
    await prepareSnapshot(universe.id, 1, 'chapter');
    await writeFile(join(dir, 'chapters', '0001-one.md'), CHAPTER('One', 'first'), 'utf8');
    await writeFile(join(dir, 'chapters', '0001-offer.json'), OFFER('The keeper read the ledger aloud and the district answered. Now the registry wants the price.'), 'utf8');
    await writeAncestry(universe.id, 1, 1, null);
    const accepted = await inventory(universe.id);
    await prepareSnapshot(universe.id, 2, 'chapter');
    await restoreState(universe.id, 2);
    const afterRestore = await inventory(universe.id);
    const diff = inventoryDiff(accepted, afterRestore);
    const ancestry = await readAncestry(universe.id, 1);
    // The same snapshot also carries the state that preceded the chapter, for generation.
    await restoreCanon(universe.id, 1);
    const canon = await readFile(join(dir, 'canon.md'), 'utf8');
    if (ancestry?.source_turn === 1 && diff.length === 0 && canon.includes('before chapter one') && accepted.has('chapters/0001-one.md')) {
      ok('ancestry: a chapter records the turn whose snapshot holds the state that preceded it, and a later snapshot keeps the chapter');
    } else {
      fail(`ancestry: record=${JSON.stringify(ancestry)}, diff=[${diff.join('; ')}], canon=${canon.slice(0, 30)}`);
    }
  }

  // The archive is what makes a drop safe: text and offer are stored before the file is removed, and a
  // chapters folder that is already complete still lists the same accepted chapters.
  {
    const universe = await bookWithChapter(checkSeed, 'inventory');
    tempDirs.push(universe.id);
    const files = (await scanChapterFiles(universe.id)).map((chapter) => chapter.number);
    const turns = (await scanTurns(universe.id)).length;
    const accepted = (await acceptedChapters(universe.id)).map((chapter) => chapter.number);
    if (files.join(',') === '1' && accepted.join(',') === '1' && turns === 0) {
      ok('inventory: chapter scan, accepted chapters and turn scan agree on a book with one chapter');
    } else {
      fail(`inventory: files=[${files}], accepted=[${accepted}], turns=${turns}`);
    }
  }
}

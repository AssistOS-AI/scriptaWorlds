// The turn group of `scripts/check.mjs`: the rewrite transaction as the store performs it, and the
// prompt a chapter turn is written from. The process-level scenarios live in `check-runtime.mjs`.
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareRewrite, turnPrompt, verifyChapterTurn } from '../src/turn.mjs';
import { jobs } from '../src/jobs.mjs';
import { normaliseDirections, normaliseRevision } from '../src/request-fields.mjs';
import { prepareSnapshot, readAncestry, restoreState, writeAncestry } from '../src/universe-state.mjs';
import { listChapterHistory } from '../src/universe-chapters.mjs';
import { sha256Hex } from '../src/version.mjs';
import { universeDir } from '../src/paths.mjs';
import { CHAPTER, OFFER, bookWithTwoChapters, inventory } from './check-fixtures.mjs';

const LAW = 'Cities exist only as long as someone tells them; silence dissolves them into stone.';

export async function runTurnChecks({ ok, fail, checkSeed, tempDirs }) {
  // Approved directions are input data of a writing request: the prompt states them, the turn record
  // keeps them with the approval they came from, and a malformed list is refused before any queueing.
  {
    const directions = [
      'Keep the voice of the keeper flat in the aftermath; do not raise the stakes this episode.',
      'Show the interest as work rather than as a fine.'
    ];
    const prompt = turnPrompt({
      meta: { title: 'The Ledger District', law: LAW, language: 'en', elements: [] },
      job: { kind: 'chapter', message: 'Continue the story: the registry collects the interest.', format: 'both' },
      chapterNumber: 3,
      chapterFiles: [],
      contextChapters: ['chapters/0002-two.md'],
      omittedChapters: [1],
      directions
    });
    const stated = prompt.includes('APPROVED DIRECTIONS') && prompt.includes(directions[1]);
    const lawFirst = prompt.indexOf(LAW) < prompt.indexOf('APPROVED DIRECTIONS');
    const bounded = [];
    let tooMany = 'accepted';
    try {
      normaliseDirections(Array.from({ length: 9 }, (_, index) => `Direction ${index} about the voice of the keeper.`));
    } catch (error) {
      tooMany = error.code;
    }
    let empty = 'accepted';
    try {
      normaliseDirections(['   ']);
    } catch (error) {
      empty = error.code;
    }
    let notAList = 'accepted';
    try {
      normaliseDirections('a single sentence');
    } catch (error) {
      notAList = error.code;
    }
    const provenance = normaliseDirections(directions.slice(0, 1), { path: 'assessments/x/result/approval.json', sha256: 'abc', version: 'sha256:fff' });
    if (stated && lawFirst && tooMany === 'BAD_DIRECTIONS' && empty === 'BAD_DIRECTIONS' && notAList === 'BAD_DIRECTIONS'
      && provenance.approval?.path === 'assessments/x/result/approval.json' && bounded.length === 0) {
      ok('approved directions: the prompt states them under the law, the record keeps the approval they came from, and a malformed list is refused');
    } else {
      fail(`approved directions: stated=${stated}, lawFirst=${lawFirst}, tooMany=${tooMany}, empty=${empty}, notAList=${notAList}, provenance=${JSON.stringify(provenance.approval)}`);
    }
  }

  // A rewrite needs two references: the current accepted book for rollback, and the state that preceded
  // its target chapter for generation. The second rewrite of a replacement generates from the same
  // ancestry as the first, while a failed rewrite restores the accepted replacement.
  {
    const universe = await bookWithTwoChapters(checkSeed, 'ancestry');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    for (const name of ['0001-one.md', '0001-offer.json', '0002-two.md', '0002-offer.json']) {
      await rm(join(dir, 'chapters', name), { force: true });
    }
    await writeFile(join(dir, 'canon.md'), '# Canon — before chapter one\n\n## Fundamental laws\n- Cities exist only as long as someone tells them; silence dissolves them into stone.\n\n## World\n- Nothing has been read aloud yet.\n\n## Recurring characters\n\n## Timeline\n\n## Stable facts\n\n## Mysteries with a fixed cause\n', 'utf8');
    await prepareSnapshot(universe.id, 1, 'chapter');
    await writeFile(join(dir, 'chapters', '0001-one.md'), CHAPTER('One', 'first'), 'utf8');
    await writeFile(join(dir, 'chapters', '0001-offer.json'), OFFER('The keeper read the ledger aloud and the district answered. Now the registry wants the price.'), 'utf8');
    await writeAncestry(universe.id, 1, 1, null);
    await writeFile(join(dir, 'canon.md'), '# Canon — after chapter one\n\n## Fundamental laws\n- Cities exist only as long as someone tells them; silence dissolves them into stone.\n\n## World\n- The district answered the reading.\n\n## Recurring characters\n\n## Timeline\n\n## Stable facts\n\n## Mysteries with a fixed cause\n', 'utf8');

    // Turn 7 rewrites chapter 1: the accepted book is snapshotted first, then the rewrite prepares.
    const firstSnapshot = await prepareSnapshot(universe.id, 7, 'rewrite');
    const previousText = await prepareRewrite({
      universeId: universe.id, chapterNumber: 1, dropLater: true,
      ancestryTurn: (await readAncestry(universe.id, 1))?.source_turn ?? null
    });
    const canonAtFirst = await readFile(join(dir, 'canon.md'), 'utf8');
    await writeFile(join(dir, 'chapters', '0001-one.md'), CHAPTER('One', 'replacement'), 'utf8');
    await writeFile(join(dir, 'chapters', '0001-offer.json'), OFFER('The replacement chapter ends quietly and the ledger stays closed for now.'), 'utf8');
    await writeFile(join(dir, 'canon.md'), '# Canon — after the replacement\n\n## Fundamental laws\n- Cities exist only as long as someone tells them; silence dissolves them into stone.\n\n## World\n- The second reading was quieter.\n\n## Recurring characters\n\n## Timeline\n\n## Stable facts\n\n## Mysteries with a fixed cause\n', 'utf8');
    const acceptedReplacement = sha256Hex(await readFile(join(dir, 'chapters', '0001-one.md'), 'utf8'));

    // Turn 8 rewrites the replacement. Its generation base is still the ancestry of chapter 1, and its
    // rollback reference is the accepted replacement, so a failure restores the replacement.
    const secondSnapshot = await prepareSnapshot(universe.id, 8, 'rewrite');
    await prepareRewrite({
      universeId: universe.id, chapterNumber: 1, dropLater: true,
      ancestryTurn: (await readAncestry(universe.id, 1))?.source_turn ?? null
    });
    const canonAtSecond = await readFile(join(dir, 'canon.md'), 'utf8');
    await writeFile(join(dir, 'chapters', '0001-one.md'), '# One\n\nthe agent half-wrote this\n', 'utf8');
    const restored = await restoreState(universe.id, 8);
    const textAfterRestore = sha256Hex(await readFile(join(dir, 'chapters', '0001-one.md'), 'utf8'));
    if (previousText.includes('first') && canonAtFirst.includes('before chapter one') && canonAtSecond.includes('before chapter one')
      && firstSnapshot.turn === 7 && secondSnapshot.turn === 8 && restored.ok === true && textAfterRestore === acceptedReplacement) {
      ok('ancestry: both rewrites generate from the original pre-chapter state, and a failed rewrite restores the accepted replacement');
    } else {
      fail(`ancestry: firstGeneration=${canonAtFirst.includes('before chapter one')}, secondGeneration=${canonAtSecond.includes('before chapter one')}, restored=${JSON.stringify(restored)}, replacement=${textAfterRestore === acceptedReplacement}`);
    }
  }

  // A rewrite of a chapter with no recorded ancestry stops before any destructive preparation.
  {
    const universe = await bookWithTwoChapters(checkSeed, 'noancestry');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    let code = 'accepted';
    try {
      // The later chapter is authorised, so the request reaches the ancestry check instead of the
      // authorisation check that runs before it.
      await prepareRewrite({
        universeId: universe.id, chapterNumber: 1, dropLater: false, ancestryTurn: null,
        expectedTargetSha256: null, expectedLaterChapters: [2]
      });
    } catch (error) {
      code = error.code;
    }
    const stillThere = await stat(join(dir, 'chapters', '0001-one.md')).then(() => true, () => false);
    if (code === 'NO_ANCESTRY' && stillThere) {
      ok('ancestry: a rewrite without a recorded pre-chapter state stops before deleting anything (NO_ANCESTRY)');
    } else {
      fail(`ancestry/missing: code=${code}, chapter still on disk=${stillThere}`);
    }
  }

  // A stale request is refused, not reinterpreted: the target changed after the rewrite was requested.
  {
    const universe = await bookWithTwoChapters(checkSeed, 'stale');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    await prepareSnapshot(universe.id, 1, 'chapter');
    await writeAncestry(universe.id, 1, 1, null);
    const staleHash = sha256Hex(await readFile(join(dir, 'chapters', '0001-one.md'), 'utf8'));
    await writeFile(join(dir, 'chapters', '0001-one.md'), CHAPTER('One', 'changed by another turn'), 'utf8');
    const before = await inventory(universe.id);
    let code = 'accepted';
    try {
      await prepareRewrite({
        universeId: universe.id, chapterNumber: 1, dropLater: false, ancestryTurn: 1,
        expectedTargetSha256: staleHash, expectedLaterChapters: [2]
      });
    } catch (error) {
      code = error.code;
    }
    const after = await inventory(universe.id);
    const touched = [...after.keys()].filter((path) => !before.has(path));
    if (code === 'STALE_REQUEST' && touched.length === 0) {
      ok('rewrite binding: a chapter that changed after the request makes the rewrite STALE_REQUEST, and nothing is touched');
    } else {
      fail(`rewrite binding: code=${code}, added=${JSON.stringify(touched)}`);
    }
  }

  // An unauthorised later chapter is refused too: the request must cover that condition explicitly.
  {
    const universe = await bookWithTwoChapters(checkSeed, 'later');
    tempDirs.push(universe.id);
    await prepareSnapshot(universe.id, 1, 'chapter');
    await writeAncestry(universe.id, 1, 1, null);
    let code = 'accepted';
    try {
      await prepareRewrite({
        universeId: universe.id, chapterNumber: 1, dropLater: false, ancestryTurn: 1,
        expectedTargetSha256: null, expectedLaterChapters: []
      });
    } catch (error) {
      code = error.code;
    }
    const archived = await listChapterHistory(universe.id, 2);
    if (code === 'STALE_REQUEST' && archived.length === 0) {
      ok('rewrite binding: a later chapter that appeared after the request is refused unless the request authorises dropping it');
    } else {
      fail(`rewrite binding/later: code=${code}, archived chapter 2 versions=${archived.length}`);
    }
  }

  // An archive that fails stops the deletion: the later chapter and its offer stay available.
  {
    const universe = await bookWithTwoChapters(checkSeed, 'archivefail');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    await prepareSnapshot(universe.id, 1, 'chapter');
    await writeAncestry(universe.id, 1, 1, null);
    const historyDir = join(dir, 'chapters', '.history');
    let code = 'accepted';
    let skipped = null;
    if (process.getuid?.() === 0) {
      skipped = 'running as root: a read-only directory would not stop the write';
    } else {
      await mkdir(historyDir, { recursive: true });
      await chmod(historyDir, 0o500);
      try {
        await prepareRewrite({
          universeId: universe.id, chapterNumber: 1, dropLater: true, ancestryTurn: 1,
          expectedTargetSha256: null, expectedLaterChapters: [2]
        });
      } catch (error) {
        code = error.code ?? error.message;
      }
      await chmod(historyDir, 0o700).catch(() => {});
    }
    const laterText = await stat(join(dir, 'chapters', '0002-two.md')).then(() => true, () => false);
    const laterOffer = await stat(join(dir, 'chapters', '0002-offer.json')).then(() => true, () => false);
    const targetKept = await stat(join(dir, 'chapters', '0001-one.md')).then(() => true, () => false);
    if (skipped) {
      ok(`rewrite binding: an archive failure stops the deletion — not injected here (${skipped})`);
    } else if (code !== 'accepted' && laterText && laterOffer && targetKept) {
      ok(`rewrite binding: a failing archive stops the deletion (${code}); the target, the later chapter and its offer remain`);
    } else {
      fail(`rewrite binding/archive failure: code=${code}, later chapter=${laterText}, later offer=${laterOffer}, target=${targetKept}`);
    }
  }

  // The chapter prompt names the narrative context explicitly, so the agent reads its accepted chapters
  // instead of whatever lies in `chapters/`, and never mistakes a reader offer for narrative context.
  {
    const meta = { title: 'The Ledger District', law: LAW, language: 'en', elements: [] };
    const prompt = turnPrompt({
      meta,
      job: { kind: 'chapter', message: 'Continue the story: the registry collects the interest.', format: 'both' },
      chapterNumber: 3,
      chapterFiles: [],
      contextChapters: ['chapters/0001-one.md', 'chapters/0002-two.md'],
      omittedChapters: [1]
    });
    const namesBoth = prompt.includes('chapters/0001-one.md') && prompt.includes('chapters/0002-two.md');
    const offerExcluded = !/offer\.json/.test(prompt.split('MANDATORY STEPS')[1]?.split('TASK')[0] ?? '') || /do not read them/.test(prompt);
    const statesOmission = prompt.includes('chapters 1 are earlier context');
    const namesSchema = prompt.includes('`canon.md`') && prompt.includes('`threads.json`') && prompt.includes('`atlas.json`');
    if (namesBoth && offerExcluded && statesOmission && namesSchema) {
      ok('prompt: the chapter prompt names the selected accepted chapters, states the omitted earlier chapters, excludes the offers and keeps the state files');
    } else {
      fail(`prompt: selected=${namesBoth}, offerExcluded=${offerExcluded}, omission=${statesOmission}, stateFiles=${namesSchema}`);
    }
  }

  // A revision carries the findings an author chose, with their evidence and the qualities to keep: the
  // prompt states them and demands one pass, a malformed list is refused, and findings reported against
  // another version of the book are refused instead of applied to stale evidence.
  {
    const findings = [
      { id: 'continuity.timeline.1', claim: 'the registry answers too quickly', evidence: ['the registry names the debtor in one line'] },
      { id: 'metrics.mood.2', claim: 'the aftermath is skipped' }
    ];
    const preserve = ['the flat voice of the keeper'];
    const prompt = turnPrompt({
      meta: { title: 'The Ledger District', law: LAW, language: 'en', elements: [] },
      job: { kind: 'rewrite', message: 'The ending feels rushed.', previousText: 'old text', format: 'both' },
      chapterNumber: 2,
      chapterFiles: [],
      contextChapters: ['chapters/0001-one.md'],
      omittedChapters: [],
      directions: ['Keep the register closed.'],
      findings,
      preserve
    });
    const statesFindings = prompt.includes('SELECTED FINDINGS') && prompt.includes('continuity.timeline.1') && prompt.includes('metrics.mood.2')
      && prompt.includes('the registry names the debtor in one line');
    const onePass = prompt.includes('one candidate version') && prompt.includes('do not start a second pass');
    const keepsQualities = prompt.includes('KEEP WHAT THE AUTHOR VALUES') && prompt.includes('the flat voice of the keeper');
    let malformed = 'accepted';
    try {
      normaliseRevision({ findings: [{ id: 'not an id', claim: 'x' }] });
    } catch (error) {
      malformed = error.code;
    }
    let tooMany = 'accepted';
    try {
      normaliseRevision({ findings: Array.from({ length: 9 }, (_, index) => ({ id: `continuity.integrity.${index}` })) });
    } catch (error) {
      tooMany = error.code;
    }
    const clean = normaliseRevision({ findings, preserve });
    // Stale findings: reported against a version that is no longer accepted. The chapter needs a
    // recorded ancestry so the request reaches the version check rather than stopping before it.
    const universe = await bookWithTwoChapters(checkSeed, 'findings');
    tempDirs.push(universe.id);
    await writeAncestry(universe.id, 2, 1, null);
    let stale = 'accepted';
    try {
      await jobs.startRewrite({
        universeId: universe.id,
        chapterNumber: 2,
        instructions: 'Act on the selected findings.',
        sourceVersion: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        findings
      });
    } catch (error) {
      stale = error.code ?? `no-code: ${error.message}`;
    }
    if (statesFindings && onePass && keepsQualities && malformed === 'BAD_FINDINGS' && tooMany === 'BAD_FINDINGS'
      && clean.findings.length === 2 && stale === 'STALE_REQUEST') {
      ok('revision: selected findings and preserved qualities reach the prompt with their evidence, a malformed list is refused, and findings from another version are refused as stale');
    } else {
      fail(`revision: stated=${statesFindings}, onePass=${onePass}, preserve=${keepsQualities}, malformed=${malformed}, tooMany=${tooMany}, clean=${clean.findings.length}, stale=${stale}`);
    }
  }

  // A chapter that fails validation is a turn failure, never an accepted chapter.
  {
    const universe = await bookWithTwoChapters(checkSeed, 'verify');
    tempDirs.push(universe.id);
    let code = 'accepted';
    try {
      await verifyChapterTurn({ universeId: universe.id, chapterNumber: 3, chapterFiles: [], record: { warnings: [] } });
    } catch (error) {
      code = error.code;
    }
    if (code === 'NO_CHAPTER') ok('acceptance: a turn that produced no chapter file fails with NO_CHAPTER');
    else fail(`acceptance: expected NO_CHAPTER, received ${code}`);
  }
}

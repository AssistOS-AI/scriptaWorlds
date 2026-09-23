// The runtime group of `scripts/check.mjs`: the export gate and the process-level scenarios — a real
// fake agent process that can be held at a gate and signalled during a shutdown. It runs last because
// the shutdown group stops the job manager on purpose.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { jobs } from '../src/jobs.mjs';
import { verifyExportTurn } from '../src/turn.mjs';
import { journalPath, readTurnConsole } from '../src/turn-console.mjs';
import { prepareSnapshot, writeAncestry } from '../src/universe-state.mjs';
import { listChapterHistory } from '../src/universe-chapters.mjs';
import { skillsDir, universeDir } from '../src/paths.mjs';
import { bookWithChapter, bookWithTwoChapters, inventory, sha256Hex, waitForTurn } from './check-fixtures.mjs';

const FAKE_AGENT = `#!/usr/bin/env node
// A stand-in for the omp agent during the environment check. It announces itself, then behaves in one
// of two documented modes: it copies the prepared fixture into place (a turn that succeeds), or it
// writes a partial candidate and damages the canon (a turn that fails). It always stays alive until a
// release marker, a signal or the deadline, so a shutdown has a real child process to wait for.
import { appendFile, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.cwd();
const fixture = join(dir, '.fixture');
const stamp = () => new Date().toISOString();
const exists = (path) => stat(path).then(() => true, () => false);
let signal = 'none';

const finish = async () => {
  await appendFile(join(dir, 'agent-exit.marker'), stamp() + ' ' + signal, 'utf8').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  await appendFile(join(dir, 'agent-late-write.marker'), stamp() + ' ' + signal, 'utf8').catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => { signal = 'SIGTERM'; void finish(); });
process.on('SIGINT', () => { signal = 'SIGINT'; void finish(); });

await writeFile(join(dir, 'agent-started.marker'), String(process.pid), 'utf8');
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working' } }) + String.fromCharCode(10));
// The mode is declared before the turn starts, so a turn that is meant to succeed never leaves the
// partial candidate of a turn that is meant to fail.
const mode = await readFile(join(fixture, 'mode'), 'utf8').then((text) => text.trim(), () => 'partial');
if (mode !== 'complete') {
  await writeFile(join(dir, 'canon.md'), '# Canon — written by the agent', 'utf8').catch(() => {});
  await writeFile(join(dir, 'chapters', '0003-agent.md'), '# Agent partial candidate', 'utf8').catch(() => {});
}

// The gate decides when this agent acts, so a check can enqueue work behind it and prepare the fixture
// in the meantime. A release with a complete fixture produces a turn that succeeds; a release without
// one produces the empty-handed candidate that a failing turn leaves behind.
const gate = join(dir, 'agent-release.marker');
let released = false;
for (let waited = 0; waited < 200 && !released; waited += 1) {
  released = await exists(gate);
  if (!released) await new Promise((resolve) => setTimeout(resolve, 50));
}
if (released && mode === 'complete') {
  const number = await readFile(join(fixture, 'chapter-number'), 'utf8').then((text) => text.trim(), () => '0003');
  const prefix = join(dir, 'chapters', number);
  await copyFile(join(fixture, 'chapter.md'), prefix + '-quiet-aftermath.md');
  await copyFile(join(fixture, 'offer.json'), prefix + '-offer.json');
  await copyFile(join(fixture, 'plan.md'), join(dir, 'drafts', number + '-plan.md'));
  await copyFile(join(fixture, 'canon.md'), join(dir, 'canon.md'));
  await copyFile(join(fixture, 'threads.json'), join(dir, 'threads.json'));
  await copyFile(join(fixture, 'atlas.json'), join(dir, 'atlas.json'));
  signal = 'complete';
  await finish();
}
if (released) {
  signal = 'released';
  await finish();
}
await new Promise((resolve) => setTimeout(resolve, 30_000));
signal = 'timeout';
await finish();
`;

/**
 * The fixture a fake agent copies into place to produce a chapter the validator accepts: the chapter,
 * its plan, its offer and the state files a chapter turn must leave behind. It lives under `.fixture/`,
 * which is not part of the accepted inventory, so a check can prepare it before the turn starts.
 */
async function writeFixture(id, chapterNumber) {
  const dir = join(universeDir(id), '.fixture');
  await mkdir(dir, { recursive: true });
  // A chapter turn writes its plan here, so the folder must exist before the fixture is copied.
  await mkdir(join(universeDir(id), 'drafts'), { recursive: true });
  const plan = `# Plan chapter ${chapterNumber}
- dramatic_question: Can a ledger be closed without erasing the debt it records?
- anchor_character: the keeper
- character_want: to close the ledger without losing the district
- primary_idea: memory as currency
- human_need: safety
- opening_hook: the keeper counts the night debts of the district before anyone wakes.
- beats:
  - the keeper finds a debt that is not in the register
  - the registry refuses to record it
  - the keeper decides to keep the debt open
  - the district reads the ledger aloud and the stone holds
- decision: the keeper refuses to write the debt off, and answers for the interest
- local_consequence: the registry flags the keeper in the ledger and in the street
- long_horizon: the unpaid debt returns in ten years, priced higher, and the keeper is still named in it
- payoff: the promise made to the district in the first chapter is weighed and answered
- return_hook: none
- new_entities: []
- deferred_answers: []
`;
  const offer = JSON.stringify({
    teaser: 'The keeper closed the register without erasing the debt, and the district kept standing. Now the registry asks who will carry the interest, and the ledger is waiting for a name.',
    options: [
      { label: 'Name the keeper', prompt: 'Continue the story: the registry names the keeper as the debtor and shows the first collection.' },
      { label: 'Pay in work', prompt: 'Continue the story: the keeper pays the interest in work, one district night at a time.' }
    ]
  });
  const canon = `# Canon — after chapter ${chapterNumber}

## Fundamental laws
- Cities exist only as long as someone tells them; silence dissolves them into stone.

## World
- The district keeps a ledger that is read aloud every night.

## Recurring characters
- The keeper reads the ledger and answers for what it records.

## Timeline
- Chapter ${chapterNumber} — the first unpaid debt is left open.

## Stable facts
- A debt that is read aloud keeps the stone standing.

## Mysteries with a fixed cause
- Who wrote the first entry — the registry's founder — hints given so far.
`;
  const threads = JSON.stringify({
    open: [{
      id: 'thread-0001', kind: 'promise', question: 'Who will carry the interest of the open debt?',
      created_chapter: Number(chapterNumber), due_chapter: Number(chapterNumber) + 1, status: 'open'
    }],
    closed: [], promises: [], deferred_answers: []
  });
  const atlas = JSON.stringify({
    version: 1,
    axes: [{ id: 'memory-identity', nodes: [{ id: 'memory-as-currency', label: 'Memory as currency', state: 'dramatized', chapters: [Number(chapterNumber)] }] }]
  });
  await writeFile(join(dir, 'chapter-number'), chapterNumber, 'utf8');
  await writeFile(join(dir, 'mode'), 'complete', 'utf8');
  await writeFile(join(dir, 'chapter.md'), `# Quiet Aftermath\n\n${'The keeper read the ledger aloud and the district answered with the sound of stone settling. Nobody spoke of the debt that had no entry, and the night went on being ordinary. '.repeat(12)}\n`, 'utf8');
  await writeFile(join(dir, 'plan.md'), plan, 'utf8');
  await writeFile(join(dir, 'offer.json'), offer, 'utf8');
  await writeFile(join(dir, 'canon.md'), canon, 'utf8');
  await writeFile(join(dir, 'threads.json'), threads, 'utf8');
  await writeFile(join(dir, 'atlas.json'), atlas, 'utf8');
  return dir;
}

/**
 * Install the fake agent as `omp` in a temporary bin directory and put it first on `PATH`. The
 * configuration is frozen and the server resolves a bare command name through `PATH`, so this is the
 * one injection point that needs no production change. The caller must call the returned `restore`.
 */
async function installFakeAgent() {
  const dir = await mkdtemp(join(tmpdir(), 'fake-omp-'));
  const path = join(dir, 'omp');
  await writeFile(path, FAKE_AGENT, 'utf8');
  await chmod(path, 0o755);
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

export async function runRuntimeChecks({ ok, fail, checkSeed, tempDirs, run }) {
  // The two scenarios below replace the agent binary through `PATH`. An operator who pinned `OMP_BIN`
  // keeps that binary, and the check says so instead of pretending it injected one.
  const fakeAgentUsable = config.ompBin === 'omp';
  // Export acceptance is verified rather than assumed: a real renderer run is accepted with its page
  // count, a truncated document is refused, and a requested format that is missing stays `NO_EXPORT`.
  {
    const universe = await bookWithChapter(checkSeed, 'edition');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    const rendered = await run(process.execPath, [
      join(skillsDir, 'scripta-book-export', 'scripts', 'build-book.mjs'),
      '--universe', dir, '--format', 'pdf'
    ], dir);
    const renderedLine = (() => {
      try {
        return JSON.parse(rendered.stdout.trim().split('\n').pop());
      } catch {
        return null;
      }
    })();
    const startedMs = Date.now() - 60_000;
    const acceptedOutcome = async (format) => {
      const record = { exports: [], warnings: [] };
      try {
        await verifyExportTurn({ universeId: universe.id, startedMs, record, format });
        return { code: 'accepted', record };
      } catch (error) {
        return { code: error.code, record };
      }
    };
    const accepted = await acceptedOutcome('pdf');
    const acceptedDocument = accepted.record.exports[0];
    // The same book, asked for both formats while only the PDF exists.
    const missingDocx = await acceptedOutcome('both');
    // A truncated document is not a document.
    const pdfPath = join(dir, 'exports', acceptedDocument?.name ?? 'missing.pdf');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4'), 'utf8');
    const truncated = await acceptedOutcome('pdf');
    if (renderedLine?.ok === true && renderedLine.outputs?.[0]?.pages > 0
      && accepted.code === 'accepted' && acceptedDocument?.pages >= 1
      && missingDocx.code === 'NO_EXPORT' && truncated.code === 'INVALID_EXPORT') {
      ok(`export acceptance: a rendered PDF is accepted (${acceptedDocument.pages} pages, manifest checked), a missing format is NO_EXPORT and a truncated document is INVALID_EXPORT`);
    } else {
      fail(`export acceptance: rendered=${renderedLine?.ok}/${renderedLine?.outputs?.[0]?.pages}, accepted=${accepted.code} pages=${acceptedDocument?.pages}, missingDocx=${missingDocx.code}, truncated=${truncated.code}`);
    }
  }

  // The rewrite a reader queued behind another turn is revalidated when it reaches the front of its
  // queue. The holding turn accepts a new chapter while the rewrite waits, which the request did not
  // authorise, so the rewrite fails as stale instead of silently retargeting or dropping the chapter.
  {
    if (!fakeAgentUsable) {
      ok(`queued rewrite: not exercised here (OMP_BIN pins the agent binary to ${config.ompBin})`);
    } else {
      const fake = await installFakeAgent();
      const universe = await bookWithTwoChapters(checkSeed, 'gate');
      tempDirs.push(universe.id);
      const dir = universeDir(universe.id);
      await prepareSnapshot(universe.id, 1, 'chapter');
      await writeAncestry(universe.id, 1, 1, null);
      let failure = null;
      let outcome = null;
      try {
        await writeFixture(universe.id, '0003');
        // The request names the chapter the reader was looking at; an unknown chapter is refused before
      // anything is queued, and the recorded turn keeps the origin of the request.
      let bogus = 'accepted';
      try {
        await jobs.start({
          universeId: universe.id,
          message: 'Continue the story from a chapter that does not exist.',
          kind: 'chapter',
          sourceChapter: 99
        });
      } catch (error) {
        bogus = error.code;
      }
      const holder = await jobs.start({
        universeId: universe.id,
        message: 'Write the next chapter of this ledger, quietly.',
        kind: 'chapter',
        sourceChapter: 2
      });
        const started = join(dir, 'agent-started.marker');
        const deadline = Date.now() + 10_000;
        while (!(await stat(started).then(() => true, () => false)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // Queued while the holding turn is still running: the request is bound to chapter 1 with
        // chapter 2 as its later chapter, and that binding is written to the durable record.
        const rewriteJob = await jobs.startRewrite({ universeId: universe.id, chapterNumber: 1, instructions: 'Rewrite chapter one with a quieter ending.' });
        const queuedRecord = await readFile(join(dir, 'turns', `${String(rewriteJob.turnNumber).padStart(4, '0')}.json`), 'utf8').then((raw) => JSON.parse(raw), () => null);
        const boundHash = sha256Hex(await readFile(join(dir, 'chapters', '0001-one.md'), 'utf8'));
        const bound = queuedRecord?.targetSha256 === boundHash
          && queuedRecord?.ancestryTurn === 1
          && Array.isArray(queuedRecord?.authorizedLaterChapters)
          && queuedRecord.authorizedLaterChapters.join(',') === '2';
        const queuedFacts = `${queuedRecord?.status} target=${String(queuedRecord?.targetSha256).slice(0, 14)} disk=${boundHash.slice(0, 14)} ancestry=${queuedRecord?.ancestryTurn} later=${JSON.stringify(queuedRecord?.authorizedLaterChapters)}`;
        // The holding turn accepts a new chapter 3, which the queued request never authorised.
        await writeFile(join(dir, 'agent-release.marker'), 'go', 'utf8');
        const holderRecord = await waitForTurn(universe.id, holder.turnNumber, (record) => record.status !== 'queued' && record.status !== 'running');
        const rewriteRecord = await waitForTurn(universe.id, rewriteJob.turnNumber, (record) => record.status !== 'queued' && record.status !== 'running');
        const after = await inventory(universe.id);
        const chapterOneKept = after.get('chapters/0001-one.md') === boundHash;
        const chapterThreeAccepted = after.has('chapters/0003-quiet-aftermath.md');
        const rewriteHistory = await listChapterHistory(universe.id, 1);
        const stale = rewriteRecord?.status === 'error' && String(rewriteRecord.error).includes('appeared after this rewrite was requested');
        outcome = { bound, queued: queuedFacts, holder: holderRecord?.status, holderError: holderRecord?.error, rewrite: rewriteRecord?.status, rewriteError: rewriteRecord?.error, chapterOneKept, chapterThreeAccepted, rewriteHistory: rewriteHistory.length };
        const context = holderRecord?.context ?? null;
        const sourceChapter = holderRecord?.sourceChapter ?? null;
        const contextSelected = context?.version?.startsWith('sha256:') === true
          && Array.isArray(context.chapters) && context.chapters.length > 0
          && context.chapters.every((file) => file.endsWith('.md') && !file.includes('offer'))
          && Array.isArray(context.omittedChapters);
        if (bound && holderRecord?.status === 'done' && stale && chapterOneKept && chapterThreeAccepted && rewriteHistory.length === 0
          && contextSelected && bogus === 'BAD_NUMBER' && sourceChapter === 2) {
          ok('queued rewrite: a chapter accepted while the request waited fails it as stale, the rewrite touches nothing, and the turn records the version and the chapters it was written from');
        } else {
          const exitMarker = `${outcome.queued} exit=${await readFile(join(dir, 'agent-exit.marker'), 'utf8').catch(() => 'none')}`;
          fail(`queued rewrite: bound=${bound}, exit=${exitMarker}, context=${JSON.stringify(context)}, bogus=${bogus}, sourceChapter=${sourceChapter}, holder=${outcome.holder}/${String(outcome.holderError).slice(0, 160)}, rewrite=${outcome.rewrite}/${String(outcome.rewriteError).slice(0, 120)}, chapterOneKept=${chapterOneKept}, chapterThreeAccepted=${chapterThreeAccepted}, archived=${rewriteHistory.length}`);
        }
      } catch (error) {
        failure = error;
      } finally {
        await rm(join(dir, 'agent-release.marker'), { force: true });
        if (failure) fail(`queued rewrite: ${failure.message}`);
        await fake.restore();
      }
    }
  }

  // The console of a run is durable: every event is journaled while the turn runs, the console route
  // answers it live, the settled run keeps it, and a turn that ran before journals existed still
  // answers with its composed log. This is what the sessions dialog reads.
  {
    if (!fakeAgentUsable) {
      ok(`run console: not exercised here (OMP_BIN pins the agent binary to ${config.ompBin})`);
    } else {
      const fake = await installFakeAgent();
      const universe = await bookWithTwoChapters(checkSeed, 'console');
      tempDirs.push(universe.id);
      const dir = universeDir(universe.id);
      let failure = null;
      try {
        // The fixture is in place before the turn starts: the stand-in reads its mode at startup, so a
        // turn meant to succeed must find a complete candidate waiting at the gate.
        await writeFixture(universe.id, '0003');
        const job = await jobs.start({
          universeId: universe.id,
          message: 'Write the next chapter of this ledger, quietly.',
          kind: 'chapter'
        });
        const started = join(dir, 'agent-started.marker');
        const deadline = Date.now() + 10_000;
        while (!(await stat(started).then(() => true, () => false)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // The fake agent announces itself and then waits at the gate, so the turn is running here.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const during = await readTurnConsole(universe.id, job.turnNumber);
        const journalOnDisk = await stat(journalPath(universe.id, job.turnNumber)).then(() => true, () => false);
        const liveText = String(during?.console?.text ?? '');
        const duringOk = during?.console?.live === true
          && journalOnDisk
          && liveText.includes('queued — request: Write the next chapter')
          && liveText.includes('running — chapter 3')
          && liveText.includes('working');
        // Released, the turn succeeds and the console keeps its story.
        await writeFile(join(dir, 'agent-release.marker'), 'go', 'utf8');
        const record = await waitForTurn(universe.id, job.turnNumber, (entry) => entry.status !== 'queued' && entry.status !== 'running');
        const after = await readTurnConsole(universe.id, job.turnNumber);
        const afterText = String(after?.console?.text ?? '');
        const afterOk = record?.status === 'done'
          && after?.console?.live === false
          && after?.console?.source === 'journal'
          && afterText.includes('✓ done')
          && afterText.includes('working');
        // A turn that ran before journals existed: its composed log is the only record, and it is
        // served as the console instead of an empty string.
        await mkdir(join(dir, 'turns'), { recursive: true });
        await writeFile(join(dir, 'turns', '0009.json'), JSON.stringify({
          number: 9,
          kind: 'chapter',
          status: 'error',
          createdAt: '2026-01-01T00:00:00.000Z',
          request: 'an older run',
          agentLog: 'the composed log of an older run',
          error: 'it failed'
        }), 'utf8');
        const fallback = await readTurnConsole(universe.id, 9);
        const fallbackOk = fallback?.console?.source === 'agentLog'
          && fallback.console.text === 'the composed log of an older run'
          && fallback.console.live === false;
        const missing = await readTurnConsole(universe.id, 42);
        if (duringOk && afterOk && fallbackOk && missing === null) {
          ok('run console: the journal is written while the turn runs, the console answers live and after the run, an older turn falls back to its composed log and an unknown turn is absent');
        } else {
          fail(`run console: during=${duringOk} (live=${during?.console?.live}, journal=${journalOnDisk}, queued=${liveText.includes('queued — request')}, running=${liveText.includes('running — chapter 3')}, delta=${liveText.includes('working')}), after=${afterOk} (status=${record?.status}, error=${String(record?.error ?? '').slice(0, 120)}, live=${after?.console?.live}, source=${after?.console?.source}, done=${afterText.includes('✓ done')}), fallback=${fallbackOk} (${fallback?.console?.source}, ${JSON.stringify(String(fallback?.console?.text ?? '').slice(0, 40))}), missing=${JSON.stringify(missing)}`);
        }
      } catch (error) {
        failure = error;
      } finally {
        await rm(join(dir, 'agent-release.marker'), { force: true });
        await fake.restore();
        if (failure) fail(`run console: ${failure.message}`);
      }
    }
  }

  // Shutdown, last: intake stops, the running child is signalled, and ownership of the store is only
  // given up after that child is gone — including the write it performs after receiving the signal.
  {
    if (!fakeAgentUsable) {
      ok(`shutdown: not exercised here (OMP_BIN pins the agent binary to ${config.ompBin})`);
    } else {
    const fake = await installFakeAgent();
    const universe = await bookWithTwoChapters(checkSeed, 'shutdown');
    tempDirs.push(universe.id);
    const dir = universeDir(universe.id);
    let failure = null;
    let outcome = null;
    try {
      const job = await jobs.start({ universeId: universe.id, message: 'Write the next chapter of this ledger, slowly.', kind: 'chapter' });
      const started = join(dir, 'agent-started.marker');
      const deadline = Date.now() + 10_000;
      while (!(await stat(started).then(() => true, () => false)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const agentStarted = await stat(started).then(() => true, () => false);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const stopped = await jobs.stop({ timeoutMs: 10_000 });
      const exited = await readFile(join(dir, 'agent-exit.marker'), 'utf8').catch(() => null);
      const lateWrite = await readFile(join(dir, 'agent-late-write.marker'), 'utf8').catch(() => null);
      const second = await jobs.stop({ timeoutMs: 1_000 });
      const record = await readFile(join(dir, 'turns', `${String(job.turnNumber).padStart(4, '0')}.json`), 'utf8').then((raw) => JSON.parse(raw), () => null);
      const canon = await readFile(join(dir, 'canon.md'), 'utf8');
      const partial = await stat(join(dir, 'chapters', '0003-agent.md')).then(() => true, () => false);
      let refused = '';
      try {
        await jobs.start({ universeId: universe.id, message: 'One more chapter after the shutdown started.', kind: 'chapter' });
      } catch (error) {
        refused = error.code;
      }
      outcome = { agentStarted, stopped, exited, lateWrite, second, record, canon, partial, refused };
    } catch (error) {
      failure = error;
    } finally {
      await fake.restore();
    }
    if (failure) {
      fail(`shutdown: ${failure.message}`);
    } else if (outcome.agentStarted && outcome.stopped.stopped === 1 && outcome.exited && outcome.lateWrite
      && outcome.second.stopped === 0 && outcome.record?.status === 'interrupted'
      && outcome.canon.includes('pre-chapter') && outcome.partial === false && outcome.refused === 'SHUTTING_DOWN') {
      ok('shutdown: the child is signalled and waited for, its late write happens before the lock is free, the turn is `interrupted` and the book is restored');
    } else {
      fail(`shutdown: started=${outcome.agentStarted}, stopped=${JSON.stringify(outcome.stopped)}, exited=${Boolean(outcome.exited)}, lateWrite=${Boolean(outcome.lateWrite)}, second=${JSON.stringify(outcome.second)}, record=${outcome.record?.status}, canonRestored=${outcome.canon.includes('pre-chapter')}, partialGone=${outcome.partial === false}, refused=${outcome.refused || 'not refused'}`);
    }
    }
  }
}

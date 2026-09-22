#!/usr/bin/env node
// Verifies the scriptaWorlds environment and technical pipeline without spending agent time:
// the omp prerequisite, the universe store, skill symlinks, the chapter validator and the book renderer.
// Usage: npm run check

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, probeOmp } from '../src/config.mjs';
import { listProjectSkills, publicDir, rootDir, skillsDir, universeDir, universesDir } from '../src/paths.mjs';
import { listUniverses, readUniverseDetail, setUniverseStatus } from '../src/universe.mjs';
import { runStoreChecks } from './check-store.mjs';
import { runTurnChecks } from './check-turns.mjs';
import { runRuntimeChecks } from './check-runtime.mjs';
import { runPhaseChecks } from './check-phases.mjs';
import { runAssessmentChecks } from './check-assessments.mjs';
import { runImportTurnChecks } from './check-import-turns.mjs';
import { runFeedbackChecks } from './check-feedback.mjs';
import { runFeedbackExportChecks } from './check-feedback-export.mjs';
import { runFeedbackFinalChecks } from './check-feedback-final.mjs';
import { runImportChecks } from './check-imports.mjs';
import { runDataChecks } from './check-data.mjs';

// The assessment workspace is shared by every process that runs this suite, and two suites at once would
// interleave their runs in it: the second one re-executes itself with a workspace of its own, so a
// developer and a background run can check the same tree without racing.
if (!process.env.ASSESSMENT_WORKSPACE) {
  const workspace = mkdtempSync(join(tmpdir(), 'scripta-check-'));
  const again = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ASSESSMENT_WORKSPACE: workspace }
  });
  process.exit(again.status ?? 1);
}

const failures = [];
let step = 0;

function ok(message) {
  step += 1;
  console.log(`  ✓ ${message}`);
}

function fail(message) {
  step += 1;
  failures.push(message);
  console.log(`  ✗ ${message}`);
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error.message) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

console.log('scriptaWorlds — environment check');

const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major >= 20) ok(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node} is too old (>= 20 required)`);

const probe = await probeOmp();
if (probe.ok) ok(`the "${config.ompBin}" agent answers: ${probe.stdout.trim().split('\n').pop()}`);
else fail(`the "${config.ompBin}" agent cannot start: ${(probe.stderr || probe.stdout).trim().split('\n')[0]} (install Oh My Pi or set OMP_BIN)`);

for (const skill of ['scripta-ala', 'scripta-book-export', 'scripta-story-design', 'scripta-prose-craft', 'scripta-continuity-review', 'scripta-metrics-report']) {
  const exists = await stat(join(skillsDir, skill, 'SKILL.md')).then(() => true, () => false);
  if (exists) ok(`skill present: skills/${skill}/SKILL.md`);
  else fail(`missing skills/${skill}/SKILL.md`);
}

// Interface files: syntax must parse and sizes must stay sane. A runaway edit once turned app.js
// into 80 MB of repeated fragments; this guard catches that class of damage before a browser does.
for (const name of ['app.js', 'markdown.js']) {
  const file = join(publicDir, name);
  const info = await stat(file).catch(() => null);
  if (!info) {
    fail(`missing public/${name}`);
    continue;
  }
  const check = await run(process.execPath, ['--check', file], rootDir);
  const limit = 400 * 1024;
  if (check.code !== 0) fail(`public/${name} does not parse: ${check.stderr.trim().split('\n')[0]}`);
  else if (info.size > limit) fail(`public/${name} is ${Math.round(info.size / 1024)} KB (limit ${limit / 1024} KB) — likely a runaway edit`);
  else ok(`public/${name}: ${Math.round(info.size / 1024)} KB, parses`);
}

const checkSeed = `check-${Date.now().toString(36)}`;
const projectSkills = await listProjectSkills();
const requiredSkills = ['scripta-ala', 'scripta-book-export'];
const missingSkills = requiredSkills.filter((name) => !projectSkills.includes(name));
if (missingSkills.length === 0) ok(`project skills discovered: ${projectSkills.length} (${projectSkills.join(', ')})`);
else fail(`missing project skills: ${missingSkills.join(', ')}`);
let checkId = null;
let checkDir = null;
const tempDirs = [];
try {
  const { createUniverse, readChapter, readIdeas, readUniverseMeta, setUniverseLanguage } = await import('../src/universe.mjs');
  const { recoverUniverse } = await import('../src/universe-state.mjs');
  await mkdir(universesDir, { recursive: true });
  const created = await createUniverse({ title: `Verification ${checkSeed}`, law: 'Nothing moves without paying with a memory; matter is born out of forgetting.', premise: 'Temporary universe for the technical pipeline check.' });
  checkId = created.id;
  checkDir = universeDir(checkId);
  tempDirs.push(checkId);
  ok(`temporary universe created: ${checkId}`);

  if (created.language === 'ro') ok('default language: ro');
  else fail(`the default language should be ro, it is ${created.language}`);

  const english = await createUniverse({ title: `Language verification ${checkSeed}`, law: 'Every act of attention dims a star somewhere; the sky remembers who looked.', language: 'en' });
  tempDirs.push(english.id);
  const switched = await setUniverseLanguage(english.id, 'fr');
  if (english.language === 'en' && switched.language === 'fr') {
    ok('book language: created with `en`, switched to `fr`');
  } else {
    fail(`language is not applied correctly (create: ${english.language}, switch: ${switched.language})`);
  }
  let rejected = false;
  try {
    await setUniverseLanguage(english.id, 'klingon');
  } catch (error) {
    rejected = error?.code === 'BAD_LANGUAGE';
  }
  if (rejected) ok('unsupported language rejected with BAD_LANGUAGE');
  else fail('an unsupported language should be rejected');

  let lawRejected = false;
  try {
    await createUniverse({ title: `No law ${checkSeed}` });
  } catch (error) {
    lawRejected = error?.code === 'BAD_LAW';
  }
  if (lawRejected) ok('universe without a fundamental law rejected with BAD_LAW');
  else fail('a universe without a fundamental law should be rejected');

  // Changing the language of a book that has chapters is refused, and before that it rewrites the
  // guidance the server generated instead of leaving permanent instructions in the old language.
  {
    const { readText } = await import('../src/io.mjs');
    const englishDir = universeDir(english.id);
    const charter = await readText(join(englishDir, 'charter.md'), '');
    const guidance = await readText(join(englishDir, 'AGENTS.md'), '');
    const guidanceUpdated = guidance.includes('Français') && charter.includes('Français');
    await writeFile(join(englishDir, 'chapters', '0001-locked.md'), '# Locked\n\nA chapter written in the current language.\n', 'utf8');
    let locked = '';
    try {
      await setUniverseLanguage(english.id, 'ro');
    } catch (error) {
      locked = error?.code;
    }
    // The charter keeps a human edit: a replaced language line is not rewritten again.
    const edited = await readText(join(englishDir, 'charter.md'), '');
    await rm(join(englishDir, 'chapters', '0001-locked.md'), { force: true });
    if (guidanceUpdated && locked === 'LANGUAGE_LOCKED' && edited.includes('Français')) {
      ok('book language: the change rewrites the generated guidance and is refused once the book has chapters');
    } else {
      fail(`book language: guidanceUpdated=${guidanceUpdated}, locked=${locked}, charter=${edited.slice(0, 80)}`);
    }
  }

  {
    const installed = (await readdir(join(checkDir, '.agents', 'skills'))).sort();
    const missing = projectSkills.filter((name) => !installed.includes(name));
    if (projectSkills.length >= 2 && missing.length === 0 && installed.length === projectSkills.length) {
      ok(`skill symlinks installed inside the universe for every project skill (${projectSkills.length})`);
    } else {
      fail(`skill symlinks: discovered ${projectSkills.join(', ')} but found ${installed.join(', ')}`);
    }
  }

  await writeFile(join(checkDir, 'chapters', '0001-check.md'), `# Verification\n\n${'A sample paragraph with diacritics: ș ț ă â î, quotes “…” and a dash — test.\n\n'.repeat(40)}`, 'utf8');
  await writeFile(join(checkDir, 'canon.md'), '# Canon — verification\n\n## Fundamental laws\n- Nothing moves without paying with a memory.\n\n## World\n- Test.\n\n## Recurring characters\n\n## Timeline\n\n## Stable facts\n\n## Mysteries with a fixed cause\n', 'utf8');
  // A complete, valid chapter fixture: the plan, the reader offer and a touched atlas node, so the
  // validator can prove `ok: true` rather than merely that the script runs.
  await mkdir(join(checkDir, 'drafts'), { recursive: true });
  await writeFile(join(checkDir, 'drafts', '0001-plan.md'), `# Plan chapter 0001
- dramatic_question: Can a memory be bought without paying?
- anchor_character: the keeper
- character_want: to forget a debt
- primary_idea: memory as currency
- human_need: safety
- opening_hook: the keeper counts the night's debts.
- beats:
  - the keeper finds a memory that is not theirs
  - the registry refuses it
  - the keeper decides to keep it
  - the debt grows
- decision: the keeper refuses to sell the memory back to the registry
- local_consequence: the registry flags the keeper in the ledger
- long_horizon: the memory returns in ten years, priced higher
- payoff: the debt the keeper carried is finally weighed
- return_hook: none
- new_entities: []
- deferred_answers: []
`, 'utf8');
  await writeFile(join(checkDir, 'chapters', '0001-offer.json'), JSON.stringify({
    teaser: 'The keeper kept a memory that was not theirs. Now the registry wants it back, and the ledger knows the price.',
    options: [
      { label: 'Return it', prompt: 'Continue the story: the keeper returns the memory.' },
      { label: 'Hide it', prompt: 'Continue the story: the keeper hides the memory.' }
    ]
  }), 'utf8');
  await writeFile(join(checkDir, 'threads.json'), JSON.stringify({ open: [], closed: [], promises: [], deferred_answers: [] }), 'utf8');
  await writeFile(join(checkDir, 'atlas.json'), JSON.stringify({ version: 1, axes: [{ id: 'memory', nodes: [{ id: 'memory-as-currency', state: 'dramatized', chapters: [1] }] }] }), 'utf8');
  const detail = await readUniverseDetail(checkId);
  if (detail.chapters.length === 1 && detail.chapters[0].words > 50) {
    ok(`store: chapter detected (${detail.chapters[0].words} words, title "${detail.chapters[0].title}")`);
  } else {
    fail('store: the fixture chapter was not detected correctly');
  }

  const closed = await setUniverseStatus(checkId, 'closed');
  const reopened = await setUniverseStatus(checkId, 'open');
  if (closed.status === 'closed' && reopened.status === 'open') ok('store: close and reopen a universe');
  else fail('store: close/reopen did not work');

  const validation = await run(process.execPath, [
    join(skillsDir, 'scripta-ala', 'scripts', 'validate-chapter.mjs'),
    '--universe', checkDir, '--chapter', '0001'
  ], checkDir);
  const validationReport = (() => {
    try {
      return JSON.parse(validation.stdout.trim().split('\n').pop());
    } catch {
      return null;
    }
  })();
  if (validationReport && validationReport.ok === true && validationReport.errors.length === 0 && validationReport.chapter.file === 'chapters/0001-check.md') {
    ok(`scripta-ala validator passes a complete fixture (words ${validationReport.chapter.words}, warnings ${validationReport.warnings.length})`);
  } else {
    fail(`the scripta-ala validator did not return ok:true on the valid fixture: ${JSON.stringify(validationReport?.errors)} ${validation.stderr.trim().split('\n')[0] ?? ''}`);
  }

  // Malformed state answers a structured report instead of a stack trace, so acceptance can always
  // read a reason rather than guess from an empty process.
  {
    await writeFile(join(checkDir, 'threads.json'), JSON.stringify({ open: {}, closed: [], promises: [], deferred_answers: [] }), 'utf8');
    const malformed = await run(process.execPath, [
      join(skillsDir, 'scripta-ala', 'scripts', 'validate-chapter.mjs'),
      '--universe', checkDir, '--chapter', '0001'
    ], checkDir);
    const report = (() => {
      try {
        return JSON.parse(malformed.stdout.trim().split('\n').pop());
      } catch {
        return null;
      }
    })();
    await writeFile(join(checkDir, 'threads.json'), JSON.stringify({ open: [], closed: [], promises: [], deferred_answers: [] }), 'utf8');
    const structured = report !== null && report.ok === false
      && report.errors.some((entry) => entry.includes('open must be a list'));
    if (structured && malformed.code === 1 && !malformed.stderr.includes('TypeError')) {
      ok('scripta-ala validator: malformed state answers a structured JSON report and exits 1, without a stack trace');
    } else {
      fail(`validator malformed input: report=${JSON.stringify(report?.errors)}, code=${malformed.code}, stack=${malformed.stderr.includes('TypeError')}`);
    }
  }

  const render = await run(process.execPath, [
    join(skillsDir, 'scripta-book-export', 'scripts', 'build-book.mjs'),
    '--universe', checkDir, '--format', 'pdf'
  ], rootDir);
  const renderReport = (() => {
    try {
      return JSON.parse(render.stdout.trim().split('\n').pop());
    } catch {
      return null;
    }
  })();
  if (renderReport?.ok && renderReport.outputs?.[0]?.pages > 0) {
    const pdf = renderReport.outputs[0];
    ok(`book renderer: ${pdf.pages} pages, ${Math.round(pdf.bytes / 1024)} KB, fonts and table of contents generated`);
  } else {
    fail(`the book renderer failed: ${renderReport?.error ?? render.stderr.trim().split('\n')[0] ?? render.stdout.slice(0, 160)}`);
  }

  const universes = await listUniverses();
  if (universes.some((entry) => entry.id === checkId)) ok(`universe list: ${universes.length} entries`);
  else fail('the check universe does not appear in the list');

  // Rewrite: version archiving and dropping later chapters.
  // Importing the server module must have no side effects: the check suite imports it for one
  // helper, and a module-level `main()` used to start a second server that marked the turns of the
  // running one as interrupted.
  {
    const probe = await run(process.execPath, ['-e', "import('./src/server.mjs').then(() => console.log('imported'))"], rootDir);
    const output = `${probe.stdout}${probe.stderr}`;
    if (probe.code === 0 && output.includes('imported') && !output.includes('is running on') && !output.includes('[start]')) {
      ok('server module: importing it starts no server and takes no lock');
    } else {
      fail(`server module import had side effects: exit=${probe.code}, output=${JSON.stringify(output.slice(0, 120))}`);
    }
  }

  // The library of start templates: an index that matches the folders, and a temple that turns a
  // night of the book into a universe with a law, a situation and the cells it is built from.
  {
    const { readLibraryIndex, readTemplate, creationFromTemplate, auditLibrary } = await import('../src/library.mjs');
    const index = await readLibraryIndex();
    const audit = await auditLibrary();
    const empty = await readTemplate('empty');
    const night = await readTemplate('night-08-forward-a-millennium-in-a-minute');
    const creation = creationFromTemplate(night, { language: 'ro', prompt: 'edited by the reader' });
    // The empty template has no prohibition and no cells: the request the reader sends becomes the law.
    const emptyCreation = creationFromTemplate(await readTemplate('empty'), { language: 'ro', prompt: empty.request });
    const indexed = index.templates.every((entry) => entry.slug && entry.title && entry.summary);
    // The request positions the world (sector, authors kept after) rather than announcing a course:
    // these are worlds a reader continues, not lessons.
    const nightOk = night.cells.length === 2 && night.cells.every((cell) => /^[A-Z]{2}$/.test(cell.symbol))
      && night.sector === 'FORWARD-CHEELA' && night.story.length > 40
      && night.request.startsWith(`A world in the ${night.sector} sector, kept after`)
      && !/night \d|of the course|Open the story of/.test(night.request)
      && !/Keep the world readable/.test(night.request)
      && Array.isArray(night.indications) && night.indications.length >= 6
      && night.indications.every((entry) => entry.label && entry.text)
      && night.sourceText.length > 500;
    const creationOk = creation.title === '' && creation.provisionalTitle === night.title
      && creation.elements.length === 2 && creation.law.includes('Prohibition that holds in this world')
      && creation.premise.includes(night.situation.slice(0, 40));
    let unknown = '';
    try {
      await readTemplate('no-such-template');
    } catch (error) {
      unknown = error.code;
    }
    if (index.count >= 75 && index.templates[0].slug === 'empty' && indexed
      && audit.missing.length === 0 && audit.orphan.length === 0
      && empty.request.length > 80 && nightOk && creationOk && emptyCreation.law === empty.request.trim()
      && unknown === 'UNKNOWN_TEMPLATE') {
      ok(`library: ${index.count} templates (empty first, night templates with cells and a central problem), creation composed from a template`);
    } else {
      fail(`library: count=${index.count}, first=${index.templates[0]?.slug}, missing=${audit.missing.length}, orphan=${audit.orphan.length}, nightOk=${nightOk}, creationOk=${creationOk}, unknown=${unknown}`);
    }
  }

  // One server owns the store: a lock held by a live process blocks a second instance, while a
  // lock left behind by a crashed one is taken over. The check runs in its own directory so it
  // never touches the lock of a server that is actually running.
  {
    const { acquireStoreLock } = await import('../src/lock.mjs');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const lockDir = await mkdtemp(join(tmpdir(), 'scriptaworlds-lock-'));
    const lockFile = join(lockDir, '.server.lock');
    const send = (pid) => writeFile(lockFile, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
    await send(process.ppid);
    let refusal = '';
    try {
      const stolen = await acquireStoreLock(lockDir);
      await stolen.release();
    } catch (error) {
      refusal = error.message;
    }
    await send(999999);
    let tookOver = false;
    try {
      const lock = await acquireStoreLock(lockDir);
      tookOver = true;
      await lock.release();
    } catch {
      tookOver = false;
    }
    const leftover = await stat(lockFile).then(() => true, () => false);
    await rm(lockDir, { recursive: true, force: true });
    if (refusal.includes('already running') && tookOver && !leftover) {
      ok('store lock: a live owner blocks a second server, a stale lock is taken over');
    } else {
      fail(`store lock: refusal=${JSON.stringify(refusal.slice(0, 60))}, tookOver=${tookOver}, leftover=${leftover}`);
    }
  }

  // The data contract of the design instrument lives in its own module.
  await runDataChecks({ ok, fail });

  // A creation request that names a library template AND its own ingredients keeps both: the route
  // must pass the reader's elements into the template composition.
  {
    const { universeInputFromRequest } = await import('../src/server.mjs');
    const { readTemplate, creationFromTemplate } = await import('../src/library.mjs');
    const template = await readTemplate('night-08-forward-a-millennium-in-a-minute');
    const fromTemplate = universeInputFromRequest({ body: { library: template.slug, language: 'ro', prompt: 'x'.repeat(40) }, libraryTemplate: template });
    const merged = universeInputFromRequest({
      body: { library: template.slug, language: 'ro', prompt: 'x'.repeat(40), elements: ['CA', { custom: true, name: 'The Salt Debt', family: 'SOCIETY' }] },
      libraryTemplate: template
    });
    const plain = universeInputFromRequest({ body: { title: 'T', premise: 'p'.repeat(40), language: 'ro' } });
    // Free text with no template and no ingredients becomes the law, the empty-template case.
    const freeText = universeInputFromRequest({ body: { prompt: 'A world where the tide keeps every promise it ever made to the shore.', language: 'en', start: true } });
    const expected = creationFromTemplate(template, { language: 'ro', prompt: 'x'.repeat(40) });
    const symbols = merged.elements.map((element) => (typeof element === 'string' ? element : (element.symbol ?? element.name)));
    const custom = merged.elements.find((element) => typeof element === 'object' && element?.custom === true);
    if (fromTemplate.elements.join(',') === expected.elements.join(',')
      && symbols.join(',') === 'LE,TQ,CA,The Salt Debt' && custom?.name === 'The Salt Debt'
      && plain.premise.length === 40
      && freeText.law === 'A world where the tide keeps every promise it ever made to the shore.' && freeText.elements.length === 0) {
      ok('creation input: a template keeps its own cells, the reader may add ingredients, and free text becomes the law');
    } else {
      fail(`creation input: template=${fromTemplate.elements.join(',')}, merged=${symbols.join(',')}, custom=${custom?.name ?? 'none'}, plain=${plain.premise.length}, freeText=${freeText.law.slice(0, 30)}`);
    }
  }

  // The creation route maps the request body: the reader's premise is the starting situation,
  // `opening` is the older name, and a template only fills what the client left empty.
  const { universeInputFromBody } = await import('../src/server.mjs');
  const template = { title: 'Template title', law: 'Template law', openings: ['Template opening'] };
  const typedOnly = universeInputFromBody({ title: 'X', premise: 'A dark wood', language: 'en' });
  const legacy = universeInputFromBody({ title: 'X', opening: 'Old name', language: 'en' });
  const fromTemplate = universeInputFromBody({ title: 'X', language: 'en' }, template);
  const mixed = universeInputFromBody({ title: 'X', premise: 'Mine', language: 'en' }, template);
  if (typedOnly.premise === 'A dark wood' && legacy.premise === 'Old name'
    && fromTemplate.premise === 'Template opening' && fromTemplate.law === 'Template law' && fromTemplate.summary === 'Template title'
    && mixed.premise === 'Mine' && mixed.law === 'Template law') {
    ok('create body: premise wins, opening stays accepted, template fills only the gaps');
  } else {
    fail(`create body mapping: ${JSON.stringify({ typedOnly, legacy, fromTemplate, mixed })}`);
  }
  // The store, queue, rewrite and export integrity group lives in its own module so that this
  // script stays a readable sequence of checks.
  await runStoreChecks({ ok, fail, checkSeed, tempDirs });

  const { listTemplates } = await import('../src/templates.mjs');
  const templates = await listTemplates('ro');
  const templatesHealthy = templates.length === 0
    || templates.every((template) => template.title && template.law && template.id);
  if (templatesHealthy && (await listTemplates('en')).length === templates.length) {
    ok(`template catalogue: ${templates.length} possible universes, localised ro/en`);
  } else {
    fail('the template catalogue does not load correctly (missing title/law or inconsistent localisation)');
  }


  const { applyAgentTitle } = await import('../src/universe.mjs');
  const provisional = await createUniverse({
    law: 'Every name spoken aloud becomes a small debt the speaker carries until the debt is paid in work.',
    provisionalTitle: 'A universe where spoken names become debts',
    language: 'en'
  });
  tempDirs.push(provisional.id);
  // A long descriptive line is not accepted as a name (the reader sees a short title in the header).
  await writeFile(join(universeDir(provisional.id), 'universe-title.txt'), 'A universe where every spoken name becomes a debt that is paid in work by the speaker\n', 'utf8');
  const rejectedName = await applyAgentTitle(provisional.id);
  await writeFile(join(universeDir(provisional.id), 'universe-title.txt'), 'The Debt of Names\n', 'utf8');
  const assigned = await applyAgentTitle(provisional.id);
  const afterNaming = await readUniverseMeta(provisional.id);
  const titleFileGone = !(await stat(join(universeDir(provisional.id), 'universe-title.txt')).then(() => true, () => false));
  if (rejectedName === null && assigned === 'The Debt of Names' && afterNaming.autoTitle === false && titleFileGone) {
    ok('naming: a short name from universe-title.txt is adopted, a long line is refused, the hand-off file is removed');
  } else {
    fail(`naming: rejected=${JSON.stringify(rejectedName)}, assigned=${JSON.stringify(assigned)}, autoTitle=${afterNaming.autoTitle}`);
  }
  await runTurnChecks({ ok, fail, checkSeed, tempDirs });
  // The separate design and review phases, over a frozen packet, with no model budget.
  await runPhaseChecks({ ok, fail, run });
  // The requested and arc-end orchestration around those phases.
  await runAssessmentChecks({ ok, fail, checkSeed, tempDirs });
  await runImportChecks({ ok, fail });
  await runImportTurnChecks({ ok, fail, checkSeed, tempDirs });
  await runFeedbackChecks({ ok, fail, checkSeed, tempDirs });
  await runFeedbackExportChecks({ ok, fail, checkSeed, tempDirs });
  await runFeedbackFinalChecks({ ok, fail, checkSeed, tempDirs });
  // The runtime group stops the job manager on purpose, so it runs after every check that queues a turn.
  await runRuntimeChecks({ ok, fail, checkSeed, tempDirs, run });
} catch (error) {
  fail(`the technical pipeline check failed: ${error?.message ?? error}`);
} finally {
  for (const id of tempDirs) await rm(universeDir(id), { recursive: true, force: true });
}

if (failures.length === 0) {
  console.log(`\nAll checks passed (${step}). Start the server with: npm run server`);
  process.exit(0);
}
console.log(`\n${failures.length} checks failed:`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(1);

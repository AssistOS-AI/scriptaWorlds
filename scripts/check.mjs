#!/usr/bin/env node
// Verifies the scriptaWorlds environment and technical pipeline without spending agent time:
// the omp prerequisite, the universe store, skill symlinks, the chapter validator and the book renderer.
// Usage: npm run check

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, probeOmp } from '../src/config.mjs';
import { publicDir, rootDir, skillsDir, universeDir, universesDir } from '../src/paths.mjs';
import { listUniverses, readUniverseDetail, setUniverseStatus } from '../src/universe.mjs';

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

for (const skill of ['scripta-ala', 'scripta-book-export']) {
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

  const skillsLink = await stat(join(checkDir, '.agents', 'skills', 'scripta-ala')).then(() => true, () => false);
  if (skillsLink) ok('skill symlinks installed inside the universe (.agents/skills/*)');
  else fail('the universe has no symlinks in .agents/skills/');

  await writeFile(join(checkDir, 'chapters', '0001-check.md'), `# Verification\n\n${'A sample paragraph with diacritics: ș ț ă â î, quotes “…” and a dash — test.\n\n'.repeat(40)}`, 'utf8');
  await writeFile(join(checkDir, 'canon.md'), '# Canon — verification\n\n## Fundamental laws\n- Nothing moves without paying with a memory.\n\n## World\n- Test.\n\n## Recurring characters\n\n## Timeline\n\n## Stable facts\n\n## Mysteries with a fixed cause\n', 'utf8');
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
  if (validationReport && validationReport.chapter.file === 'chapters/0001-check.md') {
    ok(`scripta-ala validator runs (errors: ${validationReport.errors.length}, warnings: ${validationReport.warnings.length})`);
  } else {
    fail(`the scripta-ala validator did not produce the expected report: ${validation.stderr.trim().split('\n')[0] ?? validation.stdout.slice(0, 120)}`);
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

  // Durability: queue persisted on disk + rollback after a restart.
  const durable = await createUniverse({ title: `Queue verification ${checkSeed}`, law: 'Cities exist only as long as someone tells them; silence dissolves them into stone.', language: 'ro' });
  tempDirs.push(durable.id);
  const durableDir = universeDir(durable.id);
  await writeFile(join(durableDir, 'turns', '0001.json'), JSON.stringify({ number: 1, kind: 'chapter', status: 'queued', request: 'queued request', createdAt: new Date().toISOString() }), 'utf8');
  await writeFile(join(durableDir, 'turns', '0002.json'), JSON.stringify({ number: 2, kind: 'chapter', status: 'running', request: 'interrupted request', chapterNumber: 1, createdAt: new Date().toISOString() }), 'utf8');
  await writeFile(join(durableDir, 'chapters', '0001-half.md'), '# Half\n\npartial text\n', 'utf8');
  await writeFile(join(durableDir, 'canon.md'), '# Canon — durable\n\n## Fundamental laws\n- Nothing moves without paying with a memory.\n\n## World\n- New state written by the agent before the crash.\n\n## Recurring characters\n\n## Timeline\n\n## Stable facts\n\n## Mysteries with a fixed cause\n', 'utf8');
  await mkdir(join(durableDir, 'turns', '0002.prev'), { recursive: true });
  await writeFile(join(durableDir, 'turns', '0002.prev', 'canon.md'), '# Canon — durable\n\n## Fundamental laws\n- Nothing moves without paying with a memory.\n\n## World\n- (still undefined)\n\n## Recurring characters\n\n## Timeline\n\n## Stable facts\n\n## Mysteries with a fixed cause\n', 'utf8');
  const recovery = await recoverUniverse(durable.id);
  const afterCanon = await readFile(join(durableDir, 'canon.md'), 'utf8').catch(() => '');
  const partialGone = !(await stat(join(durableDir, 'chapters', '0001-half.md')).then(() => true, () => false));
  const queuedKept = recovery.queued.length === 1 && recovery.queued[0].number === 1;
  if (queuedKept && recovery.interrupted.includes(2) && partialGone && afterCanon.includes('(still undefined)')) {
    ok('durability: the queue stays on disk, a `running` turn becomes `interrupted`, canon rolls back, the partial chapter disappears');
  } else {
    fail(`durability: queued=${recovery.queued.length}, interrupted=[${recovery.interrupted}], partialGone=${partialGone}, canonRestored=${afterCanon.includes('(still undefined)')}`);
  }

  // Concrete ideas (used by the narrative closing panel) + reading ALA's offer from a chapter.
  await writeFile(join(durableDir, 'threads.json'), JSON.stringify({
    open: [{ id: 'fir-0001', kind: 'mister', question: 'Who built cage 31?', created_chapter: 1, due_chapter: 3, status: 'deschis' }],
    closed: [],
    promises: [],
    deferred_answers: []
  }), 'utf8');
  await writeFile(join(durableDir, 'chapters', '0001-hook.md'), '# Thread\n\nSample text long enough to be counted.\n', 'utf8');
  await writeFile(join(durableDir, 'chapters', '0001-offer.json'), JSON.stringify({
    teaser: 'Something changed in the archive and the registry does not know yet.',
    options: [{ label: 'Follow the registry', prompt: 'Continue the story: show what the registry does.' }]
  }), 'utf8');
  const chapter = await readChapter(durable.id, 1);
  const ideas = await readIdeas(durable.id);
  if (chapter.offer?.options?.length === 1 && ideas.length >= 2 && ideas.some((idea) => idea.prompt.includes('cage 31'))) {
    ok(`ALA offer read from chapter/NNNN-offer.json and ${ideas.length} continuation ideas derived from threads`);
  } else {
    fail(`offer/ideas: offer=${JSON.stringify(chapter.offer)}, ideas=${ideas.length}`);
  }

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

  // The Periodic Table of Ideas is a data contract: twelve families, fifteen operators, one hundred
  // and eighty cells whose systematic symbol is the family letter followed by the operator letter.
  {
    const { loadTable, tableForClient, resolveElements, composeLaw, elementLines } = await import('../src/periodic.mjs');
    const table = await loadTable();
    const raw = JSON.parse(await readFile(join(rootDir, 'data', 'periodic-table.json'), 'utf8'));
    const { cellDetail } = await import('../src/periodic.mjs');
    // The letters live on the family and operator records themselves (family letter + operator
    // letter is what makes a cell symbol, e.g. `CA` = cosmos + alteration).
    const familyLetters = Object.fromEntries((raw.families ?? []).map((family) => [family.name, family.letter]));
    const operatorLetters = Object.fromEntries((raw.operators ?? []).map((operator) => [operator.name, operator.letter]));
    const wrongSymbol = table.elements.filter((element) => element.symbol
      !== `${familyLetters[element.family]}${operatorLetters[element.operator]}`);
    const symbols = new Set(table.elements.map((element) => element.symbol));
    const familyNames = table.familyList.map((family) => family.name);
    const perFamily = new Map(familyNames.map((family) => [family, table.elements.filter((element) => element.family === family)]));
    const orderOk = [...perFamily.values()].every((list) => list.length === table.operators.length);
    const client = await tableForClient();
    // Every cell can be opened in the interface: the book's own prose plus a one-line request.
    const openCell = await cellDetail('LE');
    const cellText = JSON.stringify(openCell);
    const cellOk = openCell.name === 'Neutron Life' && openCell.family === 'LIFE'
      && openCell.operator === 'EXTENSION' && openCell.prompt.startsWith('A universe where ')
      && openCell.operatorDoes.length > 20 && openCell.familyNote.length > 40
      && openCell.essence.length > 20 && openCell.ingredient.startsWith('Neutron Life:')
      // The book's six repeated sections are not served: what a reader sees is the idea, the
      // sentence about that kind of change, the work it appears in and the scenes that use it.
      && !('sections' in openCell)
      && Array.isArray(openCell.scenes) && openCell.scenes.length >= 1
      && openCell.scenes.every((scene) => scene.title && scene.situation && scene.story && scene.slug)
      && !/(Kesh|the Atlas|PERIODIC TABLE|scarcity-shift|Nucleus)/.test(cellText);
    let unknownCell = '';
    try {
      await cellDetail('ZZ');
    } catch (error) {
      unknownCell = error.code;
    }
    const familiesAreObjects = table.familyList.every((family) => family.name && family.label && typeof family.letter === 'string' && Array.isArray(family.cells) && family.cells.length === 15);
    if (familyNames.length === 12 && table.operators.length === 15 && table.elements.length === 180
      && symbols.size === 180 && wrongSymbol.length === 0 && orderOk && client.elements.length === 180
      && client.elements.every((element) => element.symbol && element.name && element.family && element.operator && element.gist && element.prompt)
      && familiesAreObjects && cellOk && unknownCell === 'UNKNOWN_ELEMENT') {
      ok(`periodic table: ${familyNames.length} families × ${table.operators.length} operators, ${table.elements.length} cells, opened with the idea, the family sentence and the scenes that use the cell`);
    } else {
      fail(`periodic table: families=${familyNames.length}, operators=${table.operators.length}, cells=${table.elements.length}, unique=${symbols.size}, wrong=${wrongSymbol.length}, familiesOk=${familiesAreObjects}, cellOk=${cellOk}, unknownCell=${unknownCell}`);
    }

    // Choosing ingredients: canonical symbols only, a proposed element the table does not contain,
    // a hard cap, and the law composed from what was chosen.
    // The universe's own AGENTS.md lists the ingredients as sentences too, not as symbols.
    const { universeAgentsDoc } = await import('../src/universe-prompts.mjs');
    const agentsDoc = universeAgentsDoc('Probe', 'en', 'A law long enough to be accepted by the store.', chosenForDoc());
    function chosenForDoc() {
      return [{ symbol: 'RG', name: 'Hunger for Novelty', family: 'META-REALITY', operator: 'GENESIS', gist: 'the possible becomes painfully repeatable', ingredient: 'Hunger for Novelty: a universe where the possible becomes painfully repeatable (science fantasy and meta-reality, genesis).', custom: false }];
    }
    const chosen = await resolveElements(['CA', { symbol: 'MR' }, { custom: true, name: 'The Salt Debt', family: 'SOCIETY', operator: 'SCARCITY SHIFT' }]);
    const law = composeLaw(chosen);
    // What a person reads — the law, the request field, canon.md — never shows the two-letter
    // symbols that address cells inside the table.
    const humanLines = [...elementLines(chosen), ...law.split('\n')].filter((line) => line.trim());
    const coded = humanLines.filter((line) => /(?:^|[^A-Za-z])[A-Z]{2}(?:[^A-Za-z]|$)/.test(line) && !/^The world is built/.test(line));
    const rejects = [];
    for (const bad of [['ZZ'], ['CA', 'CA', 'CA', 'CA', 'CA', 'CA', 'CA'], [{ custom: true, name: 'Unknown Family', family: 'NOPE' }]]) {
      try {
        await resolveElements(bad);
        rejects.push('accepted');
      } catch (error) {
        rejects.push(error.code);
      }
    }
    if (chosen.length === 3 && chosen[0].symbol === 'CA' && chosen[2].custom === true
      && law.includes('Alternative Gravity') && law.includes('The Salt Debt') && law.length >= 24
      && chosen.every((element) => element.custom || element.ingredient)
      && coded.length === 0 && humanLines.some((line) => /a universe where/.test(line))
      && agentsDoc.includes('a universe where the possible becomes painfully repeatable') && !/\bRG\b/.test(agentsDoc)
      && rejects.join(',') === 'UNKNOWN_ELEMENT,BAD_ELEMENTS,BAD_ELEMENT_FAMILY') {
      ok('ingredients: symbols resolve, a proposed element is kept, bad input is refused, the law is composed');
    } else {
      fail(`ingredients: length=${chosen.length}, law=${law.slice(0, 40)}, rejects=${rejects.join(',')}, coded=${JSON.stringify(coded.slice(0, 2))}, agentsDocSymbols=${/\bRG\b/.test(agentsDoc)}`);
    }
  }

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
    const expected = creationFromTemplate(template, { language: 'ro', prompt: 'x'.repeat(40) });
    const symbols = merged.elements.map((element) => (typeof element === 'string' ? element : (element.symbol ?? element.name)));
    const custom = merged.elements.find((element) => typeof element === 'object' && element?.custom === true);
    if (fromTemplate.elements.join(',') === expected.elements.join(',')
      && symbols.join(',') === 'LE,TQ,CA,The Salt Debt' && custom?.name === 'The Salt Debt'
      && plain.premise.length === 40) {
      ok('creation input: a template keeps its own cells and the reader may add ingredients on top');
    } else {
      fail(`creation input: template=${fromTemplate.elements.join(',')}, merged=${symbols.join(',')}, custom=${custom?.name ?? 'none'}, plain=${plain.premise.length}`);
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

  const { archiveChapter, dropChaptersFrom, listChapterHistory } = await import('../src/universe-chapters.mjs');
  await writeFile(join(durableDir, 'chapters', '0002-two.md'), '# Two\n\ntext two\n', 'utf8');
  await writeFile(join(durableDir, 'chapters', '0003-three.md'), '# Three\n\nthree text\n', 'utf8');
  const archived = await archiveChapter(durable.id, 1);
  const history = await listChapterHistory(durable.id, 1);
  const dropped = await dropChaptersFrom(durable.id, 2);
  const twoGone = !(await stat(join(durableDir, 'chapters', '0002-two.md')).then(() => true, () => false));
  if (archived?.version === 1 && history.length === 1 && dropped.join(',') === '2,3' && twoGone) {
    ok('rewrite: the old version is archived in chapters/.history/ and later chapters can be dropped');
  } else {
    fail(`rewrite: archived=${archived?.version}, history=${history.length}, dropped=[${dropped}], 0002 gone=${twoGone}`);
  }

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

// The separate-phase group of `scripts/check.mjs`: the smallest honest end-to-end run of the design and
// review half of the product. It freezes a synthetic accepted book into an `assessment-input.v2` packet
// (`docs/contracts.md` §8.1–§8.3), runs the continuity review and the metrics report over that packet,
// and checks the properties a host depends on: nothing in the packet changed, the results name the
// version and the scope they covered, and a tampered packet is refused by both skills with a shared code.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { skillsDir } from '../src/paths.mjs';

const CANON = '# Canon — the ledger district\n\n## Fundamental laws\n- Cities exist only as long as someone tells them; silence dissolves them into stone.\n\n## World\n- The district keeps a ledger that is read aloud every night.\n\n## Recurring characters\n- The keeper reads the ledger and answers for what it records.\n\n## Timeline\n- Chapter two — the first unpaid debt is left open.\n\n## Stable facts\n- A debt that is read aloud keeps the stone standing.\n\n## Mysteries with a fixed cause\n- Who wrote the first entry — the registry founder — hints given so far.\n';
const THREADS = JSON.stringify({
  open: [{ id: 'thread-0001', kind: 'promise', question: 'Who will carry the interest of the open debt?', created_chapter: 2, due_chapter: 3, status: 'open' }],
  closed: [],
  promises: [],
  deferred_answers: []
});
const ATLAS = JSON.stringify({
  version: 1,
  axes: [{ id: 'memory-identity', nodes: [{ id: 'memory-as-currency', label: 'Memory as currency', state: 'dramatized', chapters: [1, 2] }] }]
});
const CHAPTER_ONE = `# The Reading\n\n${'The keeper read the ledger aloud and the district answered with the sound of stone settling. Nobody spoke of the debt that had no entry. '.repeat(12)}\n`;
const CHAPTER_TWO = `# The Interest\n\n${'The registry asked who would carry the interest, and the keeper wrote a name that was not theirs. The night went on being ordinary. '.repeat(12)}\n`;
const OFFER = (teaser) => JSON.stringify({
  teaser,
  options: [
    { label: 'Name the keeper', prompt: 'Continue the story: the registry names the debtor and shows the first collection.' },
    { label: 'Pay in work', prompt: 'Continue the story: the interest is paid in work, one district night at a time.' }
  ]
});
const PROFILE = JSON.stringify({
  schema_version: 'profile.v1',
  profile_id: 'check-phases',
  scope: { kind: 'book', chapters: [1, 2], context_chapters: [] },
  aggregation: { enabled: false }
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// `docs/contracts.md` §8.2: the identity of an accepted version, over the narrative roles only.
const VERSION_ROLES = new Set(['chapter', 'offer', 'canon', 'threads', 'atlas']);

/** The accepted narrative files of the synthetic book, with the role each one plays. */
function bookFiles() {
  return [
    { path: 'canon.md', role: 'canon' },
    { path: 'threads.json', role: 'threads' },
    { path: 'atlas.json', role: 'atlas' },
    { path: 'chapters/0001-the-reading.md', role: 'chapter', chapter: 1 },
    { path: 'chapters/0001-offer.json', role: 'offer', chapter: 1 },
    { path: 'chapters/0002-the-interest.md', role: 'chapter', chapter: 2 },
    { path: 'chapters/0002-offer.json', role: 'offer', chapter: 2 }
  ];
}

function fileBody(path) {
  if (path === 'canon.md') return CANON;
  if (path === 'threads.json') return THREADS;
  if (path === 'atlas.json') return ATLAS;
  if (path === 'chapters/0001-the-reading.md') return CHAPTER_ONE;
  if (path === 'chapters/0002-the-interest.md') return CHAPTER_TWO;
  if (path === 'chapters/0001-offer.json') return OFFER('The keeper read the ledger and the district answered. Now the registry wants the price.');
  if (path === 'chapters/0002-offer.json') return OFFER('Two chapters of ledger and a district that holds. Who will carry the interest?');
  throw new Error(`no fixture body for ${path}`);
}

/** The §8.2 content identity of a list of `{ path, sha256, bytes }` entries. */
function acceptedVersion(entries) {
  const lines = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`)
    .join('');
  return `sha256:${sha256(lines)}`;
}

/** Freeze the synthetic book into the workspace layout of §8.1 as an `assessment-input.v2` packet. */
async function freezePacket(root) {
  const runDir = join(root, 'ledger-district', 'sha256-check', '20260922T120000-review-0000');
  const inputDir = join(runDir, 'input');
  const entries = [];
  for (const file of bookFiles()) {
    const body = fileBody(file.path);
    const target = join(inputDir, file.path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, body, 'utf8');
    entries.push({ path: file.path, sha256: sha256(body), bytes: Buffer.byteLength(body), role: file.role });
  }
  const manifest = {
    schema_version: 'assessment-input.v2',
    universe_id: 'ledger-district',
    version: acceptedVersion(entries),
    captured_at: '2026-09-22T12:00:00.000Z',
    book: { title: 'The Ledger District', language: 'en', last_accepted_chapter: 2 },
    scope: { kind: 'complete', chapters: [1, 2], omitted: [] },
    files: entries.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes,
      role: entry.role,
      artifact_id: entry.role === 'chapter' ? `chapter-${String(entry.path).slice(9, 13)}` : entry.role === 'offer' ? `offer-${String(entry.path).slice(9, 13)}` : entry.role,
      ...(entry.role === 'chapter' || entry.role === 'offer' ? { chapter: Number(String(entry.path).slice(9, 13)) } : {})
    }))
  };
  await writeFile(join(inputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(join(runDir, 'profile.json'), PROFILE, 'utf8');
  return { runDir, inputDir, manifest };
}

/** Every file under a directory with its hash, for the byte-identity assertions. */
async function treeHashes(dir) {
  const files = new Map();
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(relative(dir, path), sha256(await readFile(path)));
    }
  };
  await walk(dir);
  return files;
}

function diffTrees(before, after) {
  const changes = [];
  for (const [path, hash] of before) {
    if (!after.has(path)) changes.push(`removed ${path}`);
    else if (after.get(path) !== hash) changes.push(`changed ${path}`);
  }
  for (const path of after.keys()) if (!before.has(path)) changes.push(`added ${path}`);
  return changes;
}

export async function runPhaseChecks({ ok, fail, run }) {
  const root = await mkdtemp(join(tmpdir(), 'phases-'));
  try {
    const packet = await freezePacket(root);
    const before = await treeHashes(packet.inputDir);

    // The continuity review runs over the packet directory and writes its own result directory.
    const continuityOut = join(packet.runDir, 'result');
    const continuity = await run(process.execPath, [
      join(skillsDir, 'scripta-continuity-review', 'scripts', 'review-continuity.mjs'),
      '--input', packet.inputDir, '--out', continuityOut
    ], packet.runDir);
    const continuityLine = continuity.stdout.trim().split('\n').pop();
    let continuityResult = null;
    try {
      continuityResult = JSON.parse(continuityLine);
    } catch {
      continuityResult = null;
    }
    const continuityFile = join(continuityOut, 'continuity-result.json');
    const continuityBody = await readFile(continuityFile, 'utf8').then((raw) => JSON.parse(raw), () => null);
    const continuityVersion = continuityBody?.source_version ?? continuityBody?.version ?? continuityResult?.version ?? null;
    if (continuity.code === 0 && continuityBody && continuityVersion === packet.manifest.version) {
      ok(`phase run: the continuity review accepts a frozen packet and names its accepted version (${String(continuityVersion).slice(0, 18)}…)`);
    } else {
      fail(`phase run/continuity: exit=${continuity.code}, result=${continuityBody ? 'written' : 'missing'}, version=${continuityVersion}, expected=${packet.manifest.version}, stderr=${continuity.stderr.trim().split('\n')[0] ?? ''}`);
    }

    // The metrics report renders its bundle from the same frozen packet.
    const metricsOut = join(packet.runDir, 'assessment');
    const metrics = await run(process.execPath, [
      join(skillsDir, 'scripta-metrics-report', 'scripts', 'build-report.mjs'),
      '--input', packet.inputDir, '--out', metricsOut,
      '--profile', join(packet.runDir, 'profile.json')
    ], packet.runDir);
    const metricsFiles = (await readdir(metricsOut).catch(() => [])).sort();
    const expectedViews = ['assessment.json', 'index.md', '01-stg-compliance.md', '02-specification-adherence.md', '03-metrics-and-indicators.md', '04-score-justification.md', '05-detected-issues.md'];
    const missingViews = expectedViews.filter((name) => !metricsFiles.includes(name));
    const assessment = await readFile(join(metricsOut, 'assessment.json'), 'utf8').then((raw) => JSON.parse(raw), () => null);
    const assessmentVersion = assessment?.version ?? assessment?.provenance?.packet?.version ?? null;
    // The bundle carries the packet version, the scope the profile asked for, a coverage record, and one
    // result per metric of the frozen registry.
    // The bundle keys its results by metric id, one entry per metric of the frozen registry.
    const metricIds = assessment?.metrics && typeof assessment.metrics === 'object' ? Object.keys(assessment.metrics) : [];
    const indicatorIds = assessment?.indicators && typeof assessment.indicators === 'object' ? Object.keys(assessment.indicators) : [];
    const bundleComplete = assessment?.scope?.kind === 'book'
      && assessment?.coverage && typeof assessment.coverage === 'object'
      && metricIds.length === 12 && indicatorIds.length === 8;
    if (metrics.code === 0 && missingViews.length === 0 && assessmentVersion === packet.manifest.version && bundleComplete) {
      ok(`phase run: the metrics report publishes the bundle and its five views for the same version, with coverage and all twelve metrics (${metricsFiles.length} files)`);
    } else {
      fail(`phase run/metrics: exit=${metrics.code}, missing=${JSON.stringify(missingViews)}, version=${assessmentVersion}, scope=${assessment?.scope?.kind}, metrics=${metricIds.length}, indicators=${indicatorIds.length}, coverage=${assessment?.coverage ? 'present' : 'absent'}, stderr=${metrics.stderr.trim().split('\n')[0] ?? ''}`);
    }

    // Either phase may read the packet, and neither may change a byte of it.
    const after = await treeHashes(packet.inputDir);
    const touched = diffTrees(before, after);
    if (touched.length === 0) {
      ok('phase run: neither the continuity review nor the metrics report changes a byte of the frozen packet');
    } else {
      fail(`phase run/input mutation: ${touched.join('; ')}`);
    }

    // A tampered packet is refused by both skills with a shared code, and neither publishes a result.
    {
      const chapterPath = join(packet.inputDir, 'chapters/0001-the-reading.md');
      const original = await readFile(chapterPath, 'utf8');
      await writeFile(chapterPath, `${original}\nOne extra line, which the manifest does not know about.\n`, 'utf8');
      const continuityOut2 = join(packet.runDir, 'result-tampered');
      const continuityTamper = await run(process.execPath, [
        join(skillsDir, 'scripta-continuity-review', 'scripts', 'review-continuity.mjs'),
        '--input', packet.inputDir, '--out', continuityOut2
      ], packet.runDir);
      const metricsOut2 = join(packet.runDir, 'assessment-tampered');
      const metricsTamper = await run(process.execPath, [
        join(skillsDir, 'scripta-metrics-report', 'scripts', 'build-report.mjs'),
        '--input', packet.inputDir, '--out', metricsOut2,
        '--profile', join(packet.runDir, 'profile.json')
      ], packet.runDir);
      await writeFile(chapterPath, original, 'utf8');
      const codes = (result) => {
        const text = `${result.stdout}\n${result.stderr}`;
        const found = text.match(/\b(BYTE_MISMATCH|HASH_MISMATCH|VERSION_MISMATCH|INVALID_MANIFEST|MISSING_FILE)\b/g) ?? [];
        return [...new Set(found)];
      };
      const continuityCodes = codes(continuityTamper);
      const metricsCodes = codes(metricsTamper);
      const nothingPublished = !(await stat(continuityOut2).then(() => true, () => false))
        && !(await stat(metricsOut2).then(() => true, () => false));
      const shared = continuityCodes.filter((code) => metricsCodes.includes(code));
      if (continuityTamper.code === 2 && metricsTamper.code === 2 && nothingPublished && shared.length > 0) {
        ok(`phase run: a tampered packet is refused by both skills with the shared code ${shared[0]}, and neither publishes a result`);
      } else {
        fail(`phase run/tamper: continuity=${continuityTamper.code}${JSON.stringify(continuityCodes)}, metrics=${metricsTamper.code}${JSON.stringify(metricsCodes)}, nothingPublished=${nothingPublished}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

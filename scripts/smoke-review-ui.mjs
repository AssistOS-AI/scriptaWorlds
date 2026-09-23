#!/usr/bin/env node
/**
 * scriptaWorlds — a real HTTP and browser smoke over the reader surfaces a review touches.
 *
 *   node scripts/smoke-review-ui.mjs [--no-browser] [--keep-open] [--port N] [--browser PATH]
 *
 * The smoke builds a temporary book, publishes a selected-chapter review over it with supplied
 * observations (no model call), records two reader responses of which one is historical after a rewrite,
 * starts the real server on a free port against that store and then asserts two things: what the HTTP
 * routes actually answer (payloads, not status codes) and what a reader actually sees in the browser the
 * smoke drives over the DevTools protocol (`Review chapter 1`, `Reports and reviews`, the review bundle
 * and the team pane). Nothing here spends model budget, so the smoke is a separate command rather than
 * part of `npm run check`.
 *
 * `--keep-open` starts the server, prints the URL and waits, so a person or an agent can drive the same
 * store by hand. `--no-browser` performs the HTTP assertions alone and says so; when no Chromium is
 * installed the browser half is reported as skipped with the paths it looked at.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { universeDir } from '../src/paths.mjs';
import { currentVersion } from '../src/assessment-packet.mjs';
import { readAssessment, settleAssessments, startAssessment } from '../src/assessments.mjs';
import { createFeedbackReader } from '../src/feedback-readers.mjs';
import { createFeedbackTarget, readFrozenText } from '../src/feedback-targets.mjs';
import { listFeedback, submitFeedback } from '../src/feedback-entries.mjs';
import { bookWithTwoChapters, sha256Hex } from './check-fixtures.mjs';

const CHAPTER_ONE = 'chapters/0001-one.md';
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  join(process.env.HOME ?? '', '.cache/puppeteer/chrome/linux-139.0.7258.154/chrome-linux64/chrome')
].filter(Boolean);

const observations = [];
const failures = [];

function seen(message) {
  observations.push(message);
  console.log(`  ✓ ${message}`);
}

function broken(message) {
  failures.push(message);
  console.log(`  ✗ ${message}`);
}

function check(condition, message, detail = '') {
  if (condition) seen(message);
  else broken(`${message}${detail ? ` — ${detail}` : ''}`);
}

/* --------------------------------- the seed -------------------------------- */

/** The observations a selected-chapter review publishes, quoted from the chapter's real bytes. */
async function suppliedAnnotations(universeId, version) {
  const chapter = await readFile(join(universeDir(universeId), CHAPTER_ONE));
  const span = (id, start, length) => {
    const end = start + length;
    return { id, file: CHAPTER_ONE, sha256: sha256Hex(chapter), start, end, quote: chapter.subarray(start, end).toString('utf8') };
  };
  const evidence = [span('e1', 0, 40), span('e2', 120, 60)];
  const segmentEnd = Math.min(chapter.length, 200);
  return {
    schema_version: 'annotations.v1',
    source_version: version,
    request: null,
    brief: null,
    evidence,
    segments: [
      { id: 'seg1', chapter: 1, kind: 'scene', label: 'the opening', focal_character: 'the keeper', start: 0, end: segmentEnd, story_order: 1 }
    ],
    metrics: {
      CS: {
        status: 'judged',
        evaluator: 'human-1',
        dimensions: {
          referential_clarity: { rating: 3, rationale: 'Every referent is recoverable.', evidence: ['e1'] },
          discourse_connection: { rating: 2, rationale: 'The sentences connect through the ledger.', evidence: ['e2'] },
          causal_support: { rating: 2, rationale: 'The reading keeps the district standing.', evidence: ['e1'] },
          temporal_intelligibility: { rating: 3, rationale: 'The order stays clear.', evidence: ['e2'] }
        }
      },
      OI: {
        status: 'judged',
        evaluator: 'human-1',
        comparison_scope: 'declared genre references (none supplied)',
        dimensions: {
          perspective: { rating: 2, rationale: 'A familiar outsider viewpoint, precisely held.', evidence: ['e1'] },
          dramatic_development: { rating: 1, rationale: 'The scene turns on a small recognition.', evidence: ['e2'] },
          expression: { rating: 2, rationale: 'Plain diction with one careful image.', evidence: ['e1'] }
        }
      },
      NCS: {
        status: 'judged',
        evaluator: 'human-1',
        dimensions: {
          novelty: { rating: 2, rationale: 'The ledger is read aloud rather than described.', evidence: ['e1'] },
          cliche_reliance: { rating: 1, rationale: 'One weather figure is conventional but earned.', evidence: ['e2'] }
        }
      },
      EAP: {
        status: 'judged',
        evaluator: 'human-1',
        ordering: 'story',
        trajectory: [
          {
            segment_id: 'seg1',
            story_order: 1,
            focalization: 'the keeper',
            valence: 1,
            tension: 2,
            evidence: ['e1'],
            uncertainty: 'The lift may be relief rather than hope.'
          }
        ],
        emotional_fit: {
          status: 'judged',
          evaluator: 'human-1',
          fit: 55,
          rationale: 'The register answers the elegiac intention.',
          evidence: ['e1'],
          intention_binding: 'a quiet elegiac aftermath'
        }
      }
    },
    indicators: [
      {
        id: 'narrative_coherence',
        status: 'judged',
        category: 'High',
        evaluator: 'human-1',
        rationale: 'The scene recovers its causal relations.',
        evidence: ['e1'],
        counterevidence: null
      }
    ],
    findings: [
      {
        id: 'f1',
        kind: 'editorial',
        severity: 'local',
        certainty: 'tentative',
        status: 'unresolved',
        description: 'The district answers before the price is named.',
        evidence: ['e2'],
        repair_suggestion: 'Let the registry name its price one beat earlier.',
        alternative_explanation: 'The price may be deliberately withheld for the next chapter.'
      }
    ],
    preserved_qualities: {
      passages: [{ id: 'p1', rationale: 'The opening image is worth keeping.', evidence: ['e1'] }],
      reason: 'The restraint is the effect.'
    },
    departures: []
  };
}

/** A temporary book with a published chapter review and two reader responses, one of them historical. */
async function seed(checkSeed, onCreated = () => {}) {
  const universe = await bookWithTwoChapters(checkSeed, 'smoke');
  // From here on the smoke owns this universe: a failure in the middle of the seed must not leave it in
  // the store, so the caller is told about it before any work that can throw.
  onCreated(universe.id);
  const version = await currentVersion(universe.id);
  const annotations = await suppliedAnnotations(universe.id, version);
  const started = await startAssessment({
    universeId: universe.id,
    phase: 'metrics',
    annotations,
    scope: { kind: 'chapter', chapters: [1] },
    aggregate: true,
    intention: 'a quiet elegiac aftermath',
    weights: { cs: 0.4, oi: 0.3, emotional_fit: 0.3 }
  });
  await settleAssessments();
  const run = await readAssessment(universe.id, started.run_id);
  if (run.status !== 'done') throw new Error(`the seeded review did not publish: ${run.error}`);

  const reader = await createFeedbackReader({ universeId: universe.id, displayName: 'Smoke Reader' });
  // The reading is the whole book, so a response may name the report of the chapter it read: a report is
  // associated with a target only when the target displays every chapter the run's packet covers.
  const { target } = await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } });
  const frozen = await readFrozenText(universe.id, target, '0001-one.md');
  const frozenBytes = Buffer.from(frozen.text, 'utf8');
  const quote = frozenBytes.subarray(0, 40).toString('utf8');
  const current = await submitFeedback({
    universeId: universe.id,
    targetId: target.target_id,
    readerId: reader.reader_id,
    feedbackId: 'fb-smoke-first',
    answers: [{ question_id: 'interest', value: 4, comment: null }],
    comments: [{ text: 'The ledger device works; the price arrives too late to feel earned.', evidence: [{ file: '0001-one.md', start: 0, end: 40, quote }] }],
    conditions: { where: 'the smoke', minutes: 12, device: 'headless chromium', completeness: 'read the chapter twice' },
    runId: run.run_id,
    findingIds: ['f1'],
    note: 'read after the report'
  });

  // Move the book on, so the reading above is a reading of a version that is no longer accepted, and
  // freeze a second target for the text the reader sees now.
  const path = join(universeDir(universe.id), CHAPTER_ONE);
  const rewritten = `${await readFile(path, 'utf8')}\n\nThe registry named its price, and the district stayed.\n`;
  await writeFile(path, rewritten, 'utf8');
  const { target: laterTarget } = await createFeedbackTarget({ universeId: universe.id, scope: { kind: 'book' } });
  const historical = await submitFeedback({
    universeId: universe.id,
    targetId: laterTarget.target_id,
    readerId: reader.reader_id,
    feedbackId: 'fb-smoke-later',
    answers: [{ question_id: 'interest', value: 2, comment: null }],
    comments: [],
    note: 'read the earlier text'
  });
  return { universe, run, reader, target, laterTarget, current, historical, quote };
}

/* ------------------------------ the HTTP pass ------------------------------ */

async function get(base, path) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, text, body, headers: response.headers };
}

async function httpPass(base, seeded) {
  const id = seeded.universe.id;
  const detail = await get(base, `/api/universes/${id}`);
  check(detail.status === 200 && detail.body?.universe?.id === id && detail.body?.chapters?.length === 2,
    'the reader opens the book and sees its two chapters',
    `status ${detail.status}, chapters ${detail.body?.chapters?.length}`);

  const listing = await get(base, `/api/universes/${id}/assessments`);
  const listed = (listing.body?.runs ?? []).find((run) => run.run_id === seeded.run.run_id);
  // The book moved on after the review was published, so the run is listed as published and historical:
  // that is the state the report dialog announces to a reader.
  check(listing.status === 200 && listed?.status === 'done' && listed?.historical === true,
    `the book lists its review run (${seeded.run.run_id}) as published, and as historical because the accepted version moved on`,
    `status ${listing.status}, run ${listed?.status}/${listed?.historical}`);

  const bundle = await get(base, `/api/universes/${id}/assessments/${seeded.run.run_id}/report/assessment.json`);
  const metrics = bundle.body?.metrics ?? {};
  check(bundle.status === 200 && bundle.body?.scope?.chapters?.join(',') === '1' && metrics.CS?.status === 'judged' && metrics.NQS?.status === 'computed',
    `the report of the selected chapter answers with its published metrics (CS ${metrics.CS?.value}, NQS ${metrics.NQS?.value} over chapter ${bundle.body?.scope?.chapters?.join(',')})`,
    `status ${bundle.status}, CS ${metrics.CS?.status}, NQS ${metrics.NQS?.status}`);
  check((bundle.body?.findings ?? []).length === 1 && bundle.body?.findings?.[0]?.repair_suggestion?.includes('price'),
    'the report carries the finding with its bounded revision option',
    `findings ${JSON.stringify((bundle.body?.findings ?? []).map((finding) => finding.id))}`);

  const index = await get(base, `/api/universes/${id}/assessments/${seeded.run.run_id}/report/index.md`);
  check(index.status === 200 && index.text.includes('chapter 1') && /continuity|CCI/i.test(index.text),
    'the published index view is served as the markdown a reader opens',
    `status ${index.status}, ${index.text.length} bytes`);

  const guarded = await get(base, `/api/universes/${id}/assessments/${seeded.run.run_id}/report/nope.json`);
  check(guarded.status === 400 || guarded.status === 404,
    `a file the run never published is refused (status ${guarded.status}, code ${guarded.body?.error?.code ?? 'none'})`);

  const feedback = await get(base, `/api/universes/${id}/feedback`);
  const responses = feedback.body?.feedback ?? [];
  const laterEntry = responses.find((entry) => entry.feedback_id === 'fb-smoke-later');
  const firstEntry = responses.find((entry) => entry.feedback_id === 'fb-smoke-first');
  check(feedback.status === 200 && responses.length === 2 && firstEntry?.historical === true && laterEntry?.historical === false,
    'the historical response is listed beside the current one, each labeled by the version it answers',
    `status ${feedback.status}, earlier ${firstEntry?.historical}, later ${laterEntry?.historical}`);
  check(firstEntry?.run_id === seeded.run.run_id && firstEntry?.finding_ids?.includes('f1'),
    'the response still names the report and the finding its reader saw',
    `run ${firstEntry?.run_id}, findings ${JSON.stringify(firstEntry?.finding_ids)}`);

  const dataset = await get(base, `/api/universes/${id}/feedback/dataset`);
  const texts = Object.values(dataset.body?.texts ?? {}).flatMap((entry) => entry.files ?? []);
  const carriesBothVersions = texts.filter((file) => typeof file.text === 'string' && file.text.includes('The ledger was read aloud')).length >= 1;
  const carriesProse = texts.some((file) => typeof file.text === 'string' && file.text.length > 200);
  check(dataset.status === 200 && dataset.body?.schema_version === 'reader-feedback-dataset.v1' && carriesProse && carriesBothVersions,
    `the export carries the frozen prose itself (${texts.length} file(s), ${texts.reduce((total, file) => total + (file.text?.length ?? 0), 0)} characters)`,
    `status ${dataset.status}, schema ${dataset.body?.schema_version}`);
  const selection = dataset.body?.selection ?? {};
  check((selection.counted ?? []).length === 2 && (selection.superseded ?? []).length === 0
    && typeof selection.rule === 'string' && selection.rule.includes('corrected or withdrawn'),
    'the export states which responses an analysis may count, by name, and the rule that decides it',
    JSON.stringify({ counted: selection.counted, superseded: selection.superseded }));
}

/* ----------------------------- the browser pass ---------------------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function browserPath(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  return BROWSER_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** Launch headless Chromium and return the DevTools endpoint plus a killer. */
async function launchBrowser(executable) {
  const profile = await mkdtemp(join(tmpdir(), 'smoke-chrome-'));
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const deadline = setTimeout(() => reject(new Error(`chromium printed no DevTools endpoint: ${stderr.slice(0, 300)}`)), 20_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(deadline);
        resolve(match[1]);
      }
    });
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
  return {
    endpoint,
    close: async () => {
      child.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true });
    }
  };
}

/** A minimal DevTools client: send a method, wait for its result. */
async function connectDevTools(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('the DevTools socket refused the connection')), { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    next += 1;
    pending.set(next, { resolve, reject });
    socket.send(JSON.stringify({ id: next, method, params }));
  });
  return { send, close: () => socket.close() };
}

async function pageTarget(endpoint) {
  const host = new URL(endpoint).host;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await fetch(`http://${host}/json/list`).then((response) => response.json(), () => []);
    const page = list.find((target) => target.type === 'page');
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await sleep(250);
  }
  throw new Error('no page target appeared in the browser');
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'the page threw');
  return result.result?.value;
}

const pageText = (cdp) => evaluate(cdp, 'document.body ? document.body.innerText : ""');

/** The text a reader sees inside one surface, which is what the smoke asserts on. */
async function surfaceText(cdp, selector) {
  const value = await evaluate(cdp, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? node.innerText : null; })()`);
  return typeof value === 'string' ? value : '';
}

async function waitForText(cdp, needle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await pageText(cdp);
    if (typeof text === 'string' && text.includes(needle)) return text;
    if (Date.now() > deadline) return text;
    await sleep(250);
  }
}

/** Wait until one surface shows a needle, and answer with that surface's text either way. */
async function waitForSurface(cdp, selector, needle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await surfaceText(cdp, selector);
    if (text.includes(needle)) return text;
    if (Date.now() > deadline) return text;
    await sleep(250);
  }
}

/** Wait until a selector matches, because a panel loads its rows from the host after it opens. */
async function waitForSelector(cdp, selector, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}) !== null`);
    if (found === true) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

/** The markup of one element, for a failure that has to say what the reader was looking at. */
async function html(cdp, selector) {
  const value = await evaluate(cdp, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? node.outerHTML.slice(0, 400) : null; })()`);
  return value ?? 'not rendered';
}

/** Click the first element matching a selector, or report that it is not there. */
async function click(cdp, selector) {
  const outcome = await evaluate(cdp, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return 'missing'; node.click(); return 'clicked'; })()`);
  return outcome;
}

/** The text around a needle, so a failure says what the reader saw instead. */
function excerpt(text, needle) {
  const value = String(text ?? '');
  const at = value.indexOf(needle);
  return at < 0 ? value.slice(0, 500).replace(/\s+/g, ' ') : value.slice(Math.max(0, at - 120), at + 200).replace(/\s+/g, ' ');
}

/** One browser assertion: the condition, what it means, and the rendered text it was read from. */
function checkText(condition, message, text, needle) {
  if (condition) seen(message);
  else broken(`${message} — saw: ${excerpt(text, needle)}`);
}

async function browserPass(url, seeded, executable) {
  const browser = await launchBrowser(executable);
  let cdp = null;
  try {
    cdp = await connectDevTools(await pageTarget(browser.endpoint));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url });
    const book = await waitForText(cdp, 'One');
    check(book.includes('One') && book.includes('Two'),
      `the reader renders the book in a real browser (${book.length} characters of rendered text)`);

    const opened = await click(cdp, `[aria-label="Review chapter 1"]`);
    const review = opened === 'clicked' ? await waitForSurface(cdp, '#review-body', 'Start review') : '';
    const reviewTitle = await surfaceText(cdp, '#review-title');
    checkText(opened === 'clicked' && reviewTitle.includes('Review — chapter 1')
      && review.includes('WHAT TO REVIEW') && review.includes('This chapter — 1')
      && review.includes('The whole book') && review.includes('Start review'),
      'clicking "Review chapter 1" opens the review with its two scopes and one start control',
      review, 'WHAT TO REVIEW');

    // The run the smoke published is already there: the latest report offers it, and the reading a
    // reader lands on is the report itself rather than the bundle behind it.
    const reportReady = await waitForSelector(cdp, '#review-latest button');
    const openedReport = reportReady ? await click(cdp, '#review-latest button') : 'missing';
    await waitForSelector(cdp, '#report-viewstrip .viewbtn');
    const reportView = openedReport === 'clicked' ? await waitForSurface(cdp, '#report-view', 'THE REVIEW IN BRIEF') : '';
    const head = await surfaceText(cdp, '#report-head');
    const reportNeedles = ['THE REVIEW IN BRIEF', 'Strengths observed', 'Most consequential problems', 'The opening image is worth keeping.'];
    const reportMissing = reportNeedles.filter((needle) => !reportView.includes(needle));
    checkText(openedReport === 'clicked' && reportMissing.length === 0,
      'opening the latest report renders the review a reader reads: the review in brief, the strengths, the problems and the passages worth keeping',
      `${reportView.slice(0, 400)} | missing: ${reportMissing.join(', ')}`, 'THE REVIEW IN BRIEF');
    checkText(head.includes('historical') && head.includes('later accepted version'),
      'the report head tells the reader the review describes a version the book has moved past',
      head, 'historical');

    const viewed = await click(cdp, '#report-viewstrip .viewbtn[data-view="03-metrics-and-indicators.md"]');
    const metricsView = viewed === 'clicked' ? await waitForSurface(cdp, '#report-view', 'Metrics & Indicators Report') : '';
    checkText(viewed === 'clicked' && metricsView.includes('Metrics & Indicators Report')
      && metricsView.includes('CS') && metricsView.includes('NQS') && /CCI|Continuity/.test(metricsView),
      'the view strip switches to the published metric view, which lists the status of every measure it reports',
      metricsView, 'Metrics & Indicators Report');

    const feedbackButton = await click(cdp, `[aria-label="Say what you think of this book, from chapter 1"]`);
    const team = feedbackButton === 'clicked' ? await waitForText(cdp, 'What readers said') : '';
    const strip = await waitForSelector(cdp, '#feedback-views .viewbtn');
    const sawList = strip ? await click(cdp, '#feedback-views .viewbtn:nth-child(2)') : 'missing';
    const responses = sawList === 'clicked' ? await waitForSurface(cdp, '#feedback-body', 'Responses') : '';
    checkText(feedbackButton === 'clicked' && responses.includes('Smoke Reader') && /historical/i.test(responses) && /as given/i.test(responses),
      'the team pane shows the reader\'s responses, the version each answers and how each was given',
      responses, 'Responses');

    const menu = await click(cdp, '#btn-more');
    const exported = menu === 'clicked' ? await waitForText(cdp, 'Download PDF') : '';
    checkText(menu === 'clicked' && exported.includes('Download PDF') && exported.includes('Generate edition'),
      'the export menu a reader uses offers the downloadable editions',
      exported, 'Download PDF');
  } finally {
    cdp?.close();
    await browser.close();
  }
}

/* --------------------------- the operator boundaries ----------------------- */

/**
 * An evaluator installed as `omp` for the server of the smoke. It answers `--version` so the server
 * starts, chooses what to do from the request text the host puts in the prompt, and records the calls it
 * received. It produces nothing usable: these checks are about what the host does when a child fails or
 * has to be stopped, not about the reading it would have written.
 */
async function installFakeEvaluator(workspace) {
  const dir = join(workspace, 'fake-evaluator');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'fake-evaluator.mjs'), `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (process.argv.includes('--version')) { process.stdout.write('smoke-evaluator/0.0.1\\n'); process.exit(0); }
process.stdin.resume();
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
await new Promise((resolve) => process.stdin.on('end', resolve));
await writeFile(join(process.env.SMOKE_EVALUATOR_DIR, 'call-' + String(process.pid) + '.txt'), prompt.slice(0, 200), 'utf8');
const emit = (payload) => new Promise((resolve) => process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: payload } }) + String.fromCharCode(10), resolve));
if (prompt.includes('SMOKE_EXIT_ONE')) {
  // A document and then a failure: the host must not publish a reading from a child that failed.
  await emit('{"schema_version":"annotations.v1","source_version":"sha256:0000","metrics":{},"indicators":[]}');
  process.exit(1);
}
if (prompt.includes('SMOKE_HANG')) {
  // Ignores SIGTERM: the host has to escalate, and must refuse a retry while this process lives.
  process.on('SIGTERM', () => {});
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  process.exit(0);
}
await emit('{"schema_version":"annotations.v1","source_version":"sha256:0000","metrics":{},"indicators":[]}');
process.exit(0);
`, 'utf8');
  const shim = join(dir, 'omp');
  await writeFile(shim, '#!/bin/sh\nexec node "$(dirname "$0")/fake-evaluator.mjs" "$@"\n', 'utf8');
  await chmod(shim, 0o755);
  return { shim, dir };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

/** Wait until the served run reaches a settled state, and answer with the run it last served. */
async function waitForRun(base, universeId, runId, settled, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let run = null;
  for (;;) {
    run = (await get(base, `/api/universes/${universeId}/assessments/${runId}`)).body?.run ?? null;
    if (run && settled.includes(run.status)) return run;
    if (Date.now() > deadline) return run;
    await sleep(500);
  }
}

/**
 * What an operator sees when an evaluator fails or has to be stopped, and what two simultaneous
 * corrections of one response do — all of it through the routes the reader interface uses.
 */
async function boundaryPass(base, seeded) {
  const id = seeded.universe.id;
  const failing = await post(base, `/api/universes/${id}/assessments`, {
    phase: 'metrics',
    mode: 'generic',
    request: 'SMOKE_EXIT_ONE',
    scope: { kind: 'chapter', chapters: [1] },
    force: true
  });
  const failedRun = await waitForRun(base, id, failing.body?.run?.run_id, ['done', 'error', 'cancelled', 'interrupted']);
  const report = failedRun ? await get(base, `/api/universes/${id}/assessments/${failedRun.run_id}/report/assessment.json`) : { status: 0 };
  const attempts = failedRun?.annotation_attempts ?? [];
  const failedAttempt = attempts.find((attempt) => attempt.process_failure === true) ?? {};
  check(failing.status === 202 && failedRun?.status === 'error'
    && attempts.length > 0 && failedAttempt.exit_code === 1
    && (failedRun.outputs ?? []).length === 0 && /exited with code 1/.test(String(failedRun.error))
    && report.status !== 200 && report.body?.error?.code !== undefined,
    `an evaluator that answers and then exits 1 fails the run the reader sees (status ${failedRun?.status}, the attempt records exit ${failedAttempt.exit_code} as a process failure, ${(failedRun?.outputs ?? []).length} published files, the report route answers ${report.status} ${report.body?.error?.code ?? ''})`);

  const hanging = await post(base, `/api/universes/${id}/assessments`, {
    phase: 'metrics',
    mode: 'generic',
    request: 'SMOKE_HANG',
    scope: { kind: 'chapter', chapters: [1] },
    force: true
  });
  await sleep(1_500);
  const cancelled = await post(base, `/api/universes/${id}/assessments/${hanging.body?.run?.run_id}`, { action: 'cancel' });
  const refusedRetry = await post(base, `/api/universes/${id}/assessments/${hanging.body?.run?.run_id}`, { action: 'retry' });
  const settled = await waitForRun(base, id, hanging.body?.run?.run_id, ['done', 'error', 'cancelled', 'interrupted']);
  check(cancelled.status === 200 && cancelled.body?.run?.status === 'cancelled'
    && settled?.status === 'cancelled' && (settled.outputs ?? []).length === 0
    && (refusedRetry.status === 409 || refusedRetry.body?.error?.code === 'NOT_RETRYABLE'),
    `cancelling a review while its evaluator is running leaves it cancelled (${settled?.status}) with nothing published, and a retry while the child lives is refused (${refusedRetry.status} ${refusedRetry.body?.error?.code ?? ''})`);

  // Two simultaneous corrections of one response: exactly one commits, the other is refused, and the
  // lineage the reader sees has one current answer.
  const correct = (feedbackId) => post(base, `/api/universes/${id}/feedback`, {
    feedbackId,
    targetId: seeded.laterTarget.target_id,
    readerId: seeded.reader.reader_id,
    revision_of: 'fb-smoke-later',
    answers: [{ question_id: 'interest', value: feedbackId.endsWith('a') ? 3 : 5 }]
  });
  const [first, second] = await Promise.all([correct('fb-smoke-conc-a'), correct('fb-smoke-conc-b')]);
  const listing = await get(base, `/api/universes/${id}/feedback`);
  const children = (listing.body?.feedback ?? []).filter((entry) => entry.revision_of === 'fb-smoke-later');
  const refused = [first, second].filter((answer) => answer.status !== 201 && answer.status !== 200);
  check([first, second].filter((answer) => answer.status === 201 || answer.status === 200).length === 1
    && refused.length === 1 && refused[0].body?.error?.code === 'CONFLICT'
    && children.length === 1 && children[0].revision === 2,
    `two simultaneous corrections of one response left exactly one child (${children[0]?.feedback_id ?? 'none'}, revision ${children[0]?.revision}) with the other answering ${refused[0]?.body?.error?.code ?? 'nothing'}`);
}

/* ---------------------------------- main ----------------------------------- */

async function startServer({ port, workspace, ompBin = null, evaluatorDir = null }) {
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'server.mjs')], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      ASSESSMENT_WORKSPACE: workspace,
      MAX_CONCURRENT_JOBS: '0',
      ...(ompBin ? { OMP_BIN: ompBin, SMOKE_EVALUATOR_DIR: evaluatorDir } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  const ready = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`the server never listened: ${output.join('').slice(-400)}`)), 30_000);
    const read = (chunk) => {
      output.push(String(chunk));
      if (output.join('').includes('scriptaWorlds is running on')) {
        clearTimeout(deadline);
        resolve(true);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => reject(new Error(`the server exited with ${code}: ${output.join('').slice(-400)}`)));
  }).catch((error) => error);
  return { child, output, ready };
}

async function main(argv) {
  const options = { noBrowser: false, keepOpen: false, port: null, browser: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-browser') options.noBrowser = true;
    else if (arg === '--keep-open') options.keepOpen = true;
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--browser') options.browser = argv[++index];
    else {
      console.log(`Usage: node scripts/smoke-review-ui.mjs [--no-browser] [--keep-open] [--port N] [--browser PATH]`);
      process.exitCode = 2;
      return;
    }
  }
  const checkSeed = `smoke-${Date.now().toString(36)}`;
  const workspace = process.env.ASSESSMENT_WORKSPACE;
  console.log('scriptaWorlds — review smoke (no model budget, no check suite)');
  let createdId = null;
  let server = null;
  try {
    const seeded = await seed(checkSeed, (id) => { createdId = id; });
    seen(`a temporary book ${seeded.universe.id} was published with a selected-chapter review (${seeded.run.run_id}) and two reader responses, one of them historical`);
    const port = options.port ?? await freePort();
    // The server of the smoke is given its own evaluator, so the operator boundaries below can prove
    // what the host does with a child that fails or has to be stopped without spending model budget.
    const fake = await installFakeEvaluator(workspace);
    server = await startServer({ port, workspace, ompBin: fake.shim, evaluatorDir: fake.dir });
    if (server.ready !== true) {
      broken(String(server.ready.message ?? server.ready));
      process.exitCode = 1;
      return;
    }
    const base = `http://127.0.0.1:${port}`;
    console.log(`  · the server is up on ${base} over the store ${seeded.universe.id} (workspace ${workspace})`);
    if (options.keepOpen) {
      console.log(`  · open ${base}/?universe=${seeded.universe.id} — press Enter when the reader is done`);
      await new Promise((resolve) => process.stdin.once('data', resolve));
      return;
    }
    await httpPass(base, seeded);
    if (options.noBrowser) {
      console.log('  · the browser half was not run (--no-browser): the reader surface was not opened in a browser');
    } else {
      const executable = browserPath(options.browser);
      if (!executable) {
        console.log(`  · the browser half is SKIPPED: no Chromium found at ${BROWSER_CANDIDATES.join(', ')}`);
      } else {
        await browserPass(`${base}/?universe=${seeded.universe.id}`, seeded, executable);
      }
    }
    await boundaryPass(base, seeded);
  } finally {
    if (server?.child) {
      server.child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (createdId) await rm(universeDir(createdId), { recursive: true, force: true });
  }
  console.log(`\n${observations.length} observation(s), ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

// The review and feedback artifacts of a smoke belong outside the repository, and the host reads the
// workspace once at import: a run without one re-executes itself with a workspace of its own, the way
// `scripts/check.mjs` does, so the store of a developer is never touched and two smokes cannot race.
if (!process.env.ASSESSMENT_WORKSPACE) {
  const workspace = mkdtempSync(join(tmpdir(), 'smoke-review-workspace-'));
  const again = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ASSESSMENT_WORKSPACE: workspace }
  });
  rmSync(workspace, { recursive: true, force: true });
  process.exit(again.status ?? 1);
}

await main(process.argv.slice(2));

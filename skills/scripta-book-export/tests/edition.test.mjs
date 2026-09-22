// node --test suite for the edition acceptance path: the renderer binds every edition to the
// accepted version it was rendered from (`exports/edition-manifest.json`, schema
// `edition-manifest.v1`) and `scripts/verify-edition.mjs` accepts real renderer output, refuses a
// document that only looks like one, refuses a missing requested format, a document without its
// record and a chapter set with two files for one number, and marks an older edition historical. No
// external tool, no npm package, no model: the fixtures are temporary universes and the real CLIs.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadBook } from '../scripts/lib/book.mjs';
import { essentialCodes, resolveFonts } from '../scripts/lib/fonts.mjs';
import { layoutBook, usedFaces } from '../scripts/lib/layout.mjs';
import { verifyFile } from '../scripts/lib/verify.mjs';
import {
  acceptedVersionOf,
  exportsSnapshot,
  identityOf,
  makeTempDir,
  manifestOf,
  openFont,
  removeDir,
  runRenderer,
  runVerifier,
  sha256,
  subsetFace,
  writeFontFamily,
  writeUniverse,
} from './helpers.mjs';

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => removeDir(root)));
});

async function workspace(prefix) {
  const dir = await makeTempDir(prefix);
  roots.push(dir);
  return dir;
}

const CHAPTER =
  '# The First Chapter\n\n' +
  'A plain paragraph with Romanian diacritics ă â î ș ț and quotes „quoted”.\n\n' +
  '> A *quoted line* and one **emphasised word**.\n';

const OFFER = { teaser: 'What happens next', options: [{ label: 'go', prompt: 'the door opens' }] };

/** A universe with one chapter and its offer; `format` decides what the renderer is asked for. */
async function renderEdition(dir, { format = 'both', language = null } = {}) {
  const universe = await writeUniverse(dir, {
    id: 'edition-book',
    title: 'The Edition Book',
    language: 'en',
    chapters: { '0001-the-first-chapter.md': CHAPTER },
    offers: { '0001-offer.json': OFFER },
    threads: { version: 1, threads: [] },
    atlas: { version: 1, axes: [] },
  });
  const args = ['--universe', universe, '--format', format];
  if (language) args.push('--language', language);
  const run = await runRenderer(args, dir);
  assert.equal(run.code, 0, run.json?.error ?? run.stderr);
  return { universe, run };
}

test('the renderer records an edition manifest and the verifier accepts the produced edition', async () => {
  const dir = await workspace('edition-accept');
  try {
    const { universe, run } = await renderEdition(dir);

    // The single JSON line names the accepted version and the manifest, next to the documents.
    assert.equal(run.stdout.trim().split('\n').length, 1, 'stdout carries exactly one line');
    assert.match(run.json.source_version, /^sha256:[0-9a-f]{64}$/);
    assert.equal(run.json.source_version, await acceptedVersionOf(universe), '§8.2 over chapters, the offer, canon, threads and atlas');
    assert.equal(run.json.manifest, 'edition-manifest.json');

    const manifest = await manifestOf(universe);
    assert.equal(manifest.schema_version, 'edition-manifest.v1');
    assert.equal(manifest.universe_id, 'edition-book');
    assert.equal(manifest.format, 'both');
    assert.equal(manifest.language, 'en');
    assert.equal(manifest.source_version, run.json.source_version);
    assert.ok(!Number.isNaN(Date.parse(manifest.generated_at)));
    assert.deepEqual(manifest.documents.map((entry) => entry.format), ['pdf', 'docx']);
    assert.deepEqual(manifest.documents.map((entry) => entry.pages), [run.json.outputs[0].pages, null]);
    for (const [index, entry] of manifest.documents.entries()) {
      const bytes = await readFile(join(universe, 'exports', entry.path));
      assert.equal(entry.bytes, bytes.length, `${entry.format} is recorded with its size`);
      assert.equal(entry.sha256, sha256(bytes), `${entry.format} is recorded with its hash`);
      assert.equal(entry.sha256, run.json.outputs[index].sha256);
    }

    const before = await exportsSnapshot(universe);
    const verified = await runVerifier(['--universe', universe], dir);
    assert.equal(verified.code, 0, verified.stdout);
    assert.equal(verified.stdout.trim().split('\n').length, 1, 'stdout carries exactly one line');
    assert.equal(verified.json.schema_version, 'edition-verification.v1');
    assert.equal(verified.json.ok, true);
    assert.deepEqual(verified.json.errors, []);
    assert.deepEqual(verified.json.warnings, []);
    assert.deepEqual(verified.json.documents.map((entry) => entry.format), ['pdf', 'docx']);

    const [pdf, docx] = verified.json.documents;
    assert.equal(pdf.path, `exports/${manifest.documents[0].path}`);
    assert.ok(pdf.pages >= 1, 'the PDF page count is read from the file, not from the manifest');
    assert.equal(pdf.pages, manifest.documents[0].pages);
    assert.equal(pdf.source_version, manifest.source_version);
    assert.equal(pdf.historical, false);
    assert.equal(docx.pages, null);
    assert.equal(docx.historical, false);
    assert.equal((await stat(join(universe, docx.path))).size, docx.bytes);

    // The accepted DOCX is a real ZIP container with the Word parts, not a signature.
    const parsed = verifyFile(join(universe, docx.path), 'docx');
    assert.ok(parsed.paragraphs >= 1, 'the DOCX parses as OOXML with paragraphs');

    // The verifier is read-only: no name, no size and not one manifest byte changed.
    assert.equal(await exportsSnapshot(universe), before, 'the verifier wrote nothing');
  } finally {
    await removeDir(dir);
  }
});

test('a document that is not a readable document is refused, whatever its header says', async () => {
  const cases = [
    {
      what: 'a bare %PDF- header',
      format: 'pdf',
      damage: async (file) => writeFile(file, '%PDF-1.7\n'),
      match: /no startxref entry/,
    },
    {
      what: 'a text file under the PDF name',
      format: 'pdf',
      damage: async (file) => writeFile(file, 'this is a text file, not an edition\n'),
      match: /%PDF- header/,
    },
    {
      what: 'a truncated PDF',
      format: 'pdf',
      damage: async (file) => {
        const bytes = await readFile(file);
        await writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
      },
      match: /startxref|truncated|does not point at a cross-reference table/,
    },
    {
      what: 'a five-byte ZIP signature',
      format: 'docx',
      damage: async (file) => writeFile(file, Buffer.from('PK\x03\x04\x00', 'latin1')),
      match: /ZIP/,
    },
    {
      what: 'the PDF bytes under the DOCX name',
      format: 'docx',
      damage: async (file, paths) => writeFile(file, await readFile(paths.pdf)),
      match: /ZIP local file header/,
    },
  ];
  for (const scenario of cases) {
    const dir = await workspace('edition-damage');
    try {
      const { universe } = await renderEdition(dir);
      const manifest = await manifestOf(universe);
      const paths = Object.fromEntries(manifest.documents.map((entry) => [entry.format, join(universe, 'exports', entry.path)]));
      await scenario.damage(paths[scenario.format], paths);
      const before = await exportsSnapshot(universe);

      const verified = await runVerifier(['--universe', universe, '--format', scenario.format], dir);
      assert.equal(verified.code, 2, `${scenario.what}: exit 2`);
      assert.equal(verified.json.ok, false, scenario.what);
      assert.deepEqual(verified.json.documents, [], scenario.what);
      assert.equal(verified.json.errors.length >= 1, true, scenario.what);
      assert.equal(verified.json.errors[0].code, 'INVALID_EXPORT', scenario.what);
      assert.match(verified.json.errors[0].message, scenario.match, scenario.what);
      assert.equal(verified.stdout.trim().split('\n').length, 1, `${scenario.what}: one JSON line`);
      assert.equal(await exportsSnapshot(universe), before, `${scenario.what}: nothing was written`);
    } finally {
      await removeDir(dir);
    }
  }
});

test('a missing requested format is NO_EXPORT and a document without its record is MISSING_MANIFEST', async () => {
  const dir = await workspace('edition-missing');
  try {
    const { universe } = await renderEdition(dir, { format: 'pdf' });

    // A format the run never produced is a missing product, not an invalid one.
    const absent = await runVerifier(['--universe', universe, '--format', 'both'], dir);
    assert.equal(absent.code, 2);
    assert.deepEqual(absent.json.errors.map((entry) => [entry.code, entry.format]), [['NO_EXPORT', 'docx']]);
    assert.match(absent.json.errors[0].message, /No docx document was produced/);
    assert.deepEqual(absent.json.documents.map((entry) => entry.format), ['pdf'], 'the produced PDF is still verified');

    // A document with no manifest cannot be bound to a source version, so it is not accepted.
    await rm(join(universe, 'exports', 'edition-manifest.json'));
    const unrecorded = await runVerifier(['--universe', universe, '--format', 'pdf'], dir);
    assert.equal(unrecorded.code, 2);
    assert.equal(unrecorded.json.errors[0].code, 'MISSING_MANIFEST');
    assert.match(unrecorded.json.errors[0].message, /no edition-manifest\.json records it/);

    // A record that is present but unusable is refused as such.
    await writeFile(join(universe, 'exports', 'edition-manifest.json'), '{"schema_version":"edition-manifest.v2"}\n');
    const unusable = await runVerifier(['--universe', universe, '--format', 'pdf'], dir);
    assert.equal(unusable.code, 2);
    assert.equal(unusable.json.errors[0].code, 'INVALID_MANIFEST');
    assert.match(unusable.json.errors[0].message, /edition-manifest\.v2/);
  } finally {
    await removeDir(dir);
  }
});

test('two files for one chapter number leave no chapter set to bind the edition to', async () => {
  const dir = await workspace('edition-duplicate');
  try {
    const { universe } = await renderEdition(dir);
    await writeFile(join(universe, 'chapters', '0001-other-name.md'), '# Another First\n\nText.\n');

    const verified = await runVerifier(['--universe', universe], dir);
    assert.equal(verified.code, 2);
    assert.equal(verified.json.ok, false);
    const duplicate = verified.json.errors.find((entry) => entry.code === 'DUPLICATE_CHAPTER');
    assert.ok(duplicate, 'a duplicate chapter number is reported');
    assert.match(duplicate.message, /0001/);
    assert.match(duplicate.message, /0001-the-first-chapter\.md/);
    assert.match(duplicate.message, /0001-other-name\.md/);
  } finally {
    await removeDir(dir);
  }
});

test('an edition rendered from content that has changed is historical, not the current book', async () => {
  const dir = await workspace('edition-historical');
  try {
    const { universe, run } = await renderEdition(dir, { format: 'pdf' });
    const before = await acceptedVersionOf(universe);

    // The chapter is rewritten after the edition was produced: the edition is no longer current.
    await writeFile(join(universe, 'chapters', '0001-the-first-chapter.md'), `${CHAPTER}\nA new closing paragraph.\n`);
    const after = await acceptedVersionOf(universe);
    assert.notEqual(after, before);

    const verified = await runVerifier(['--universe', universe, '--format', 'pdf'], dir);
    assert.equal(verified.code, 0, 'an old edition is still a readable edition');
    assert.equal(verified.json.ok, true);
    assert.equal(verified.json.documents[0].historical, true);
    assert.equal(verified.json.documents[0].source_version, run.json.source_version);
    assert.deepEqual(verified.json.warnings.map((entry) => entry.code), ['HISTORICAL_EDITION']);
    assert.match(verified.json.warnings[0].message, /does not contain the current book/);

    // The same edition asked for as this run's product is not this run's product at all.
    const since = Date.now();
    const fresh = await runVerifier(['--universe', universe, '--format', 'pdf', '--since', String(since)], dir);
    assert.equal(fresh.code, 2);
    assert.deepEqual(fresh.json.errors.map((entry) => entry.code), ['NO_EXPORT']);
    assert.match(fresh.json.errors[0].message, /predates this run|written at or after --since/);
  } finally {
    await removeDir(dir);
  }
});

test('a requested language the manifest does not record is refused', async () => {
  const dir = await workspace('edition-language');
  try {
    const { universe } = await renderEdition(dir, { format: 'pdf' });
    const verified = await runVerifier(['--universe', universe, '--format', 'pdf', '--language', 'ro'], dir);
    assert.equal(verified.code, 2);
    assert.equal(verified.json.errors[0].code, 'INVALID_MANIFEST');
    assert.match(verified.json.errors[0].message, /"en"/);
    assert.match(verified.json.errors[0].message, /"ro"/);
  } finally {
    await removeDir(dir);
  }
});

test('a glyph only an emphasised run needs is not covered by a font family that lacks it', async () => {
  const dir = await workspace('edition-glyph');
  try {
    const nonLatin = 'П'; // a representative non-Latin character, used only inside the bold run
    const chapter =
      '# The First Chapter\n\n' +
      'A plain paragraph with Romanian diacritics ă â î ș ț and quotes „quoted”.\n\n' +
      `A line where only **${nonLatin}** is emphasised.\n`;
    const universe = await writeUniverse(dir, {
      id: 'glyph-edition',
      title: 'The Edition Book',
      language: 'en',
      chapters: { '0001-the-first-chapter.md': chapter },
    });

    // The fixture faces are the real serif faces, cut down to the characters this book needs.
    const book = loadBook(universe);
    const system = resolveFonts(null, (faces) => usedFaces(layoutBook(book, faces)));
    const regular = openFont(system.files.regular);
    const bold = openFont(system.files.bold);
    const codes = new Set([...essentialCodes(), ...[...`${chapter}The Edition Book`].map((ch) => ch.codePointAt(0))]);
    const without = (set, drops) => new Set([...set].filter((code) => !drops.includes(code)));

    const covering = join(dir, 'covering-fonts');
    await writeFontFamily(covering, {
      Regular: subsetFace(regular, codes),
      Bold: subsetFace(bold, codes),
    });
    const narrow = join(dir, 'narrow-fonts');
    await writeFontFamily(narrow, {
      Regular: subsetFace(regular, codes),
      Bold: subsetFace(bold, without(codes, [nonLatin.codePointAt(0)])),
    });
    const diacriticFree = join(dir, 'diacritic-fonts');
    await writeFontFamily(diacriticFree, {
      Regular: subsetFace(regular, without(codes, [0x0219])),
      Bold: subsetFace(bold, codes),
    });

    // A family whose faces cover their own characters is accepted, by the renderer and the verifier.
    const covered = await runRenderer(['--universe', universe, '--format', 'pdf', '--fonts', covering], dir);
    assert.equal(covered.code, 0, covered.json.error ?? covered.stderr);
    const coveredVerified = await runVerifier(['--universe', universe, '--format', 'pdf', '--fonts', covering], dir);
    assert.equal(coveredVerified.code, 0, coveredVerified.stdout);

    // The bold face is the only one that renders the emphasised run, and it has no glyph for it:
    // the regular face covering the Latin essentials must not be enough.
    const refused = await runRenderer(['--universe', universe, '--format', 'pdf', '--fonts', narrow], dir);
    assert.equal(refused.code, 1, 'the renderer refuses an edition with a missing glyph');
    assert.equal(refused.json.code, 'MISSING_FONT');
    assert.match(refused.json.error, /bold face/);
    assert.match(refused.json.error, /U\+041F/);
    const refusedVerified = await runVerifier(['--universe', universe, '--format', 'pdf', '--fonts', narrow], dir);
    assert.equal(refusedVerified.code, 2, 'the verifier refuses it too, before claiming success');
    assert.equal(refusedVerified.json.errors[0].code, 'MISSING_FONT');
    assert.match(refusedVerified.json.errors[0].message, /U\+041F/);
    assert.match(refusedVerified.json.errors[0].message, /bold face/);

    // A missing Romanian diacritic is named the same way.
    const diacritics = await runVerifier(['--universe', universe, '--format', 'pdf', '--fonts', diacriticFree], dir);
    assert.equal(diacritics.code, 2);
    assert.equal(diacritics.json.errors[0].code, 'MISSING_FONT');
    assert.match(diacritics.json.errors[0].message, /U\+0219/);
    assert.match(diacritics.json.errors[0].message, /regular face/);
  } finally {
    await removeDir(dir);
  }
});

test('an invalid invocation or an unusable universe is a usage failure with one JSON line', async () => {
  const dir = await workspace('edition-usage');
  try {
    const { universe } = await renderEdition(dir, { format: 'pdf' });
    const cases = [
      { args: ['--universe', universe, '--nonsense'], code: 'USAGE' },
      { args: ['--universe', universe, '--format', 'epub'], code: 'USAGE' },
      { args: ['--universe', universe, '--since', 'yesterday'], code: 'USAGE' },
      { args: ['--universe', universe, '--language', 'not a language'], code: 'USAGE' },
      { args: ['--universe'], code: 'USAGE' },
      { args: [], code: 'USAGE' },
      { args: ['--universe', join(dir, 'nowhere')], code: 'MISSING_UNIVERSE' },
    ];
    for (const scenario of cases) {
      const run = await runVerifier(scenario.args, dir);
      assert.equal(run.code, 2, scenario.args.join(' '));
      assert.equal(run.json.schema_version, 'edition-verification.v1');
      assert.equal(run.json.ok, false);
      assert.equal(run.json.errors[0].code, scenario.code, scenario.args.join(' '));
      assert.deepEqual(run.json.documents, []);
      assert.equal(run.stdout.trim().split('\n').length, 1, `${scenario.args.join(' ')}: one JSON line`);
    }

    // The identity an edition is bound to covers the whole accepted version, not the chapter set
    // alone: a manifest that only hashed the chapters would not match the universe it came from.
    const manifest = await manifestOf(universe);
    const chapterBytes = await readFile(join(universe, 'chapters', '0001-the-first-chapter.md'));
    const chaptersOnly = identityOf([
      { path: 'chapters/0001-the-first-chapter.md', sha256: sha256(chapterBytes), bytes: chapterBytes.length },
    ]);
    assert.notEqual(chaptersOnly, manifest.source_version);
    assert.equal(manifest.source_version, await acceptedVersionOf(universe));
  } finally {
    await removeDir(dir);
  }
});

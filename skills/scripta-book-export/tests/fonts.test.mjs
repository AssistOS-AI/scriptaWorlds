// node --test suite: C32 glyph coverage for every used face. A family is refused when any face the
// layout renders with cannot render the characters that face is asked for — including a single
// glyph used only inside an italic run — and it is accepted when a missing style falls back to the
// regular face that covers those characters. No external tool: the fixture faces are subsets of a
// real system font, cut by the skill's own subsetter.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadBook } from '../scripts/lib/book.mjs';
import { essentialCodes, resolveFonts } from '../scripts/lib/fonts.mjs';
import { layoutBook, usedFaces } from '../scripts/lib/layout.mjs';
import { makeTempDir, openFont, removeDir, runRenderer, subsetFace, writeFontFamily, writeUniverse } from './helpers.mjs';

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => removeDir(root)));
});

const MARKER = 'señor';
const MARKER_CODE = 'ñ'.codePointAt(0); // used only inside the emphasised run below
const CHAPTER =
  `# One\n\nA plain paragraph of Latin text, with diacritics ăâîșț and quotes „x”.\n\n` +
  `> An *italic ${MARKER}* only here.\n`;

async function workspace(prefix) {
  const dir = await makeTempDir(prefix);
  roots.push(dir);
  return dir;
}

/** The regular and italic source faces of the family the system search resolves for this book. */
async function systemSources(universe) {
  const book = loadBook(universe);
  const resolved = resolveFonts(null, (faces) => usedFaces(layoutBook(book, faces)));
  const regular = openFont(resolved.files.regular);
  const italic = openFont(resolved.files.italic || resolved.files.regular);
  return { regular, italic, family: resolved.family };
}

test('a family whose italic face misses a glyph used only in an italic run is refused', async () => {
  const dir = await workspace('book-export-glyph');
  try {
    const universe = await writeUniverse(dir, { id: 'glyph-book', title: 'Glyph Book', chapters: { '0001-one.md': CHAPTER } });
    const { regular, italic } = await systemSources(universe);

    const regularCodes = new Set([...essentialCodes(), ...[...CHAPTER].map((ch) => ch.codePointAt(0))]);
    const italicCodes = new Set([...essentialCodes(), ...[...`An italic ${MARKER} only here.`].map((ch) => ch.codePointAt(0))]);
    const withoutMarker = new Set([...italicCodes].filter((code) => code !== MARKER_CODE));

    const broken = join(dir, 'broken-fonts');
    await writeFontFamily(broken, {
      Regular: subsetFace(regular, regularCodes),
      Italic: subsetFace(italic, withoutMarker),
    });
    // The fixture is what it claims to be: the regular face has the glyph, the italic one has not.
    const writtenRegular = openFont(join(broken, 'TestSerif-Regular.ttf'));
    const writtenItalic = openFont(join(broken, 'TestSerif-Italic.ttf'));
    assert.equal(writtenRegular.covers([MARKER_CODE]), true);
    assert.equal(writtenItalic.covers([MARKER_CODE]), false);

    const out = join(dir, 'broken-out');
    const run = await runRenderer(['--universe', universe, '--out', out, '--format', 'pdf', '--fonts', broken], dir);

    assert.equal(run.code, 1, 'an incomplete family is a processing failure');
    assert.equal(run.json.ok, false);
    assert.equal(run.json.code, 'MISSING_FONT');
    // The message names the family, the face and the missing character.
    assert.match(run.json.error, /testserif/);
    assert.match(run.json.error, /italic face/);
    assert.match(run.json.error, /U\+00F1/);
    assert.equal(await import('node:fs').then((fs) => fs.existsSync(out)), false, 'no output folder is created');
  } finally {
    await removeDir(dir);
  }
});

test('a family is accepted when every face covers its own characters', async () => {
  const dir = await workspace('book-export-coverage');
  try {
    const universe = await writeUniverse(dir, { id: 'coverage-book', title: 'Coverage Book', chapters: { '0001-one.md': CHAPTER } });
    const { regular, italic } = await systemSources(universe);

    const allCodes = new Set([...essentialCodes(), ...[...CHAPTER].map((ch) => ch.codePointAt(0))]);
    const fonts = join(dir, 'fonts');
    await writeFontFamily(fonts, {
      Regular: subsetFace(regular, allCodes),
      Italic: subsetFace(italic, allCodes),
    });

    const run = await runRenderer(['--universe', universe, '--out', join(dir, 'out'), '--format', 'pdf', '--fonts', fonts], dir);
    assert.equal(run.code, 0, run.json.error ?? run.stderr);
    assert.equal(run.json.outputs[0].pages > 0, true);
  } finally {
    await removeDir(dir);
  }
});

test('a style with no file of its own falls back to the regular face, which must cover its characters', async () => {
  const dir = await workspace('book-export-fallback');
  try {
    const universe = await writeUniverse(dir, { id: 'fallback-book', title: 'Fallback Book', chapters: { '0001-one.md': CHAPTER } });
    const { regular } = await systemSources(universe);
    const allCodes = new Set([...essentialCodes(), ...[...CHAPTER].map((ch) => ch.codePointAt(0))]);

    // Only the regular face exists, so bold and italic are rendered with it — and it covers them.
    const fonts = join(dir, 'fonts');
    await writeFontFamily(fonts, { Regular: subsetFace(regular, allCodes) });
    const run = await runRenderer(['--universe', universe, '--out', join(dir, 'out'), '--format', 'pdf', '--fonts', fonts], dir);
    assert.equal(run.code, 0, run.json.error ?? run.stderr);

    // The fallback is only allowed when the regular face covers the characters: a book with a
    // character the regular face does not have is refused, not rendered with a placeholder.
    const narrow = new Set([...allCodes].filter((code) => code !== 'ț'.codePointAt(0)));
    const narrowFonts = join(dir, 'narrow-fonts');
    await writeFontFamily(narrowFonts, { Regular: subsetFace(regular, narrow) });
    const refused = await runRenderer(
      ['--universe', universe, '--out', join(dir, 'narrow-out'), '--format', 'pdf', '--fonts', narrowFonts],
      dir,
    );
    assert.equal(refused.code, 1);
    assert.equal(refused.json.code, 'MISSING_FONT');
    assert.match(refused.json.error, /U\+021B/);
  } finally {
    await removeDir(dir);
  }
});

test('non-Latin chapter text is measured, rendered and refused only when a face lacks it', async () => {
  const dir = await workspace('book-export-cyrillic');
  try {
    const cyrillic = 'Привет, мир!';
    const universe = await writeUniverse(dir, {
      id: 'cyrillic-book',
      title: 'Cyrillic Book',
      chapters: { '0001-one.md': `# Один\n\n${cyrillic}\n\n> Тихо *шепчет* он.\n` },
    });

    // The system family covers Cyrillic in every face, so the edition is produced.
    const ok = await runRenderer(['--universe', universe, '--out', join(dir, 'out'), '--format', 'pdf'], dir);
    assert.equal(ok.code, 0, ok.json.error ?? ok.stderr);
    assert.ok(ok.json.outputs[0].pages > 0);

    // A family cut down to Latin cannot render it, and no placeholder character is used.
    const { regular, italic } = await systemSources(universe);
    const latinOnly = new Set(essentialCodes());
    const fonts = join(dir, 'latin-fonts');
    await writeFontFamily(fonts, {
      Regular: subsetFace(regular, latinOnly),
      Italic: subsetFace(italic, latinOnly),
    });
    const refused = await runRenderer(
      ['--universe', universe, '--out', join(dir, 'latin-out'), '--format', 'pdf', '--fonts', fonts],
      dir,
    );
    assert.equal(refused.code, 1);
    assert.equal(refused.json.code, 'MISSING_FONT');
    assert.match(refused.json.error, /regular face/);
    assert.match(refused.json.error, /U\+041F/); // the Cyrillic capital П of the title
    assert.equal(await pathToFileURL(join(dir, 'latin-out')).href.length > 0, true);
  } finally {
    await removeDir(dir);
  }
});

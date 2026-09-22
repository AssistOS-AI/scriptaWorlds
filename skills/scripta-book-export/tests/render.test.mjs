// node --test suite: the real renderer produces a verified PDF and DOCX and its single JSON line
// carries the edition keys plus the chapter inventory and the §8.2 `source_version` of the accepted
// content the edition was rendered from. No external tool, no npm package.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { verifyFile } from '../scripts/lib/verify.mjs';
import { acceptedVersionOf, makeTempDir, removeDir, runRenderer, sha256, writeUniverse } from './helpers.mjs';

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => removeDir(root)));
});

async function workspace(prefix) {
  const dir = await makeTempDir(prefix);
  roots.push(dir);
  return dir;
}

test('the renderer writes a verified PDF and DOCX and reports the chapter inventory and source version', async () => {
  const dir = await workspace('book-export-render');
  try {
    const skip = 'liniuță';
    const universe = await writeUniverse(dir, {
      title: 'The Test Book',
      language: 'ro',
      chapters: {
        '0001-the-first.md': `# The First\n\nUn paragraf cu diacritice: ăâîșț „citește” — ${skip}.\n\n> Un citat.\n`,
        '0002-the-second.md': '# The Second\n\nAl doilea capitol, cu *cursiv*.\n',
      },
      edition: { title: 'The Test Book', subtitle: 'Two episodes', author: 'scriptaWorlds · ALA', dedication: 'Pentru cititori.' },
    });
    const out = join(dir, 'out');

    const run = await runRenderer(['--universe', universe, '--out', out, '--format', 'both'], dir);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout.trim().split('\n').length, 1, 'stdout carries exactly one line');

    // The keys the contract already had (§3) are unchanged.
    const report = run.json;
    assert.equal(report.ok, true);
    assert.equal(report.title, 'The Test Book');
    assert.equal(report.chapters, 2);
    assert.ok(report.words > 0);
    assert.deepEqual(report.outputs.map((entry) => entry.format), ['pdf', 'docx']);

    // The inventory names the ordered chapters with the hash and the size of the files it read.
    assert.deepEqual(report.chapterInventory.map((entry) => entry.number), [1, 2]);
    assert.deepEqual(report.chapterInventory.map((entry) => entry.path), [
      'chapters/0001-the-first.md',
      'chapters/0002-the-second.md',
    ]);
    for (const entry of report.chapterInventory) {
      const bytes = await readFile(join(universe, entry.path));
      assert.equal(entry.bytes, bytes.length);
      assert.equal(entry.sha256, sha256(bytes));
    }
    assert.match(report.source_version, /^sha256:[0-9a-f]{64}$/);
    assert.equal(
      report.source_version,
      await acceptedVersionOf(universe),
      'the source version is the §8.2 identity of the role files the edition was rendered from',
    );

    // Both produced files are readable: the verification path reads them back from disk.
    const [pdf, docx] = report.outputs;
    // The contract reports absolute paths (§3); the name is the slug and the build date.
    assert.equal(dirname(pdf.path), out);
    assert.match(basename(pdf.path), /^the-test-book-\d{8}\.pdf$/);
    assert.equal(dirname(docx.path), out);
    assert.match(basename(docx.path), /^the-test-book-\d{8}\.docx$/);
    for (const entry of report.outputs) {
      assert.equal((await stat(entry.path)).size, entry.bytes, `${entry.format} size matches the file on disk`);
    }
    const verifiedPdf = verifyFile(pdf.path, 'pdf');
    assert.ok(verifiedPdf.pages > 0);
    assert.equal(verifiedPdf.pages, pdf.pages);
    assert.equal(docx.pages, null);
    const verifiedDocx = verifyFile(docx.path, 'docx');
    assert.ok(verifiedDocx.paragraphs >= 1);
  } finally {
    await removeDir(dir);
  }
});

test('a changed chapter changes the source version, so the older edition is a different version', async () => {
  const dir = await workspace('book-export-identity');
  try {
    const chapters = { '0001-one.md': '# One\n\nThe first chapter.\n' };
    const universe = await writeUniverse(dir, { title: 'Bound Book', chapters });

    const first = await runRenderer(['--universe', universe, '--out', join(dir, 'out'), '--format', 'pdf'], dir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.chapters, 1);

    await writeUniverse(dir, { title: 'Bound Book', chapters: { ...chapters, '0002-two.md': '# Two\n\nA new chapter.\n' } });
    const second = await runRenderer(['--universe', universe, '--out', join(dir, 'out'), '--format', 'pdf'], dir);
    assert.equal(second.code, 0, second.stderr);

    assert.deepEqual(second.json.chapterInventory.map((entry) => entry.number), [1, 2]);
    assert.notEqual(second.json.source_version, first.json.source_version);
  } finally {
    await removeDir(dir);
  }
});

test('an invalid invocation is refused with exit 2 and a structured JSON line', async () => {
  const dir = await workspace('book-export-usage');
  try {
    const universe = await writeUniverse(dir, { chapters: { '0001-one.md': '# One\n\nText.\n' } });

    for (const args of [
      ['--universe', universe, '--nonsense'],
      ['--universe', universe, '--format', 'epub'],
      ['--universe'],
      [],
    ]) {
      const run = await runRenderer(args, dir);
      assert.equal(run.code, 2, `exit 2 for ${args.join(' ')}`);
      assert.equal(run.json.ok, false);
      assert.ok(['USAGE'].includes(run.json.code), `code is USAGE for ${args.join(' ')}`);
      assert.equal(run.stdout.trim().split('\n').length, 1);
    }
  } finally {
    await removeDir(dir);
  }
});

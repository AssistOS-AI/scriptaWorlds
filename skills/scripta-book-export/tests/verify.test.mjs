// node --test suite: the verification path reads real produced editions and refuses files a reader
// could not open — a truncated PDF, a `%PDF-` header with nothing behind it, a ZIP signature on its
// own, a DOCX without `word/document.xml`, and containers whose local headers lie. No external tool.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { verifyDocx, verifyEdition, verifyFile, verifyPdf } from '../scripts/lib/verify.mjs';
import { makeTempDir, removeDir, runRenderer, storedZip, writeUniverse } from './helpers.mjs';

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => removeDir(root)));
});

const DOCUMENT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body><w:p><w:r><w:t>text</w:t></w:r></w:p></w:body></w:document>';

/** An otherwise plausible DOCX container built by hand, so a single part can be left out. */
function docxContainer(parts) {
  return storedZip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    ...parts,
  ]);
}

function assertRejected(callback, expected) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, expected.code, `code for: ${error.message}`);
    assert.equal(error.exitCode, expected.exitCode, `exit code for: ${error.message}`);
    if (expected.match) assert.match(error.message, expected.match);
    return true;
  });
}

test('a produced PDF and DOCX pass verification', async () => {
  const dir = await makeTempDir('book-export-verify');
  try {
    const universe = await writeUniverse(dir, {
      title: 'Verified Book',
      chapters: { '0001-one.md': '# One\n\nA chapter.\n\n> And a quote.\n' },
    });
    const run = await runRenderer(['--universe', universe, '--out', join(dir, 'out'), '--format', 'both'], dir);
    assert.equal(run.code, 0, run.stderr);
    const [pdf, docx] = run.json.outputs;

    const verifiedPdf = verifyFile(pdf.path, 'pdf');
    assert.deepEqual(verifiedPdf.format, 'pdf');
    assert.ok(verifiedPdf.objects > 0);
    assert.ok(verifiedPdf.pages > 0);
    assert.equal(verifiedPdf.pages, pdf.pages);
    assert.equal(verifiedPdf.bytes, pdf.bytes);

    const verifiedDocx = verifyFile(docx.path, 'docx');
    assert.deepEqual(verifiedDocx.format, 'docx');
    assert.ok(verifiedDocx.entries >= 5);
    assert.ok(verifiedDocx.paragraphs >= 1);
  } finally {
    await removeDir(dir);
  }
});

test('a damaged or hollow PDF is rejected with BAD_PDF and exit 1', async () => {
  const dir = await makeTempDir('book-export-bad-pdf');
  try {
    const universe = await writeUniverse(dir, { chapters: { '0001-one.md': '# One\n\nA chapter.\n' } });
    const run = await runRenderer(['--universe', universe, '--out', join(dir, 'out'), '--format', 'pdf'], dir);
    assert.equal(run.code, 0, run.stderr);
    const pdfPath = run.json.outputs[0].path;
    const pdf = await readFile(pdfPath);
    assert.ok(verifyPdf(pdf).pages > 0);

    // The header alone: a file that claims to be a PDF and contains nothing else.
    assertRejected(() => verifyPdf(Buffer.from('%PDF-1.7\n')), {
      code: 'BAD_PDF',
      exitCode: 1,
      match: /no startxref entry/,
    });

    // Truncated: the cross-reference table and the trailer are gone.
    assertRejected(() => verifyPdf(pdf.subarray(0, Math.floor(pdf.length / 2))), {
      code: 'BAD_PDF',
      exitCode: 1,
    });

    // A hole in the middle: the cross-reference entries no longer point at their objects.
    const holeStart = Math.floor(pdf.length / 3);
    const holed = Buffer.concat([pdf.subarray(0, holeStart), pdf.subarray(holeStart + 512)]);
    assertRejected(() => verifyPdf(holed), { code: 'BAD_PDF', exitCode: 1 });

    // Not a PDF at all.
    assertRejected(() => verifyPdf(Buffer.from('this is a text file, not an edition')), {
      code: 'BAD_PDF',
      exitCode: 1,
      match: /%PDF- header/,
    });
  } finally {
    await removeDir(dir);
  }
});

test('a damaged DOCX container is rejected with BAD_DOCX and exit 1', async () => {
  const dir = await makeTempDir('book-export-bad-docx');
  try {
    const signatureOnly = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4)]);
    assertRejected(() => verifyDocx(signatureOnly), { code: 'BAD_DOCX', exitCode: 1, match: /shorter than/ });

    // A ZIP whose members parse but which carries no document part.
    const withoutDocument = docxContainer([{ name: 'word/styles.xml', data: '<w:styles/>' }]);
    assertRejected(() => verifyDocx(withoutDocument), {
      code: 'BAD_DOCX',
      exitCode: 1,
      match: /word\/document\.xml/,
    });

    // The document part is present but its XML stops before the root element is closed.
    const truncatedDocument = docxContainer([
      { name: 'word/_rels/document.xml.rels', data: '<Relationships/>' },
      { name: 'word/document.xml', data: '<?xml version="1.0"?><w:document><w:body><w:p>' },
    ]);
    assertRejected(() => verifyDocx(truncatedDocument), { code: 'BAD_DOCX', exitCode: 1, match: /never closes/ });

    // A container whose local headers disagree with its central directory.
    const disagreeing = storedZip(
      [
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: DOCUMENT_XML },
      ],
      { crcOverride: 0x12345678 },
    );
    assertRejected(() => verifyDocx(disagreeing), { code: 'BAD_DOCX', exitCode: 1 });
  } finally {
    await removeDir(dir);
  }
});

test('a produced DOCX without word/document.xml is rejected, verified on disk', async () => {
  const dir = await makeTempDir('book-export-docx-file');
  try {
    const universe = await writeUniverse(dir, { chapters: { '0001-one.md': '# One\n\nText.\n' } });
    const run = await runRenderer(['--universe', universe, '--out', join(dir, 'out'), '--format', 'docx'], dir);
    assert.equal(run.code, 0, run.stderr);

    const file = join(dir, 'partial.docx');
    await writeFile(
      file,
      docxContainer([
        { name: 'word/_rels/document.xml.rels', data: '<Relationships/>' },
        { name: 'word/styles.xml', data: '<w:styles/>' },
      ]),
    );
    assertRejected(() => verifyFile(file, 'docx'), { code: 'BAD_DOCX', exitCode: 1, match: /word\/document\.xml/ });
  } finally {
    await removeDir(dir);
  }
});

test('an unknown format is a usage failure with exit 2', () => {
  assertRejected(() => verifyEdition(Buffer.from('anything'), 'epub'), { code: 'USAGE', exitCode: 2, match: /Unknown format/ });
  assertRejected(() => verifyEdition(Buffer.alloc(0), ''), { code: 'USAGE', exitCode: 2 });
});

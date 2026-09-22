# The extraction file — the fixed input of an import

This file is written by the host, not by you. It is the only place the book's prose comes from, so its shape is a contract: an import reads it, and an import that cannot read it is refused instead of guessed at.

## Where it lives

```
<universe>/.agents/import/extracted.json     the structured extraction
<universe>/.agents/import/book.md            the same prose as plain text, for reading
```

`.agents/` belongs to the host. Read both files; never write them. `book.md` carries exactly the text stored in `extracted.json` and exists so that a human can read the book comfortably; when the two ever disagree, `extracted.json` is the one that counts.

## The file, verbatim

```json
{
  "schema_version": "book-import.v1",
  "import_id": "20260922T155732-ab12",
  "source": { "filename": "book.pdf", "format": "pdf", "sha256": "<hex>", "bytes": 123456, "pages": 210 },
  "detected": { "title": "…", "author": "… or null", "language": "ro|en|null" },
  "chapters": [ { "number": 1, "title": "…", "words": 4210, "text": "the extracted prose, paragraphs separated by blank lines" } ],
  "warnings": [ "…" ]
}
```

## Field by field

| Field | Meaning |
| --- | --- |
| `schema_version` | Always `book-import.v1`. Any other value means this file was not written by the import pipeline, and the import is refused with `INVALID_IMPORT`. |
| `import_id` | The identifier of this upload, `<YYYYMMDDTHHMMSS>-<4 hex>`. It is copied into the import record so that a later turn can prove which upload it continued. |
| `source.filename`, `source.format` | The uploaded file and its kind (`pdf`, `docx`, `epub`, `txt`, …). Useful in reports; never a source of prose. |
| `source.sha256` | The hash of the uploaded file. The record repeats it, and the validator refuses a record that names another upload. |
| `source.bytes`, `source.pages` | Size, and for a PDF the examined page count. They exist so an operator can tell a truncated extraction from a complete one. |
| `detected.title` | The book's title as the host recognised it. |
| `detected.author` | The author, or `null` when the host did not find one. |
| `detected.language` | The language of the prose as a two-letter code, or `null` when the host could not tell. It decides the language of the state files, and a value that differs from `universe.json` is recorded and reported rather than acted on. |
| `chapters` | The chapters of the book, in order. `number` is the source chapter's own number; `title` may be `null` for front matter; `words` is the host's count; `text` is the extracted prose with paragraphs separated by blank lines. |
| `warnings` | What the host could not do: no detectable chapter boundaries, missing text layer on some pages, a truncated file. **A warning that says the book arrived as one chapter is your instruction to segment it yourself.** |

## What the host guarantees, and what it does not

The host guarantees that the file parses, that chapter numbers are unique, and that `text` is the prose it managed to read. It does not guarantee that chapters are the book's own divisions: when the book has none, the host produces one large chapter and says so in `warnings`. It also does not guarantee that a heading-only entry is absent: a part title or a blank page can arrive as a chapter whose `text` carries no words at all.

## Refusals on the host side

Before writing this file the host refuses the upload itself, throwing an error rather than writing a partial extraction: `IMPORT_UNSUPPORTED` (a format it cannot read), `IMPORT_TOO_LARGE` (above the size limit), `IMPORT_NO_TEXT` (no text layer at all — a scan of page images), `IMPORT_UNREADABLE` (the file cannot be opened or is corrupt). When you are called at all, one of those refusals has already happened or has not, and your job begins with the file that exists.

## What makes an extraction unusable for you

- It is absent, or it has no content: report `NO_EXTRACTION` and write nothing.
- It does not parse, or its `schema_version` is not `book-import.v1`, or a chapter entry has no `text` field: report the defect and write nothing.
- No chapter carries a single word: the book has no text layer, so there is nothing to copy. Report `NO_EXTRACTION` and write nothing. Prose is never invented to fill the gap.
- Its `chapters` is empty: the same answer, for the same reason.

An extraction with *some* empty chapters is usable: those are the headings and blank pages of the book, recorded in the import record's `skipped` list and not written as chapters. An extraction whose prose arrives as replacement characters (`�`) or in a script you cannot copy faithfully is unusable for another reason: report it and stop, because a half-copied book is worse than an unimported one.

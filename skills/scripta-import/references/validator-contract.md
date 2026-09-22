# The validator contract

`scripts/validate-import.mjs` is the machine-checkable half of this skill. It answers one question without spending model budget: *is the universe a faithful, complete import of the extraction it claims to come from, as far as a machine can tell?* The host runs it after every import turn and decides from its answer whether the turn is accepted.

It reads. It writes nothing, calls no model and reaches no network.

## The command

```sh
node skills/scripta-import/scripts/validate-import.mjs \
  --universe <universe-folder> --import <extracted.json> [--chapters <from>-<to>]
```

| Argument | Meaning |
| --- | --- |
| `--universe` | The universe folder, required. A folder that does not exist is a usage error. |
| `--import` | The extraction file. Optional: without it the validator reads `<universe>/.agents/import/extracted.json`, which is where the host writes it. |
| `--chapters` | Bounds the check to the extraction chapters one import turn covered, for example `--chapters 4-6` — the range the host planned and the range the record's own turn journal carries. Without it the whole import is checked. The range must be ascending, every chapter in it must be declared by the extraction, and every one of them must lie behind the continuation pointer (a range that reaches an unimported chapter is `MISSING_CHAPTER`). The cut segments of one source chapter always belong to the same range, because a range is expressed in extraction chapters. |

Inside a universe the same command is reached through the project symlink, which is how a turn calls it:

```sh
node .agents/skills/scripta-import/scripts/validate-import.mjs \
  --universe . --import .agents/import/extracted.json --chapters 4-6
```

## The envelope

Standard output carries exactly one JSON line and nothing else. Exit status is `0` when `ok` is `true` and `2` in every other case — a defect, an unusable universe, or bad arguments.

```json
{"schema_version":"book-import-validation.v1","ok":true,"code":null,"errors":[],"warnings":[],
 "universe":"/abs/path/universe","extraction":"/abs/path/universe/.agents/import/extracted.json",
 "import_id":"20260922T155732-ab12","source":{"filename":"book.pdf","sha256":"…"},
 "segmentation":"host","start_chapter":1,"last_imported_chapter":2,"range":"1-2","complete":false,
 "next_source_chapter":3,"chapters_checked":2,"words_checked":263}
```

| Field | Meaning |
| --- | --- |
| `schema_version` | `book-import-validation.v1`. |
| `ok` | `true` only when `errors` is empty. Warnings never change it. |
| `code` | The most severe code among the errors, or `null`. The order, most severe first, is `NO_EXTRACTION`, `UNPARSEABLE_JSON`, `INVALID_IMPORT`, `MISSING_CHAPTER`, `WORD_COVERAGE`; `USAGE` is used only for bad arguments. |
| `errors` | One `<CODE>: <message>` string per defect, each naming the file, the chapter or the extraction chapter it belongs to. |
| `warnings` | What does not refuse the import: see the table below. |
| `universe`, `extraction` | The absolute paths that were read. |
| `import_id`, `source`, `segmentation`, `start_chapter`, `last_imported_chapter`, `complete`, `next_source_chapter` | What the import record says, echoed so a caller can act without reading the record itself. |
| `range` | `"from-to"` over extraction chapter numbers when `--chapters` was given, `null` otherwise. |
| `chapters_checked`, `words_checked` | How much prose was actually measured. |

## The codes

| Code | Meaning | What it means for the host |
| --- | --- | --- |
| `NO_EXTRACTION` | The extraction file is absent, empty, or holds no word of prose at all. This is the scan without a text layer. | Refuse the import; nothing can be imported and nothing may be invented. |
| `UNPARSEABLE_JSON` | A file that must be JSON does not parse: the extraction, `drafts/import-progress.json`, `threads.json` or `atlas.json`. | Refuse the turn; the file has to be rewritten before anything can be judged. |
| `INVALID_IMPORT` | The import record is absent, malformed, or contradicts itself or the extraction: another upload, a chapter number with a hole, a turn whose range does not match the chapters it lists, a continuation pointer that does not follow, a source chapter imported and skipped at once, a chapter that carries no prose, a record that claims `complete` while chapters remain, a record entry whose title is not the title of its file, a chapter file that does not begin with `# Title`, canon without its sections, a thread or atlas reference to a chapter that does not exist. | Refuse the turn and repair the record; the book state is not describable. |
| `MISSING_CHAPTER` | A chapter the record claims is not on disk, two files carry one chapter number, a file has another name than the record says, or the checked range names an extraction chapter that the extraction does not declare or that the import has not reached. | Refuse the turn; the chapter set is not intact. A duplicate number is refused rather than resolved: there is no single chapter set to bind an edition to. |
| `WORD_COVERAGE` | A chapter's words are not plausible against its extraction chapter: the count falls outside 0.8×–1.2× (plus 20 words of slack), or the eight-word run overlap is below 85% in either direction. | Refuse the turn. Either the chapter was cut short or padded, or it is not the book's prose. |
| `USAGE` | The arguments are wrong: a missing `--universe`, an unreadable folder, an unknown flag, a malformed `--chapters`. | The host called the command incorrectly; nothing was checked. |

Precedence matters when several defects appear at once: `NO_EXTRACTION` and `UNPARSEABLE_JSON` are decided before anything else is read, so a broken universe with a missing extraction is reported as `NO_EXTRACTION`. Everything after that is reported together in `errors`, and `code` names the most severe of them.

`NO_EXTRACTION` and a broken extraction stop the run: nothing else is checked, because there is no text to check against. A record that does not parse or does not hold together also stops the run. Chapter and state defects are collected together in one answer.

## The warnings

| Warning | Meaning |
| --- | --- |
| `TURN_OVERSIZE` | A recorded turn covered more than 3 extraction chapters or more than 6,000 words of prose. The import stays valid; the turns are larger than the guide prescribes. |
| `SEGMENT_OFF_BAND` | A non-final segment of a chapter that was cut by word count is outside 1,500–2,500 words. The cut is declared, but not the one the segmentation guide describes. |
| `LANGUAGE_MISMATCH` | The book's detected language differs from `universe.json`. The prose and the state stay in the book's language; the metadata is for the operator to settle. |
| `EXTRACTION_WORD_MISMATCH` | The extraction's own `words` field disagrees with the words of its `text` by more than 10%. The validator uses the text, and reports that the host's count is off. |
| `UNIVERSE_UNREADABLE` | `universe.json` could not be read, so the law and the language were not checked. |

## What it proves, and what it does not

It proves, without a model:

- the extraction exists, parses and declares prose;
- the import record exists, parses, and agrees with the extraction on the upload it came from;
- the chapter files the record names exist once, in one contiguous run from the import's start, each beginning with its `# Title` and carrying the title the record says;
- the words of every imported chapter are plausible against its extraction chapter in quantity *and* in sequence (the run overlap is a real check that the prose was copied, not written);
- the state files exist, parse and cite chapters that exist, and the canon carries its sections;
- the import is marked as such, in a machine-readable place: `drafts/import-progress.json`.

It does not prove:

- that the cleaning kept every sentence — a paragraph silently dropped inside the band passes the count and lowers the overlap only slightly (a real loss shows up as a lower overlap, a wholesale rewrite as a much lower one);
- that a canon line is true of the book, that a thread is the right thread, or that the atlas state is well judged: those are readings of prose, and no deterministic check settles them;
- that the segmentation chosen for a boundaryless book is the one the book itself would have used: the record declares it, and a declared approximation is all anyone can honestly claim.

## What the host may rely on

- The last line on standard output is the envelope, always — also on a usage error — so a caller can parse it without inspecting the exit status.
- Exit `0` means the checked range holds; exit `2` means it does not and `errors` says why.
- With `--chapters 1-3` an import of a twelve-chapter book passes while extraction chapters 4 to 12 are not imported yet: the range decides what is checked, and `complete: false` with `next_source_chapter: 4` is a coherent state, not a defect.
- A range is expressed in extraction chapters, so a host that planned a window with `schema/import.v1.json` passes exactly that window, whether a chapter was skipped or cut.
- Nothing is written, so the command is safe to run as often as the host likes.

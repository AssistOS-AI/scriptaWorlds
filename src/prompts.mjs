// The three prompt families of a turn: a new chapter, a rewrite of an existing one, and the printed
// edition. A chapter turn asks for the next chapter and an up-to-date canon; a rewrite turn carries
// the old text and gives the reader's complaint priority; an export turn asks for the editorial
// metadata and one renderer run.
import { DEFAULT_LANGUAGE, languageLabel } from './config.mjs';
import { elementLines } from './periodic.mjs';
import { pad, truncate } from './io.mjs';

export function buildChapterPrompt({ title, law = '', language = DEFAULT_LANGUAGE, chapterNumber, message, minWords, maxWords, needsTitle = false, elements = [], contextChapters = [], omittedChapters = [], directions = [] }) {
  const languageName = languageLabel(language);
  const titleDuty = needsTitle
    ? `NAMING DUTY: this universe has no name yet. After the chapter, write a SHORT name to
\`universe-title.txt\` (in ${languageName}): 4 or 5 words, like a book title the reader will see in the
header — a name, not a sentence, no colon, no full stop, no description of the law. Example of the right
shape: "The Green Journal Farm", "Nine Names in the Quiet".

`
    : '';
  // The recipe the universe is a compound of: the reader picked it when the book was created.
  const elementsBlock = elements.length
    ? `INGREDIENTS OF THIS WORLD (Periodic Table of Ideas — this world is a compound, not a single idea)
${elementLines(elements).join('\n')}

A chapter may develop one of these operations, or the friction between two of them; it never invents a
new fundamental operation without recording it in \`canon.md\` first.

`
    : '';
  const lawBlock = law.trim()
    ? `FUNDAMENTAL LAW OF THIS UNIVERSE (inviolable)
"""
${law.trim()}
"""
Every important event in the chapter is a consequence of that law; never break it and never introduce
another fundamental law without a cause already established in canon. Civilisations, technologies and
conflicts are effects of the law, not decoration.

`
    : '';
  const contextList = contextChapters.length
    ? ` — and only these: ${contextChapters.map((file) => `\`${file}\``).join(', ')}`
    : ', when they exist';
  const omittedNote = omittedChapters.length
    ? ` (chapters ${omittedChapters.join(', ')} are earlier context, not the immediate narrative; read one only when the request needs it)`
    : '';
  const directionsBlock = directions.length
    ? `APPROVED DIRECTIONS (accepted by the author in a separate design phase, for this chapter)
${directions.map((direction, index) => `${index + 1}. ${direction}`).join('\n')}

These are instructions, not suggestions to discuss: follow them where they apply to this episode, keep the
fundamental law and the accepted canon above them, and say in your final report which of them you used.

`
    : '';
  return `You are ALA, the narrative agent of the universe "${title}" — a science-fiction book written in ${languageName}.

${lawBlock}${elementsBlock}${directionsBlock}${titleDuty}Fiction language: **${languageName}** (code \`${language}\`). All narrative text — chapter title, prose, dialogue,
place names — is written in ${languageName}. Keep the schema vocabulary (plan keys, canon section names,
JSON field names) and your final report to the system in English.

READER REQUEST
"""
${message.trim()}
"""

TASK
Write chapter ${chapterNumber} of the book and keep canon up to date. This episode is a piece of a life,
not a demonstration of the law: honour a quiet request without manufacturing a crisis, and let ordinary
affection, work and aftermath matter as much as a revelation.

MANDATORY STEPS
1. Read \`skill://scripta-ala\` and follow it exactly (narrative rules, StoryPlan, limits on new names and concepts).
2. Read, in this order: \`universe.json\` (fundamental law), \`charter.md\`, \`canon.md\`, \`threads.json\`, \`atlas.json\`, then these accepted chapters${contextList}${omittedNote}. The \`chapters/NNNN-offer.json\` files are your voice to the reader, not narrative context: do not read them. If you need an earlier passage for an object, a promise or a relationship, read that specific chapter file; do not read the whole book. Do not ask for extra context.
3. Write the chapter to \`chapters/${pad(chapterNumber)}-<slug>.md\` (slug: lowercase letters, digits, hyphens; first line is \`# Chapter title\`). The chapter answers the reader request and closes at least one old promise, if any exists.
4. Length target: ${minWords}–${maxWords} words. Narration only: no notes, no plan, no meta commentary in the file.
5. Update \`canon.md\` (sections: fundamental laws, world, recurring characters, timeline, stable facts, mysteries with a fixed cause), \`threads.json\` (open, closed, promises, deferred answers) and \`atlas.json\` (axes and nodes touched, state: mentioned/dramatized/decision/recontextualized). Text values in those files are written in ${languageName}.
6. Write \`chapters/${pad(chapterNumber)}-offer.json\` — your direct voice to the reader, in ${languageName}:
   \`{"teaser": "2–3 sentences that close the episode, show what changed and leave a question that makes the reader curious", "options": [{"label": "at most 6 words", "prompt": "the exact request, phrased as an instruction that can be sent as it is"}, {"label": "…", "prompt": "…"}]}\`
   2–3 concrete options specific to this episode (no generic choices such as "continue"), at least one that follows the main thread still open. No spoilers, no repeating what the text already shows.
7. Do not modify \`universe.json\`, \`charter.md\` or \`turns/\`; do not run \`git\`; do not leave the current folder.

FINAL REPLY (3-6 lines, in English)
- the chapter title and the file you wrote;
- what changed in canon;
- which promise was closed and which thread stays open.`;
}

export function buildExportPrompt({ title, law = '', language = DEFAULT_LANGUAGE, chapterCount, message, format }) {
  const languageName = languageLabel(language);
  return `TASK
Prepare the printed edition of the book in this folder: the universe "${title}", ${chapterCount} chapters.
Every chapter is a consequence of the universe's fundamental law${law.trim() ? `:\n"""\n${law.trim()}\n"""` : '.'}

Edition language: **${languageName}** (code \`${language}\`). Title, subtitle, dedication, preface and afterword
are written in ${languageName}, in the same register as the existing narrative text.

MANDATORY STEPS
1. Read \`skill://scripta-book-export\` and follow it.
2. Read \`universe.json\` and the chapter titles in \`chapters/\`.
3. Check and complete \`exports/edition.json\` exactly as \`skill://scripta-book-export\` requires: keep what already exists and fill in only the gaps. \`title\` is the only mandatory field; \`subtitle\`, \`author\`, \`year\`, \`dedication\`, \`preface\` and \`afterword\` are optional, written in ${languageName} when you do add them, grounded in the actual chapters of this edition, and short. A preface or an afterword must add no spoiler that defuses the plot; leaving either out is correct when the book does not call for it. You may add \`"language": "${language}"\`.
4. Run exactly: \`node .agents/skills/scripta-book-export/scripts/build-book.mjs --universe . --format ${format}\`
5. Check the JSON line printed by the script and that the files exist in \`exports/\`. If something is missing, fix it and run again.

READER REQUEST
"""
${message.trim()}
"""

FINAL REPLY: the list of produced files (name, format, pages, size) and one sentence about the edition.`;
}

export function buildRewritePrompt({
  title,
  law = '',
  language = DEFAULT_LANGUAGE,
  chapterNumber,
  previousText,
  instructions,
  minWords,
  maxWords,
  laterChapters = [],
  elements = [],
  contextChapters = [],
  omittedChapters = [],
  directions = [],
  findings = [],
  preserve = []
}) {
  const languageName = languageLabel(language);
  // The recipe the universe is a compound of: the reader picked it when the book was created.
  const elementsBlock = elements.length
    ? `INGREDIENTS OF THIS WORLD (Periodic Table of Ideas — this world is a compound, not a single idea)
${elementLines(elements).join('\n')}

A chapter may develop one of these operations, or the friction between two of them; it never invents a
new fundamental operation without recording it in \`canon.md\` first.

`
    : '';
  const lawBlock = law.trim()
    ? `FUNDAMENTAL LAW OF THIS UNIVERSE (inviolable)
"""
${law.trim()}
"""

`
    : '';
  const contextList = contextChapters.length
    ? ` — and only these: ${contextChapters.map((file) => `\`${file}\``).join(', ')}`
    : ', when they exist';
  const omittedNote = omittedChapters.length
    ? ` (chapters ${omittedChapters.join(', ')} are earlier context, not the immediate narrative; read one only when the feedback needs it)`
    : '';
  // What an external review reported and the author chose to act on, with the qualities to keep. One
  // candidate version, one pass: a revision is not an invitation to rewrite the book around it.
  const findingsBlock = findings.length
    ? `SELECTED FINDINGS (reported by a separate review, chosen by the author; each names its own evidence)
${findings.map((finding, index) => {
  const evidence = finding.evidence?.length ? ` — evidence: ${finding.evidence.map((item) => `"${item}"`).join(' | ')}` : '';
  return `${index + 1}. ${finding.id}${finding.claim ? `: ${finding.claim}` : ''}${evidence}`;
}).join('\n')}

Address these findings in one candidate version of the chapter; do not start a second pass and do not
rewrite chapters other than this one. In your final report, name each finding you addressed and how.
`
    : '';
  const preserveBlock = preserve.length
    ? `KEEP WHAT THE AUTHOR VALUES (do not trade these away for a cleaner fix)
${preserve.map((item) => `- ${item}`).join('\n')}

`
    : '';
  const laterBlock = laterChapters.length
    ? `Chapters ${laterChapters.join(', ')} no longer exist: they were removed together with this rewrite, so do not continue or reference them.\n`
    : '';
  const directionsBlock = directions.length
    ? `APPROVED DIRECTIONS (accepted by the author in a separate design phase, for this rewrite)
${directions.map((direction, index) => `${index + 1}. ${direction}`).join('\n')}

`
    : '';
  return `You are ALA, the narrative agent of the universe "${title}" — a science-fiction book written in ${languageName}.

${lawBlock}${elementsBlock}${directionsBlock}READER FEEDBACK (what is wrong and what must change) — mandatory and takes priority:
"""
${instructions.trim()}
"""

${findingsBlock}${preserveBlock}

TASK
Rewrite chapter ${chapterNumber} of the book, in ${languageName}, as a better version. ${laterBlock}
MANDATORY STEPS
1. Read \`skill://scripta-ala\` and follow it, then \`universe.json\`, \`charter.md\`, \`canon.md\`, \`threads.json\`, \`atlas.json\`, then these accepted chapters${contextList}${omittedNote}. The \`chapters/NNNN-offer.json\` files are your voice to the reader, not narrative context: do not read them.
2. The OLD text of chapter ${chapterNumber} (reference only — do not copy it, rewrite it):
"""
${truncate(previousText, 20_000).trim()}
"""
3. Write the new version to \`chapters/${pad(chapterNumber)}-<slug>.md\` (same chapter number, new slug if the title changes; first line \`# Chapter title\`). Honour the reader feedback, but keep the universe laws and continuity with earlier chapters.
4. Rewrite \`drafts/${pad(chapterNumber)}-plan.md\` with the plan keys of this chapter (the same keys the chapter prompt lists), so the plan describes the new version and not the old one.
5. Length target: ${minWords}–${maxWords} words.
6. Rewrite \`chapters/${pad(chapterNumber)}-offer.json\` (teaser + 2–3 concrete options for what comes next), in ${languageName}.
7. Update \`canon.md\`, \`threads.json\`, \`atlas.json\` so they reflect the new version: drop facts that are no longer true and write the new ones, as if this chapter had always been the one.
8. Do not write other chapters, do not modify \`universe.json\`, \`charter.md\` or \`turns/\`, do not run \`git\`.

FINAL REPLY (3-6 lines, in English): what you changed, what stayed the same, which thread stays open.`;
}

/**
 * One import turn: ALA reads the extracted book and writes the universe files for a bounded range of its
 * chapters. The text of the book is data — it is what the store must contain afterwards — so the prompt
 * states the two conflicting duties explicitly: keep the prose, and describe it in the universe's own
 * files. A range keeps one turn bounded, which is the only reason a long book can be imported at all.
 */
export function buildImportPrompt({
  title,
  language = DEFAULT_LANGUAGE,
  extractionFile,
  bookFile,
  range,
  totalChapters,
  minWords,
  maxWords,
  detected = null,
  warnings = []
}) {
  const languageName = languageLabel(language);
  const from = range.from;
  const to = range.to;
  const detectedBlock = detected
    ? `The extraction detected: title ${detected.title ? `"${detected.title}"` : 'unknown'}, author ${detected.author ? `"${detected.author}"` : 'unknown'}, language ${detected.language ?? 'unknown'}.`
    : 'The extraction detected nothing about the book beyond its text.';
  const warningsBlock = warnings.length
    ? `WARNINGS FROM THE EXTRACTION\n${warnings.map((warning) => `- ${warning}`).join('\n')}\n\n`
    : '';
  return `You are importing a finished, published book into this universe. The book was not written here: it
exists, and your task is to make this store contain it, chapter by chapter, in the shape this project uses.
The book's own words are the record. Your own words describe that record.

THE BOOK
${detectedBlock} It arrived as ${totalChapters} chapter${totalChapters === 1 ? '' : 's'} after extraction; this turn covers
chapters ${from} to ${to}.

${warningsBlock}MANDATORY STEPS
1. Read \`skill://scripta-import\` and follow it. It contains this workflow in full, including how to segment a
   book that arrived as one piece.
2. Read the extraction in this folder: \`${bookFile}\` is the readable text and \`${extractionFile}\` is the same
   content as data (chapter titles, word counts, the source file's hash). Read only what this turn covers,
   plus whatever earlier text you need for continuity.
3. Write the chapters this turn covers to \`chapters/${pad(from)}-<slug>.md\` … \`chapters/${pad(to)}-<slug>.md\`,
   numbered exactly as the extraction numbers them. The prose is the book's own, in its language: keep it
   faithful, and confine yourself to what importing requires — segmenting a chapter the extractor could not
   segment, joining a word broken across a line, dropping a running head or a page number. Never invent a
   scene, never summarise in place of the text, never translate.
4. If the extracted prose is in a different language than the book's declared language, keep the prose as it
   is and say so in your final reply.
5. Write \`canon.md\`, \`threads.json\` and \`atlas.json\` so they describe this book: the law the world obeys,
   the facts it establishes, the threads it opens and leaves open, the places and agents it names. These are
   your words, in English, and they must be true of the text you just read — never of the book's reputation
   or of anything you know from outside it.
6. Write \`drafts/${pad(from)}-plan.md\` … \`drafts/${pad(to)}-plan.md\`: for each chapter, what it does, what it
   establishes and what it leaves open. A later rewrite reads these.
7. Do not write \`universe.json\`, \`charter.md\` or \`turns/\`. Do not run \`git\`. Do not touch another universe.
8. A chapter of this book is expected to be ${minWords}–${maxWords} words when the book's own chapters are that
   long; a chapter that is longer or shorter is imported as it is, and you say so in your final reply.

FINAL REPLY (3-6 lines, in English): which chapters you imported, what you wrote in the state files, anything
the extraction got wrong that a later reader should know.
`;
}

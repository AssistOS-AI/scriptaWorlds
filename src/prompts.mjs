// The three prompt families of a turn: a new chapter, a rewrite of an existing one, and the printed
// edition. A chapter turn asks for the next chapter and an up-to-date canon; a rewrite turn carries
// the old text and gives the reader's complaint priority; an export turn asks for the editorial
// metadata and one renderer run.
import { DEFAULT_LANGUAGE, languageLabel } from './config.mjs';
import { elementLines } from './periodic.mjs';
import { pad, truncate } from './io.mjs';

export function buildChapterPrompt({ title, law = '', language = DEFAULT_LANGUAGE, chapterNumber, message, minWords, maxWords, needsTitle = false, elements = [] }) {
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
  return `You are ALA, the narrative agent of the universe "${title}" — a science-fiction book written in ${languageName}.

${lawBlock}${elementsBlock}${titleDuty}Fiction language: **${languageName}** (code \`${language}\`). All narrative text — chapter title, prose, dialogue,
place names — is written in ${languageName}. Keep the schema vocabulary (plan keys, canon section names,
JSON field names) and your final report to the system in English.

READER REQUEST
"""
${message.trim()}
"""

TASK
Write chapter ${chapterNumber} of the book and keep canon up to date.

MANDATORY STEPS
1. Read \`skill://scripta-ala\` and follow it exactly (narrative rules, StoryPlan, limits on new names and concepts).
2. Read, in this order: \`universe.json\` (fundamental law), \`charter.md\`, \`canon.md\`, \`threads.json\`, \`atlas.json\`, then the last two files in \`chapters/\` (if any). Do not ask for extra context.
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
3. Write \`exports/edition.json\` with quality editorial metadata in ${languageName}: title, subtitle, author, year, dedication, \`preface\` (300–600 words about the world and what the book is after) and \`afterword\` (150–400 words). No spoilers that defuse the plot. You may add \`"language": "${language}"\`.
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
  elements = []
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
  const laterBlock = laterChapters.length
    ? `Chapters ${laterChapters.join(', ')} no longer exist: they were removed together with this rewrite, so do not continue or reference them.\n`
    : '';
  return `You are ALA, the narrative agent of the universe "${title}" — a science-fiction book written in ${languageName}.

${lawBlock}${elementsBlock}READER FEEDBACK (what is wrong and what must change) — mandatory and takes priority:
"""
${instructions.trim()}
"""

TASK
Rewrite chapter ${chapterNumber} of the book, in ${languageName}, as a better version. ${laterBlock}
MANDATORY STEPS
1. Read \`skill://scripta-ala\` and follow it, then \`universe.json\`, \`charter.md\`, \`canon.md\`, \`threads.json\`.
2. The OLD text of chapter ${chapterNumber} (reference only — do not copy it, rewrite it):
"""
${truncate(previousText, 20_000).trim()}
"""
3. Write the new version to \`chapters/${pad(chapterNumber)}-<slug>.md\` (same chapter number, new slug if the title changes; first line \`# Chapter title\`). Honour the reader feedback, but keep the universe laws and continuity with earlier chapters.
4. Length target: ${minWords}–${maxWords} words.
5. Rewrite \`chapters/${pad(chapterNumber)}-offer.json\` (teaser + 2–3 concrete options for what comes next), in ${languageName}.
6. Update \`canon.md\`, \`threads.json\`, \`atlas.json\` so they reflect the new version: drop facts that are no longer true and write the new ones, as if this chapter had always been the one.
7. Do not write other chapters, do not modify \`universe.json\`, \`charter.md\` or \`turns/\`, do not run \`git\`.

FINAL REPLY (3-6 lines, in English): what you changed, what stayed the same, which thread stays open.`;
}

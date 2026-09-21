// The documents of a universe: the charter, the first canon, the instructions the agent reads inside
// the folder, and the request that starts the first chapter. Pure text composition — no file access.
import { DEFAULT_LANGUAGE, languageLabel } from './config.mjs';
import { elementLines } from './periodic.mjs';

export function charterTemplate(title, language = DEFAULT_LANGUAGE, law = '') {
  return `# Charter of the universe "${title}"

Fiction language: **${languageLabel(language)} (${language})**. All narrative text — chapters, titles, dialogue —
is written in this language. Keep the schema vocabulary (plan keys, canon section names, JSON fields) in English.

## Fundamental law of the universe (inviolable)
${law ? law : '(to be completed)'}

A universe is not a civilisation and not a single idea: it is a regime of existence everything else derives
from. Every episode shows a consequence of these laws; an exception needs a cause already established in canon.

Standing rules ALA follows in this universe. Edit freely: what is written here overrides the agent's preferences.

## Narrative core
- One episode equals one dramatic question, statable in a single sentence.
- At most 2 important new characters and at most 5 new proper nouns per episode.
- At most 2 new speculative concepts the reader must understand to follow the episode.

## Human anchor
- Every cosmological idea is lived by a character with a concrete want.
- The local consequence of a choice appears in the same episode; century-scale effects may come later.

## Honesty and agency
- Factual questions get a direct answer; only revelations with narrative value may be deferred, with a due date.
- A reader intervention changes canon, not just text.
- Never punish choices: show benefits, costs and unforeseen effects.

## Forbidden
- At most one major return hook at the end of an episode.
- No retroactive canon changes without an explicit fork.
`;
}

export function canonTemplate(title, law, premise, elements = []) {
  return `# Canon — ${title}

## Fundamental laws
${law
    ? law
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      // `composeLaw` already writes its ingredient lines as a list: do not add a second dash.
      .map((line) => (line.startsWith('- ') ? line : `- ${line}`))
      .join('\n')
    : '- (to be completed: the metaphysical law of the universe)'}

These laws are inviolable. Every important event in the book must be a consequence of them, and exceptions
need a cause already established in canon.

## Ingredients (from the Periodic Table of Ideas)
${elements.length ? elementLines(elements).join('\n') : '- (none chosen: the world still has to state which operations it is built from)'}

These are the operations the world is a compound of. Every important event must be a consequence of
at least one of them; a newly invented rule needs its own line here, added by ALA.

## World
(still undefined — ALA fills this in after the first episode)
${premise ? `\nStarting situation: ${premise}\n` : ''}
## Recurring characters

## Timeline

## Stable facts

## Mysteries with a fixed cause
`;
}

export function universeAgentsDoc(title, language = DEFAULT_LANGUAGE, law = '', elements = []) {
  return `# Universe "${title}" — instructions for the ALA agent

- Fundamental law of this universe (inviolable): ${law || '(to be completed in universe.json)'}
- Ingredients of this world:
${elements.length ? elementLines(elements).join('\n') : '- (none chosen: the world still has to say which operations it is built from)'}
- Fiction language: **${languageLabel(language)} (${language})**. Write all narrative text in this language; keep the
  schema vocabulary (plan keys, canon section names, JSON fields) in English.
- Work only inside this folder. Do not run \`git\`, do not touch folders outside it.
- Chapters are written through the \`scripta-ala\` skill; printed editions through \`scripta-book-export\`.
- You write: \`canon.md\`, \`threads.json\`, \`atlas.json\`, \`chapters/*.md\`, \`chapters/NNNN-offer.json\`, \`exports/edition.json\`.
- If the universe still has no name (universe.json → autoTitle: true), the first chapter names it:
  write one descriptive line to \`universe-title.txt\` (in the fiction language) saying what is unique about this universe.
- The server writes: \`universe.json\`, \`turns/*\`. Do not modify them.
- Short paragraphs, concrete scenes, no encyclopaedia blocks.
`;
}

/** The reader's intervention, turned into a continuation request for the next chapter. */
export function fictionPrompt(language, kind, text) {
  if (kind === 'answer') return `Answer this on the page: ${text}`;
  if (kind === 'jump') return 'Let ten years pass and show what changed.';
  return `Continue the story: ${text}`;
}

export function firstChapterRequest({ language, title, law, premise, elements = [] }) {
  const cleanLaw = String(law ?? '').trim();
  const cleanPremise = String(premise ?? '').trim();
  const parts = [`Open the story of "${title}".`];
  if (elements.length) {
    parts.push(`The world is a compound built from these ingredients of the Periodic Table of Ideas: ${elementLines(elements).join(' ')}`);
  }
  if (cleanLaw) parts.push(`Fundamental law of this universe: ${cleanLaw}`);
  if (cleanPremise) parts.push(`Starting situation: ${cleanPremise}`);
  return parts.join(' ');
}

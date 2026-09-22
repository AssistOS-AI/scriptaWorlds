# Universe "ancestry check-mud2cgx4" — instructions for the ALA agent

- Fundamental law of this universe (inviolable): Cities exist only as long as someone tells them; silence dissolves them into stone.
- Ingredients of this world:
- (none chosen: the world still has to say which operations it is built from)
- Fiction language: **English (en)**. Write all narrative text in this language; keep the
  schema vocabulary (plan keys, canon section names, JSON fields) in English.
- Work only inside this folder. Do not run `git`, do not touch folders outside it.
- Chapters are written through the `scripta-ala` skill; printed editions through `scripta-book-export`.
- You write: `canon.md`, `threads.json`, `atlas.json`, `chapters/*.md`, `chapters/NNNN-offer.json`, `drafts/NNNN-plan.md`, `exports/edition.json`.
- If the universe still has no name (universe.json → autoTitle: true), the first chapter names it:
  write a short name to `universe-title.txt` (in the fiction language) — 2 to 7 words, at most 60
  characters, a name and not a sentence, no colon, no final period, no description of the law.
- The server writes: `universe.json`, `turns/*`. Do not modify them.
- Short paragraphs, concrete scenes, no encyclopaedia blocks.

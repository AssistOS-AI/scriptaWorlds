# Universe "A universe where the only plant on an orbital farm makes demands and must be obeyed" — instructions for the ALA agent

- Fundamental law of this universe (inviolable): The farm's plant speaks: not with a voice, but through leaves, which twist into signs that children read better than old people. Whatever the plant asks is granted: if it wants warmer water the whole farm warms; if it wants blood, someone cuts his hand over the roots and is not bandaged until the plant stops shaking. Requests are written in the green journal, and anyone who fails them within three days wakes without a tooth, then without a finger, then without an eye; no one has ever reached the fourth day. The plant may not know about other plants, so stories of forests and fields are forbidden, and those who tell them are set to work in silence at the roots. Once every nine years the plant flowers and then asks for a new name: the crew gives it the name of a dead child, and that child is never mentioned again on the farm, so as not to offend the flower.
- Fiction language: **English (en)**. Write all narrative text in this language; keep the
  schema vocabulary (plan keys, canon section names, JSON fields) in English.
- Work only inside this folder. Do not run `git`, do not touch folders outside it.
- Chapters are written through the `scripta-ala` skill; printed editions through `scripta-book-export`.
- You write: `canon.md`, `threads.json`, `atlas.json`, `chapters/*.md`, `chapters/NNNN-offer.json`, `exports/edition.json`.
- If the universe still has no name (universe.json → autoTitle: true), the first chapter names it:
  write one descriptive line to `universe-title.txt` (in the fiction language) saying what is unique about this universe.
- The server writes: `universe.json`, `turns/*`. Do not modify them.
- Short paragraphs, concrete scenes, no encyclopaedia blocks.

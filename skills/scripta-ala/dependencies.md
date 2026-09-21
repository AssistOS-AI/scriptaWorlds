# Dependencies

## Scope

Acest record acoperă folderul complet `scripta-ala`: instrucțiuni (SKILL.md), două referințe Markdown,
metadate de catalog și un script de validare Node.js (`scripts/validate-chapter.mjs`).

## Runtime prerequisites

- **Node.js ≥ 20** — necesar exclusiv pentru `scripts/validate-chapter.mjs`. Scriptul folosește doar
  `node:fs/promises` și `node:path`, fără pachete. Verificare: `node --version`; dacă lipsește,
  scriptul nu poate rula, dar restul skill-ului (instrucțiuni + referințe) rămâne utilizabil.

## External dependencies

Niciuna. Nu există pachete npm, cod vendorizat, unelte CLI terțe sau descărcări la rulare.
Fișierele `atlas.md` și `universe-files.md` sunt material original derivat din specificația de produs
`vision/ALA_Specificatie_v2_clara_si_simplificata.docx` (document intern al proiectului).

## Maintenance

Orice dependență viitoare (bibliotecă, unealtă CLI, font) se înregistrează aici cu justificare,
alternative respinse, sursă, licență, verificare la pornire și oportunitate de eliminare. Nu se
instalează global fără autorizare explicită.

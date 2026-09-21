# Scripta ALA — episoade · Design Summary

## Introduction

`scripta-ala` este skill-ul narativ al proiectului scriptaWorlds. Îi spune agentului de codare care
rulează în folderul unui univers cum să transforme cererea unui cititor într-un episod canonic:
plan verificabil, proză, actualizarea stării (canon, fire, atlas) și autoverificare.

## Core Content

Ordinea de lucru este fixă: citirea contextului din fișiere, clasificarea cererii, scrierea planului
în `drafts/NNNN-plan.md`, redactarea capitolului în `chapters/NNNN-slug.md`, review-ul în patru
întrebări, actualizarea `canon.md` / `threads.json` / `atlas.json` și rularea validatorului.
Invariantele narative (un nucleu, puține nume, ancore umane, payoff, un singur hook, onestitate)
sunt enunțate ca tabel de reguli R1–R12, cu interdicția pedepsirii alegerilor cititorului și a
soluțiilor retroactive.

Contractul de fișiere este precizat separat în `references/universe-files.md` (secțiuni de canon,
scheme JSON pentru fire și atlas, forme de nume pentru capitole), iar `references/atlas.md` oferă
paleta creativă: axe speculative, tipare de hook, schelete de poveste, semințe SF, conflicte pentru
dileme, moduri de interacțiune. Referințele sunt material de combinat, nu intrigi de reprodus.

`scripts/validate-chapter.mjs` verifică mecanic rezultatul: existența și titlul capitolului, lungimea,
absența conținutului nepotrivit (cod, tabele, link-uri, chei de plan scurse în proză), prezența
cheilor obligatorii din plan, validitatea JSON-ului pentru fire și atlas, limitele de amânare
(maximum un răspuns amânat nou per episod, termen ≤ capitolul curent + 3) și secțiunile canonului.
Ieșirea este o linie JSON cu `errors`/`warnings`, iar codul de ieșire este 1 când există erori.

## Decisions & Questions

### Question #1: De ce un plan obligatoriu în fișier?

Response: specificația cere ca proza să fie scrisă după un plan verificabil, iar un plan scris face
verificarea posibilă atât pentru agent, cât și pentru validator și pentru interfață.

### Question #2: De ce validator separat, nu doar instrucțiuni?

Response: un model mic respectă mai bine un contract verificabil mecanic; validatorul prinde erorile
de schemă (JSON invalid, chei lipsă, limite depășite) înainte ca serverul să marcheze turnul ca reușit.

### Question #3: Ce rămâne în afara skill-ului?

Response: generarea edițiilor tipărite (`scripta-book-export`), orchestrarea proceselor și API-ul
HTTP (modulele `src/*.mjs`), plus regulile permanente per univers (`charter.md`, scris de server).

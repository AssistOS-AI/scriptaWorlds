// The state files of an imported universe: `canon.md`, `threads.json`, `atlas.json`.
//
// An import is not finished by writing chapter files. A book that can be continued, reviewed or
// extended has to carry the canon, the threads and the atlas the prose established, in the same
// vocabulary a written book uses. These checks prove that those files are there, that their
// containers parse and that the chapter numbers they cite are chapters that exist. They prove
// nothing about whether a fact is true of the book; only the extraction can say that.

import { join } from 'node:path';

import {
  ATLAS_AXIS_IDS,
  ATLAS_STATES,
  CANON_LAW_SECTION,
  CANON_SECTIONS,
  CODE_INVALID_IMPORT,
  CODE_UNPARSEABLE_JSON,
  SUPPORTED_LANGUAGES,
  THREAD_COLLECTIONS,
  THREAD_ID,
  THREAD_KINDS,
  THREAD_STATUSES,
  WARNING_LANGUAGE_MISMATCH,
  WARNING_UNIVERSE_UNREADABLE,
} from './limits.mjs';
import { identifier, isPlainObject, meaningful, problem, readJsonFile, readTextFile, warning, worstCode } from './problems.mjs';

const NODE_ID = /^[a-z0-9][a-z0-9-]*$/;
const LAW_MIN_CHARS = 20;

/** `universe.json` belongs to the server; it is read for the law and the language, and never written. */
function readUniverse(universeDir, warnings) {
  const read = readJsonFile(join(universeDir, 'universe.json'));
  if (!read.ok) {
    warnings.push(warning(WARNING_UNIVERSE_UNREADABLE, `universe.json could not be read (${read.message}); the law and the language were not checked`, { path: 'universe.json' }));
    return null;
  }
  if (!isPlainObject(read.value)) {
    warnings.push(warning(WARNING_UNIVERSE_UNREADABLE, 'universe.json is not an object; the law and the language were not checked', { path: 'universe.json' }));
    return null;
  }
  return read.value;
}

function checkLanguageDecision(record, universe, problems, warnings) {
  const book = record.language.book;
  const declared = record.language.state;
  if (typeof declared !== 'string' || !SUPPORTED_LANGUAGES.includes(declared)) {
    problems.push(problem(CODE_INVALID_IMPORT, `the import record does not say which language its state files are written in (got ${JSON.stringify(declared)})`, { path: 'drafts/import-progress.json' }));
  }
  const universeLanguage = universe && typeof universe.language === 'string' ? universe.language : null;
  if (book && universeLanguage && record.language.universe !== universeLanguage) {
    problems.push(
      problem(CODE_INVALID_IMPORT, `the import record says the universe language is ${JSON.stringify(record.language.universe)} while universe.json says ${JSON.stringify(universeLanguage)}`, {
        path: 'drafts/import-progress.json',
      }),
    );
  }
  const expectedMatch = !book || !universeLanguage ? record.language.match : book === universeLanguage;
  if (book && universeLanguage && record.language.match !== expectedMatch) {
    problems.push(
      problem(CODE_INVALID_IMPORT, `the import record claims language.match ${record.language.match}, but the book is ${book} and the universe is ${universeLanguage}`, {
        path: 'drafts/import-progress.json',
      }),
    );
  }
  const expectedState = book ?? universeLanguage;
  if (expectedState && declared && declared !== expectedState) {
    problems.push(
      problem(CODE_INVALID_IMPORT, `the import record writes its state in ${declared} while the book is in ${expectedState}`, { path: 'drafts/import-progress.json' }),
    );
  }
  if (book && universeLanguage && book !== universeLanguage) {
    warnings.push(
      warning(
        WARNING_LANGUAGE_MISMATCH,
        `the book is in ${book} and universe.json says ${universeLanguage}: the prose and the state files stay in the book's language, and the metadata mismatch is for the operator to settle, never for the import to hide`,
        { path: 'universe.json' },
      ),
    );
  }
}

function checkCanon(universeDir, universe, problems) {
  const read = readTextFile(join(universeDir, 'canon.md'));
  if (!read.ok) {
    problems.push(problem(CODE_INVALID_IMPORT, `no canon.md: an imported universe needs the canon of the imported book (${read.message})`, { path: 'canon.md' }));
    return;
  }
  for (const section of CANON_SECTIONS) {
    if (!read.text.includes(section)) {
      problems.push(problem(CODE_INVALID_IMPORT, `canon.md does not contain the section "${section}"`, { path: 'canon.md' }));
    }
  }
  const law = universe && typeof universe.law === 'string' ? universe.law.trim() : '';
  if (law.length > 0) {
    const index = read.text.indexOf(CANON_LAW_SECTION);
    if (index >= 0) {
      const body = read.text.slice(index + CANON_LAW_SECTION.length).split(/\n## /)[0].trim();
      if (body.length < LAW_MIN_CHARS) {
        problems.push(problem(CODE_INVALID_IMPORT, 'the "Fundamental laws" section of canon.md is empty; the universe law belongs there', { path: 'canon.md' }));
      }
    }
  }
}

function checkThreads(universeDir, highestChapter, problems) {
  const read = readJsonFile(join(universeDir, 'threads.json'));
  if (!read.ok) {
    const code = read.kind === 'unparseable' ? CODE_UNPARSEABLE_JSON : CODE_INVALID_IMPORT;
    problems.push(problem(code, read.kind === 'missing' ? 'no threads.json: an imported universe records its open threads' : read.message, { path: 'threads.json' }));
    return;
  }
  if (!isPlainObject(read.value)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'threads.json must be a JSON object', { path: 'threads.json' }));
    return;
  }
  const seen = new Set();
  for (const collection of THREAD_COLLECTIONS) {
    const list = read.value[collection];
    if (list === undefined) {
      problems.push(problem(CODE_INVALID_IMPORT, `threads.json has no "${collection}" list`, { path: 'threads.json' }));
      continue;
    }
    if (!Array.isArray(list)) {
      problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${collection} must be a list`, { path: 'threads.json' }));
      continue;
    }
    list.forEach((entry, index) => {
      const where = `${collection}[${index}]`;
      if (!isPlainObject(entry)) {
        problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} must be an object`, { path: 'threads.json' }));
        return;
      }
      const id = identifier(entry.id);
      if (!id || !THREAD_ID.test(id)) {
        problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} needs an id of the form <prefix>-NNNN`, { path: 'threads.json' }));
      } else if (seen.has(id)) {
        problems.push(problem(CODE_INVALID_IMPORT, `threads.json: the id ${id} is used twice`, { path: 'threads.json' }));
      } else {
        seen.add(id);
      }
      const created = Number.isInteger(entry.created_chapter ?? entry.asked_chapter) ? (entry.created_chapter ?? entry.asked_chapter) : null;
      if (created === null) {
        problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} has no integer created_chapter or asked_chapter`, { path: 'threads.json' }));
      } else if (created < 1 || created > highestChapter) {
        problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} cites chapter ${created}, but the book has chapters 1–${highestChapter}`, { path: 'threads.json' }));
      }
      if (entry.closed_chapter !== undefined) {
        const closed = Number.isInteger(entry.closed_chapter) ? entry.closed_chapter : null;
        if (closed === null || closed < 1 || closed > highestChapter) {
          problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} closed_chapter must name an existing chapter`, { path: 'threads.json' }));
        } else if (created !== null && closed < created) {
          problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} closes in chapter ${closed} before it was created in ${created}`, { path: 'threads.json' }));
        }
      }
      if (entry.due_chapter !== undefined) {
        const due = Number.isInteger(entry.due_chapter) ? entry.due_chapter : null;
        if (due === null || due < 1) {
          problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} due_chapter must be a chapter number`, { path: 'threads.json' }));
        } else if (created !== null && due <= created) {
          problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} is due in chapter ${due}, at or before its creation in chapter ${created}`, { path: 'threads.json' }));
        }
      }
      if (entry.kind !== undefined && !THREAD_KINDS.includes(entry.kind)) {
        problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} has the unknown kind ${JSON.stringify(entry.kind)} (use ${THREAD_KINDS.join('/')})`, { path: 'threads.json' }));
      }
      if (collection === 'open' && entry.kind === undefined) {
        problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} has no kind`, { path: 'threads.json' }));
      }
      if (entry.status !== undefined && !THREAD_STATUSES.includes(entry.status)) {
        problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} has the unknown status ${JSON.stringify(entry.status)} (use ${THREAD_STATUSES.join('/')})`, { path: 'threads.json' }));
      }
      const text = collection === 'promises' ? entry.promise : collection === 'closed' ? entry.resolution : (entry.question ?? entry.reason);
      if (!meaningful(text)) {
        problems.push(problem(CODE_INVALID_IMPORT, `threads.json: ${where} has no usable question, promise or resolution`, { path: 'threads.json' }));
      }
    });
  }
}

function checkAtlas(universeDir, record, highestChapter, problems) {
  const read = readJsonFile(join(universeDir, 'atlas.json'));
  if (!read.ok) {
    const code = read.kind === 'unparseable' ? CODE_UNPARSEABLE_JSON : CODE_INVALID_IMPORT;
    problems.push(problem(code, read.kind === 'missing' ? 'no atlas.json: an imported universe records which ideas the book works' : read.message, { path: 'atlas.json' }));
    return;
  }
  const value = read.value;
  if (!isPlainObject(value) || !Array.isArray(value.axes)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'atlas.json must be an object with an `axes` list', { path: 'atlas.json' }));
    return;
  }
  if (value.version !== 1) {
    problems.push(problem(CODE_INVALID_IMPORT, `atlas.json declares version ${JSON.stringify(value.version)}; 1 is expected`, { path: 'atlas.json' }));
  }
  const axisIds = new Set();
  const nodeIds = new Set();
  let touchesImport = false;
  const last = record.chapters[record.chapters.length - 1].chapter;
  value.axes.forEach((axis, axisIndex) => {
    if (!isPlainObject(axis)) {
      problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: axes[${axisIndex}] must be an object`, { path: 'atlas.json' }));
      return;
    }
    if (!ATLAS_AXIS_IDS.includes(axis.id)) {
      problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: axes[${axisIndex}] has the unknown axis ${JSON.stringify(axis.id)}`, { path: 'atlas.json' }));
    } else if (axisIds.has(axis.id)) {
      problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: the axis ${axis.id} is declared twice`, { path: 'atlas.json' }));
    } else {
      axisIds.add(axis.id);
    }
    if (!meaningful(axis.name)) {
      problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: axes[${axisIndex}] has no name`, { path: 'atlas.json' }));
    }
    if (!Array.isArray(axis.nodes)) {
      problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: axes[${axisIndex}] needs a \`nodes\` list`, { path: 'atlas.json' }));
      return;
    }
    axis.nodes.forEach((node, nodeIndex) => {
      const where = `axis ${JSON.stringify(axis.id)} node ${nodeIndex}`;
      if (!isPlainObject(node)) {
        problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: ${where} must be an object`, { path: 'atlas.json' }));
        return;
      }
      if (typeof node.id !== 'string' || !NODE_ID.test(node.id)) {
        problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: ${where} needs an English lowercase identifier`, { path: 'atlas.json' }));
      } else if (nodeIds.has(node.id)) {
        problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: the node ${node.id} is declared twice`, { path: 'atlas.json' }));
      } else {
        nodeIds.add(node.id);
      }
      if (!meaningful(node.label)) {
        problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: ${where} has no label`, { path: 'atlas.json' }));
      }
      if (!ATLAS_STATES.includes(node.state)) {
        problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: ${where} has the invalid state ${JSON.stringify(node.state)} (use ${ATLAS_STATES.join('/')})`, { path: 'atlas.json' }));
      }
      if (!Array.isArray(node.chapters) || node.chapters.length === 0) {
        problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: ${where} must name the chapters that show it`, { path: 'atlas.json' }));
        return;
      }
      node.chapters.forEach((chapter) => {
        if (!Number.isInteger(chapter) || chapter < 1 || chapter > highestChapter) {
          problems.push(problem(CODE_INVALID_IMPORT, `atlas.json: ${where} cites chapter ${JSON.stringify(chapter)}, but the book has chapters 1–${highestChapter}`, { path: 'atlas.json' }));
          return;
        }
        if (chapter >= record.start_chapter && chapter <= last) touchesImport = true;
      });
    });
  });
  if (!touchesImport && nodeIds.size > 0) {
    problems.push(problem(CODE_INVALID_IMPORT, `atlas.json names no chapter of the imported range ${record.start_chapter}–${last}, so it does not describe the imported book`, { path: 'atlas.json' }));
  }
}

/** Check canon, threads, atlas and the language decision against the record. */
export function checkState({ universeDir, record, highestChapter }) {
  const problems = [];
  const warnings = [];
  const universe = readUniverse(universeDir, warnings);
  checkLanguageDecision(record, universe, problems, warnings);
  checkCanon(universeDir, universe, problems);
  checkThreads(universeDir, highestChapter, problems);
  checkAtlas(universeDir, record, highestChapter, problems);
  return { ok: problems.length === 0, code: worstCode(problems), problems, warnings };
}

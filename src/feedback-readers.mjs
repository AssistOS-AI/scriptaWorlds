// The reader identities of a book (`docs/contracts.md` §8.7): one record per person under
// `<workspace>/<universe-id>/feedback/readers/<reader-id>.json`. The invariants this module keeps:
//
//  - the identifier is issued by the server and never changes, so renaming a reader or reading from
//    another machine keeps every response attributed to the same person;
//  - a record is created once and then only marked — a rename, a deletion request — never rewritten
//    into a different person, and a deleted identity stays readable as the record of who was deleted;
//  - nothing here writes inside `universes/`, and the record is written through a temporary file and
//    a rename, so a reader is never half-written.
import { mkdir, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { nowIso, readJson, writeJson } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { feedbackRoot, LIMITS } from './feedback-targets.mjs';

export const READER_SCHEMA = 'reader-identity.v1';
export const READER_KINDS = ['team_human', 'model', 'synthetic'];

export const readersRoot = (universeId) => join(feedbackRoot(universeId), 'readers');
export const readerFile = (universeId, readerId) => join(readersRoot(universeId), `${readerId}.json`);

const READER_ID_RE = /^reader-[0-9a-f]{16}$/;

export const isReaderId = (readerId) => typeof readerId === 'string' && READER_ID_RE.test(readerId);

const invalid = (message) => new UniverseError('INVALID_FEEDBACK', message, 400);
const unknownReader = (readerId) => new UniverseError('READER_NOT_FOUND', `Unknown reader ${readerId}.`, 404);

function checkDisplayName(displayName) {
  if (typeof displayName !== 'string') throw invalid('A reader needs a display name.');
  const value = displayName.trim();
  if (value.length === 0) throw invalid('A reader needs a display name.');
  if (value.length > LIMITS.displayNameChars) throw invalid(`A display name is at most ${LIMITS.displayNameChars} characters.`);
  return value;
}

/**
 * Create the identity of one reader of a book. The identifier is issued here and returned to the
 * caller, which stores it (the interface keeps it across sessions); the same display name may be used
 * by two people, because the identifier, not the name, is what a response is attributed to.
 */
export async function createFeedbackReader({ universeId, displayName, kind = null }) {
  const name = checkDisplayName(displayName);
  const readerKind = kind === null || kind === undefined || kind === '' ? 'team_human' : String(kind);
  if (!READER_KINDS.includes(readerKind)) throw invalid(`A reader is a ${READER_KINDS.join(', ')} (received ${readerKind}).`);
  const at = nowIso();
  await mkdir(readersRoot(universeId), { recursive: true });
  for (;;) {
    const readerId = `reader-${randomBytes(8).toString('hex')}`;
    if (await readJson(readerFile(universeId, readerId), null)) continue;
    const reader = {
      schema_version: READER_SCHEMA,
      reader_id: readerId,
      display_name: name,
      kind: readerKind,
      created_at: at,
      last_seen_at: at,
      deleted_at: null
    };
    await writeJson(readerFile(universeId, readerId), reader);
    return reader;
  }
}

/** One identity, deleted identities included: the record of who was deleted is still a record. */
export async function readFeedbackReader(universeId, readerId) {
  if (!isReaderId(readerId)) throw unknownReader(readerId);
  const reader = await readJson(readerFile(universeId, readerId), null);
  if (!reader) throw unknownReader(readerId);
  return reader;
}

/** Every identity of a book, oldest first, so the team's list reads like a roster. */
export async function listFeedbackReaders(universeId) {
  const readers = [];
  for (const name of await readdir(readersRoot(universeId)).catch(() => [])) {
    if (!/^reader-[0-9a-f]{16}\.json$/.test(name)) continue;
    const reader = await readJson(join(readersRoot(universeId), name), null);
    if (reader) readers.push(reader);
  }
  return readers.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.reader_id).localeCompare(String(b.reader_id)));
}

/** Rename a reader without touching attribution: the identifier and every response stay the same. */
export async function renameFeedbackReader({ universeId, readerId, displayName }) {
  const reader = await readFeedbackReader(universeId, readerId);
  const renamed = { ...reader, display_name: checkDisplayName(displayName) };
  await writeJson(readerFile(universeId, readerId), renamed);
  return renamed;
}

/** Mark an identity as deleted. The file stays: a deletion is visible rather than silent. */
export async function markFeedbackReaderDeleted(universeId, readerId) {
  const reader = await readFeedbackReader(universeId, readerId);
  if (reader.deleted_at) return reader;
  const deleted = { ...reader, deleted_at: nowIso() };
  await writeJson(readerFile(universeId, readerId), deleted);
  return deleted;
}

/** Record that a reader was seen: an identity is refreshed when it submits, never on a read. */
export async function touchFeedbackReader(universeId, readerId) {
  const reader = await readFeedbackReader(universeId, readerId);
  const seen = { ...reader, last_seen_at: nowIso() };
  await writeJson(readerFile(universeId, readerId), seen);
  return seen;
}

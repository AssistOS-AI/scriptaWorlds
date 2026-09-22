// The self-contained dataset of one book's reader feedback (`docs/contracts.md` §8.7): the lightweight
// dataset of `./feedback-export.mjs` plus the frozen text itself, so a fresh workspace with no access to
// the original store can reproduce every reading target and every passage a reader quoted. Where the
// lightweight export carries paths and hashes and leaves the prose where it was frozen, this snapshot is
// meant to be moved: it is the document a team keeps after the store is gone. The invariants:
//
//  - the frozen text travels byte for byte, and it is verified before it is carried: every displayed file
//    is read back from the target's own copy and compared with the `sha256` and the byte count the target
//    recorded, so a target whose prose no longer reproduces its hashes answers `STALE_TARGET` instead of
//    exporting words nobody was shown;
//  - identity is not disclosed by default. A reader appears under a stable pseudonym derived from their
//    identifier inside this book, so repeated readings stay visible as one person's and a fresh workspace
//    can still count independent readers, while the identifiers and the display names travel only in the
//    internal dataset, which a caller has to ask for by name;
//  - the selection is stated rather than implied: the snapshot names the responses an analysis may count,
//    the ones a correction replaced and the ones a reader withdrew, all of which travel, so a dataset
//    never silently drops what a reader said and never counts it twice either;
//  - the manifest carries the counts and the hashes of every part, including the hash of the lightweight
//    export of the same store, so a future analysis can check what it received against what was sent;
//  - the same store yields the same bytes, the document carries no timestamp of its own, and nothing is
//    written inside `universes/` or in the feedback tree.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { UniverseError } from './errors.mjs';
import { buildFeedbackExport, serializeFeedbackExport } from './feedback-export.mjs';
import { readFrozenText, verifyFrozenText } from './feedback-targets.mjs';

export const FEEDBACK_DATASET_SCHEMA = 'reader-feedback-dataset.v1';

/** The identities a snapshot can carry: a stable pseudonym (the default) or the named internal one. */
export const DATASET_IDENTITIES = ['pseudonym', 'internal'];

/** The file name of a snapshot: the identity mode is part of the name, so the two are never confused. */
export const feedbackDatasetName = (universeId, identity = 'pseudonym') => (identity === 'internal'
  ? `${universeId}-feedback-dataset-internal.json`
  : `${universeId}-feedback-dataset.json`);

const digest = (value) => createHash('sha256').update(value).digest('hex');
const hashOf = (value) => digest(typeof value === 'string' ? value : JSON.stringify(value));

/**
 * A stable pseudonym for one reader of one book: derived from the identifier and the book, so the same
 * reader keeps the same name in every snapshot of that book — which is what keeps a repeated reading
 * visible as one person — while the identifier itself does not travel. It is an identifier of this
 * dataset and not a secret, which is exactly why the internal dataset exists beside it.
 */
const pseudonymOf = (universeId, readerId) => `reader-p${digest(`${universeId}|${readerId}`).slice(0, 12)}`;

/** One reader as a snapshot carries them: the pseudonym always, the name and the identifier only inside. */
function readerOf(reader, { mode, pseudonyms }) {
  const entry = {
    reader: pseudonyms.get(reader.reader_id) ?? null,
    display_name: mode === 'internal' ? reader.display_name : null,
    kind: reader.kind,
    created_at: reader.created_at,
    last_seen_at: reader.last_seen_at,
    deleted_at: reader.deleted_at
  };
  return mode === 'internal' ? { ...entry, reader_id: reader.reader_id } : entry;
}

/** One response, with the identity replaced by the pseudonym of this snapshot. */
function responseOf(response, { mode, pseudonyms }) {
  const { reader_id: readerId, ...rest } = response;
  const identity = { reader: pseudonyms.get(readerId) ?? null };
  if (mode === 'internal') identity.reader_id = readerId;
  return { ...identity, ...rest };
}

/**
 * The frozen text of every target, read back from the store and checked against what the target
 * recorded. A file that cannot be read, or that no longer hashes to the value its target carries,
 * refuses the whole snapshot: a dataset that carries prose a reader never saw is worse than no dataset.
 */
async function textsOf(universeId, targets) {
  const texts = [];
  for (const target of targets) {
    await verifyFrozenText(universeId, target);
    const files = [];
    for (const file of target.displayed.files) {
      const frozen = await readFrozenText(universeId, target, file.path);
      if (!frozen || typeof frozen.text !== 'string') {
        throw new UniverseError('STALE_TARGET', `The frozen text of ${target.target_id} (${file.path}) cannot be read back, so no dataset is produced.`, 409);
      }
      files.push({ path: file.path, name: basename(file.path), sha256: file.sha256, bytes: file.bytes, text: frozen.text });
    }
    texts.push({
      target_id: target.target_id,
      accepted_version: target.source_version,
      scope: target.scope,
      language: target.language,
      questionnaire_version: target.questionnaire_version,
      historical: target.historical,
      displayed_hash: target.displayed.hash,
      files
    });
  }
  return texts;
}

/** Which responses a snapshot counts, which a correction replaced, and which a reader took back. */
function selectionOf(responses) {
  return {
    unit: 'reader',
    rule: 'every stored response travels in the snapshot; `counted` names the responses an analysis may compute a distribution from, `superseded` the ones a correction replaced and `withdrawn` the ones a reader took back, because a corrected or withdrawn answer is not the reader\'s opinion any more',
    counted: responses.filter((entry) => entry.withdrawn !== true && entry.superseded !== true).map((entry) => entry.feedback_id),
    superseded: responses.filter((entry) => entry.superseded === true).map((entry) => entry.feedback_id),
    withdrawn: responses.filter((entry) => entry.withdrawn === true).map((entry) => entry.feedback_id),
    corrections: Object.fromEntries(responses.filter((entry) => entry.revision_of).map((entry) => [entry.feedback_id, entry.revision_of])),
    reader_note: 'one reader may appear in several responses of one target; their pseudonym is what keeps the repeated readings of one person visible as one person, which is what a count of independent readers needs'
  };
}

/** The counts and the hashes of every part, so a receiver can check what it was given. */
function manifestOf({ texts, questionnaires, readers, responses, selection, identityDeletions, lightweight }) {
  const files = {};
  let fileCount = 0;
  let bytes = 0;
  for (const text of texts) {
    for (const file of text.files) {
      files[`${text.target_id}/${file.name}`] = file.sha256;
      fileCount += 1;
      bytes += Buffer.byteLength(file.text, 'utf8');
    }
  }
  return {
    counts: {
      targets: texts.length,
      questionnaires: questionnaires.length,
      readers: readers.length,
      responses: responses.length,
      counted: selection.counted.length,
      superseded: selection.superseded.length,
      withdrawn: selection.withdrawn.length,
      identity_deletions: identityDeletions.length,
      files: fileCount,
      bytes
    },
    hashes: {
      // The hash of the lightweight export of the same store: the two documents can be checked against
      // each other without the store they came from.
      lightweight_export: hashOf(serializeFeedbackExport(lightweight)),
      texts: files,
      questionnaires: Object.fromEntries(questionnaires.map((questionnaire) => [questionnaire.version, hashOf(questionnaire)])),
      readers: hashOf(readers),
      responses: hashOf(responses),
      selection: hashOf(selection)
    },
    verified: 'every frozen file was read back from its target and checked against the sha256 and the byte count the target recorded before this snapshot was written',
    identity: null
  };
}

/**
 * The self-contained dataset of one book: the lightweight dataset of §8.7 plus the frozen text of every
 * target, a stable pseudonym for every reader (or the real identities of the internal dataset, which the
 * caller has to name), the revision and withdrawal selection, and a manifest of counts and hashes. It
 * answers `404 NOT_FOUND` for a book that does not exist, `404 NO_FEEDBACK` for a book no reader has
 * responded to yet, `400 BAD_DATASET` for an identity mode the store does not know and `409 STALE_TARGET`
 * when a frozen file no longer reproduces the hashes its target recorded. It writes nothing.
 */
export async function buildFeedbackDataset(universeId, { identity = 'pseudonym' } = {}) {
  const mode = String(identity ?? 'pseudonym');
  if (!DATASET_IDENTITIES.includes(mode)) {
    throw new UniverseError('BAD_DATASET', `A feedback dataset carries ${DATASET_IDENTITIES.join(' or ')} identities (received ${mode}).`, 400);
  }
  const lightweight = await buildFeedbackExport(universeId);
  const texts = await textsOf(universeId, lightweight.targets);
  const pseudonyms = new Map(lightweight.readers.map((reader) => [reader.reader_id, pseudonymOf(universeId, reader.reader_id)]));
  const readers = lightweight.readers.map((reader) => readerOf(reader, { mode, pseudonyms }));
  const responses = lightweight.responses.map((response) => responseOf(response, { mode, pseudonyms }));
  const identityDeletions = lightweight.identity_deletions.map((entry) => responseOf(entry, { mode, pseudonyms }));
  const selection = selectionOf(responses);
  const manifest = manifestOf({
    texts,
    questionnaires: lightweight.questionnaires,
    readers,
    responses,
    selection,
    identityDeletions,
    lightweight
  });
  manifest.identity = mode;
  return {
    schema_version: FEEDBACK_DATASET_SCHEMA,
    universe_id: lightweight.universe_id,
    identity: {
      mode,
      note: mode === 'internal'
        ? 'the internal dataset: reader identifiers and display names travel with it, and it is asked for by name'
        : 'every reader appears under a stable pseudonym derived from the identifier inside this book; display names and identifiers do not travel'
    },
    book: lightweight.book,
    manifest,
    questionnaires: lightweight.questionnaires,
    readers,
    targets: lightweight.targets,
    texts,
    selection,
    responses,
    identity_deletions: identityDeletions
  };
}

/** The snapshot as the bytes a client keeps: two-space JSON, one trailing newline, no wall-clock field. */
export function serializeFeedbackDataset(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * What the download of one book's snapshot is: the file name a client keeps and the bytes it receives.
 * The identity mode is part of the name, so the internal dataset is never mistaken for the pseudonymous
 * one in a directory of exports.
 */
export async function feedbackDatasetDownload(universeId, { identity = 'pseudonym' } = {}) {
  const bytes = Buffer.from(serializeFeedbackDataset(await buildFeedbackDataset(universeId, { identity })), 'utf8');
  return { name: feedbackDatasetName(universeId, identity), body: bytes };
}

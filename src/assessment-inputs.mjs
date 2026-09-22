// The inputs a caller may declare for one review phase, and how they are frozen into the packet.
//
// A phase reads only files inside the captured input directory, so an input is not "passed along" — it
// is captured with its hash like every other packet file, and the child process is told where it lies.
// What a phase does not support is refused here rather than ignored, because a silently dropped input
// looks exactly like an input that was honoured.
import { createHash } from 'node:crypto';
import { UniverseError } from './errors.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Which declared inputs each phase supports. */
export const PHASE_INPUTS = {
  continuity: { annotations: true, corpus: false, profile: false },
  metrics: { annotations: true, corpus: true, profile: true }
};

const serialize = (value) => (typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
export const annotationsFile = 'annotations.json';
export const corpusDir = 'corpus';
export const corpusFile = `${corpusDir}/corpus.json`;
export const profileFile = 'profile.json';

/** The references of a corpus manifest, accepting a bare array or the `corpus.v1` object. */
function corpusReferences(manifest) {
  const references = Array.isArray(manifest) ? manifest : manifest?.references;
  if (!Array.isArray(references)) {
    throw new UniverseError('INVALID_CORPUS', 'A corpus manifest is an array of references or an object with a `references` array.', 400);
  }
  return references;
}

/** A relative path inside the packet, with no escape and no absolute form. */
function safeRelative(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text.startsWith('/') || text.startsWith('\\') || /^[A-Za-z]:/.test(text)) {
    throw new UniverseError('INVALID_CORPUS', `${label} must be a relative path inside the corpus, not ${JSON.stringify(value)}.`, 400);
  }
  if (text.split(/[\\/]/).includes('..')) {
    throw new UniverseError('INVALID_CORPUS', `${label} must stay inside the corpus (${JSON.stringify(value)} contains "..").`, 400);
  }
  return text;
}

/**
 * Freeze a declared corpus: its manifest and every text it references. A manifest alone is refused,
 * because a review that cannot read the compared text would report a comparison it never made.
 */
function corpusInputs(corpus) {
  if (typeof corpus !== 'object' || corpus === null) {
    throw new UniverseError('INVALID_CORPUS', 'A declared corpus is `{ manifest, files }`, where `files` maps each reference path to its text.', 400);
  }
  const manifest = corpus.manifest ?? null;
  if (manifest === null) {
    throw new UniverseError('INVALID_CORPUS', 'A declared corpus needs a `manifest` (a `corpus.v1` object or an array of references).', 400);
  }
  const files = corpus.files ?? {};
  if (typeof files !== 'object' || Array.isArray(files)) {
    throw new UniverseError('INVALID_CORPUS', '`corpus.files` maps each reference path to the text of that reference.', 400);
  }
  const references = corpusReferences(manifest);
  const entries = [];
  const usedPaths = new Set();
  const sorted = [...references].map((reference, index) => ({ reference, index }))
    .sort((a, b) => String(a.reference?.path ?? '').localeCompare(String(b.reference?.path ?? '')));
  for (const { reference } of sorted) {
    if (typeof reference !== 'object' || reference === null) {
      throw new UniverseError('INVALID_CORPUS', 'Every corpus reference is an object with at least a `path` and a `language`.', 400);
    }
    const path = safeRelative(reference.path, 'A corpus reference path');
    if (usedPaths.has(path)) {
      throw new UniverseError('INVALID_CORPUS', `The corpus declares ${path} twice.`, 400);
    }
    usedPaths.add(path);
    const text = files[path];
    if (typeof text !== 'string') {
      throw new UniverseError(
        'MISSING_RESOURCE',
        `The corpus reference ${JSON.stringify(reference.id ?? path)} points at ${path}, but its text was not supplied: capture it in \`corpus.files[${JSON.stringify(path)}]\` so the review can read the text it compares.`,
        400
      );
    }
    if (typeof reference.sha256 === 'string' && reference.sha256.length > 0 && reference.sha256 !== sha256(text)) {
      throw new UniverseError(
        'HASH_MISMATCH',
        `The corpus reference ${JSON.stringify(reference.id ?? path)} declares sha256 ${reference.sha256.slice(0, 16)}… but the supplied text of ${path} hashes to ${sha256(text).slice(0, 16)}….`,
        400
      );
    }
    entries.push({ path: `${corpusDir}/${path}`, text });
  }
  for (const path of Object.keys(files)) {
    if (!usedPaths.has(safeRelative(path, 'A supplied corpus file'))) {
      throw new UniverseError('UNKNOWN_RESOURCE', `The corpus files include ${path}, which no reference declares.`, 400);
    }
  }
  return { entries, manifest };
}

/**
 * The files one phase needs, from the inputs a caller declared. Returns the packet entries to capture
 * and the paths the child process will be given, both relative to the captured input directory.
 */
export function resolveAssessmentInputs(phase, { profile = null, annotations = null, corpus = null } = {}) {
  const supported = PHASE_INPUTS[phase];
  if (!supported) {
    throw new UniverseError('BAD_PHASE', `Unknown assessment phase (${Object.keys(PHASE_INPUTS).join('|')}).`, 400);
  }
  const files = [];
  const paths = { profile: null, annotations: null, corpus: null };

  if (profile !== null && profile !== undefined) {
    if (!supported.profile) {
      throw new UniverseError('UNSUPPORTED_INPUT', `The ${phase} phase takes no profile: it does not measure against one.`, 400);
    }
    files.push({ path: profileFile, role: 'profile', content: serialize(profile) });
    paths.profile = profileFile;
  }
  if (annotations !== null && annotations !== undefined) {
    if (!supported.annotations) {
      throw new UniverseError('UNSUPPORTED_INPUT', `The ${phase} phase takes no annotations.`, 400);
    }
    files.push({ path: annotationsFile, role: 'annotations', content: serialize(annotations) });
    paths.annotations = annotationsFile;
  }
  if (corpus !== null && corpus !== undefined) {
    if (!supported.corpus) {
      throw new UniverseError('UNSUPPORTED_INPUT', `The ${phase} phase compares no corpus.`, 400);
    }
    const frozen = corpusInputs(corpus);
    files.push({ path: corpusFile, role: 'corpus', content: serialize(frozen.manifest), artifact_id: 'corpus' });
    // The reference texts travel beside the manifest, not in the packet's own inventory: the packet
    // vocabulary gives one artifact id per role, and the manifest is the artifact of role `corpus`. The
    // texts are captured all the same, and the manifest declares each of their hashes, which the review
    // recomputes before it compares anything.
    frozen.entries.forEach((entry) => {
      files.push({ path: entry.path, role: 'corpus', content: entry.text, declared: false });
    });
    paths.corpus = corpusFile;
  }
  return { files, paths };
}

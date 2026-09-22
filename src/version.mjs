// The accepted version identity of a book, defined once for the server: the content of a universe at
// one moment, identified by what it contains rather than by its folder or by a timestamp. The
// separate design and review skills implement the same rule in their own portable loaders
// (`docs/contracts.md` §8.2), so a result can name the version it judged and stay checkable.
import { createHash } from 'node:crypto';

/** The roles that make up the narrative content of an accepted version. */
export const VERSION_ROLES = Object.freeze(['chapter', 'offer', 'canon', 'threads', 'atlas']);

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The canonical entry of one file: its relative path, its content hash and its byte count, separated
 * by tabs and terminated by a newline.
 */
function entryLine(entry) {
  return `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`;
}

/**
 * `sha256:<hex>` over every entry whose role takes part, sorted by path in byte order. Entries are
 * `{ path, role, sha256, bytes }`; anything outside the version roles is ignored, so a mutable
 * record such as `universe.json` or an assessment input never changes the identity.
 */
export function acceptedVersion(entries) {
  const lines = entries
    .filter((entry) => VERSION_ROLES.includes(entry.role))
    .map(entryLine)
    .sort();
  return `sha256:${sha256Hex(lines.join(''))}`;
}

/** The directory-name form of a version identity (`sha256:` is not usable in a path). */
export function versionSlug(version) {
  return String(version ?? '').replace(/^sha256:/, 'sha256-');
}

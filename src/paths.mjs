import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, readlink, stat, symlink, unlink } from 'node:fs/promises';

export const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const universesDir = join(rootDir, 'universes');
export const skillsDir = join(rootDir, 'skills');
export const publicDir = join(rootDir, 'public');

const UNIVERSE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function isUniverseId(id) {
  return typeof id === 'string' && UNIVERSE_ID_RE.test(id);
}

export function universeDir(id) {
  return join(universesDir, id);
}

export function slugify(input, { maxLength = 60 } = {}) {
  const ascii = (input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[șşȘŞ]/g, 's')
    .replace(/[țţȚŢ]/g, 't')
    .toLowerCase();
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'universe';
}

export async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function listProjectSkills() {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(skillsDir, entry.name);
    if (await fileExists(join(dir, 'SKILL.md'))) skills.push(entry.name);
  }
  return skills.sort();
}

/**
 * Ensures `<universe>/.agents/skills/<name>` symlinks to every project skill.
 * Stale links that no longer match a project skill are removed.
 */
export async function syncUniverseSkills(dir) {
  const linksDir = join(dir, '.agents', 'skills');
  await mkdir(linksDir, { recursive: true });
  const skills = await listProjectSkills();
  const expected = new Set(skills);
  for (const name of skills) {
    const linkPath = join(linksDir, name);
    const target = relative(linksDir, join(skillsDir, name));
    let current = null;
    try {
      current = await readlink(linkPath);
    } catch {
      current = null;
    }
    if (current === target) continue;
    if (current !== null) await unlink(linkPath);
    await symlink(target, linkPath);
  }
  let existing = [];
  try {
    existing = await readdir(linksDir);
  } catch {
    existing = [];
  }
  for (const name of existing) {
    if (expected.has(name)) continue;
    const linkPath = join(linksDir, name);
    try {
      const current = await readlink(linkPath);
      if (current.includes('skills/')) await unlink(linkPath);
    } catch {
      // real directory or file: leave it alone
    }
  }
  return skills;
}

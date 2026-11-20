import type { DatabaseSync } from 'node:sqlite';
import { favoriteFolderIds, favoriteFolderSchema, type FavoriteFolder, type FavoriteLibrary, type FavoriteMembership } from '../../contracts/src/favorites.ts';

// A problem row means it is saved, including when its list of folder IDs is empty.
// These keys travel with the same portable catalog metadata as ordered goal lists.
export const FAVORITE_FOLDER_PREFIX = 'favorite:v1:folder:';
export const FAVORITE_PROBLEM_PREFIX = 'favorite:v1:problem:';

/** Read saved identifiers and their folders without loading or paginating the problem catalog. */
export function readFavoriteMemberships(db: DatabaseSync): FavoriteMembership[] {
  return db.prepare('SELECT key, value FROM catalog_meta WHERE key GLOB ?').all(FAVORITE_PROBLEM_PREFIX + '*')
    .map(row => ({ frontendId: String(row.key).slice(FAVORITE_PROBLEM_PREFIX.length), folderIds: JSON.parse(String(row.value)) }));
}

export function readFavoriteFolders(db: DatabaseSync): FavoriteFolder[] {
  return db.prepare(`SELECT substr(key, ?) AS id, value AS name FROM catalog_meta
    WHERE key GLOB ? ORDER BY value COLLATE NOCASE, key`)
    .all(FAVORITE_FOLDER_PREFIX.length + 1, FAVORITE_FOLDER_PREFIX + '*')
    .map(row => ({ id: String(row.id), name: String(row.name) }));
}

export function readFavoriteLibrary(db: DatabaseSync): FavoriteLibrary {
  const counts = db.prepare(`SELECT member.value AS id, count(*) AS count
    FROM catalog_meta AS problem, json_each(problem.value) AS member
    WHERE problem.key GLOB ? GROUP BY member.value`).all(FAVORITE_PROBLEM_PREFIX + '*');
  const byFolder = new Map(counts.map(row => [String(row.id), Number(row.count)]));
  const total = db.prepare('SELECT count(*) AS n FROM catalog_meta WHERE key GLOB ?').get(FAVORITE_PROBLEM_PREFIX + '*');
  return {
    total: Number(total!.n),
    folders: readFavoriteFolders(db).map(folder => ({ ...folder, count: byFolder.get(folder.id) ?? 0 })),
  };
}

/** Check portable references before a restore or a device sync replaces the current profile. */
export function validateFavorites(rows: { key: string; value: string }[], problems: { frontend_question_id: string }[], version: number) {
  const favoriteRows = rows.filter(row => row.key.startsWith('favorite:v1:'));
  if (!favoriteRows.length) return;
  if (version !== 5) throw new Error('Favorites require Bundle v5.');
  const folders = new Set<string>();
  const names = new Set<string>();
  for (const row of favoriteRows.filter(row => row.key.startsWith(FAVORITE_FOLDER_PREFIX))) {
    const { id, name } = favoriteFolderSchema.parse({ id: row.key.slice(FAVORITE_FOLDER_PREFIX.length), name: row.value });
    if (name !== row.value || names.has(name.toLowerCase())) throw new Error('Invalid favorite folder name.');
    folders.add(id);
    names.add(name.toLowerCase());
  }
  const catalog = new Set(problems.map(problem => problem.frontend_question_id));
  for (const { key, value } of favoriteRows) {
    if (key.startsWith(FAVORITE_FOLDER_PREFIX)) continue;
    if (!key.startsWith(FAVORITE_PROBLEM_PREFIX) || !catalog.has(key.slice(FAVORITE_PROBLEM_PREFIX.length))) {
      throw new Error('Unknown favorite problem.');
    }
    if (favoriteFolderIds.parse(JSON.parse(value)).some(id => !folders.has(id))) throw new Error('Unknown favorite folder.');
  }
}

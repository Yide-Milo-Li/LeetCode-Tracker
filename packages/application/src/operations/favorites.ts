import { z } from 'zod';
import { addFavoritesSchema, favoriteFolderSchema, removeFavoritesSchema, restoreFavoritesSchema, saveFavoriteFolderSchema, saveFavoriteSchema, type FavoriteFolder } from '../../../contracts/src/favorites.ts';
import { FAVORITE_FOLDER_PREFIX, FAVORITE_PROBLEM_PREFIX, readFavoriteFolders, readFavoriteLibrary, readFavoriteMemberships } from '../../../database/src/favorites.ts';
import type { ApplicationContext } from '../context.ts';
import { fail } from '../errors.ts';

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) fail(400, { error: 'INVALID_INPUT', issues: result.error.issues });
  return result.data;
}

export function createFavoriteOperations({ store, writeLock }: ApplicationContext) {
  const { db } = store;
  function write<T>(run: () => T, backup: 'scheduled' | 'before' = 'scheduled') {
    return writeLock.run(() => store.protectedTransaction(run, backup));
  }
  function putFolder({ id, name }: FavoriteFolder, expectedName: string | null) {
    const folders = readFavoriteFolders(db);
    const current = folders.find(folder => folder.id === id)?.name ?? null;
    if (current === name) return;
    if (current !== expectedName) fail(409, { error: 'STALE_FAVORITE_FOLDER' });
    if (folders.some(folder => folder.id !== id && folder.name.toLowerCase() === name.toLowerCase())) {
      fail(409, { error: 'FAVORITE_FOLDER_NAME_TAKEN' });
    }
    db.prepare('INSERT OR REPLACE INTO catalog_meta(key, value) VALUES(?, ?)').run(FAVORITE_FOLDER_PREFIX + id, name);
  }
  function requireFolders(ids: string[]) {
    if (!ids.length) return;
    const known = new Set(readFavoriteFolders(db).map(folder => folder.id));
    if (ids.some(id => !known.has(id))) fail(409, { error: 'STALE_FAVORITE_FOLDER' });
  }
  return {
    library: async () => readFavoriteLibrary(db),
    memberships: async (frontendIds?: string[]) => ({ items: readFavoriteMemberships(db, frontendIds) }),
    saveFolder(input: unknown) {
      const folder = parse(saveFavoriteFolderSchema, input);
      return write(() => {
        putFolder(folder, folder.expectedName);
        return { id: folder.id, name: folder.name };
      });
    },
    deleteFolder(input: unknown) {
      const { id, name } = parse(favoriteFolderSchema, input);
      return write(() => {
        const key = FAVORITE_FOLDER_PREFIX + id;
        const current = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(key);
        if (!current) return { ok: true };
        if (current.value !== name) fail(409, { error: 'STALE_FAVORITE_FOLDER' });
        db.prepare(`UPDATE catalog_meta SET value =
          (SELECT json_group_array(value) FROM json_each(catalog_meta.value) WHERE value <> ?)
          WHERE key GLOB ? AND EXISTS (SELECT 1 FROM json_each(catalog_meta.value) WHERE value = ?)`)
          .run(id, FAVORITE_PROBLEM_PREFIX + '*', id);
        db.prepare('DELETE FROM catalog_meta WHERE key=?').run(key);
        return { ok: true };
      }, 'before');
    },
    saveProblem(input: unknown) {
      const { frontendId, expectedFolderIds, folderIds, newFolder } = parse(saveFavoriteSchema, input);
      return write(() => {
        if (!db.prepare('SELECT 1 FROM problems WHERE frontend_question_id=?').get(frontendId)) {
          fail(404, { error: 'FAVORITE_PROBLEM_NOT_FOUND' });
        }
        const key = FAVORITE_PROBLEM_PREFIX + frontendId;
        const row = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(key);
        const current = row ? (JSON.parse(String(row.value)) as string[]).sort() : null;
        const next = folderIds?.sort() ?? null;
        if (JSON.stringify(current) === JSON.stringify(next)) return { folderIds: current };
        if (JSON.stringify(current) !== JSON.stringify(expectedFolderIds?.sort() ?? null)) fail(409, { error: 'STALE_FAVORITE' });
        if (newFolder) putFolder(newFolder, null);
        if (next === null) {
          db.prepare('DELETE FROM catalog_meta WHERE key=?').run(key);
        } else {
          requireFolders(next);
          db.prepare('INSERT OR REPLACE INTO catalog_meta(key, value) VALUES(?, ?)').run(key, JSON.stringify(next));
        }
        return { folderIds: next };
      });
    },
    addProblems(input: unknown) {
      const { frontendIds, folderIds, newFolder } = parse(addFavoritesSchema, input);
      return write(() => {
        if (newFolder) putFolder(newFolder, null);
        requireFolders(folderIds);
        const read = db.prepare(`SELECT favorite.value AS folders FROM problems p
          LEFT JOIN catalog_meta favorite ON favorite.key = ? || p.frontend_question_id
          WHERE p.frontend_question_id = ?`);
        const save = db.prepare('INSERT OR REPLACE INTO catalog_meta(key, value) VALUES(?, ?)');
        const ids = new Set(frontendIds);
        for (const id of ids) {
          const row = read.get(FAVORITE_PROBLEM_PREFIX, id);
          if (!row) fail(404, { error: 'FAVORITE_PROBLEM_NOT_FOUND', frontendId: id, message: id });
          const existing: string[] = row.folders === null ? [] : JSON.parse(String(row.folders));
          const merged = new Set([...existing, ...folderIds]);
          if (row.folders === null || merged.size !== existing.length) {
            save.run(FAVORITE_PROBLEM_PREFIX + id, JSON.stringify([...merged].sort()));
          }
        }
        return { count: ids.size };
      }, frontendIds.length > 1 ? 'before' : 'scheduled');
    },
    /**
     * Undo one change to favorites in a single transaction; see {@link restoreFavoritesSchema}.
     *
     * @throws 409 `STALE_FAVORITE` or `STALE_FAVORITE_FOLDER` when anything moved on since the
     * change; nothing is written then.
     */
    restoreProblems(input: unknown) {
      const { problems, createdFolder } = parse(restoreFavoritesSchema, input);
      return write(() => {
        const read = db.prepare('SELECT value FROM catalog_meta WHERE key=?');
        const sorted = (ids: string[] | null) => JSON.stringify(ids && [...ids].sort());
        for (const { frontendId, expectedFolderIds } of problems) {
          const row = read.get(FAVORITE_PROBLEM_PREFIX + frontendId);
          const current = row ? JSON.parse(String(row.value)) as string[] : null;
          if (sorted(current) !== sorted(expectedFolderIds)) fail(409, { error: 'STALE_FAVORITE', frontendId });
        }
        const folder = createdFolder && readFavoriteFolders(db).find(item => item.id === createdFolder.id);
        if (folder && folder.name !== createdFolder.name) fail(409, { error: 'STALE_FAVORITE_FOLDER' });
        for (const { frontendId, folderIds } of problems) {
          const key = FAVORITE_PROBLEM_PREFIX + frontendId;
          if (folderIds === null) {
            db.prepare('DELETE FROM catalog_meta WHERE key=?').run(key);
          } else {
            requireFolders(folderIds);
            db.prepare('INSERT OR REPLACE INTO catalog_meta(key, value) VALUES(?, ?)').run(key, JSON.stringify([...folderIds].sort()));
          }
        }
        // The folder goes only if it is as empty as the change found it.
        if (folder) {
          const used = db.prepare(`SELECT 1 FROM catalog_meta WHERE key GLOB ?
            AND EXISTS (SELECT 1 FROM json_each(catalog_meta.value) WHERE value = ?) LIMIT 1`).get(FAVORITE_PROBLEM_PREFIX + '*', folder.id);
          if (!used) db.prepare('DELETE FROM catalog_meta WHERE key=?').run(FAVORITE_FOLDER_PREFIX + folder.id);
        }
        return { restored: problems.length };
      }, 'before');
    },
    removeProblems(input: unknown) {
      const { expected } = parse(removeFavoritesSchema, input);
      return write(() => {
        const read = db.prepare('SELECT value FROM catalog_meta WHERE key=?');
        const remove = db.prepare('DELETE FROM catalog_meta WHERE key=?');
        let removed = 0;
        for (const { frontendId, folderIds } of expected) {
          const key = FAVORITE_PROBLEM_PREFIX + frontendId;
          const row = read.get(key);
          if (!row) continue; // Already removed, including a retry after a lost response.
          const current: string[] = JSON.parse(String(row.value));
          if (JSON.stringify(current.sort()) !== JSON.stringify(folderIds.sort())) {
            fail(409, { error: 'STALE_FAVORITES', frontendId });
          }
          remove.run(key);
          removed++;
        }
        return { removed };
      }, expected.length > 1 ? 'before' : 'scheduled');
    },
  };
}

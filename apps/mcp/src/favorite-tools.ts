import { z } from 'zod';
import {
  addFavoritesSchema, favoriteFolderSchema, removeFavoritesSchema, saveFavoriteFolderSchema, saveFavoriteSchema,
} from '../../../packages/contracts/src/favorites.ts';
import { json, type Registrar } from './registrar.ts';

export function registerFavoriteTools({ register }: Registrar) {
  register('tracker_get_favorite_folders', {
    description: 'Page favorite folders with counts and IDs. Use favoriteScope on tracker_search_problems to browse their problems.',
    inputSchema: z.object({ page: z.int().min(1).default(1), limit: z.int().min(1).max(100).default(25) }),
  }, async (app, { page, limit }) => {
    const { total, folders } = await app.favorites.library();
    return json({ totalFavorites: total, totalFolders: folders.length, folders: folders.slice((page - 1) * limit, page * limit),
      page, nextPage: page * limit < folders.length ? page + 1 : null });
  });
  register('tracker_save_favorite_folder', {
    description: 'Create with a client UUID and expectedName null, or rename with the current expectedName.',
    inputSchema: saveFavoriteFolderSchema,
  }, async (app, args) => json(await app.favorites.saveFolder(args)), 'write', { destructive: false, idempotent: true });
  register('tracker_delete_favorite_folder', {
    description: 'Delete the named folder. Its problems remain starred.',
    inputSchema: favoriteFolderSchema,
  }, async (app, args) => json(await app.favorites.deleteFolder(args)), 'write', { destructive: true, idempotent: true });
  register('tracker_set_favorite', {
    description: 'Set one star using favoriteFolderIds from search or lookup as expectedFolderIds. folderIds null removes the star, [] stars without folders.',
    inputSchema: saveFavoriteSchema,
  }, async (app, args) => json(await app.favorites.saveProblem(args)), 'write', { destructive: true, idempotent: true });
  register('tracker_add_favorites', {
    description: 'Star all supplied problems in one transaction, merging the chosen folders with any existing memberships.',
    inputSchema: addFavoritesSchema,
  }, async (app, args) => json(await app.favorites.addProblems(args)), 'write', { destructive: false, idempotent: true });
  register('tracker_remove_favorites', {
    description: 'Remove the reviewed stars from all folders atomically. Supply current folderIds per problem; reread after a membership conflict.',
    inputSchema: removeFavoritesSchema,
  }, async (app, args) => json(await app.favorites.removeProblems(args)), 'write', { destructive: true, idempotent: true });
}

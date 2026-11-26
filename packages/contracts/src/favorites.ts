import { z } from 'zod';
import type { CatalogProblem } from './sync.ts';

export const favoriteFolderName = z.string().trim().min(1).max(100);
export const favoriteFolderSchema = z.object({ id: z.uuid(), name: favoriteFolderName }).strict();
export type FavoriteFolder = z.infer<typeof favoriteFolderSchema>;
export interface FavoriteMembership {
  frontendId: string;
  folderIds: string[];
}
export interface FavoriteLibrary {
  total: number;
  folders: Array<FavoriteFolder & { count: number }>;
}

export const favoriteFolderIds = z.array(z.uuid()).refine(ids => new Set(ids).size === ids.length);
const frontendId = z.string().min(1).max(100);
export const saveFavoriteSchema = z.object({
  frontendId,
  expectedFolderIds: favoriteFolderIds.nullable(),
  folderIds: favoriteFolderIds.nullable(),
  newFolder: favoriteFolderSchema.optional(),
}).strict().refine(input => !input.newFolder || input.folderIds?.includes(input.newFolder.id));
export type SaveFavorite = z.infer<typeof saveFavoriteSchema>;
export const addFavoritesSchema = z.object({
  frontendIds: z.array(frontendId).min(1),
  folderIds: favoriteFolderIds,
  newFolder: favoriteFolderSchema.optional(),
}).strict().refine(input => !input.newFolder || input.folderIds.includes(input.newFolder.id));
export type AddFavorites = z.infer<typeof addFavoritesSchema>;
export const removeFavoritesSchema = z.object({
  expected: z.array(z.object({ frontendId, folderIds: favoriteFolderIds }).strict()).min(1)
    .refine(items => new Set(items.map(item => item.frontendId)).size === items.length),
}).strict();
export type RemoveFavorites = z.infer<typeof removeFavoritesSchema>;
/**
 * Put problems back to the folders they had before one change, all of them or none: each must
 * still be in `expectedFolderIds`. `createdFolder` is a folder that change created; it is removed
 * when nothing is left in it, and the restore is refused if it was renamed since.
 */
export const restoreFavoritesSchema = z.object({
  problems: z.array(z.object({ frontendId, expectedFolderIds: favoriteFolderIds, folderIds: favoriteFolderIds.nullable() }).strict()).max(100)
    .refine(items => new Set(items.map(item => item.frontendId)).size === items.length),
  createdFolder: favoriteFolderSchema.optional(),
}).strict();
export type RestoreFavorites = z.infer<typeof restoreFavoritesSchema>;
export const saveFavoriteFolderSchema = favoriteFolderSchema.extend({ expectedName: favoriteFolderName.nullable() });

/** Present only for saved problems in a catalog query requesting favorite state. */
export type CatalogListProblem = CatalogProblem & { favoriteFolderIds?: string[] };

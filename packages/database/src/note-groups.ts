import type { DatabaseSync } from 'node:sqlite';
import type { ProblemNoteListQuery } from '../../contracts/src/notes.ts';
import { readFavoriteFolders, readFavoriteMemberships } from './favorites.ts';
import { readGoalLists } from './goal-lists.ts';

/** Intersect portable list memberships with all matching problems before paging a group. */
export function groupNoteProblems(db: DatabaseSync, groupBy: Exclude<ProblemNoteListQuery['groupBy'], 'none'>, matchingIds: string[]) {
  const remaining = new Set(matchingIds);
  const groups: Array<{ id: string; name: string | null; frontendIds: string[] }> = [];
  if (groupBy === 'goal') {
    const matches = new Set(matchingIds);
    for (const list of readGoalLists(db)) {
      const frontendIds = list.items.map(item => item.frontendId).filter(id => matches.has(id));
      if (frontendIds.length) groups.push({ id: list.id, name: list.name, frontendIds });
      for (const id of frontendIds) remaining.delete(id);
    }
  } else {
    const folders = readFavoriteFolders(db).map(folder => ({ ...folder, frontendIds: [] as string[] }));
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const unfiled: string[] = [];
    for (const { frontendId, folderIds } of readFavoriteMemberships(db, matchingIds)) {
      remaining.delete(frontendId);
      if (!folderIds.length) unfiled.push(frontendId);
      for (const id of folderIds) byId.get(id)?.frontendIds.push(frontendId);
    }
    groups.push(...folders.filter(folder => folder.frontendIds.length));
    if (unfiled.length) groups.push({ id: 'unfiled', name: null, frontendIds: unfiled });
  }
  if (remaining.size) groups.push({ id: 'unassigned', name: null, frontendIds: [...remaining] });
  return groups;
}

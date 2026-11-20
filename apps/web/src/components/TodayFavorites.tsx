import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { useAsyncResource } from '../hooks/useAsyncResource.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { FavoriteProblemEditor, FavoriteStarButton, type FavoriteEditorProblem } from './FavoriteFolders.tsx';
import { Feedback } from './ui.tsx';

interface TodayStarState {
  lang: Language;
  memberships?: ReadonlyMap<string, string[]> | null;
  ready: boolean;
  edit(problem: FavoriteEditorProblem): void;
}
const Stars = createContext<TodayStarState | null>(null);

/** Both Today lists share the same saved state and folder chooser. */
export function TodayFavorites({ lang, active, favoriteRevision, onChanged, children }: {
  lang: Language; active: boolean; favoriteRevision: number; onChanged?: () => void; children: ReactNode;
}) {
  const { revision } = useWorkspace();
  const zh = lang === 'zh';
  const [editing, setEditing] = useState<FavoriteEditorProblem | null>(null);
  const [retry, setRetry] = useState(0);
  const refresh = () => setRetry(value => value + 1);
  const memberships = useAsyncResource(async signal => {
    if (!active) return null;
    const items = await api.getFavoriteMemberships({ signal });
    return new Map(items.map(item => [item.frontendId, item.folderIds]));
  }, [active, favoriteRevision, revision, retry]);
  const editorOpen = active && editing !== null;
  const library = useAsyncResource(signal => editorOpen ? api.getFavoriteLibrary({ signal }) : Promise.resolve(null),
    [editorOpen, favoriteRevision, revision, retry]);
  useEffect(() => { if (!active) setEditing(null); }, [active]);

  const ready = active && !!memberships.data && !memberships.loading && !memberships.error;
  return <Stars.Provider value={{ lang, memberships: memberships.data, ready, edit: setEditing }}>
    {active && !!memberships.error && <Feedback retry={{ label: zh ? '重试' : 'Retry', run: refresh }}>
      {zh ? '无法读取题目的收藏状态。' : 'Could not load favorite status.'}
    </Feedback>}
    {children}
    {editorOpen && <FavoriteProblemEditor key={editing.questionFrontendId} target={{ problem: editing }}
      library={library.data} loadError={library.error} lang={lang} onClose={() => setEditing(null)}
      onRefresh={refresh} onSaved={() => {
        setEditing(null);
        refresh();
        onChanged?.();
      }} />}
  </Stars.Provider>;
}

export function TodayFavoriteStar({ frontendId, title }: { frontendId: string; title: string }) {
  const state = useContext(Stars);
  if (!state) return null;
  const zh = state.lang === 'zh';
  const folderIds = state.memberships?.get(frontendId);
  const saved = folderIds !== undefined;
  const action = saved ? (zh ? '管理收藏' : 'Manage favorite') : (zh ? '收藏题目' : 'Save to favorites');
  return <FavoriteStarButton saved={saved} label={`${action} #${frontendId} ${title}`} hint={action} ready={state.ready}
    onClick={() => state.edit({ questionFrontendId: frontendId, title, favoriteFolderIds: folderIds })} />;
}

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Star, Folder, FolderPlus } from 'lucide-react';
import type { CatalogListProblem, FavoriteFolder, FavoriteLibrary } from '../../../../packages/contracts/src/favorites.ts';
import { api, ApiError } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import { formatCount, type Language } from '../i18n.ts';
import { Dialog, Feedback, Field, Tooltip } from './ui.tsx';

import { useProblemListWindow } from '../hooks/useProblemListWindow.ts';
import { useAsyncResource } from '../hooks/useAsyncResource.ts';

/** Open the same folder chooser from either a catalog or a Today row. */
export function FavoriteStarButton({ saved, label, hint = label, ready = true, onClick }: {
  saved: boolean; label: string; hint?: string; ready?: boolean; onClick(): void;
}) {
  return <Tooltip text={hint} position="top">
    <button type="button" className={'btn-icon favorite-star' + (saved ? ' is-favorite' : '')}
      aria-label={label} aria-haspopup="dialog" aria-disabled={!ready} onClick={() => { if (ready) onClick(); }}>
      <Star size={18} aria-hidden="true" />
    </button>
  </Tooltip>;
}

export function FavoriteFolderPicker({ library, selected, lang, onSelect }: {
  library: FavoriteLibrary; selected: string; lang: Language; onSelect(id: string): void;
}) {
  const zh = lang === 'zh';
  const folders = [{ id: 'all', name: zh ? '全部收藏' : 'All favorites', count: library.total }, ...library.folders];
  if (library.folders.length > 8) {
    return <label className="favorite-folder-switcher">
      <span className="visually-hidden">{zh ? '选择收藏夹' : 'Choose a folder'}</span>
      <select value={selected} title={folders.find(folder => folder.id === selected)?.name} onChange={event => onSelect(event.currentTarget.value)}>
        {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name} ({formatCount(folder.count, lang)})</option>)}
      </select>
    </label>;
  }
  return <div className="favorite-folders" role="group" aria-label={zh ? '选择收藏夹' : 'Choose a folder'}>
    {folders.map(({ id, name, count }) => <button key={id} type="button" aria-pressed={id === selected}
      className="btn btn-secondary favorite-folder" onClick={() => onSelect(id)}>
      {id === 'all' ? <Star size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
      <span>{name}</span> <small>{formatCount(count, lang)}</small>
    </button>)}
  </div>;
}

function useFavoriteWrite(lang: Language, onRefresh: () => void) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(save: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await save();
    } catch (cause) {
      setError(localizeApiError(cause, lang));
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) onRefresh();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { busy, error, clearError: () => setError(''), submit };
}

const membershipKey = (row: { membership: { frontendId: string } }) => row.membership.frontendId;

export function RemoveFavoritesDialog({ problems, library, lang, onClose, onRemoved, onRefresh }: {
  problems: CatalogListProblem[]; library?: FavoriteLibrary | null; lang: Language;
  onClose(): void; onRemoved(count: number): void; onRefresh(): void;
}) {
  const zh = lang === 'zh';
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (revision) cancelButton.current?.focus();
  }, [revision]);
  const review = useAsyncResource(async signal => {
    const memberships = new Map((await api.getFavoriteMemberships({ signal })).map(item => [item.frontendId, item]));
    return problems.flatMap(problem => {
      const membership = memberships.get(problem.questionFrontendId);
      return membership ? [{ membership, title: problem.title }] : [];
    });
  }, [problems, revision]);
  const { busy, error, submit } = useFavoriteWrite(lang, () => {
    setRevision(value => value + 1);
    onRefresh();
  });
  const rows = review.data ?? [];
  const list = useRef<HTMLUListElement>(null);
  const windowed = useProblemListWindow(rows, membershipKey, list, 56);
  const folderNames = useMemo(() => new Map(library?.folders.map(folder => [folder.id, folder.name])), [library]);
  const ready = !review.loading && !review.error && !!review.data;
  function confirm() {
    if (!ready || !rows.length) return;
    void submit(async () => {
      const result = await api.removeFavorites({ expected: rows.map(row => row.membership) });
      onRemoved(result.removed);
    });
  }
  const footer = <div className="favorite-form-actions">
    <button type="button" className="btn btn-secondary" ref={cancelButton} disabled={busy}
      onClick={ready && !rows.length ? () => onRemoved(0) : onClose}>
      {ready && !rows.length ? (zh ? '完成' : 'Done') : (zh ? '取消' : 'Cancel')}
    </button>
    {(!ready || rows.length > 0) && <button type="button" className="btn btn-danger" disabled={!ready || busy} onClick={confirm}>
      {zh ? '确认取消收藏' : 'Confirm removal'}
    </button>}
  </div>;
  return <Dialog title={zh ? '批量取消收藏' : 'Remove favorites'} lang={lang} onClose={onClose}
    initialFocusRef={cancelButton} closeDisabled={busy} footer={footer}>
    {review.loading ? <p role="status">{zh ? '正在核对收藏状态…' : 'Checking favorite memberships…'}</p>
      : review.error ? <Feedback retry={{ label: zh ? '重试' : 'Retry', run: () => setRevision(value => value + 1) }}>
        {localizeApiError(review.error, lang)}
      </Feedback> : rows.length ? <>
        <p>{zh ? `将从「全部收藏」及所属收藏夹中移除 ${formatCount(rows.length, lang)} 道题。已有题单和练习记录会保留。`
          : `Remove ${formatCount(rows.length, lang)} ${rows.length === 1 ? 'problem' : 'problems'} from All favorites and every folder containing them? Goal lists and practice history will be kept.`}</p>
        <ul className="favorite-removal-list" ref={list} role="list" tabIndex={0}
          aria-label={zh ? '将取消收藏的题目' : 'Problems to remove from favorites'} {...windowed.listProps}>
          {windowed.renderRows(({ membership, title }, _index, rowProps) => {
            const names = membership.folderIds.map(id => folderNames.get(id)).filter(Boolean);
            return <li key={membership.frontendId} {...rowProps}>#{membership.frontendId} {title}
              {names.length > 0 && <small>{names.join(zh ? '、' : ', ')}</small>}
            </li>;
          })}
        </ul>
      </> : <p>{zh ? '所选题目均已取消收藏。' : 'The selected problems are already out of your favorites.'}</p>}
    {error && (!ready || rows.length > 0) && <Feedback>{error}</Feedback>}
  </Dialog>;
}

export function FavoriteFolderEditor({ folder, lang, onClose, onSaved, onRefresh }: {
  folder: FavoriteFolder | null; lang: Language; onClose(): void; onSaved(id: string): void; onRefresh(): void;
}) {
  const zh = lang === 'zh';
  const [id] = useState(() => folder?.id ?? crypto.randomUUID());
  const [name, setName] = useState(folder?.name ?? '');
  const [deleting, setDeleting] = useState(false);
  const { busy, error, submit } = useFavoriteWrite(lang, onRefresh);
  const title = deleting ? (zh ? '删除收藏夹' : 'Delete folder') : folder
    ? (zh ? '编辑收藏夹' : 'Edit folder') : (zh ? '新建收藏夹' : 'New folder');
  return <Dialog title={title} lang={lang} onClose={onClose} closeDisabled={busy}>
    <form className="favorite-form" aria-label={title} onSubmit={event => {
      event.preventDefault();
      void submit(async () => {
        if (deleting && folder) {
          await api.deleteFavoriteFolder(folder);
          onSaved('all');
        } else {
          await api.saveFavoriteFolder({ id, name: name.trim() }, folder?.name ?? null);
          onSaved(id);
        }
      });
    }}>
      {deleting ? <p>{zh ? `删除「${folder?.name}」？其中的题目仍可在「全部收藏」中查看。`
        : `Delete “${folder?.name}”? Its problems will stay in All favorites.`}</p> :
        <Field label={zh ? '收藏夹名称' : 'Folder name'}>
          <input name="folderName" required maxLength={100} pattern={'.*\\S.*'} autoComplete="off"
            value={name} onChange={event => setName(event.target.value)} disabled={busy} />
        </Field>}
      {error && <Feedback>{error}</Feedback>}
      <div className="favorite-form-actions">
        {folder && !deleting && <button type="button" className="text-link danger-text" disabled={busy}
          onClick={() => setDeleting(true)}>{zh ? '删除收藏夹' : 'Delete folder'}</button>}
        <button type="button" className="btn btn-secondary" disabled={busy}
          onClick={deleting ? () => setDeleting(false) : onClose}>{zh ? '取消' : 'Cancel'}</button>
        <button type="submit" className={deleting ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy}>
          {deleting ? (zh ? '确认删除' : 'Confirm deletion') : (zh ? '保存' : 'Save')}
        </button>
      </div>
    </form>
  </Dialog>;
}

export type FavoriteEditorProblem = Pick<CatalogListProblem, 'questionFrontendId' | 'title' | 'favoriteFolderIds'>;
export type FavoriteEditorTarget = { problem: FavoriteEditorProblem; frontendIds?: never } | { frontendIds: string[]; problem?: never };

export function FavoriteProblemEditor({ target: { problem, frontendIds }, library, loadError, lang, onClose, onSaved, onRefresh }: {
  target: FavoriteEditorTarget; library?: FavoriteLibrary | null; loadError: unknown; lang: Language;
  onClose(): void; onSaved(action: 'saved' | 'removed'): void; onRefresh(): void;
}) {
  const zh = lang === 'zh';
  const wasSaved = problem?.favoriteFolderIds !== undefined;
  const [selected, setSelected] = useState(problem?.favoriteFolderIds ?? []);
  const selectedFolders = useMemo(() => new Set(selected), [selected]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newId] = useState(() => crypto.randomUUID());
  const { busy, error, clearError, submit } = useFavoriteWrite(lang, onRefresh);
  const newFieldId = useId();
  const title = frontendIds ? (zh ? `收藏选中的 ${formatCount(frontendIds.length, lang)} 道题` : `Favorite ${formatCount(frontendIds.length, lang)} selected ${frontendIds.length === 1 ? 'problem' : 'problems'}`)
    : wasSaved ? (zh ? '管理收藏' : 'Manage favorite') : (zh ? '收藏题目' : 'Save to favorites');
  function save(folderIds: string[] | null) {
    const newFolder = creating && folderIds !== null ? { id: newId, name: newName.trim() } : undefined;
    const destinations = newFolder && folderIds ? [...folderIds, newFolder.id] : folderIds;
    void submit(async () => {
      if (frontendIds) {
        if (!destinations) return;
        await api.addFavorites({ frontendIds, folderIds: destinations, newFolder });
      } else {
        await api.saveFavorite({
          frontendId: problem.questionFrontendId, expectedFolderIds: problem.favoriteFolderIds ?? null,
          folderIds: destinations, newFolder,
        });
      }
      onSaved(destinations === null ? 'removed' : 'saved');
    });
  }
  const formId = useId();
  const footer = <div className="favorite-form-actions">
    {wasSaved && library && !loadError && <button type="button" disabled={busy} className="text-link danger-text"
      onClick={() => save(null)}>{zh ? '取消收藏' : 'Remove from favorites'}</button>}
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
    <button type="submit" form={formId} className="btn btn-primary" disabled={busy || !library || !!loadError}>{zh ? '保存收藏' : frontendIds ? 'Save favorites' : 'Save favorite'}</button>
  </div>;
  return <Dialog title={title} lang={lang} onClose={onClose} closeDisabled={busy} footer={footer}>
    {problem ? <p className="favorite-problem-title">#{problem.questionFrontendId} {problem.title}</p>
      : <p>{zh ? '所选题目将存入「全部收藏」，并加入下方勾选的收藏夹。已有的收藏夹归属会保留。'
        : 'Save these problems in All favorites and any folders you check below. Existing folder memberships are kept.'}</p>}
    {loadError ? <Feedback retry={{ label: zh ? '重试' : 'Retry', run: onRefresh }}>
      {localizeApiError(loadError, lang)}
    </Feedback> : !library ? <p role="status">{zh ? '正在读取收藏夹…' : 'Loading folders…'}</p> :
      <form id={formId} className="favorite-form" aria-label={title} onChange={clearError} onSubmit={event => {
        event.preventDefault();
        save(library.folders.filter(folder => selectedFolders.has(folder.id)).map(folder => folder.id));
      }}>
        {(!frontendIds || library.folders.length > 0) && <fieldset className="favorite-choices" disabled={busy}>
          <legend>{zh ? '收藏夹（可多选）' : 'Folders (optional)'}</legend>
          {library.folders.map(folder => <label key={folder.id} className="favorite-choice">
            <input type="checkbox" name="folder" value={folder.id} checked={selectedFolders.has(folder.id)}
              onChange={event => {
                const checked = event.currentTarget.checked;
                setSelected(ids => checked ? [...ids, folder.id] : ids.filter(id => id !== folder.id));
              }} />
            <span>{folder.name}</span>
          </label>)}
          {!frontendIds && !library.folders.length && <p className="muted">{zh ? '可以直接保存到「全部收藏」，也可以新建收藏夹。'
            : 'Save in All favorites, or create a folder below.'}</p>}
        </fieldset>}
        <button type="button" className="text-link" disabled={busy} aria-expanded={creating} aria-controls={newFieldId}
          onClick={() => { clearError(); setCreating(value => !value); }}>
          <FolderPlus size={16} aria-hidden="true" />{creating ? (zh ? '取消新建' : 'Cancel new folder') : (zh ? '新建收藏夹' : 'New folder')}
        </button>
        <div id={newFieldId} hidden={!creating}>
          {creating && <Field label={zh ? '新收藏夹名称' : 'New folder name'}>
            <input name="newFolder" autoFocus required maxLength={100} pattern={'.*\\S.*'} autoComplete="off"
              value={newName} onChange={event => setNewName(event.target.value)} disabled={busy} />
          </Field>}
        </div>
        {error && <Feedback>{error}</Feedback>}
      </form>}
  </Dialog>;
}

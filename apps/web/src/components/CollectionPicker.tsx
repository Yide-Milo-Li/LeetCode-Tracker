import { useId, useMemo, useRef, useState, type Dispatch, type ReactNode, type Ref, type SetStateAction } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useCollectionPages, type NamedCollection } from '../hooks/useCollectionPages.ts';
import { formatCount, type Language } from '../i18n.ts';
import { Dialog, Field, Pagination, SortDirectionButton, type SortDirection } from './ui.tsx';

export const COLLECTION_PICKER_PAGE_SIZE = 8;

export function CollectionSearch({ label, query, onSearch, inputRef }: {
  label: string; query: string; onSearch(query: string): void; inputRef?: Ref<HTMLInputElement>;
}) {
  return <div className="collection-search" role="search" aria-label={label}>
    <Field label={label}>
      <input type="search" name="collectionSearch" autoComplete="off" autoCorrect="off" spellCheck={false}
        ref={inputRef} value={query} onChange={event => onSearch(event.currentTarget.value)}
        onKeyDown={event => {
          // Filtering inside a membership form must not implicitly save the current selection.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) event.preventDefault();
        }} />
    </Field>
  </div>;
}

export function CollectionSort({ lang, field, direction, onFieldChange, onDirectionChange, children }: {
  lang: Language; field: string; direction: SortDirection; onFieldChange(field: string): void;
  onDirectionChange(direction: SortDirection): void; children: ReactNode;
}) {
  const id = useId();
  return <div className="form-field">
    <label htmlFor={id}>{lang === 'zh' ? '排序方式' : 'Sort by'}</label>
    <div className="collection-sort-field">
      <select id={id} value={field} onChange={event => onFieldChange(event.currentTarget.value)}>{children}</select>
      <SortDirectionButton direction={direction} lang={lang} onChange={onDirectionChange} />
    </div>
  </div>;
}

interface PickerOption extends NamedCollection {
  detail?: string;
  count?: number;
}

interface FolderSort {
  field: string;
  direction?: SortDirection;
}

export function CollectionPicker({ options, selected, label, searchLabel, lang, disabled, onSelect }: {
  options: PickerOption[]; selected?: string; label: string; searchLabel: string; lang: Language;
  disabled?: boolean; onSelect(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<FolderSort>({ field: 'name' });
  const current = options.find(option => option.id === selected);
  return <>
    <button type="button" className="btn btn-secondary collection-picker-trigger" aria-haspopup="dialog"
      aria-label={current ? label + ' · ' + current.name : label} title={current?.name}
      disabled={disabled} onClick={() => setOpen(true)}>
      <span>{current?.name ?? label}</span>
      {current?.detail && <small>{current.detail}</small>}
      <ChevronsUpDown size={16} aria-hidden="true" />
    </button>
    {open && <CollectionPickerDialog options={options} selected={selected} label={label} searchLabel={searchLabel} lang={lang}
      sort={sort} onSort={setSort}
      onClose={() => setOpen(false)} onSelect={id => {
        setOpen(false);
        onSelect(id);
      }} />}
  </>;
}

function CollectionPickerDialog({ options, selected, label, searchLabel, lang, sort, onSort, onClose, onSelect }: {
  options: PickerOption[]; selected?: string; label: string; searchLabel: string; lang: Language;
  sort: FolderSort; onSort(sort: FolderSort): void;
  onClose(): void; onSelect(id: string): void;
}) {
  const { field } = sort;
  const direction = sort.direction ?? (field === 'count' ? 'desc' : 'asc');
  const sorted = useMemo(() => {
    const byName = new Intl.Collator(lang, { numeric: true });
    const sign = direction === 'asc' ? 1 : -1;
    return options.toSorted((a, b) => {
      const names = byName.compare(a.name, b.name);
      return field === 'count' ? sign * ((a.count ?? 0) - (b.count ?? 0)) || names : sign * names;
    });
  }, [options, field, direction, lang]);
  const directory = useCollectionPages(sorted, COLLECTION_PICKER_PAGE_SIZE, selected);
  const input = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  const zh = lang === 'zh';
  function changeSort(next: FolderSort) {
    onSort(next);
    directory.pagination.onPage(1);
    if (rows.current) rows.current.scrollTop = 0;
  }
  return <Dialog title={label} lang={lang} onClose={onClose} initialFocusRef={input}>
    <div className="collection-picker">
      <div className="collection-picker-tools">
        <CollectionSearch label={searchLabel} query={directory.query} inputRef={input} onSearch={query => {
          directory.search(query);
          if (rows.current) rows.current.scrollTop = 0;
        }} />
        {options.some(option => option.count !== undefined) && <CollectionSort lang={lang} field={field} direction={direction}
          onFieldChange={field => changeSort({ ...sort, field })} onDirectionChange={direction => changeSort({ ...sort, direction })}>
          <option value="name">{zh ? '名称' : 'Name'}</option>
          <option value="count">{zh ? '收藏题数' : 'Problem count'}</option>
        </CollectionSort>}
      </div>
      {directory.pagination.total > COLLECTION_PICKER_PAGE_SIZE && <Pagination {...directory.pagination} lang={lang}
        onPage={page => {
          directory.pagination.onPage(page);
          if (rows.current) rows.current.scrollTop = 0;
        }} />}
      {directory.items.length > 0
        ? <ul className="collection-picker-rows" role="list" ref={rows}>
          {directory.items.map(option => <li key={option.id}>
            <button type="button" className="collection-picker-option" aria-current={option.id === selected ? 'true' : undefined}
              onClick={() => onSelect(option.id)}>
              <span>{option.name}</span>{' '}
              {option.detail && <small>{option.detail}</small>}
              {option.id === selected && <Check size={16} aria-hidden="true" />}
            </button>
          </li>)}
        </ul>
        : <p className="text-muted" role="status">{lang === 'zh' ? '没有匹配项。' : 'No matches.'}</p>}
    </div>
  </Dialog>;
}

export function CollectionChoices({ options, selected, onChange, label, searchLabel, name, lang, disabled }: {
  options: NamedCollection[]; selected: string[]; onChange: Dispatch<SetStateAction<string[]>>;
  label: string; searchLabel: string; name: string; lang: Language; disabled: boolean;
}) {
  const directory = useCollectionPages(options, COLLECTION_PICKER_PAGE_SIZE);
  const large = options.length > COLLECTION_PICKER_PAGE_SIZE;
  const checked = new Set(selected);
  const rows = useRef<HTMLDivElement>(null);
  const count = formatCount(selected.length, lang);
  return <fieldset className="favorite-choices collection-choices" disabled={disabled}>
    <legend>{label}</legend>
    {(large || directory.query) && <div className="collection-choice-tools">
      <CollectionSearch label={searchLabel} query={directory.query} onSearch={query => {
        directory.search(query);
        if (rows.current) rows.current.scrollTop = 0;
      }} />
      <small role="status">{lang === 'zh' ? `已选 ${count} 项` : `${count} selected`}</small>
    </div>}
    {directory.pagination.total > COLLECTION_PICKER_PAGE_SIZE && <Pagination {...directory.pagination} lang={lang}
      onPage={page => {
        directory.pagination.onPage(page);
        if (rows.current) rows.current.scrollTop = 0;
      }} />}
    <div className="collection-picker-rows" ref={rows}>
      {directory.items.map(option => <label key={option.id} className="favorite-choice">
        <input type="checkbox" name={name} value={option.id} checked={checked.has(option.id)}
          onChange={event => {
            const include = event.currentTarget.checked;
            onChange(previous => include ? [...previous, option.id] : previous.filter(id => id !== option.id));
          }} />
        <span>{option.name}</span>
      </label>)}
      {directory.items.length === 0 && <p className="text-muted" role="status">{lang === 'zh' ? '没有匹配项。' : 'No matches.'}</p>}
    </div>
  </fieldset>;
}

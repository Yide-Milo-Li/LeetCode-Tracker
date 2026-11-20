import { useEffect, useId, useState } from 'react';
import { api, type CatalogProblem } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';

/** Catalog search stays optional beside paste. Ignore superseded results while typing. */
export function GoalProblemPicker({
  label,
  selected,
  onAdd,
  lang,
}: {
  label: string;
  selected: string[];
  onAdd(problem: CatalogProblem): void;
  lang: Language;
}) {
  const zh = lang === 'zh';
  const id = useId();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<CatalogProblem[]>([]);
  const [status, setStatus] = useState('');
  const term = query.trim();
  useEffect(() => {
    let current = true;
    if (!term) return;
    const timer = setTimeout(() => {
      api
        .getCatalog({ search: term, limit: 12, page: 1 })
        .then((result) => {
          if (!current) return;
          setItems(result.items);
          setStatus(result.items.length ? '' : zh ? '题库中没有匹配题目。' : 'No matching catalog problems.');
        })
        .catch((err) => {
          if (current) setStatus(localizeApiError(err, lang));
        });
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [term, lang, zh]);
  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="form-input"
        type="search"
        value={query}
        placeholder={zh ? '搜索题号或题名' : 'Search by ID or title'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
        onChange={(e) => {
          const next = e.target.value;
          if (next.trim() !== term) {
            setItems([]);
            setStatus(zh ? '正在查找…' : 'Searching…');
          }
          setQuery(next);
        }}
      />
      {term && (
        <>
          <span role="status" className="text-muted">
            {status}
          </span>
          {items.length > 0 && (
            <ul className="goal-picker-results">
              {items.map((item) => (
                <li key={item.questionId}>
                  <button
                    type="button"
                    className="text-link"
                    disabled={selected.includes(item.questionFrontendId)}
                    onClick={() => onAdd(item)}
                  >
                    #{item.questionFrontendId} {item.title}{' '}
                    {selected.includes(item.questionFrontendId) ? '✓' : '+'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

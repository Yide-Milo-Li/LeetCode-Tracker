import { useEffect, useId, useState } from 'react';
import { api, type CatalogProblem } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';

/** Catalog search stays optional beside paste. Ignore superseded results while typing. */
export function GoalProblemPicker({
  replaceId,
  selected,
  onAdd,
  lang,
}: {
  replaceId: string | null;
  selected: string[];
  onAdd(problem: CatalogProblem): void;
  lang: Language;
}) {
  const zh = lang === 'zh';
  const label = replaceId ? (zh ? `替换 #${replaceId} 为` : `Replace #${replaceId} with`)
    : (zh ? '从题库添加' : 'Add from catalog');
  const id = useId();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<CatalogProblem[]>([]);
  const [status, setStatus] = useState('');
  const term = query.trim();
  useEffect(() => {
    let current = true;
    if (!term) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .getCatalog({ search: term, limit: 12, page: 1 }, { signal: controller.signal })
        .then((result) => {
          if (!current) return;
          setItems(result.items);
          setStatus(result.items.length ? '' : zh ? '题库中没有匹配题目。' : 'No matching catalog problems.');
        })
        .catch((err) => {
          if (current && !controller.signal.aborted) setStatus(localizeApiError(err, lang));
        });
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, lang, zh]);
  return (
    <div className="form-field">
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
          {status && <span role="status" className="text-muted">{status}</span>}
          {items.length > 0 && (
            <ul className="goal-picker-results">
              {items.map((item) => {
                const id = item.questionFrontendId;
                const included = selected.includes(id);
                return <li key={item.questionId}>
                  <button
                    type="button"
                    className="text-link"
                    disabled={included}
                    onClick={() => onAdd(item)}
                  >
                    #{id} {item.title} {included ? '✓' : '+'}
                  </button>
                </li>;
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

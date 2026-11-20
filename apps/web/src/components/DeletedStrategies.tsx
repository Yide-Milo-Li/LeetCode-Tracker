import { useEffect, useState } from 'react';
import { api, type Strategy } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useWorkspace } from '../workspace.tsx';

export function DeletedStrategies({ active, lang }: { active: Strategy[]; lang: Language }) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Strategy[]>([]);
  const [selected, setSelected] = useState<Strategy | null>(null);
  const [days, setDays] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    if (open)
      api
        .getDeletedStrategies()
        .then((result) => {
          if (live) {
            setItems(result.items);
            setError('');
          }
        })
        .catch((err) => {
          if (live) setError(localizeApiError(err, lang));
        });
    return () => {
      live = false;
    };
  }, [open, workspace.revision, lang]);
  const owner = (day: number) => active.find((strategy) => strategy.weekdays.includes(day));
  async function restore() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api.restoreStrategy(selected.id, selected.version, days);
      setSelected(null);
      setError('');
      workspace.notifyMutation();
    } catch (err) {
      setError(localizeApiError(err, lang));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="study-goal-options" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{zh ? '已删除的策略' : 'Deleted strategies'}</summary>
      {open && (
        <>
          {items.map((item) => (
            <div className="action-row" key={item.id}>
              <span>{item.name}</span>
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setSelected(item);
                  setDays(item.weekdays.filter((day) => !owner(day)));
                }}
              >
                {zh ? '恢复策略' : 'Restore strategy'}
              </button>
            </div>
          ))}
          {!items.length && !error && <p>{zh ? '没有已删除的策略。' : 'No deleted strategies.'}</p>}
          {selected && (
            <fieldset className="study-goal-fields" disabled={busy}>
              <legend>
                {selected.name} · {zh ? '恢复到哪些星期' : 'Restore weekdays'}
              </legend>
              <div className="weekday-selector-row">
                {translations[lang].weekdays.map((label, day) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={days.includes(day)}
                      disabled={!!owner(day)}
                      onChange={(e) =>
                        setDays(e.target.checked ? [...days, day].sort() : days.filter((d) => d !== day))
                      }
                    />
                    {label}
                    {owner(day) && ' · ' + owner(day)!.name}
                  </label>
                ))}
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => void restore()}>
                {zh ? '确认恢复' : 'Confirm restoration'}
              </button>
            </fieldset>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </details>
  );
}

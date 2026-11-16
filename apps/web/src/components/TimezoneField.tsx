/** Timezone picker shared by Settings and the first-run guide; a selection is saved immediately. */
import React, { useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback } from './ui.tsx';

/**
 * List IANA zones grouped by their region prefix ("Asia", "America", ...).
 *
 * `extra` is merged in so a saved legacy alias that the runtime no longer enumerates stays selectable.
 * Falls back to a short list on runtimes without `Intl.supportedValuesOf`.
 */
export function groupedTimeZones(extra: string[] = []): [string, string[]][] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : ['Asia/Shanghai', 'Asia/Tokyo', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Paris'];
  const zones = [...new Set([...supported, ...extra.filter(Boolean)])].filter((zone) => zone !== 'UTC').sort();
  const groups = new Map<string, string[]>();
  for (const zone of zones) {
    const region = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other';
    groups.set(region, [...(groups.get(region) ?? []), zone]);
  }
  return [['UTC', ['UTC']], ...groups.entries()];
}

/** Browser-reported zone, or null when the runtime cannot resolve one. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

interface TimezoneFieldProps {
  lang: Language;
  /** Currently persisted zone; empty or null means not configured. */
  value: string | null;
  /** Called with the persisted zone after the server confirms the write. */
  onSaved: (zone: string | null) => void;
  id?: string;
  /** Keep the label for assistive tech only, when a visible heading already names the field. */
  hideLabel?: boolean;
}

/**
 * A select over every IANA zone plus a one-click browser suggestion.
 *
 * Every choice is a complete, valid zone, so it is persisted on change; a failed write restores
 * the previous value and shows the error inline. Dependent views are invalidated through the workspace.
 */
export function TimezoneField({ lang, value, onSaved, id = 'timezone-select', hideLabel = false }: TimezoneFieldProps) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const current = value ?? '';
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const suggestion = browserTimeZone();
  const shown = pending ?? current;
  const groups = useMemo(() => groupedTimeZones([current, suggestion ?? '']), [current, suggestion]);

  /** Persist one zone; the select shows the pending value until the server answers. */
  async function save(zone: string) {
    if (zone === current || pending !== null) return;
    setPending(zone);
    setError('');
    setSaved(false);
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      const settings = await api.updateSettings({ timezone: zone });
      onSaved(settings.timezone);
      workspace.notifyMutation();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="timezone-field">
      <label className="form-field" htmlFor={id}>
        <span className={hideLabel ? 'visually-hidden' : undefined}>{zh ? '时区' : 'Timezone'}</span>
        <select
          id={id}
          value={shown}
          disabled={pending !== null}
          onChange={(event) => void save(event.target.value)}
        >
          {!shown && <option value="">{zh ? '选择时区…' : 'Choose a timezone…'}</option>}
          {groups.map(([region, zones]) => (
            <optgroup key={region} label={region}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, ' ')}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {suggestion && suggestion !== shown && (
        <button
          type="button"
          // With nothing chosen yet, the device zone is the likely answer, so it gets a real button.
          className={shown ? 'text-link' : 'btn btn-secondary btn-sm'}
          disabled={pending !== null}
          onClick={() => void save(suggestion)}
        >
          {zh ? `使用本机时区 ${suggestion}` : `Use this device's timezone (${suggestion})`}
        </button>
      )}
      {error && <Feedback>{error}</Feedback>}
      {saved && !error && (
        <p className="field-status" role="status">
          {zh ? '已保存' : 'Saved'}
        </p>
      )}
    </div>
  );
}

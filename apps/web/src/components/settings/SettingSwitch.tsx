/** On/off switch for boolean settings, shared by the Settings tabs. */
import type { Language } from '../../i18n.ts';

interface SettingSwitchProps {
  lang: Language;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name; usually the row heading. */
  label: string;
  /** Id of the element that explains what the switch does. */
  describedBy?: string;
  disabled?: boolean;
}

/**
 * Render a `role="switch"` button with a visible On/Off state.
 *
 * The parent owns the value and persistence; clicking only reports the flipped value.
 */
export function SettingSwitch({ lang, checked, onChange, label, describedBy, disabled }: SettingSwitchProps) {
  const zh = lang === 'zh';
  return (
    <button
      type="button"
      role="switch"
      className="setting-switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="setting-switch-track" aria-hidden="true">
        <span className="setting-switch-thumb" />
      </span>
      <span className="setting-switch-state" aria-hidden="true">
        {checked ? (zh ? '已开启' : 'On') : (zh ? '已关闭' : 'Off')}
      </span>
    </button>
  );
}

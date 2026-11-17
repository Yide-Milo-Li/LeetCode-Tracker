/** "Appearance" Settings tab: theme mode and color palette pickers. */
import type { ThemePalette } from '../../../../../packages/contracts/src/sync.ts';
import { translations, type Language } from '../../i18n.ts';
import { brandIconUrl } from '../../brand-icons.ts';
import { PALETTE_OPTIONS } from '../../palettes.ts';
import { paletteForMode, type ThemeMode } from './settings-model.ts';

interface AppearanceSectionProps {
  lang: Language;
  currentTheme: ThemeMode;
  resolvedDark: boolean;
  currentPalette: ThemePalette;
  onThemeChange: (theme: ThemeMode) => void;
  onPaletteChange: (palette: ThemePalette) => void;
}

/**
 * Render the Appearance tab panel.
 *
 * Picking a mode drops a palette that no longer fits it; picking a light or dark palette switches
 * the mode to match. Both changes are reported through the parent callbacks.
 */
export function AppearanceSection({
  lang,
  currentTheme,
  resolvedDark,
  currentPalette,
  onThemeChange,
  onPaletteChange,
}: AppearanceSectionProps) {
  const t = translations[lang];
  const zh = lang === 'zh';

  return (
    <div role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance" className="settings-panel">
      <section className="preference-row">
        <div className="preference-label">
          <h2>{t.themeModeLabel}</h2>
          <p>{zh ? '跟随系统时，配色会回到默认主题。' : 'Following the system uses the default palette.'}</p>
        </div>
        <div className="segmented-control" aria-label={t.themeModeLabel}>
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={currentTheme === mode}
              onClick={() => {
                // Keep a palette that already matches the new mode; otherwise fall back to default.
                const nextPalette = paletteForMode(currentPalette, mode);
                if (nextPalette !== currentPalette) onPaletteChange(nextPalette);
                onThemeChange(mode);
              }}
            >
              {mode === 'light' ? t.themeLight : mode === 'dark' ? t.themeDark : t.themeSystem}
            </button>
          ))}
        </div>
      </section>

      <section className="preference-row is-stacked">
        <div className="preference-label">
          <h2>{t.paletteLabel}</h2>
          <p>{t.paletteDesc}</p>
        </div>
        <div className="palette-grid" role="radiogroup" aria-label={t.paletteLabel}>
          {PALETTE_OPTIONS.map((pal) => {
            const isSelected = currentPalette === pal.id;
            return (
              <button
                key={pal.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={`palette-card ${isSelected ? 'active' : ''}`}
                onClick={() => {
                  onPaletteChange(pal.id);
                  if (pal.type === 'dark' && currentTheme !== 'dark') {
                    onThemeChange('dark');
                  } else if (pal.type === 'light' && currentTheme !== 'light' && pal.id !== 'default') {
                    onThemeChange('light');
                  }
                }}
              >
                <div className="palette-preview" aria-hidden="true">
                  <div className="palette-swatches">
                    {/* Swatch colors are per-palette data, so they stay inline. */}
                    <span style={{ backgroundColor: pal.canvas }} />
                    <span style={{ backgroundColor: pal.surface }} />
                    <span style={{ backgroundColor: pal.primary }} />
                    <span style={{ backgroundColor: pal.accent }} />
                  </div>
                  <img src={brandIconUrl(pal.id, resolvedDark)} alt="" width="40" height="40" />
                </div>
                <div className="palette-meta">
                  <span className="palette-name">{t[pal.nameKey] as string}</span>
                  <span className={`palette-badge ${pal.type}`}>
                    {pal.id === 'default' ? (zh ? '自适应' : 'Auto') : pal.type === 'dark' ? (zh ? '暗色' : 'Dark') : (zh ? '浅色' : 'Light')}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

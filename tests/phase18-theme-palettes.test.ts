import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { themePaletteSchema, userSettingsSchema, updateSettingsInputSchema, type ThemePalette } from '../packages/contracts/src/sync.ts';
import { CatalogStore } from '../packages/database/src/store.ts';

describe('Phase 18 - Theme Palettes Contract and Persistence', () => {
  const allPalettes: ThemePalette[] = [
    'default',
    'dracula',
    'nord',
    'catppuccin-mocha',
    'catppuccin-latte',
    'tokyo-night',
    'one-dark',
    'gruvbox-dark',
    'midnight-oled',
    'github-light',
  ];

  it('validates all 10 theme palettes through themePaletteSchema', () => {
    for (const pal of allPalettes) {
      const parsed = themePaletteSchema.safeParse(pal);
      assert.equal(parsed.success, true, `Expected ${pal} to be valid`);
    }

    const invalid = themePaletteSchema.safeParse('non-existent-theme');
    assert.equal(invalid.success, false);
  });

  it('validates userSettingsSchema and updateSettingsInputSchema with palette field', () => {
    const validSettings = userSettingsSchema.safeParse({
      language: 'en',
      theme: 'dark',
      palette: 'dracula',
      timezone: 'UTC',
      updatedAt: 12345,
    });
    assert.equal(validSettings.success, true);
    if (validSettings.success) {
      assert.equal(validSettings.data.palette, 'dracula');
    }

    const partialUpdate = updateSettingsInputSchema.safeParse({
      palette: 'tokyo-night',
    });
    assert.equal(partialUpdate.success, true);
  });

  it('defaults palette to "default" in new database', () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    const settings = store.getSettings();
    assert.equal(settings.palette, 'default');
  });

  it('updates and persists custom theme palettes in SQLite', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    for (const pal of allPalettes) {
      const updated = await store.updateSettings({ palette: pal });
      assert.equal(updated.palette, pal);

      const fetched = store.getSettings();
      assert.equal(fetched.palette, pal);
    }
  });

  it('preserves existing settings when updating only palette', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    await store.updateSettings({ language: 'zh', theme: 'dark', timezone: 'Asia/Shanghai' });
    const withPal = await store.updateSettings({ palette: 'gruvbox-dark' });

    assert.equal(withPal.language, 'zh');
    assert.equal(withPal.theme, 'dark');
    assert.equal(withPal.timezone, 'Asia/Shanghai');
    assert.equal(withPal.palette, 'gruvbox-dark');

    const refetched = store.getSettings();
    assert.equal(refetched.language, 'zh');
    assert.equal(refetched.theme, 'dark');
    assert.equal(refetched.palette, 'gruvbox-dark');
  });
});

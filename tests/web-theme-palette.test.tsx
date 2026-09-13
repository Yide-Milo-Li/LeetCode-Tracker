/** Tests for Phase 18 custom theme palettes and settings gallery. */
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ThemePalette } from '../packages/contracts/src/sync.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  FileReader: dom.window.FileReader,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

const React = await import('react');
const { render, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const { api } = await import('../apps/web/src/api.ts');
const { SettingsView, PALETTE_OPTIONS } = await import('../apps/web/src/components/SettingsView.tsx');

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

it('renders all 10 theme palettes in SettingsView gallery', async () => {
  const settings = {
    language: 'en' as const,
    theme: 'dark' as const,
    palette: 'default' as ThemePalette,
    timezone: 'UTC',
    updatedAt: 1,
  };
  mock.method(api, 'getSettings', async () => settings);

  await act(async () => {
    render(
      <SettingsView
        lang="en"
        currentTheme="dark"
        currentPalette="default"
        onLanguageChange={() => {}}
        onThemeChange={() => {}}
        onPaletteChange={() => {}}
      />
    );
  });

  // Verify radiogroup exists
  const group = screen.getByRole('radiogroup', { name: 'Personalized Themes' });
  assert.ok(group);

  // Check that all 10 options from PALETTE_OPTIONS are present
  assert.equal(PALETTE_OPTIONS.length, 10);
  const radios = screen.getAllByRole('radio');
  assert.equal(radios.length, 10);

  // The default palette should be checked
  const defaultCard = radios.find((r) => r.getAttribute('aria-checked') === 'true');
  assert.ok(defaultCard);
});

it('switching to a dark palette automatically activates dark mode', async () => {
  const settings = {
    language: 'en' as const,
    theme: 'light' as const,
    palette: 'default' as ThemePalette,
    timezone: 'UTC',
    updatedAt: 1,
  };
  mock.method(api, 'getSettings', async () => settings);

  let chosenPalette: ThemePalette | null = null;
  let chosenTheme: string | null = null;

  await act(async () => {
    render(
      <SettingsView
        lang="en"
        currentTheme="light"
        currentPalette="default"
        onLanguageChange={() => {}}
        onThemeChange={(th) => {
          chosenTheme = th;
        }}
        onPaletteChange={(pal) => {
          chosenPalette = pal;
        }}
      />
    );
  });

  // Find Dracula button
  const draculaCard = screen.getByText('Dracula').closest('button');
  assert.ok(draculaCard);

  await act(async () => {
    fireEvent.click(draculaCard);
  });

  assert.equal(chosenPalette, 'dracula');
  assert.equal(chosenTheme, 'dark');
});

it('switching to a light palette automatically activates light mode', async () => {
  const settings = {
    language: 'en' as const,
    theme: 'dark' as const,
    palette: 'dracula' as ThemePalette,
    timezone: 'UTC',
    updatedAt: 1,
  };
  mock.method(api, 'getSettings', async () => settings);

  let chosenPalette: ThemePalette | null = null;
  let chosenTheme: string | null = null;

  await act(async () => {
    render(
      <SettingsView
        lang="en"
        currentTheme="dark"
        currentPalette="dracula"
        onLanguageChange={() => {}}
        onThemeChange={(th) => {
          chosenTheme = th;
        }}
        onPaletteChange={(pal) => {
          chosenPalette = pal;
        }}
      />
    );
  });

  // Find Catppuccin Latte button
  const latteCard = screen.getByText('Catppuccin Latte').closest('button');
  assert.ok(latteCard);

  await act(async () => {
    fireEvent.click(latteCard);
  });

  assert.equal(chosenPalette, 'catppuccin-latte');
  assert.equal(chosenTheme, 'light');
});

it('renders Light, Dark, and System options in Interface Mode and respects system mode', async () => {
  const settings = {
    language: 'en' as const,
    theme: 'system' as const,
    palette: 'default' as ThemePalette,
    timezone: 'UTC',
    updatedAt: 1,
  };
  mock.method(api, 'getSettings', async () => settings);

  await act(async () => {
    render(
      <SettingsView
        lang="en"
        currentTheme="system"
        currentPalette="default"
        onLanguageChange={() => {}}
        onThemeChange={() => {}}
        onPaletteChange={() => {}}
      />
    );
  });

  const modeGroup = screen.getByLabelText('Interface Mode');
  assert.ok(modeGroup);

  const lightBtn = screen.getByRole('button', { name: 'Light' });
  const darkBtn = screen.getByRole('button', { name: 'Dark' });
  const systemBtn = screen.getByRole('button', { name: 'System' });

  assert.equal(lightBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(darkBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(systemBtn.getAttribute('aria-pressed'), 'true');
});

it('switching mode while in a personalized theme resets palette to default', async () => {
  const settings = {
    language: 'en' as const,
    theme: 'dark' as const,
    palette: 'dracula' as ThemePalette,
    timezone: 'UTC',
    updatedAt: 1,
  };
  mock.method(api, 'getSettings', async () => settings);

  let chosenPalette: ThemePalette | null = null;
  let chosenTheme: string | null = null;

  await act(async () => {
    render(
      <SettingsView
        lang="en"
        currentTheme="dark"
        currentPalette="dracula"
        onLanguageChange={() => {}}
        onThemeChange={(th) => {
          chosenTheme = th;
        }}
        onPaletteChange={(pal) => {
          chosenPalette = pal;
        }}
      />
    );
  });

  // Clicking Light should switch theme to light AND reset palette to default
  const lightBtn = screen.getByRole('button', { name: 'Light' });
  await act(async () => {
    fireEvent.click(lightBtn);
  });

  assert.equal(chosenTheme, 'light');
  assert.equal(chosenPalette, 'default');

  // Reset trackers and test clicking Dark while in Dracula
  chosenTheme = null;
  chosenPalette = null;
  const darkBtn = screen.getByRole('button', { name: 'Dark' });
  await act(async () => {
    fireEvent.click(darkBtn);
  });

  assert.equal(chosenTheme, 'dark');
  assert.equal(chosenPalette, 'default');

  // Reset trackers and test clicking System while in Dracula
  chosenTheme = null;
  chosenPalette = null;
  const systemBtn = screen.getByRole('button', { name: 'System' });
  await act(async () => {
    fireEvent.click(systemBtn);
  });

  assert.equal(chosenTheme, 'system');
  assert.equal(chosenPalette, 'default');
});

it('switching mode while in default palette updates theme without resetting palette', async () => {
  const settings = {
    language: 'en' as const,
    theme: 'light' as const,
    palette: 'default' as ThemePalette,
    timezone: 'UTC',
    updatedAt: 1,
  };
  mock.method(api, 'getSettings', async () => settings);

  let chosenPalette: ThemePalette | null = null;
  let chosenTheme: string | null = null;

  await act(async () => {
    render(
      <SettingsView
        lang="en"
        currentTheme="light"
        currentPalette="default"
        onLanguageChange={() => {}}
        onThemeChange={(th) => {
          chosenTheme = th;
        }}
        onPaletteChange={(pal) => {
          chosenPalette = pal;
        }}
      />
    );
  });

  const darkBtn = screen.getByRole('button', { name: 'Dark' });
  await act(async () => {
    fireEvent.click(darkBtn);
  });

  assert.equal(chosenTheme, 'dark');
  assert.equal(chosenPalette, null);
});


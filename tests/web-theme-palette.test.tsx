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
const { applyAppIcon, brandIconUrl, iconColors, resetNativeIconCache } = await import('../apps/web/src/brand-icons.ts');

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetNativeIconCache();
  Reflect.deleteProperty(dom.window, '__TAURI_INTERNALS__');
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
        section="appearance"
      />
    );
  });

  // Verify radiogroup exists
  const group = screen.getByRole('radiogroup', { name: 'Color palette' });
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
        section="appearance"
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
        section="appearance"
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
        section="appearance"
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

it('switching mode keeps a matching palette and resets an incompatible one', async () => {
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
        section="appearance"
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

  // Dracula is already a dark palette, so choosing Dark keeps it
  chosenTheme = null;
  chosenPalette = null;
  const darkBtn = screen.getByRole('button', { name: 'Dark' });
  await act(async () => {
    fireEvent.click(darkBtn);
  });

  assert.equal(chosenTheme, 'dark');
  assert.equal(chosenPalette, null);

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
        section="appearance"
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

it('tints the app icon per palette and keeps the original artwork for the default light palette', () => {
  const urls = new Set(PALETTE_OPTIONS.map((option) => brandIconUrl(option.id, option.type === 'dark')));
  assert.equal(urls.size, PALETTE_OPTIONS.length, 'every palette gets a distinct icon');
  assert.equal(iconColors('default', false).tile, '#3c5a44');
  assert.notEqual(iconColors('default', true).plate, iconColors('default', false).plate);
  const midnight = iconColors('midnight-oled', true);
  assert.equal(midnight.tile, '#10b981');
  assert.equal(midnight.stroke, '#000000', 'dark palettes draw dark strokes on a bright tile');
  const svg = decodeURIComponent(brandIconUrl('dracula', true).split(',')[1]);
  assert.match(svg, /fill="#bd93f9"/);
});

it('points the favicon at the active palette icon outside the desktop host', async () => {
  await applyAppIcon('nord', true);
  const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
  assert.equal(link.getAttribute('href'), brandIconUrl('nord', true));
});

it('renders SVG at requested target dimensions while preserving the 1024 viewBox', () => {
  const svg32 = decodeURIComponent(brandIconUrl('tokyo-night', true, 32).split(',')[1]);
  assert.match(svg32, /viewBox="0 0 1024 1024" width="32" height="32"/);
});

it('rasterizes each host target size directly from SVG when running inside Tauri', async () => {
  const originalImage = globalThis.Image;
  const decodedUrls: string[] = [];
  const canvasSizes: number[] = [];
  const invokes: Array<{ cmd: string; args: unknown }> = [];

  class MockImage {
    decoding = '';
    src = '';
    async decode() {
      decodedUrls.push(this.src);
    }
  }

  Object.assign(globalThis, { Image: MockImage });
  mock.method(dom.window.HTMLCanvasElement.prototype, 'getContext', function () {
    return {
      drawImage(_img: unknown, _x: number, _y: number, width: number, height: number) {
        assert.equal(width, height);
        canvasSizes.push(width);
      },
    };
  });
  mock.method(dom.window.HTMLCanvasElement.prototype, 'toBlob', function (
    this: HTMLCanvasElement,
    callback: (blob: Blob | null) => void,
  ) {
    callback(new Blob([new Uint8Array([this.width & 0xff, (this.width >> 8) & 0xff])]));
  });

  (dom.window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      invokes.push({ cmd, args });
      if (cmd === 'get_icon_target_sizes') {
        return { platform: 'windows', small: 20, big: 40, sizes: [16, 20, 32, 40, 256] };
      }
      return undefined;
    },
  };

  try {
    await applyAppIcon('dracula', true);

    assert.deepEqual(canvasSizes, [16, 20, 32, 40, 256]);
    for (const size of [16, 20, 32, 40, 256]) {
      assert.ok(
        decodedUrls.some((url) => decodeURIComponent(url).includes(`width="${size}" height="${size}"`)),
        `expected SVG rasterized at ${size}px`,
      );
    }

    assert.equal(invokes.length, 2);
    assert.equal(invokes[0].cmd, 'get_icon_target_sizes');
    assert.equal(invokes[1].cmd, 'set_app_icon');
    const payload = invokes[1].args as { png: number[]; variants: Array<{ size: number; png: number[] }> };
    assert.deepEqual(
      payload.variants.map((v) => v.size),
      [16, 20, 32, 40, 256],
    );
    assert.deepEqual(payload.png, [256 & 0xff, (256 >> 8) & 0xff]);
  } finally {
    if (originalImage === undefined) {
      Reflect.deleteProperty(globalThis, 'Image');
    } else {
      Object.assign(globalThis, { Image: originalImage });
    }
  }
});

it('falls back to 512 px when an older desktop host lacks get_icon_target_sizes', async () => {
  const originalImage = globalThis.Image;
  const canvasSizes: number[] = [];
  const invokes: Array<{ cmd: string; args: unknown }> = [];

  class MockImage {
    decoding = '';
    src = '';
    async decode() {}
  }

  Object.assign(globalThis, { Image: MockImage });
  mock.method(dom.window.HTMLCanvasElement.prototype, 'getContext', () => ({
    drawImage(_img: unknown, _x: number, _y: number, width: number) {
      canvasSizes.push(width);
    },
  }));
  mock.method(dom.window.HTMLCanvasElement.prototype, 'toBlob', function (
    this: HTMLCanvasElement,
    callback: (blob: Blob | null) => void,
  ) {
    callback(new Blob([new Uint8Array([1, 2, 3])]));
  });

  (dom.window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      if (cmd === 'get_icon_target_sizes') {
        throw new Error('Command get_icon_target_sizes not found');
      }
      invokes.push({ cmd, args });
      return undefined;
    },
  };

  try {
    await applyAppIcon('catppuccin-mocha', true);
    assert.deepEqual(canvasSizes, [512]);
    assert.equal(invokes.length, 1);
    assert.equal(invokes[0].cmd, 'set_app_icon');
    const payload = invokes[0].args as { png: number[]; variants: Array<{ size: number; png: number[] }> };
    assert.deepEqual(payload.png, [1, 2, 3]);
    assert.deepEqual(payload.variants, [{ size: 512, png: [1, 2, 3] }]);
  } finally {
    if (originalImage === undefined) {
      Reflect.deleteProperty(globalThis, 'Image');
    } else {
      Object.assign(globalThis, { Image: originalImage });
    }
  }
});

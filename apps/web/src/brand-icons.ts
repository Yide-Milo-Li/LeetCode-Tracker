/**
 * Palette-tinted application icons.
 *
 * The mark is the same geometry as `assets/brand-icon.svg` (plate, tile, six cells, `</>`), recolored
 * from the palette tokens in `palettes.ts`. Icons are generated as SVG data URLs, so switching a
 * palette updates every icon immediately with no extra assets or network requests.
 *
 * `applyAppIcon` also updates the document favicon and, inside the desktop host, the native
 * window/taskbar (Windows) or Dock (macOS) icon.
 */
import type { ThemePalette } from '../../../packages/contracts/src/sync.ts';
import { PALETTE_OPTIONS } from './palettes.ts';
import { isTauri } from './platform/index.ts';

/** Fill colors for one rendering of the mark. Cells are listed in the order A, B, C (see `iconSvg`). */
export interface IconColors {
  plate: string;
  tile: string;
  cellA: string;
  cellB: string;
  cellC: string;
  stroke: string;
}

/** The hand-tuned original artwork, used for the default palette in light mode. */
const ORIGINAL: IconColors = {
  plate: '#edece1',
  tile: '#3c5a44',
  cellA: '#a7c195',
  cellB: '#dfe8d6',
  cellC: '#d3aa71',
  stroke: '#f3f3e9',
};

/** Linear mix of two `#rrggbb` colors; `amount` is the share of `b` (0..1). */
export function mixHex(a: string, b: string, amount: number): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ca, cb] = [parse(a), parse(b)];
  return `#${ca
    .map((value, i) => Math.round(value + (cb[i] - value) * amount).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Derive icon colors for a palette.
 *
 * Light palettes keep the original layout: a pale plate, a saturated tile, light cells and white
 * strokes. Dark palettes sit on their own canvas with a bright primary tile, so cells and strokes
 * turn dark to keep the `</>` readable at Dock and taskbar sizes. Unknown ids fall back to default.
 */
export function iconColors(palette: ThemePalette, dark: boolean): IconColors {
  const option = PALETTE_OPTIONS.find((item) => item.id === palette);
  if (!option || option.id === 'default') {
    return dark ? { ...ORIGINAL, plate: '#232a24' } : ORIGINAL;
  }
  const { canvas, primary, accent } = option;
  if (option.type === 'light') {
    return {
      plate: mixHex(canvas, primary, 0.1),
      tile: primary,
      cellA: mixHex(primary, '#ffffff', 0.45),
      cellB: mixHex(primary, '#ffffff', 0.8),
      cellC: mixHex(accent, '#ffffff', 0.2),
      stroke: '#ffffff',
    };
  }
  return {
    plate: canvas,
    tile: primary,
    cellA: mixHex(primary, canvas, 0.45),
    cellB: mixHex(primary, '#ffffff', 0.5),
    cellC: accent,
    stroke: canvas,
  };
}

/** Render the mark as SVG markup; geometry matches `assets/brand-icon.svg`. */
export function iconSvg(colors: IconColors): string {
  const cell = (x: number, y: number, fill: string) =>
    `<rect x="${x}" y="${y}" width="112" height="112" rx="25" fill="${fill}"/>`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">',
    `<rect x="28" y="28" width="968" height="968" rx="230" fill="${colors.plate}"/>`,
    `<rect x="175" y="175" width="674" height="674" rx="154" fill="${colors.tile}"/>`,
    cell(284, 284, colors.cellA),
    cell(456, 284, colors.cellB),
    cell(628, 284, colors.cellC),
    cell(284, 628, colors.cellB),
    cell(456, 628, colors.cellA),
    cell(628, 628, colors.cellB),
    `<g fill="none" stroke="${colors.stroke}" stroke-width="42" stroke-linecap="round" stroke-linejoin="round">`,
    '<path d="M372 469 318 512 372 555"/><path d="M652 469 706 512 652 555"/><path d="M535 463 489 561"/>',
    '</g></svg>',
  ].join('');
}

/** Icon URL for a palette in the given mode, as an inline SVG data URL. */
export function brandIconUrl(palette: ThemePalette, dark: boolean): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(iconColors(palette, dark)))}`;
}

/** Edge length of the PNG sent to the desktop host; large enough for Retina Dock icons. */
const NATIVE_ICON_SIZE = 512;
let lastNativeIcon = '';

/** Rasterize an SVG data URL to PNG bytes in the webview. Resolves null when canvas is unavailable. */
async function rasterize(url: string, size: number): Promise<Uint8Array | null> {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/**
 * Apply the palette icon everywhere outside React: the favicon and, on desktop, the native icon.
 *
 * Native failures are swallowed: an older host without `set_app_icon`, or a webview that cannot
 * rasterize, keeps its bundled icon. Repeated calls with the same icon do not reach the host.
 */
export async function applyAppIcon(palette: ThemePalette, dark: boolean): Promise<void> {
  if (typeof document === 'undefined') return;
  const url = brandIconUrl(palette, dark);
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = url;

  if (!isTauri() || url === lastNativeIcon) return;
  lastNativeIcon = url;
  try {
    const png = await rasterize(url, NATIVE_ICON_SIZE);
    if (!png || url !== lastNativeIcon) return;
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    await tauri.invoke('set_app_icon', { png: Array.from(png) });
  } catch {
    // Keep the bundled icon; allow a later palette change to retry.
    if (lastNativeIcon === url) lastNativeIcon = '';
  }
}

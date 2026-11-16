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
export function iconSvg(colors: IconColors, size = 1024): string {
  const cell = (x: number, y: number, fill: string) =>
    `<rect x="${x}" y="${y}" width="112" height="112" rx="25" fill="${fill}"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">`,
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
export function brandIconUrl(palette: ThemePalette, dark: boolean, size = 1024): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(iconColors(palette, dark), size))}`;
}

/** Default fallback PNG edge length when the host does not report target sizes (e.g. macOS Retina Dock). */
const FALLBACK_NATIVE_ICON_SIZE = 512;
let lastNativeIcon = '';

interface TauriBridge {
  invoke: <T = unknown>(cmd: string, args?: unknown) => Promise<T>;
}

/** Reset deduplication state in unit tests. */
export function resetNativeIconCache(): void {
  lastNativeIcon = '';
}

/** Query the host for OS-specific icon sizes; falls back to 512 px for older hosts. */
async function resolveTargetSizes(tauri: TauriBridge): Promise<number[]> {
  try {
    const info = await tauri.invoke<{ sizes?: unknown }>('get_icon_target_sizes');
    if (info && Array.isArray(info.sizes)) {
      const valid = Array.from(
        new Set(
          info.sizes.filter(
            (n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 1024,
          ),
        ),
      ).sort((a, b) => a - b);
      if (valid.length > 0) return valid;
    }
  } catch {
    // Older desktop host without `get_icon_target_sizes`; fall back to single high-res PNG.
  }
  return [FALLBACK_NATIVE_ICON_SIZE];
}

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
 * Each host-requested target size is rasterized directly from SVG so Windows `ICON_SMALL` and
 * `ICON_BIG` stay crisp without downscaling blur. Native failures are swallowed so older hosts
 * or webviews without canvas support keep their bundled icon.
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
    const tauri = (window as unknown as { __TAURI_INTERNALS__: TauriBridge }).__TAURI_INTERNALS__;
    const targetSizes = await resolveTargetSizes(tauri);
    if (url !== lastNativeIcon) return;

    const rasterized = await Promise.all(
      targetSizes.map(async (size) => {
        const bytes = await rasterize(brandIconUrl(palette, dark, size), size);
        return bytes ? { size, png: Array.from(bytes) } : null;
      }),
    );
    if (url !== lastNativeIcon) return;

    const variants = rasterized.filter((item): item is { size: number; png: number[] } => item !== null);
    if (variants.length === 0) {
      lastNativeIcon = '';
      return;
    }

    const fallbackPng = variants[variants.length - 1].png;
    await tauri.invoke('set_app_icon', { png: fallbackPng, variants });
  } catch {
    // Keep the bundled icon; allow a later palette change to retry.
    if (lastNativeIcon === url) lastNativeIcon = '';
  }
}

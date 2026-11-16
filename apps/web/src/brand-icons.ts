/**
 * Brand icon shown on each palette card in Settings → Appearance.
 *
 * Minimal implementation: every palette and mode uses the shared application mark until
 * palette-specific artwork exists. Resolved with `new URL(..., import.meta.url)` like `App.tsx`,
 * so it works in Vite builds and in Node-based component tests.
 */
import type { ThemePalette } from '../../../packages/contracts/src/sync.ts';

const sharedBrandIcon = new URL('./assets/brand-icon.svg', import.meta.url).href;

/**
 * Return the icon URL for a palette card.
 *
 * @param _palette Palette being previewed; reserved for palette-specific icons.
 * @param _dark Whether the interface currently renders dark; reserved for mode-specific icons.
 */
export function brandIconUrl(_palette: ThemePalette, _dark: boolean): string {
  return sharedBrandIcon;
}

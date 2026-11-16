/** Theme palettes offered in Settings → Appearance; the icon generator reuses the same colors. */
import type { ThemePalette } from '../../../packages/contracts/src/sync.ts';
import type { translations } from './i18n.ts';

/** One palette card: display name key, light/dark type and the four colors its preview shows. */
export interface PaletteOption {
  id: ThemePalette;
  nameKey: keyof typeof translations.en;
  type: 'dark' | 'light';
  canvas: string;
  surface: string;
  primary: string;
  accent: string;
}

export const PALETTE_OPTIONS: PaletteOption[] = [
  {
    id: 'default',
    nameKey: 'paletteDefault',
    type: 'light',
    canvas: '#f7f6f2',
    surface: '#ffffff',
    primary: '#42634b',
    accent: '#82561f',
  },
  {
    id: 'dracula',
    nameKey: 'paletteDracula',
    type: 'dark',
    canvas: '#282a36',
    surface: '#343746',
    primary: '#bd93f9',
    accent: '#ff79c6',
  },
  {
    id: 'nord',
    nameKey: 'paletteNord',
    type: 'dark',
    canvas: '#2e3440',
    surface: '#3b4252',
    primary: '#88c0d0',
    accent: '#a3be8c',
  },
  {
    id: 'catppuccin-mocha',
    nameKey: 'paletteCatppuccinMocha',
    type: 'dark',
    canvas: '#1e1e2e',
    surface: '#252538',
    primary: '#cba6f7',
    accent: '#f5c2e7',
  },
  {
    id: 'tokyo-night',
    nameKey: 'paletteTokyoNight',
    type: 'dark',
    canvas: '#1a1b26',
    surface: '#24283b',
    primary: '#7aa2f7',
    accent: '#bb9af7',
  },
  {
    id: 'one-dark',
    nameKey: 'paletteOneDark',
    type: 'dark',
    canvas: '#21252b',
    surface: '#282c34',
    primary: '#61afef',
    accent: '#c678dd',
  },
  {
    id: 'gruvbox-dark',
    nameKey: 'paletteGruvboxDark',
    type: 'dark',
    canvas: '#282828',
    surface: '#32302f',
    primary: '#fabd2f',
    accent: '#b8bb26',
  },
  {
    id: 'midnight-oled',
    nameKey: 'paletteMidnightOled',
    type: 'dark',
    canvas: '#000000',
    surface: '#0f1117',
    primary: '#10b981',
    accent: '#06b6d4',
  },
  {
    id: 'catppuccin-latte',
    nameKey: 'paletteCatppuccinLatte',
    type: 'light',
    canvas: '#eff1f5',
    surface: '#ffffff',
    primary: '#8839ef',
    accent: '#df8e1d',
  },
  {
    id: 'github-light',
    nameKey: 'paletteGithubLight',
    type: 'light',
    canvas: '#f6f8fa',
    surface: '#ffffff',
    primary: '#0969da',
    accent: '#1a7f37',
  },
];

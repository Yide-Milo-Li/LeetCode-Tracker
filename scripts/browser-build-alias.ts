import { fileURLToPath } from 'node:url';

/** Markdown entity decoding must also work while a host bundle initializes without a DOM. */
export const browserBuildAliases = {
  'decode-named-character-reference': fileURLToPath(new URL('../packages/markdown/src/decode-named-reference.ts', import.meta.url)),
};

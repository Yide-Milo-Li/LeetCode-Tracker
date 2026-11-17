/**
 * Read the shared workspace stylesheet as one CSS string for builds that inline it into HTML.
 *
 * `packages/workspace/src/styles.css` is an entry of relative `@import` partials (Vite resolves
 * them for the desktop build). Inlined `<style>` blocks have no base URL, so this expands each
 * relative import in place, recursively and in order, preserving the cascade.
 *
 * Throws when an imported partial is missing; remote or `url()` imports are not supported.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_PATTERN = /^@import\s+(['"])(\.{1,2}\/[^'"]+)\1\s*;[^\S\n]*$/gm;

/** Return `file` with its relative `@import` statements replaced by the imported CSS. */
export function inlineCssImports(file: string): string {
  const css = readFileSync(file, 'utf8');
  return css.replace(IMPORT_PATTERN, (_statement, _quote: string, path: string) =>
    inlineCssImports(resolve(dirname(file), path)),
  );
}

/** The complete shared workspace stylesheet with every partial inlined. */
export function readWorkspaceStyles(): string {
  return inlineCssImports(resolve(repoRoot, 'packages/workspace/src/styles.css'));
}

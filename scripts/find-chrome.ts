/**
 * Shared local Chrome resolution and optional `.env` loading helper for
 * browser verification and asset generation scripts across macOS and Windows.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Load `.env` into `process.env` when present without failing if missing or unreadable.
 * Existing environment variables remain unchanged.
 */
export function loadOptionalEnv(): void {
  if (typeof process.loadEnvFile !== 'function') {
    return;
  }
  try {
    process.loadEnvFile();
  } catch {
    const repoEnv = path.resolve(import.meta.dirname, '..', '.env');
    if (fs.existsSync(repoEnv)) {
      try {
        process.loadEnvFile(repoEnv);
      } catch {
        // .env is optional
      }
    }
  }
}

/**
 * Locate an installed Google Chrome executable for headless CDP verification.
 * Auto-loads `.env` before inspecting `process.env.CHROME_BIN`.
 *
 * @returns Absolute or configured path to an existing Google Chrome binary.
 * @throws Error if no Chrome binary is found at `CHROME_BIN` or standard macOS/Windows paths.
 */
export function findChromeExecutable(): string {
  loadOptionalEnv();

  const configured = process.env.CHROME_BIN?.trim();
  const homeDir = process.env.HOME?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();

  const candidates = [
    configured || undefined,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    homeDir
      ? path.join(homeDir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      : undefined,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData
      ? path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe')
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Google Chrome executable was not found. Please install Chrome or set CHROME_BIN.');
}

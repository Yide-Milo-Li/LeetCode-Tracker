/** Prepare pinned official Node sidecars without falling back to another CPU. */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NODE_VERSION = '24.15.0';
export const RUNTIMES = {
  'x86_64-pc-windows-msvc': {
    file: 'win-x64/node.exe',
    sha256: '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5',
    output: 'node-x86_64-pc-windows-msvc.exe',
  },
  'aarch64-apple-darwin': {
    file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: '372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4',
    output: 'node-aarch64-apple-darwin',
  },
} as const;
export type RuntimeTarget = keyof typeof RUNTIMES;

/** Select only supported native targets or an explicit supported target. */
export function runtimeTarget(explicit?: string, platform: string = process.platform, arch: string = process.arch): RuntimeTarget {
  const target = explicit ?? (platform === 'win32' && arch === 'x64' ? 'x86_64-pc-windows-msvc'
    : platform === 'darwin' && arch === 'arm64' ? 'aarch64-apple-darwin' : 'unsupported');
  if (!Object.hasOwn(RUNTIMES, target)) throw new Error(`Unsupported desktop runtime target: ${target}`);
  return target as RuntimeTarget;
}

/** Hash the official archive or extracted binary for integrity/cache comparison. */
export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Verify before extracting the single fixed Node entry; never reuse an unchecked binary. */
export async function prepareDesktopRuntime(target: RuntimeTarget): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..');
  const spec = RUNTIMES[target];
  const cache = path.join(root, '.local/runtime-cache', target);
  const out = path.join(root, 'apps/desktop/src-tauri/binaries', spec.output);
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const archive = path.join(cache, path.basename(spec.file));
  let data = fs.existsSync(archive) ? fs.readFileSync(archive) : undefined;
  if (!data || sha256(data) !== spec.sha256) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${spec.file}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    if (sha256(data) !== spec.sha256) throw new Error('Official Node SHA-256 mismatch');
    fs.writeFileSync(archive, data);
  }
  let binary = data;
  if (target === 'aarch64-apple-darwin') {
    // One known archive entry, verified above; no shell or untrusted extraction paths.
    // Run from the cache directory so MSYS tar on Windows never parses a drive letter as a remote host.
    binary = execFileSync('tar', ['-xOf', path.basename(archive), `node-v${NODE_VERSION}-darwin-arm64/bin/node`], {
      cwd: cache,
      maxBuffer: 150 * 1024 * 1024,
    });
  }
  if (!fs.existsSync(out) || sha256(fs.readFileSync(out)) !== sha256(binary)) fs.writeFileSync(out, binary);
  if (process.platform !== 'win32') fs.chmodSync(out, 0o755);
  console.log(`Verified Node ${NODE_VERSION}: ${target}, binary SHA-256 ${sha256(binary)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--target')) throw new Error('Usage: prepare-desktop-runtime.ts [--target TARGET]');
  await prepareDesktopRuntime(runtimeTarget(args[1]));
}

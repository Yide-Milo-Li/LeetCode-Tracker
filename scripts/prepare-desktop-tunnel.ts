/** Build-time acquisition only: pin the complete official Windows archive and preserve its license materials. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TUNNEL_VERSION = '0.0.15';
export const TUNNEL_ARCHIVE_SHA256 =
  '3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1';
export const TUNNEL_DOWNLOAD = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}/tunnel-client-v${TUNNEL_VERSION}-windows-amd64.zip`;
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

/** An explicit archive is still hash checked; a corrupt archive cannot replace a prepared package. */
export async function prepareDesktopTunnel(archiveInput?: string): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..'),
    cache = path.join(root, '.local/runtime-cache/tunnel');
  fs.mkdirSync(cache, { recursive: true });
  const archive = archiveInput ?? path.join(cache, `tunnel-client-${TUNNEL_VERSION}.zip`);
  if (!fs.existsSync(archive)) {
    const response = await fetch(TUNNEL_DOWNLOAD, {
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`Tunnel archive download failed: ${response.status}`);
    const body = new Uint8Array(await response.arrayBuffer());
    if (hash(body) !== TUNNEL_ARCHIVE_SHA256) throw new Error('TUNNEL_ARCHIVE_HASH_MISMATCH');
    fs.writeFileSync(archive, body);
  }
  if (hash(fs.readFileSync(archive)) !== TUNNEL_ARCHIVE_SHA256)
    throw new Error('TUNNEL_ARCHIVE_HASH_MISMATCH');
  const extracted = fs.mkdtempSync(path.join(cache, 'verified-'));
  const extractor =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe')
      : 'tar';
  execFileSync(extractor, ['-xf', path.resolve(archive), '-C', extracted], {
    stdio: 'pipe',
    windowsHide: true,
  });
  const files = [
    'tunnel-client.exe',
    'cloudflared.exe',
    'LICENSE',
    'NOTICE',
    'cloudflared-manifest.json',
    `tunnel-client-v${TUNNEL_VERSION}-windows-amd64-licenses.txt`,
    `tunnel-client-v${TUNNEL_VERSION}-windows-amd64.spdx.json`,
  ];
  const hashes = Object.fromEntries(
    files.map((file) => [file, hash(fs.readFileSync(path.join(extracted, file)))]),
  );
  const output = path.join(root, 'apps/desktop/src-tauri/tunnel');
  fs.mkdirSync(output, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(extracted, file), path.join(output, file));
  fs.writeFileSync(
    path.join(output, 'tracker-manifest.json'),
    JSON.stringify(
      {
        version: TUNNEL_VERSION,
        archiveSha256: TUNNEL_ARCHIVE_SHA256,
        files: hashes,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Prepared verified official Tunnel v${TUNNEL_VERSION} with licenses.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareDesktopTunnel(process.argv[2]);

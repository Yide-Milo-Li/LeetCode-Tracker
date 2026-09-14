/**
 * Prepares the private Node.js 24 runtime sidecar executable for Tauri desktop distribution.
 * Ensures the binary is placed at apps/desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe
 * with cryptographic SHA-256 integrity verification against official Node.js distribution hashes.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

const EXPECTED_NODE_VERSION = 'v24.15.0';
const EXPECTED_SHA256 = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5';
const DOWNLOAD_URL = `https://nodejs.org/dist/${EXPECTED_NODE_VERSION}/win-x64/node.exe`;

const repoRoot = path.resolve(import.meta.dirname, '..');
const targetDir = path.join(repoRoot, 'apps/desktop/src-tauri/binaries');
const targetFile = path.join(targetDir, 'node-x86_64-pc-windows-msvc.exe');

/**
 * Compute the SHA-256 digest of a file.
 */
function computeFileSha256(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

/**
 * Main runtime preparation workflow.
 */
async function prepareDesktopRuntime(): Promise<void> {
  console.log(`[Runtime] Preparing private Node.js ${EXPECTED_NODE_VERSION} runtime sidecar...`);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 1. Check if the target binary is already present and matches expected SHA-256
  if (fs.existsSync(targetFile)) {
    const existingHash = computeFileSha256(targetFile);
    if (existingHash === EXPECTED_SHA256) {
      console.log(`✓ Existing sidecar binary verified (${EXPECTED_SHA256}): ${targetFile}`);
      return;
    }
    console.warn(`[Runtime] Target binary exists but hash mismatch (${existingHash}). Re-acquiring...`);
  }

  // 2. Check if local host Node executable matches expected version and hash
  if (process.version === EXPECTED_NODE_VERSION && process.platform === 'win32' && process.arch === 'x64') {
    const localHash = computeFileSha256(process.execPath);
    if (localHash === EXPECTED_SHA256) {
      console.log(`[Runtime] Copying verified host Node.js binary from ${process.execPath}...`);
      fs.copyFileSync(process.execPath, targetFile);
      console.log(`✓ Copied and verified host binary to: ${targetFile}`);
      return;
    }
  }

  // 3. Download official binary from nodejs.org
  console.log(`[Runtime] Downloading official binary from ${DOWNLOAD_URL}...`);
  const response = await fetch(DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`Failed to download Node.js binary: HTTP ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const downloadedHash = crypto.createHash('sha256').update(buffer).digest('hex');

  if (downloadedHash !== EXPECTED_SHA256) {
    throw new Error(`SHA-256 checksum verification failed! Expected: ${EXPECTED_SHA256}, Actual: ${downloadedHash}`);
  }

  fs.writeFileSync(targetFile, buffer);
  console.log(`✓ Downloaded and verified official Node.js sidecar to: ${targetFile}`);
}

prepareDesktopRuntime().catch((err) => {
  console.error('Fatal error preparing desktop runtime:', err);
  process.exit(1);
});

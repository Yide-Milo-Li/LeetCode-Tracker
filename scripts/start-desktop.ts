/**
 * Cross-platform source-mode desktop launcher for LeetCode Tracker.
 *
 * - On Windows (`win32`), delegates to `scripts/start-desktop.ps1`, forwarding CLI arguments and stdio.
 * - On macOS (`darwin`) and other POSIX platforms, probes loopback port for a running instance,
 *   checks for port conflicts, builds missing web assets, spawns `apps/server/src/server.ts`,
 *   polls `/api/v1/catalog/stats` up to 15s, opens the browser, and forwards `SIGINT`/`SIGTERM`.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { loadOptionalEnv } from './find-chrome.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Parse optional `--port <number>` or `--port=<number>` override from CLI arguments. */
function parsePortArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--port=')) {
      return arg.slice('--port='.length);
    }
    if ((arg === '--port' || arg === '-p') && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return undefined;
}

/** Probe `/api/v1/catalog/stats` to detect an already-running LeetCode Tracker server. */
async function probeStats(statsUrl: string): Promise<boolean> {
  try {
    const res = await fetch(statsUrl, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) {
      return false;
    }
    const data = (await res.json()) as unknown;
    return Boolean(data && typeof data === 'object' && 'totalProblems' in data);
  } catch {
    return false;
  }
}

/** Test whether `host:port` is already occupied by attempting an exclusive loopback bind. */
async function checkPortOccupied(host: string, port: number): Promise<{ occupied: boolean; details?: string }> {
  const occupied = await new Promise<boolean>((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        reject(err);
      }
    });
    tester.once('listening', () => {
      tester.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(false);
      });
    });
    tester.listen(port, host);
  });

  if (!occupied) {
    return { occupied: false };
  }

  let details: string | undefined;
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      details = out;
    }
  } catch {
    // lsof may be unavailable or lack permission; EADDRINUSE already confirmed occupation
  }

  return { occupied: true, details };
}

/** Open the local workbench URL using the platform browser launcher without blocking shutdown. */
function openBrowser(url: string): void {
  if (process.platform === 'darwin') {
    const opener = fs.existsSync('/usr/bin/open') ? '/usr/bin/open' : 'open';
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
      console.warn(`Could not open browser automatically (${err.message}). Open ${url} manually.`);
    });
    child.unref();
    return;
  }

  const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.log(`Please open this URL in your browser: ${url}`);
  });
  child.unref();
}

/** Delegate Windows execution to the existing PowerShell launcher with full args/stdio forwarding. */
function runWindowsLauncher(): void {
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', './scripts/start-desktop.ps1', ...process.argv.slice(2)],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );

  child.on('error', (err) => {
    console.error(`Failed to invoke PowerShell launcher: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

/** Run the macOS/POSIX source-mode launch workflow. */
async function runPosixLauncher(): Promise<void> {
  loadOptionalEnv();

  console.log('=====================================================');
  console.log('       LeetCode Tracker - Desktop Launcher           ');
  console.log('=====================================================');

  const portRaw = parsePortArg(process.argv.slice(2)) ?? process.env.PORT ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Error: Invalid PORT '${portRaw}'. Expected an integer between 1 and 65535.`);
    process.exit(1);
  }

  const host = '127.0.0.1';
  const url = `http://${host}:${port}`;
  const statsUrl = `${url}/api/v1/catalog/stats`;

  // 1. Reuse an already-running LeetCode Tracker instance to avoid DB lease collisions
  if (await probeStats(statsUrl)) {
    console.log(`LeetCode Tracker is already running on ${url}.`);
    console.log('Opening default browser...');
    openBrowser(url);
    process.exit(0);
  }

  // 2. Abort clearly if another process occupies the port
  const portStatus = await checkPortOccupied(host, port);
  if (portStatus.occupied) {
    console.error(`Error: Port ${port} on ${host} is currently occupied by another process.`);
    if (portStatus.details) {
      console.error(portStatus.details);
    }
    console.error(`Please free port ${port} or set a custom PORT (e.g., PORT=3001).`);
    process.exit(1);
  }

  // 3. Ensure frontend production bundle exists
  const distIndex = path.join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.log('Frontend build assets missing. Running npm run build...');
    const buildResult = spawnSync('npm', ['run', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (buildResult.error) {
      console.error(`Build failed to start: ${buildResult.error.message}`);
      process.exit(1);
    }
    if (buildResult.status !== 0) {
      console.error('Build failed. Please fix build errors before launching.');
      process.exit(buildResult.status ?? 1);
    }
  }

  // 4. Spawn Fastify server and forward shutdown signals
  console.log(`Starting LeetCode Tracker server on ${url}...`);
  const serverProcess = spawn(process.execPath, ['apps/server/src/server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), HOST: host },
    stdio: 'inherit',
  });

  let shuttingDown = false;
  let childExited = false;
  let childExitCode = 0;

  const childDone = new Promise<number>((resolve, reject) => {
    serverProcess.on('error', (err) => {
      childExited = true;
      reject(err);
    });
    serverProcess.on('exit', (code, signal) => {
      childExited = true;
      childExitCode = code ?? (signal ? 1 : 0);
      resolve(childExitCode);
    });
  });

  const forwardSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\n[Stopping server process (${signal})...]`);
    if (!childExited) {
      serverProcess.kill(signal);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  // 5. Poll /api/v1/catalog/stats up to 15s (30 x 500ms)
  process.stdout.write('Waiting for local service readiness');
  let ready = false;
  const maxAttempts = 30;

  for (let attempt = 0; attempt < maxAttempts && !shuttingDown && !childExited; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (shuttingDown || childExited) {
      break;
    }
    process.stdout.write('.');
    if (await probeStats(statsUrl)) {
      ready = true;
      break;
    }
  }

  process.stdout.write('\n');

  if (childExited) {
    const exitCode = await childDone;
    if (!shuttingDown) {
      console.error(`Server process exited prematurely with exit code ${exitCode}.`);
      process.exit(exitCode || 1);
    }
    process.exit(exitCode);
  }

  if (!shuttingDown) {
    if (ready) {
      console.log('LeetCode Tracker is ready!');
      console.log(`  Web: ${url}/`);
      console.log(`  API: ${statsUrl}`);
      console.log('Opening default browser...');
      openBrowser(url);
      console.log('\n[Server is running. Press Ctrl+C to stop cleanly]\n');
    } else {
      console.warn('Warning: Health check timed out after 15s, but server process is still running.');
      console.warn(`Opening browser anyway: ${url}`);
      openBrowser(url);
    }
  }

  const finalCode = await childDone;
  process.exit(shuttingDown ? 0 : finalCode);
}

if (process.platform === 'win32') {
  runWindowsLauncher();
} else {
  runPosixLauncher().catch((err) => {
    console.error('Desktop launcher failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

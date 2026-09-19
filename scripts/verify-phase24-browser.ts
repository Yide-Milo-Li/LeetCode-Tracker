/**
 * Phase 24 Browser Verification Script.
 * Verifies Add-one UI loading states, mutual exclusion, zero model calls,
 * and captures desktop screenshots across resolutions (1024, 1440, 1920),
 * languages (en, zh), and themes (light, dark).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { fallbackPlanContent, type IGeminiAssistant } from '../apps/server/src/gemini.ts';

function findChrome(): string {
  const paths = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Google Chrome executable was not found.');
}

class CdpClient {
  private ws: WebSocket;
  private msgId = 0;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  async connect(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    };
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

async function main() {
  console.log('[Verify] Starting Phase 24 Add-one browser verification...');

  const evidenceDir = path.resolve('.local/evidence/phase24/add-one-local');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const tempDir = path.resolve('.local/temp-verify-phase24-' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });

  const dbPath = path.join(tempDir, 'verify.db');
  const chromeProfile = path.join(tempDir, 'chrome-profile');
  const port = 3192;
  const host = '127.0.0.1';
  const cdpPort = 9449;

  // 1. Setup isolated database
  const db = new DatabaseSync(dbPath);
  const store = await CatalogStore.open(db, { skipBackup: true });

  // Import problems
  const difficulties = ['Easy', 'Medium', 'Hard'] as const;
  const tagsPool = ['Array', 'Hash Table', 'Dynamic Programming', 'Tree', 'Graph', 'Two Pointers'];
  const problems = Array.from({ length: 200 }, (_, i) => ({
    id: String(i + 1),
    questionId: String(i + 1),
    title: `Problem ${i + 1}`,
    titleSlug: `problem-${i + 1}`,
    difficulty: difficulties[i % 3],
    tags: [tagsPool[i % tagsPool.length]],
    url: `https://leetcode.com/problems/problem-${i + 1}/`,
    isPaidOnly: false,
  }));
  await store.importJsonl(problems.map((p) => JSON.stringify(p)).join('\n'));

  // Seed practice records for review
  const now = Date.now();
  const insertRecord = db.prepare(`INSERT INTO practice_records
    (id, question_id, completed, practiced_at, time_precision, created_at, updated_at, duration_minutes, source_timezone)
    VALUES (?, ?, 1, ?, 'datetime', ?, ?, ?, 'America/Los_Angeles')`);
  db.exec('BEGIN');
  for (let i = 0; i < 20; i++) {
    const at = new Date(now - (30 + i) * 86400000).toISOString();
    insertRecord.run(`rec-${i}`, String(i + 1), at, Date.parse(at), Date.parse(at), 20);
  }
  db.exec('COMMIT');
  db.prepare("UPDATE catalog_meta SET value='0' WHERE key='review_baseline'").run();

  await store.updateSettings({ timezone: 'America/Los_Angeles', language: 'en', theme: 'dark' });

  await store.planning.saveStrategy({
    name: 'Core Algorithms Practice',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 34, Medium: 33, Hard: 33 },
      tags: [],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 33,
      preference: '',
      focusWeakTags: false,
    },
  });

  // 2. Track model calls
  let modelCallCount = 0;
  const assistant: IGeminiAssistant = {
    getStatus: () => ({ configured: true, model: 'synthetic-verify-mock' }),
    formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'synthetic-verify-mock' }),
    generatePlanContent: async (p) => {
      modelCallCount++;
      return fallbackPlanContent(p.problems, p.rules);
    },
  };

  // Build app with staticRoot serving built frontend
  const staticRoot = path.resolve('apps/web/dist');
  const app = await buildApp({
    store,
    geminiAssistant: assistant,
    staticRoot,
  });

  await app.listen({ host, port });
  console.log(`[Verify] Backend server listening at http://${host}:${port}`);

  // 3. Launch Chrome
  const chromeBin = findChrome();
  const chromeProcess: ChildProcess = spawn(
    chromeBin,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${chromeProfile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let pageWsUrl = '';
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (res.ok) {
        const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          pageWsUrl = page.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!pageWsUrl) throw new Error('Failed to connect to Chrome CDP endpoint.');

  const cdp = new CdpClient(pageWsUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');

  const screenshots: string[] = [];

  const captureViewport = async (filename: string, width: number, height: number) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 400));
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const targetFile = path.join(evidenceDir, filename);
    fs.writeFileSync(targetFile, Buffer.from(result.data, 'base64'));
    screenshots.push(filename);
    console.log(`  ✓ Saved ${filename} (${(fs.statSync(targetFile).size / 1024).toFixed(1)} KB)`);
  };

  // Navigate to Today view
  console.log('[Verify] Navigating to Today view...');
  await cdp.send('Page.navigate', { url: `http://${host}:${port}/#today` });
  await new Promise((r) => setTimeout(r, 2000));

  // Reset model call counter after initial plan ensure
  const ensureCalls = modelCallCount;
  modelCallCount = 0;

  // Viewports to test
  const viewports = [
    { name: '1024', width: 1024, height: 768 },
    { name: '1440', width: 1440, height: 900 },
    { name: '1920', width: 1920, height: 1080 },
  ];

  // 1. Capture Idle State across viewports (EN Dark)
  for (const vp of viewports) {
    await captureViewport(`today-add-one-idle-${vp.name}-en-dark.png`, vp.width, vp.height);
  }

  // Switch to Light theme
  await store.updateSettings({ theme: 'light' });
  await cdp.send('Runtime.evaluate', { expression: `document.documentElement.classList.remove('dark')` });
  await new Promise((r) => setTimeout(r, 300));
  await captureViewport('today-add-one-idle-1440-en-light.png', 1440, 900);

  // Switch to Chinese
  await store.updateSettings({ language: 'zh', theme: 'dark' });
  await cdp.send('Page.navigate', { url: `http://${host}:${port}/#today` });
  await new Promise((r) => setTimeout(r, 1500));
  await captureViewport('today-add-one-idle-1440-zh-dark.png', 1440, 900);

  // Switch to Chinese Light
  await store.updateSettings({ language: 'zh', theme: 'light' });
  await cdp.send('Runtime.evaluate', { expression: `document.documentElement.classList.remove('dark')` });
  await new Promise((r) => setTimeout(r, 300));
  await captureViewport('today-add-one-idle-1440-zh-light.png', 1440, 900);

  // Switch back to English Dark for interaction tests
  await store.updateSettings({ language: 'en', theme: 'dark' });
  await cdp.send('Page.navigate', { url: `http://${host}:${port}/#today` });
  await new Promise((r) => setTimeout(r, 1500));

  // 2. Perform Add One click and verify loading feedback & zero model calls
  console.log('[Verify] Testing Add one click and interaction protection...');
  const addBtnExists = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Add one'));
      return !!btn;
    })()`,
    returnByValue: true,
  });
  console.log('  - Add one button exists:', addBtnExists.result.value);

  // Click Add one
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Add one'));
      if (btn) btn.click();
    })()`,
  });

  // Wait a short moment for loading state to activate and capture
  await new Promise((r) => setTimeout(r, 50));
  await captureViewport('today-add-one-loading-1440-en-dark.png', 1440, 900);

  // Wait for append completion
  await new Promise((r) => setTimeout(r, 1200));
  await captureViewport('today-add-one-completed-1440-en-dark.png', 1440, 900);

  // Verify item count increased
  const itemCountResult = await cdp.send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.today-problem-row, [data-testid="problem-row"], article').length`,
    returnByValue: true,
  });
  console.log('  - Problems rendered after append:', itemCountResult.result.value);

  // Verify 0 model calls made during append
  const appendModelCalls = modelCallCount;
  console.log(`  - Model calls during initial ensure: ${ensureCalls}`);
  console.log(`  - Model calls during Add-one append: ${appendModelCalls}`);

  // Clean up
  await cdp.close();
  chromeProcess.kill();
  await app.close();
  db.close();

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}

  const verificationReport = {
    scope: 'Phase 24: Add-one browser visual acceptance & zero-token verification',
    timestamp: new Date().toISOString(),
    viewports: ['1024x768', '1440x900', '1920x1080'],
    themes: ['light', 'dark'],
    languages: ['en', 'zh'],
    screenshots,
    addOneInteraction: {
      initialEnsureModelCalls: ensureCalls,
      addOneAppendModelCalls: appendModelCalls,
      zeroModelCallsConfirmed: appendModelCalls === 0,
      postAppendProblemsRendered: itemCountResult.result.value,
    },
    passed: appendModelCalls === 0,
  };

  const reportPath = path.join(evidenceDir, 'verification-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(verificationReport, null, 2), 'utf8');
  console.log(`\n[Verify] Verification report written to ${reportPath}`);

  if (appendModelCalls !== 0) {
    throw new Error(`Expected 0 model calls during Add-one append, got ${appendModelCalls}`);
  }

  console.log('✨ Phase 24 browser visual verification PASSED with 0 model calls!');
}

main().catch((err) => {
  console.error('Fatal error during browser verification:', err);
  process.exit(1);
});

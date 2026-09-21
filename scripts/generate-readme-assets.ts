/**
 * Script to generate high-resolution, Retina (2x) screenshots for GitHub README showcase.
 *
 * Launches an isolated Fastify server with fictional synthetic data (4,046 problems,
 * full year practice activity, daily plan, notes, strategies, and themes),
 * connects headless Chrome via CDP with deviceScaleFactor: 2, and saves screenshots
 * to `docs/assets/screenshots/`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { createSocialCatalog, socialPracticeIds } from './social-catalog.ts';
import { localDate } from '../packages/contracts/src/time.ts';

/** Resolve Chrome without downloading a browser or using a personal profile. */
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

/** Request/response transport for the isolated screenshot browser. */
class CdpClient {
  private ws: WebSocket;
  readonly errors: string[] = [];
  private msgId = 0;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  /** Open the local browser debugging socket. */
  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  /** Install response dispatch before issuing protocol requests. */
  async connect(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data.toString());
        if (msg.method === 'Runtime.exceptionThrown') this.errors.push(JSON.stringify(msg.params.exceptionDetails));
        if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
          this.errors.push(JSON.stringify(msg.params));
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    };
  }

  /** Resolve a protocol response by request ID. */
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Close this capture connection. */
  async close(): Promise<void> {
    this.ws.close();
  }
}

/** Seed an isolated public fixture and refresh all README screenshots. */
async function main() {
  console.log('🚀 Generating High-Definition Screenshots for GitHub README...');

  const outputDir = path.resolve(process.cwd(), 'docs/assets/screenshots');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const localRoot = path.resolve(process.cwd(), '.local');
  fs.mkdirSync(localRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(localRoot, 'temp-readme-assets-'));

  const dbPath = path.join(tempDir, `readme-preview-${Date.now()}.sqlite`);
  const chromeProfile = path.join(tempDir, `chrome-profile-${Date.now()}`);

  const port = 3089;
  const host = '127.0.0.1';
  const cdpPort = 9338;

  // 1. Initialize SQLite database & store
  console.log('  [1/5] Ingesting catalog and seeding rich data...');
  const db = new DatabaseSync(dbPath);
  const store = await CatalogStore.open(db, { skipBackup: true });

  await store.importJsonl(createSocialCatalog());

  // 2. Configure default theme and language
  await store.updateSettings({
    timezone: 'America/New_York',
    language: 'en',
    theme: 'dark',
    palette: 'default',
    geminiApiKey: '',
    openaiApiKey: '',
    deepseekApiKey: '',
    openaiModel: 'gpt-5.6-luna',
    deepseekModel: 'deepseek-flash',
  });

  // 3. Seed realistic practice history across the past 280 days for a vibrant heatmap
  const now = Date.now();
  const dayMs = 86400000;
  const popularProblems = socialPracticeIds;

  for (let d = 260; d >= 0; d--) {
    // 70% probability of practicing on any given day
    if ((d % 7 !== 2 && d % 7 !== 6) || d % 3 === 0) {
      const count = (d % 4) + 1;
      for (let i = 0; i < count; i++) {
        const pId = popularProblems[(d * 3 + i) % popularProblems.length];
        await store.createPracticeRecord({
          questionFrontendId: pId,
          completed: true,
          practicedAt: new Date(now - d * dayMs - i * 3600000 * 2).toISOString(),
          durationMinutes: 15 + ((d * 7 + i * 5) % 45),
          notes: `Solid practice session focusing on edge cases and optimal complexity for #${pId}.`,
        });
      }
    }
  }

  // 4. Seed Strategy
  const showcaseStrategy = await store.planning.saveStrategy({
    name: 'Dynamic Programming & System Algorithms',
    weekdays: [1, 2, 3, 4, 5],
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 34, Medium: 33, Hard: 33 },
      tags: ['dynamic-programming', 'tree'],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 33,
      preference: 'Master bottom-up tabulation and memoization patterns',
    },
  });

  await store.planning.saveStrategy({
    name: 'Weekend Hard Problem Sprint',
    weekdays: [0, 6],
    rules: {
      dailyCount: 2,
      difficulty: { Easy: 0, Medium: 50, Hard: 50 },
      tags: ['graph-theory', 'dynamic-programming'],
      premium: false,
      reviewEnabled: false,
      reviewPercent: 0,
      preference: 'Advanced topological sort, union find and hard DP',
    },
  });

  // 5. Seed Today Plan
  const todayDate = localDate(now, 'America/New_York');
  const p1 = store.getProblem('1', 'frontendId') || { questionFrontendId: '1', title: 'Two Sum', difficulty: 'Easy', tags: ['Array', 'Hash Table'] };
  const p70 = store.getProblem('70', 'frontendId') || { questionFrontendId: '70', title: 'Climbing Stairs', difficulty: 'Easy', tags: ['Dynamic Programming', 'Math'] };
  const p322 = store.getProblem('322', 'frontendId') || { questionFrontendId: '322', title: 'Coin Change', difficulty: 'Medium', tags: ['Dynamic Programming', 'Breadth-First Search'] };

  const planPayload = {
    id: 'daily-plan-readme',
    date: todayDate,
    timezone: 'America/New_York',
    version: 1,
    strategyId: showcaseStrategy.id,
    strategyVersion: 1,
    strategyName: 'Dynamic Programming & System Algorithms',
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 34, Medium: 33, Hard: 33 },
      tags: ['dynamic-programming', 'tree'],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 33,
      preference: 'Master bottom-up tabulation and memoization patterns',
    },
    items: [
      {
        id: 'item-1',
        problem: p1,
        kind: 'review' as const,
        addedAt: now - 3600000 * 2,
        reason: {
          en: 'Essential hash table pattern for pair sum lookup with O(1) average time.',
          zh: '哈希表查找核心基础，快速检验状态映射思维与边界处理。',
        },
        evidenceIds: [],
        completed: true,
      },
      {
        id: 'item-2',
        problem: p70,
        kind: 'review' as const,
        addedAt: now - 3600000,
        reason: {
          en: 'Foundational dynamic programming problem demonstrating overlapping subproblems.',
          zh: '动态规划入门基石，建立自底向上状态转移递推思维。',
        },
        evidenceIds: [],
        completed: false,
      },
      {
        id: 'item-3',
        problem: p322,
        kind: 'new' as const,
        addedAt: now,
        reason: {
          en: 'Classic unbounded knapsack DP pattern with state transition optimization.',
          zh: '经典完全背包变种，强化最优子结构分析与备忘录求解。',
        },
        evidenceIds: [],
        completed: false,
      },
    ],
    source: 'local' as const,
    model: null,
    encouragement: {
      en: 'Every complex algorithm is built upon simple, step-by-step logic. Trust your process today!',
      zh: '每一个复杂的算法都是由简单、循序渐进的逻辑构建而成的。相信今天的努力！',
    },
    notices: [],
    catalogRevision: store.getCatalogRevision(),
    practiceRevision: store.getPracticeRevision(),
    planningRevision: 1,
    algorithmVersion: 'phase4-v2',
    createdAt: now,
    updatedAt: now,
    action: 'created',
  };

  db.prepare(`
    INSERT INTO daily_plans (id, plan_date, version, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(planPayload.id, planPayload.date, planPayload.version, JSON.stringify(planPayload));

  // 6. Seed Markdown Notes
  store.upsertProblemNote('1', `# Synthetic exercise 1

### 💡 Optimal Strategy
Use a single-pass hash map to store seen elements and their corresponding indices. As we iterate through \`nums\`, check if \`target - nums[i]\` exists in the table.

### ⏱️ Complexity
- **Time Complexity:** $\\mathcal{O}(N)$ - single pass through the array.
- **Space Complexity:** $\\mathcal{O}(N)$ - to store at most $N$ elements in the hash map.

\`\`\`cpp
class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> seen;
        for (int i = 0; i < nums.size(); ++i) {
            int complement = target - nums[i];
            if (seen.find(complement) != seen.end()) {
                return {seen[complement], i};
            }
            seen[nums[i]] = i;
        }
        return {};
    }
};
\`\`\`
`);

  store.upsertProblemNote('322', `# Synthetic exercise 322

### 💡 Dynamic Programming Approach
Bottom-up 1D DP tabulation: let \`dp[i]\` represent the minimum number of coins to make up amount \`i\`.
Initialize \`dp[0] = 0\` and all other values to \`amount + 1\`.

### 🔄 Recurrence Relation
$$dp[i] = \\min(dp[i], dp[i - c] + 1) \\quad \\forall c \\in \\text{coins}, i \\ge c$$
`);

  // 7. Start Server
  console.log(`  [2/5] Starting Fastify backend on http://${host}:${port}...`);
  const app = await buildApp({ store });
  await app.listen({ host, port });

  // 8. Launch Headless Chrome
  console.log(`  [3/5] Launching Headless Chrome (CDP Port: ${cdpPort})...`);
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
    { stdio: 'ignore', windowsHide: true }
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

  if (!pageWsUrl) {
    throw new Error('Failed to connect to Chrome CDP endpoint.');
  }

  const cdp = new CdpClient(pageWsUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');

  // Set standard desktop 1440x900 viewport with deviceScaleFactor: 2 for Retina sharpness
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const capture = async (hashUrl: string, filename: string, label: string, extraWait = 1200, evalBeforeCapture?: string) => {
    console.log(`  [4/5] Capturing: ${label} -> ${filename}...`);
    await cdp.send('Page.navigate', { url: `http://${host}:${port}/${hashUrl}` });
    await new Promise((r) => setTimeout(r, extraWait));
    if (evalBeforeCapture) {
      await cdp.send('Runtime.evaluate', { expression: evalBeforeCapture, awaitPromise: true });
      await new Promise((r) => setTimeout(r, 600));
    }
    await verifyPage();
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const targetFile = path.join(outputDir, filename);
    fs.writeFileSync(targetFile, Buffer.from(result.data, 'base64'));
    console.log(`    ✓ Saved ${filename} (${(fs.statSync(targetFile).size / 1024).toFixed(1)} KB)`);
  };

  /** Require meaningful rendered content and capture identity rather than trusting fixed delays alone. */
  const verifyPage = async () => {
    const result = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({url: location.href, title: document.title, heading: Array.from(document.querySelectorAll('h1')).find(h => h.getClientRects().length > 0)?.textContent, textLength: document.body.innerText.length, overlay: !!document.querySelector('vite-error-overlay')})`, returnByValue: true });
    const state = JSON.parse(result.result.value);
    if (!state.title || !state.heading || state.textLength < 100 || state.overlay) throw new Error(`Invalid capture state: ${JSON.stringify(state)}`);
    return state;
  };

  // 1. Today View
  await capture('#today', '01-today-overview.png', 'Today Practice & AI Recommendation View', 1500);

  // 2. Progress / Dashboard Analytics View
  await capture('#statistics', '02-dashboard-analytics.png', '365-Day Heatmap & Progress Analytics', 1500);

  // 3. Problem Catalog View
  await capture('#problems', '03-problems-catalog.png', 'Problems Catalog with Instant Search & Tags', 1500);

  // 4. Notes Workspace
  await capture('#notes', '04-notes-workspace.png', 'Master-Detail Notes Workspace & Markdown Editor', 1500, `document.querySelector('.notes-master-pane button')?.click()`);

  // 5. Weekly Study Schedule
  await capture('#schedule', '05-study-schedule.png', 'Weekly Strategy & Quota Planner', 1500);

  // 6. Settings - Theme Palettes Gallery
  await capture('#settings', '06-theme-palettes.png', '10 Developer Theme Palettes Gallery', 1500, `(() => {
    const el = document.querySelector('.palette-selection-section') || document.querySelector('.theme-palette-grid');
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
  })()`);

  // 7. Settings - Multi-Provider AI Configuration
  await capture('#settings', '07-ai-configuration.png', 'Multi-Provider AI Configuration Panel', 1500, `(() => {
    const el = document.querySelector('.ai-settings-form')?.closest('.preference-row') || document.querySelector('.ai-settings-form');
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
  })()`);

  // 8. Problems - Import Problems Modal (BYOD Demonstration)
  await capture('#problems', '08-catalog-import-modal.png', 'BYOD JSON Lines Import Workspace', 1500, `(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Import problems') || b.textContent.includes('导入题库'));
    if (btn) btn.click();
  })()`);

  // Exercise the newly delivered focus control after capturing the normal workspace.
  await cdp.send('Page.navigate', { url: `http://${host}:${port}/#notes` });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await cdp.send('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Zen Mode')?.click()` });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const focused = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('.notes-master-pane').style.display === 'none'`, returnByValue: true });
  if (!focused.result.value) throw new Error('Notes focus control did not hide the master list');
  await cdp.send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: String.fromCharCode(92), ctrlKey: true, bubbles: true }))` });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const normal = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('.notes-master-pane').style.display !== 'none'`, returnByValue: true });
  if (!normal.result.value) throw new Error('Notes focus shortcut did not restore the master list');
  const report = { viewport: '1440x900 at 2x', source: 'isolated synthetic catalog', screenshots: 8, identity: await verifyPage(), interactions: ['catalog import navigation', 'Notes focus button', 'Notes focus keyboard restore'], errors: cdp.errors };
  fs.writeFileSync(path.join(tempDir, 'capture-report.json'), JSON.stringify(report, null, 2));
  if (cdp.errors.length) throw new Error(`Browser errors: ${JSON.stringify(cdp.errors)}`);
  console.log('  [5/5] Cleaning up processes and temporary files...');
  await cdp.close();
  chromeProcess.kill();
  await app.close();
  db.close();

  console.log(`Synthetic capture profile retained at ${tempDir}`);

  console.log('\n✨ All high-definition screenshots successfully generated in `docs/assets/screenshots/`!');
}

main().catch((err) => {
  console.error('Fatal error generating assets:', err);
  process.exit(1);
});

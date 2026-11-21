/**
 * Script to generate high-resolution, Retina (2x) screenshots for GitHub README showcase.
 *
 * Launches an isolated Fastify server with fictional synthetic data (4,046 problems,
 * full year practice activity, daily plan, notes, strategies, and themes),
 * connects headless Chrome via CDP with deviceScaleFactor: 2, and saves screenshots
 * to `docs/assets/screenshots/`.
 *
 * Optional environment variables (all default to the README gallery):
 * - `README_SCREENSHOT_THEME`: `light` (default) or `dark`, captured with the default palette.
 * - `README_SCREENSHOT_LANG`: `en` (default) or `zh`.
 * - `README_SCREENSHOT_DIR`: output directory; defaults to `docs/assets/screenshots`.
 * An unknown theme or language fails before anything is captured.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { saveGoalList } from '../packages/database/src/goal-lists.ts';
import { FAVORITE_FOLDER_PREFIX, FAVORITE_PROBLEM_PREFIX } from '../packages/database/src/favorites.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { createSocialCatalog, socialPracticeIds } from './social-catalog.ts';
import { localDate } from '../packages/contracts/src/time.ts';
import { findChromeExecutable } from './find-chrome.ts';

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

/** Read an enumerated capture option from the environment, rejecting unknown values. */
function captureOption<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
  return value as T;
}

/** Seed an isolated public fixture and refresh all README screenshots. */
async function main() {
  const theme = captureOption('README_SCREENSHOT_THEME', ['light', 'dark'] as const, 'light');
  const language = captureOption('README_SCREENSHOT_LANG', ['en', 'zh'] as const, 'en');
  console.log('🚀 Generating High-Definition Screenshots for GitHub README...');

  const outputDir = path.resolve(process.cwd(), process.env.README_SCREENSHOT_DIR?.trim() || 'docs/assets/screenshots');
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
    language,
    theme,
    palette: 'default',
    geminiApiKey: '',
    openaiApiKey: '',
    deepseekApiKey: '',
    openaiModel: 'gpt-6-luna',
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

  // 4. Seed Strategy, Goal Lists, and Favorite Folders
  const zh = language === 'zh';
  const showcaseStrategy = await store.planning.saveStrategy({
    name: zh ? '动态规划与图论专项' : 'Core DP & Graph Routine',
    weekdays: [1, 2, 3, 4, 5],
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 34, Medium: 33, Hard: 33 },
      tags: ['dynamic-programming', 'tree'],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 33,
      preference: zh
        ? '重点巩固自底向上递推与状态转移模板'
        : 'Master bottom-up tabulation and memoization patterns',
    },
  });

  await store.planning.saveStrategy({
    name: zh ? '周末困难题冲刺' : 'Weekend Hard Sprint',
    weekdays: [0, 6],
    rules: {
      dailyCount: 2,
      difficulty: { Easy: 0, Medium: 50, Hard: 50 },
      tags: ['graph-theory', 'dynamic-programming'],
      premium: false,
      reviewEnabled: false,
      reviewPercent: 0,
      preference: zh
        ? '专注拓扑排序、并查集与高难度动态规划'
        : 'Advanced topological sort, union find and hard DP',
    },
  });

  saveGoalList(db, {
    id: '11111111-1111-4111-8111-111111111111',
    name: zh ? '刷题核心 8 题' : 'Core Interview 8',
    version: 1,
    items: [
      { frontendId: '1', completed: true },
      { frontendId: '206', completed: true },
      { frontendId: '21', completed: true },
      { frontendId: '121', completed: true },
      { frontendId: '200', completed: false },
      { frontendId: '15', completed: false },
      { frontendId: '322', completed: false },
      { frontendId: '146', completed: false },
    ],
  });

  saveGoalList(db, {
    id: '22222222-2222-4222-8222-222222222222',
    name: zh ? '图论与动态规划冲刺' : 'Graph & DP Sprint',
    version: 1,
    items: [
      { frontendId: '207', completed: true },
      { frontendId: '210', completed: true },
      { frontendId: '300', completed: false },
      { frontendId: '198', completed: false },
      { frontendId: '102', completed: false },
    ],
  });

  const favFolders = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: zh ? '考前必刷' : 'Must Review' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: zh ? '边界易错题' : 'Tricky Edge Cases' },
  ];
  for (const folder of favFolders) {
    db.prepare('INSERT OR REPLACE INTO catalog_meta (key, value) VALUES (?, ?)').run(
      FAVORITE_FOLDER_PREFIX + folder.id,
      folder.name,
    );
  }
  const favoriteMemberships: Record<string, string[]> = {
    '1': [favFolders[0].id],
    '2': [favFolders[0].id, favFolders[1].id],
    '3': [favFolders[1].id],
    '15': [favFolders[0].id],
    '200': [favFolders[0].id, favFolders[1].id],
    '322': [favFolders[1].id],
    '146': [favFolders[0].id],
  };
  for (const [frontendId, folderIds] of Object.entries(favoriteMemberships)) {
    db.prepare('INSERT OR REPLACE INTO catalog_meta (key, value) VALUES (?, ?)').run(
      FAVORITE_PROBLEM_PREFIX + frontendId,
      JSON.stringify(folderIds),
    );
  }

  // 5. Seed Today Plan
  const todayDate = localDate(now, 'America/New_York');
  const planningRevisionRow = db.prepare("SELECT value FROM catalog_meta WHERE key = 'planning_revision'").get() as { value: string } | undefined;
  const planningRevision = planningRevisionRow ? Number(planningRevisionRow.value) || 1 : 1;
  const p1 = store.getProblem('1', 'frontendId') || { questionFrontendId: '1', title: 'Synthetic array exercise 1', difficulty: 'Easy', tags: ['Array'] };
  const p200 = store.getProblem('200', 'frontendId') || { questionFrontendId: '200', title: 'Synthetic dynamic-programming exercise 200', difficulty: 'Medium', tags: ['Dynamic Programming'] };
  const p15 = store.getProblem('15', 'frontendId') || { questionFrontendId: '15', title: 'Synthetic tree exercise 15', difficulty: 'Hard', tags: ['Tree'] };

  const planPayload = {
    id: 'daily-plan-readme',
    date: todayDate,
    timezone: 'America/New_York',
    version: 1,
    strategyId: showcaseStrategy.id,
    strategyVersion: 1,
    strategyName: zh ? '动态规划与图论专项' : 'Core DP & Graph Routine',
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 34, Medium: 33, Hard: 33 },
      tags: ['dynamic-programming', 'tree'],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 33,
      preference: zh
        ? '重点巩固自底向上递推与状态转移模板'
        : 'Master bottom-up tabulation and memoization patterns',
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
        problem: p200,
        kind: 'review' as const,
        addedAt: now - 3600000,
        reason: {
          en: 'Foundational dynamic programming problem demonstrating overlapping subproblems.',
          zh: '动态规划经典题型，强化状态定义与滚动优化。',
        },
        evidenceIds: [],
        completed: false,
      },
      {
        id: 'item-3',
        problem: p15,
        kind: 'new' as const,
        addedAt: now,
        reason: {
          en: 'Challenging tree traversal problem for sharpening recursion invariants.',
          zh: '树形结构进阶挑战，重点梳理递归边界与返回值约束。',
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
    planningRevision,
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
  store.upsertProblemNote(
    '1',
    zh
      ? `# 练习题 #1

### 💡 最优思路
使用单遍哈希表记录遍历过的元素及其下标。每次访问 \`nums[i]\` 时，检查 \`target - nums[i]\` 是否已经出现在哈希表中即可完成配对。

### ⏱️ 复杂度分析
- **时间复杂度：** $O(N)$，数组只需单次线性扫描。
- **空间复杂度：** $O(N)$，哈希表最多存储 $N$ 个元素。

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
`
      : `# Synthetic exercise 1

### 💡 Optimal Strategy
Use a single-pass hash map to store seen elements and their corresponding indices. As we iterate through \`nums\`, check if \`target - nums[i]\` exists in the table.

### ⏱️ Complexity
- **Time Complexity:** $O(N)$ - single pass through the array.
- **Space Complexity:** $O(N)$ - to store at most $N$ elements in the hash map.

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
`,
  );

  store.upsertProblemNote(
    '322',
    zh
      ? `# 练习题 #322

### 💡 动态规划思路
自底向上的一维背包 DP：令 \`dp[i]\` 表示凑出金额 \`i\` 所需的最少硬币枚数。初始化 \`dp[0] = 0\`，其余状态设为 \`amount + 1\`。

### 🔄 状态转移方程
$$dp[i] = \\min(dp[i], dp[i - c] + 1)$$
`
      : `# Synthetic exercise 322

### 💡 Dynamic Programming Approach
Bottom-up 1D DP tabulation: let \`dp[i]\` represent the minimum number of coins to make up amount \`i\`.
Initialize \`dp[0] = 0\` and all other values to \`amount + 1\`.

### 🔄 Recurrence Relation
$$dp[i] = \\min(dp[i], dp[i - c] + 1) \\quad \\forall c \\in \\text{coins}, i \\ge c$$
`,
  );

  // 7. Start Server
  console.log(`  [2/5] Starting Fastify backend on http://${host}:${port}...`);
  const app = await buildApp({ store });
  await app.listen({ host, port });

  // 8. Launch Headless Chrome
  console.log(`  [3/5] Launching Headless Chrome (CDP Port: ${cdpPort})...`);
  const chromeBin = findChromeExecutable();
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
  await capture('#notes', '04-notes-workspace.png', 'Master-Detail Notes Workspace & Markdown Editor', 1500, `document.querySelector('.notes-problem-card')?.click()`);

  // 5. Weekly Study Schedule
  await capture('#schedule', '05-study-schedule.png', 'Weekly Strategy & Quota Planner', 1500);

  // 6. Settings - Theme Palettes Gallery
  await capture('#settings', '06-theme-palettes.png', '10 Developer Theme Palettes Gallery', 1500, `(async () => {
    document.getElementById('settings-tab-appearance')?.click();
    await new Promise((r) => setTimeout(r, 150));
    const el = document.querySelector('.palette-grid') || document.querySelector('#settings-panel-appearance');
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
  })()`);

  // 7. Settings - Multi-Provider AI Configuration
  await capture('#settings', '07-ai-configuration.png', 'Multi-Provider AI Configuration Panel', 1500, `(async () => {
    document.getElementById('settings-tab-ai')?.click();
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('.disclosure-toggle')?.click();
    await new Promise((r) => setTimeout(r, 150));
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
  await cdp.send('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll('button')).find(b => ['Zen', 'Zen Mode', '专注'].includes((b.getAttribute('aria-label') || b.textContent || '').trim()))?.click()` });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const focused = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('.notes-master-pane').style.display === 'none'`, returnByValue: true });
  if (!focused.result.value) throw new Error('Notes focus control did not hide the master list');
  await cdp.send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: String.fromCharCode(92), ctrlKey: true, bubbles: true }))` });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const normal = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('.notes-master-pane').style.display !== 'none'`, returnByValue: true });
  if (!normal.result.value) throw new Error('Notes focus shortcut did not restore the master list');
  const report = { viewport: '1440x900 at 2x', theme, language, source: 'isolated synthetic catalog', screenshots: 8, identity: await verifyPage(), interactions: ['catalog import navigation', 'Notes focus button', 'Notes focus keyboard restore'], errors: cdp.errors };
  fs.writeFileSync(path.join(tempDir, 'capture-report.json'), JSON.stringify(report, null, 2));
  if (cdp.errors.length) throw new Error(`Browser errors: ${JSON.stringify(cdp.errors)}`);
  console.log('  [5/5] Cleaning up processes and temporary files...');
  await cdp.close();
  chromeProcess.kill();
  await app.close();
  db.close();

  console.log(`Synthetic capture profile retained at ${tempDir}`);

  console.log(`\n✨ All high-definition screenshots successfully generated in \`${path.relative(process.cwd(), outputDir) || '.'}\`!`);
}

main().catch((err) => {
  console.error('Fatal error generating assets:', err);
  process.exit(1);
});

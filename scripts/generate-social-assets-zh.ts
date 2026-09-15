/**
 * Script to generate high-resolution (2x Retina) Chinese promotional visual assets
 * across multiple developer themes for community posting (Xiaohongshu, V2EX, Zhihu, Jike, Twitter).
 *
 * Launches an isolated Fastify backend with 4,046 fictional synthetic problems, a full year of seeded
 * practice activity, Chinese study strategies, bilingual today plan, and notes.
 * Uses Headless Chrome via CDP (deviceScaleFactor: 2) to capture each view under its best theme.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { createSocialCatalog, socialPracticeIds } from './social-catalog.ts';

/** Resolve a locally installed browser without downloading or changing its profile. */
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

/** Minimal request/response CDP client for an isolated headless capture session. */
class CdpClient {
  private ws: WebSocket;
  private msgId = 0;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  /** Open a connection to the selected local debugging target. */
  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  /** Wait for the socket before installing response dispatch. */
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

  /** Match each protocol response to its pending request. */
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Close the capture session's socket. */
  async close(): Promise<void> {
    this.ws.close();
  }
}

/** Seed synthetic data and replace promotional screenshots using a private temporary profile. */
async function main() {
  console.log('🌟 [1/6] 正在准备中文多主题社交发帖宣传资产生成环境...');

  const outputDir = path.resolve(process.cwd(), 'docs/assets/social-zh');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const localRoot = path.resolve(process.cwd(), '.local');
  fs.mkdirSync(localRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(localRoot, 'temp-social-assets-'));

  const dbPath = path.join(tempDir, `social-preview-${Date.now()}.sqlite`);
  const chromeProfile = path.join(tempDir, `chrome-profile-${Date.now()}`);

  const port = 3098;
  const host = '127.0.0.1';
  const cdpPort = 9348;

  // 1. Initialize SQLite database & store with seed data
  console.log('  [2/6] 导入 4,046 道题库并填充一整年活跃打卡数据与中文规划...');
  const db = new DatabaseSync(dbPath);
  const store = await CatalogStore.open(db, { skipBackup: true });

  await store.importJsonl(createSocialCatalog());

  const tz = 'Asia/Shanghai';

  // Seed default settings: Chinese UI
  await store.updateSettings({
    timezone: tz,
    language: 'zh',
    theme: 'dark',
    palette: 'tokyo-night',
    // Explicitly cleared settings prevent inherited provider credentials from enabling network calls.
    geminiApiKey: '',
    openaiApiKey: '',
    deepseekApiKey: '',
    geminiModel: 'models/gemini-3.5-flash',
    geminiFallbackModels: ['models/gemini-2.5-pro', 'models/gemini-2.5-flash'],
    openaiModel: 'gpt-5.6-luna',
    deepseekModel: 'deepseek-flash',
  });

  // Seed practice records for past 280 days
  const now = Date.now();
  const dayMs = 86400000;
  const popularProblems = socialPracticeIds;

  for (let d = 260; d >= 0; d--) {
    if ((d % 7 !== 2 && d % 7 !== 6) || d % 3 === 0) {
      const count = (d % 4) + 1;
      for (let i = 0; i < count; i++) {
        const pId = popularProblems[(d * 3 + i) % popularProblems.length];
        await store.createPracticeRecord({
          questionFrontendId: pId,
          completed: true,
          practicedAt: new Date(now - d * dayMs - i * 3600000 * 2).toISOString(),
          durationMinutes: 15 + ((d * 7 + i * 5) % 45),
          notes: `#${pId} 练习记录：边界与最优复杂度优化验证。`,
        });
      }
    }
  }

  // Seed Chinese Strategies
  await store.planning.saveStrategy({
    name: '动态规划与核心系统算法专攻',
    weekdays: [1, 2, 3, 4, 5],
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 34, Medium: 33, Hard: 33 },
      tags: ['dynamic-programming', 'tree'],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 33,
      preference: '深入掌握自底向上递推、状态压缩与备忘录转移模式',
    },
  });

  await store.planning.saveStrategy({
    name: '周末高难压轴专项突破',
    weekdays: [0, 6],
    rules: {
      dailyCount: 2,
      difficulty: { Easy: 0, Medium: 50, Hard: 50 },
      tags: ['graph-theory', 'dynamic-programming'],
      premium: false,
      reviewEnabled: false,
      reviewPercent: 0,
      preference: '进阶拓扑排序、并查集连通性与高维区间DP',
    },
  });

  // Seed Today Plan
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayDate = formatter.format(new Date());
  const p1 = store.getProblem('1', 'frontendId') || { questionFrontendId: '1', title: 'Two Sum', difficulty: 'Easy', tags: ['Array', 'Hash Table'] };
  const p70 = store.getProblem('70', 'frontendId') || { questionFrontendId: '70', title: 'Climbing Stairs', difficulty: 'Easy', tags: ['Dynamic Programming', 'Math'] };
  const p322 = store.getProblem('322', 'frontendId') || { questionFrontendId: '322', title: 'Coin Change', difficulty: 'Medium', tags: ['Dynamic Programming', 'Breadth-First Search'] };

  const planPayload = {
    id: 'daily-plan-social',
    date: todayDate,
    timezone: tz,
    version: 1,
    strategyId: 'strategy-social',
    strategyVersion: 1,
    strategyName: '动态规划与核心系统算法专攻',
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 34, Medium: 33, Hard: 33 },
      tags: ['dynamic-programming', 'tree'],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 33,
      preference: '深入掌握自底向上递推、状态压缩与备忘录转移模式',
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
    source: 'gemini' as const,
    model: 'models/gemini-3.5-flash',
    encouragement: {
      en: 'Every complex algorithm is built upon simple, step-by-step logic. Trust your process today!',
      zh: '每一个复杂的算法都是由简单、循序渐进的逻辑构建而成的。保持专注，享受递推的魅力！',
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

  // Seed Markdown Notes
  store.upsertProblemNote('1', `# 1. 两数之和 (Two Sum)

### 💡 最优解题策略（单遍哈希表）
使用哈希映射（Hash Map）在遍历数组的同时记录每个元素的数值及其对应索引。
在访问当前数字 \`nums[i]\` 时，在哈希表中检查配对目标值 \`target - nums[i]\` 是否已存在：
- 若存在，说明找到了符合条件的双数，直接返回两者的下标。
- 若不存在，将当前 \`nums[i]\` 与索引 \`i\` 存入哈希表中供后续匹配。

### ⏱️ 复杂度分析
- **时间复杂度:** $\\mathcal{O}(N)$ —— 仅需单次遍历数组，哈希查找平均为 $\\mathcal{O}(1)$。
- **空间复杂度:** $\\mathcal{O}(N)$ —— 最多需在哈希表中存入 $N$ 个键值对。

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

  store.upsertProblemNote('322', `# 322. 零钱兑换 (Coin Change)

### 💡 动态规划解法（自底向上 Tabulation）
定义 \`dp[i]\` 为凑成总金额 \`i\` 所需的**最少硬币数**。
- **初始状态:** \`dp[0] = 0\`（凑出金额 0 需 0 枚硬币），其余值初始化为金额不可达的大值 \`amount + 1\`。
- **状态转移:** 对于每个可选硬币面值 $c \\in \\text{coins}$，当 $i \\ge c$ 时：

$$dp[i] = \\min(dp[i], \\; dp[i - c] + 1)$$

### ⏱️ 复杂度分析
- **时间复杂度:** $\\mathcal{O}(S \\times n)$，其中 $S$ 为金额 \`amount\`，$n$ 为硬币面额种类数。
- **空间复杂度:** $\\mathcal{O}(S)$，维护大小为 \`amount + 1\` 的动态规划数组。
`);

  // 2. Start Fastify backend
  console.log(`  [3/6] 启动 Fastify 本地服务 (http://${host}:${port})...`);
  const app = await buildApp({ store });

  // Add custom routes for social cover & theme matrix showcase
  app.get('/social-cover.html', async (req, reply) => {
    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>LeetCode Tracker 社交封面</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: radial-gradient(circle at 50% 20%, #1a1e2d 0%, #0d1117 100%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #f0f6fc;
    width: 1440px;
    height: 900px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 60px 80px 40px;
  }
  .header {
    text-align: center;
    max-width: 1000px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 18px;
    border-radius: 9999px;
    background: rgba(122, 162, 247, 0.15);
    border: 1px solid rgba(122, 162, 247, 0.35);
    color: #7aa2f7;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.5px;
    margin-bottom: 20px;
  }
  h1 {
    font-size: 48px;
    font-weight: 800;
    line-height: 1.2;
    background: linear-gradient(135deg, #ffffff 30%, #a5b4fc 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 14px;
    letter-spacing: -0.5px;
  }
  .subtitle {
    font-size: 20px;
    color: #94a3b8;
    line-height: 1.5;
    margin-bottom: 24px;
  }
  .tags {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 12px;
  }
  .tag {
    padding: 6px 14px;
    border-radius: 8px;
    background: #161b22;
    border: 1px solid #30363d;
    font-size: 13px;
    color: #c9d1d9;
    font-weight: 500;
  }
  .tag.highlight {
    background: rgba(189, 147, 249, 0.12);
    border-color: rgba(189, 147, 249, 0.4);
    color: #cba6f7;
  }
  .cards-grid {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 24px;
    margin-top: 20px;
  }
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 16px 36px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    height: 380px;
    position: relative;
    overflow: hidden;
  }
  .card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; height: 3px;
  }
  .card-1::before { background: linear-gradient(90deg, #7aa2f7, #bb9af7); }
  .card-2::before { background: linear-gradient(90deg, #10b981, #06b6d4); }
  .card-3::before { background: linear-gradient(90deg, #bd93f9, #ff79c6); }
  .card-theme-tag {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 12px;
  }
  .card-1 .card-theme-tag { color: #7aa2f7; }
  .card-2 .card-theme-tag { color: #10b981; }
  .card-3 .card-theme-tag { color: #bd93f9; }
  .card-title {
    font-size: 20px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 8px;
  }
  .card-desc {
    font-size: 13px;
    color: #8b949e;
    line-height: 1.6;
    margin-bottom: 16px;
  }
  .mock-content {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 10px;
    padding: 14px;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
  }
  .mock-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: #161b22;
    border-radius: 6px;
  }
  .diff-easy { color: #3fb950; font-weight: 600; }
  .diff-med { color: #d29922; font-weight: 600; }
  .diff-hard { color: #f85149; font-weight: 600; }
  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    border-top: 1px solid #21262d;
    padding-top: 18px;
    color: #8b949e;
    font-size: 13px;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="badge">Release 1.0 · Windows 桌面端 · 合成数据演示</div>
    <h1>LeetCode Tracker 算法刷题工作台</h1>
    <p class="subtitle">4,046 道合成题目演示 · 每周练习与间隔复习 · 10 款主题 · 可选 AI 辅助</p>
    <div class="tags">
      <div class="tag highlight">📚 自备 JSONL 题库导入</div>
      <div class="tag highlight">🎨 10 款程序员主题调色板</div>
      <div class="tag highlight">🧠 AI 个性化推荐与复习</div>
      <div class="tag">📝 双栏 Markdown 笔记</div>
      <div class="tag">📊 365 天刷题全景热力图</div>
      <div class="tag">🔒 SQLite 本地存储 · AI 按需联网</div>
    </div>
  </div>

  <div class="cards-grid">
    <div class="card card-1">
      <div>
        <div class="card-theme-tag">Theme: Tokyo Night · 东京暗夜</div>
        <div class="card-title">今日计划与智能推荐</div>
        <div class="card-desc">结合每周策略与练习记录安排新题和复习；AI 可选，本地规则校验推荐与保存。</div>
      </div>
      <div class="mock-content">
        <div class="mock-row">
          <span>✓ 1. 两数之和</span>
          <span class="diff-easy">简单 · 已打卡</span>
        </div>
        <div class="mock-row">
          <span>⏳ 70. 爬楼梯</span>
          <span class="diff-easy">简单 · 待复习</span>
        </div>
        <div class="mock-row">
          <span>🔥 322. 零钱兑换</span>
          <span class="diff-med">中等 · 攻坚中</span>
        </div>
      </div>
    </div>

    <div class="card card-2">
      <div>
        <div class="card-theme-tag">Theme: Midnight OLED · 纯黑极夜</div>
        <div class="card-title">365天热力图与数据看板</div>
        <div class="card-desc">纯黑 OLED 极致黑曜石背景，翠绿荧光全景打卡活跃方块与多维度解题占比统计。</div>
      </div>
      <div class="mock-content">
        <div class="mock-row">
          <span>累计练习题数</span>
          <strong style="color:#10b981;">348 题</strong>
        </div>
        <div class="mock-row">
          <span>当前连续打卡</span>
          <strong style="color:#06b6d4;">28 天</strong>
        </div>
        <div class="mock-row">
          <span>简单 / 中等 / 困难</span>
          <span>120 / 185 / 43</span>
        </div>
      </div>
    </div>

    <div class="card card-3">
      <div>
        <div class="card-theme-tag">Theme: Dracula · 暗夜吸血鬼</div>
        <div class="card-title">双栏笔记与代码速记</div>
        <div class="card-desc">一题一记，保存 Markdown 源文、公式文本和代码笔记，导出至 Obsidian 或 Notion。</div>
      </div>
      <div class="mock-content">
        <div class="mock-row">
          <span># 1. 两数之和</span>
          <span style="color:#bd93f9;">单遍哈希 O(N)</span>
        </div>
        <div class="mock-row">
          <span># 322. 零钱兑换</span>
          <span style="color:#ff79c6;">DP 状态转移</span>
        </div>
        <div style="font-family: monospace; color:#95a3cf; font-size: 11px; padding: 6px;">
          dp[i] = min(dp[i], dp[i - c] + 1)
        </div>
      </div>
    </div>
  </div>

  <div class="footer">
    <span>开源 Local-First 架构 · 无内置爬虫 · 自持数据 JSONL 导入</span>
    <span>GitHub: Yide-Milo-Li/Leetcode-Tracker</span>
  </div>
</body>
</html>`);
  });

  app.get('/theme-matrix.html', async (req, reply) => {
    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>10款程序员专属调色板矩阵</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0d1117;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #f0f6fc;
    width: 1440px;
    height: 900px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 40px 60px 30px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title-area h1 {
    font-size: 32px;
    font-weight: 800;
    color: #fff;
    margin-bottom: 6px;
  }
  .title-area p {
    font-size: 15px;
    color: #8b949e;
  }
  .tag-pill {
    padding: 6px 14px;
    background: #1f242c;
    border: 1px solid #30363d;
    border-radius: 999px;
    font-size: 12px;
    color: #58a6ff;
  }
  .matrix-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 18px;
    margin: 16px 0;
  }
  .theme-column {
    border-radius: 14px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    height: 610px;
    border: 1px solid;
    box-shadow: 0 12px 30px rgba(0,0,0,0.35);
  }
  .col-title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .col-sub {
    font-size: 12px;
    opacity: 0.75;
    margin-bottom: 14px;
  }
  .palette-swatches {
    display: flex;
    gap: 6px;
    margin-bottom: 14px;
  }
  .swatch {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.15);
  }
  .ui-mock-card {
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 10px;
    border: 1px solid;
    font-size: 12px;
  }
  .mock-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
    font-weight: 600;
  }
  .badge-easy { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
  .badge-med { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
  .badge-hard { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
  .mock-desc {
    font-size: 11px;
    line-height: 1.45;
    opacity: 0.8;
    margin-bottom: 8px;
  }
  .mock-tags {
    display: flex;
    gap: 6px;
  }
  .mock-tag {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    opacity: 0.85;
  }
  .mock-btn {
    width: 100%;
    padding: 8px;
    border-radius: 8px;
    border: none;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    margin-top: 6px;
  }
  .bottom-bar {
    border-top: 1px solid #21262d;
    padding-top: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    color: #8b949e;
  }
  .other-themes {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .theme-chip {
    padding: 4px 10px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    font-size: 11px;
    color: #c9d1d9;
  }

  /* 1. Tokyo Night */
  .col-tokyo {
    background: #1a1b26;
    border-color: #2f3549;
    color: #c0caf5;
  }
  .col-tokyo .col-title { color: #7aa2f7; }
  .col-tokyo .ui-mock-card { background: #24283b; border-color: #3b4261; color: #c0caf5; }
  .col-tokyo .badge-easy { background: rgba(158,206,106,0.18); color: #9ece6a; }
  .col-tokyo .badge-med { background: rgba(224,175,104,0.18); color: #e0af68; }
  .col-tokyo .mock-tag { background: #16161e; color: #7aa2f7; }
  .col-tokyo .mock-btn { background: #7aa2f7; color: #1a1b26; }

  /* 2. Dracula */
  .col-dracula {
    background: #282a36;
    border-color: #4d5470;
    color: #f8f8f2;
  }
  .col-dracula .col-title { color: #bd93f9; }
  .col-dracula .ui-mock-card { background: #343746; border-color: #44475a; color: #f8f8f2; }
  .col-dracula .badge-easy { background: rgba(80,250,123,0.18); color: #50fa7b; }
  .col-dracula .badge-med { background: rgba(255,184,108,0.18); color: #ffb86c; }
  .col-dracula .mock-tag { background: #21222c; color: #ff79c6; }
  .col-dracula .mock-btn { background: #bd93f9; color: #282a36; }

  /* 3. Nord */
  .col-nord {
    background: #2e3440;
    border-color: #4c566a;
    color: #eceff4;
  }
  .col-nord .col-title { color: #88c0d0; }
  .col-nord .ui-mock-card { background: #3b4252; border-color: #434c5e; color: #eceff4; }
  .col-nord .badge-easy { background: rgba(163,190,140,0.18); color: #a3be8c; }
  .col-nord .badge-med { background: rgba(235,203,139,0.18); color: #ebcb8b; }
  .col-nord .mock-tag { background: #242933; color: #88c0d0; }
  .col-nord .mock-btn { background: #88c0d0; color: #2e3440; }

  /* 4. Catppuccin Mocha */
  .col-catppuccin {
    background: #1e1e2e;
    border-color: #45475a;
    color: #cdd6f4;
  }
  .col-catppuccin .col-title { color: #cba6f7; }
  .col-catppuccin .ui-mock-card { background: #252538; border-color: #313244; color: #cdd6f4; }
  .col-catppuccin .badge-easy { background: rgba(166,227,161,0.18); color: #a6e3a1; }
  .col-catppuccin .badge-med { background: rgba(250,179,135,0.18); color: #fab387; }
  .col-catppuccin .mock-tag { background: #181825; color: #f5c2e7; }
  .col-catppuccin .mock-btn { background: #cba6f7; color: #1e1e2e; }
</style>
</head>
<body>
  <div class="header">
    <div class="title-area">
      <h1>10 款程序员专属调色板 · 即时热切换</h1>
      <p>4 款主题示意预览 · 应用共提供 10 款配色 · 明暗主题与高对比度选项</p>
    </div>
    <div class="tag-pill">🎨 纯原生 CSS 令牌层叠架构</div>
  </div>

  <div class="matrix-grid">
    <!-- 1. Tokyo Night -->
    <div class="theme-column col-tokyo">
      <div>
        <div class="col-title">
          <span>东京暗夜</span>
          <span style="font-size: 11px; opacity:0.8;">Tokyo Night</span>
        </div>
        <div class="col-sub">霓虹冷调深蓝 · 极具现代科技感</div>
        <div class="palette-swatches">
          <div class="swatch" style="background:#1a1b26;"></div>
          <div class="swatch" style="background:#24283b;"></div>
          <div class="swatch" style="background:#7aa2f7;"></div>
          <div class="swatch" style="background:#bb9af7;"></div>
          <div class="swatch" style="background:#9ece6a;"></div>
        </div>

        <div class="ui-mock-card">
          <div class="mock-header">
            <span>#1 两数之和</span>
            <span class="badge-easy">简单</span>
          </div>
          <div class="mock-desc">单遍哈希表查找最优解，O(1) 状态映射。</div>
          <div class="mock-tags">
            <span class="mock-tag">数组</span>
            <span class="mock-tag">哈希表</span>
          </div>
        </div>

        <div class="ui-mock-card">
          <div class="mock-header">
            <span>#322 零钱兑换</span>
            <span class="badge-med">中等</span>
          </div>
          <div class="mock-desc">经典完全背包 DP 转移方程递推。</div>
          <div class="mock-tags">
            <span class="mock-tag">动态规划</span>
            <span class="mock-tag">BFS</span>
          </div>
        </div>
      </div>
      <button class="mock-btn">打卡记录 (Today)</button>
    </div>

    <!-- 2. Dracula -->
    <div class="theme-column col-dracula">
      <div>
        <div class="col-title">
          <span>吸血鬼</span>
          <span style="font-size: 11px; opacity:0.8;">Dracula</span>
        </div>
        <div class="col-sub">暗夜高对比度紫粉 · 经典黑客首选</div>
        <div class="palette-swatches">
          <div class="swatch" style="background:#282a36;"></div>
          <div class="swatch" style="background:#343746;"></div>
          <div class="swatch" style="background:#bd93f9;"></div>
          <div class="swatch" style="background:#ff79c6;"></div>
          <div class="swatch" style="background:#50fa7b;"></div>
        </div>

        <div class="ui-mock-card">
          <div class="mock-header">
            <span>#1 两数之和</span>
            <span class="badge-easy">简单</span>
          </div>
          <div class="mock-desc">单遍哈希表查找最优解，O(1) 状态映射。</div>
          <div class="mock-tags">
            <span class="mock-tag">数组</span>
            <span class="mock-tag">哈希表</span>
          </div>
        </div>

        <div class="ui-mock-card">
          <div class="mock-header">
            <span>#322 零钱兑换</span>
            <span class="badge-med">中等</span>
          </div>
          <div class="mock-desc">经典完全背包 DP 转移方程递推。</div>
          <div class="mock-tags">
            <span class="mock-tag">动态规划</span>
            <span class="mock-tag">BFS</span>
          </div>
        </div>
      </div>
      <button class="mock-btn">打卡记录 (Today)</button>
    </div>

    <!-- 3. Nord -->
    <div class="theme-column col-nord">
      <div>
        <div class="col-title">
          <span>北极极光</span>
          <span style="font-size: 11px; opacity:0.8;">Nord</span>
        </div>
        <div class="col-sub">典雅冰雪蓝灰 · 护眼清冽高冷</div>
        <div class="palette-swatches">
          <div class="swatch" style="background:#2e3440;"></div>
          <div class="swatch" style="background:#3b4252;"></div>
          <div class="swatch" style="background:#88c0d0;"></div>
          <div class="swatch" style="background:#a3be8c;"></div>
          <div class="swatch" style="background:#ebcb8b;"></div>
        </div>

        <div class="ui-mock-card">
          <div class="mock-header">
            <span>#1 两数之和</span>
            <span class="badge-easy">简单</span>
          </div>
          <div class="mock-desc">单遍哈希表查找最优解，O(1) 状态映射。</div>
          <div class="mock-tags">
            <span class="mock-tag">数组</span>
            <span class="mock-tag">哈希表</span>
          </div>
        </div>

        <div class="ui-mock-card">
          <div class="mock-header">
            <span>#322 零钱兑换</span>
            <span class="badge-med">中等</span>
          </div>
          <div class="mock-desc">经典完全背包 DP 转移方程递推。</div>
          <div class="mock-tags">
            <span class="mock-tag">动态规划</span>
            <span class="mock-tag">BFS</span>
          </div>
        </div>
      </div>
      <button class="mock-btn">打卡记录 (Today)</button>
    </div>

    <!-- 4. Catppuccin Mocha -->
    <div class="theme-column col-catppuccin">
      <div>
        <div class="col-title">
          <span>猫咖深摩卡</span>
          <span style="font-size: 11px; opacity:0.8;">Mocha</span>
        </div>
        <div class="col-sub">温润粉彩暗色 · 社区最受欢迎新星</div>
        <div class="palette-swatches">
          <div class="swatch" style="background:#1e1e2e;"></div>
          <div class="swatch" style="background:#252538;"></div>
          <div class="swatch" style="background:#cba6f7;"></div>
          <div class="swatch" style="background:#f5c2e7;"></div>
          <div class="swatch" style="background:#a6e3a1;"></div>
        </div>

        <div class="ui-mock-card">
          <div class="mock-header">
            <span>#1 两数之和</span>
            <span class="badge-easy">简单</span>
          </div>
          <div class="mock-desc">单遍哈希表查找最优解，O(1) 状态映射。</div>
          <div class="mock-tags">
            <span class="mock-tag">数组</span>
            <span class="mock-tag">哈希表</span>
          </div>
        </div>

        <div class="ui-mock-card">
          <div class="mock-header">
            <span>#322 零钱兑换</span>
            <span class="badge-med">中等</span>
          </div>
          <div class="mock-desc">经典完全背包 DP 转移方程递推。</div>
          <div class="mock-tags">
            <span class="mock-tag">动态规划</span>
            <span class="mock-tag">BFS</span>
          </div>
        </div>
      </div>
      <button class="mock-btn">打卡记录 (Today)</button>
    </div>
  </div>

  <div class="bottom-bar">
    <div class="other-themes">
      <span>更多内置风格：</span>
      <span class="theme-chip">One Dark (原子暗色)</span>
      <span class="theme-chip">Gruvbox (复古暖棕)</span>
      <span class="theme-chip">Midnight OLED (纯黑极夜)</span>
      <span class="theme-chip">GitHub Light (极简明亮)</span>
      <span class="theme-chip">Catppuccin Latte (清晨拿铁)</span>
      <span class="theme-chip">Forest Sage (静谧林语)</span>
    </div>
    <span>支持个人设置面板一键无损切换</span>
  </div>
</body>
</html>`);
  });

  await app.listen({ host, port });

  // 3. Launch Headless Chrome
  console.log(`  [4/6] 启动 Headless Chrome 自动化截屏 (CDP Port: ${cdpPort})...`);
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

  if (!pageWsUrl) {
    throw new Error('Failed to connect to Chrome CDP endpoint.');
  }

  const cdp = new CdpClient(pageWsUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');

  // Set standard desktop 1440x900 viewport with deviceScaleFactor: 2 for 2880x1800 Retina clarity
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  /** Apply a desktop theme, wait for rendering, and save a PNG into the public asset directory. */
  const captureView = async (options: {
    urlPath: string;
    filename: string;
    label: string;
    palette: string;
    theme?: 'dark' | 'light';
    extraWait?: number;
    evalBeforeCapture?: string;
  }) => {
    const { urlPath, filename, label, palette, theme = 'dark', extraWait = 1500, evalBeforeCapture } = options;
    console.log(`  [5/6] 📸 正在截取: [${palette}] ${label} -> ${filename}...`);

    // Update settings in database so on reload it has exactly this palette & theme & zh language
    await store.updateSettings({
      language: 'zh',
      theme,
      palette: palette as any,
      timezone: tz,
    });

    // Query param comes BEFORE hash so location.hash is clean
    const targetUrl = urlPath.startsWith('http')
      ? urlPath
      : urlPath.endsWith('.html')
        ? `http://${host}:${port}/${urlPath}`
        : `http://${host}:${port}/?theme=${palette}&t=${Date.now()}${urlPath}`;

    await cdp.send('Page.navigate', { url: targetUrl });
    await new Promise((r) => setTimeout(r, extraWait));

    // Force DOM attribute to guarantee styling applies without any delay
    if (!urlPath.endsWith('.html')) {
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          if ('${palette}' !== 'default') {
            document.documentElement.setAttribute('data-palette', '${palette}');
          } else {
            document.documentElement.removeAttribute('data-palette');
          }
          document.documentElement.classList.toggle('dark', ${theme === 'dark'});
          document.documentElement.style.colorScheme = '${theme}';
        })()`,
        awaitPromise: true,
      });
    }

    if (evalBeforeCapture) {
      await cdp.send('Runtime.evaluate', { expression: evalBeforeCapture, awaitPromise: true });
      await new Promise((r) => setTimeout(r, 600));
    }

    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const targetFile = path.join(outputDir, filename);
    fs.writeFileSync(targetFile, Buffer.from(result.data, 'base64'));
    const sizeKb = (fs.statSync(targetFile).size / 1024).toFixed(1);
    console.log(`    ✓ 已保存 ${filename} (${sizeKb} KB)`);
  };

  try {
    // 00. Social Media Banner Cover
    await captureView({
      urlPath: 'social-cover.html',
      filename: '00-cover-banner.png',
      label: '社交全景封面横幅 (Cover Banner)',
      palette: 'tokyo-night',
      extraWait: 900,
    });

    // 01. Today View (Tokyo Night - 东京暗夜)
    await captureView({
      urlPath: '#today',
      filename: '01-today-overview-tokyonight.png',
      label: '今日刷题与 AI 推荐 (Tokyo Night)',
      palette: 'tokyo-night',
      theme: 'dark',
      extraWait: 1600,
    });

    // 02. Dashboard Analytics & Heatmap (Midnight OLED - 纯黑极夜)
    await captureView({
      urlPath: '#statistics',
      filename: '02-dashboard-analytics-oled.png',
      label: '365天全景热力图与刷题分析 (Midnight OLED)',
      palette: 'midnight-oled',
      theme: 'dark',
      extraWait: 1800,
    });

    // 03. Problems Catalog (Nord - 北极极光)
    await captureView({
      urlPath: '#problems',
      filename: '03-problems-catalog-nord.png',
      label: '4046道题库中心与秒级检索 (Nord)',
      palette: 'nord',
      theme: 'dark',
      extraWait: 1600,
    });

    // 04. Notes Workspace (One Dark - 原子暗色)
    await captureView({
      urlPath: '#notes',
      filename: '04-notes-workspace-onedark.png',
      label: '双栏 Markdown 笔记与代码速记 (One Dark)',
      palette: 'one-dark',
      theme: 'dark',
      extraWait: 1800,
    });

    // 05. Study Schedule & Strategies (Catppuccin Mocha - 猫咖深摩卡)
    await captureView({
      urlPath: '#schedule',
      filename: '05-study-schedule-catppuccin.png',
      label: '多周策略与智能复习编排 (Catppuccin Mocha)',
      palette: 'catppuccin-mocha',
      theme: 'dark',
      extraWait: 1600,
    });

    // 06. Theme Palettes Gallery (Dracula - 吸血鬼)
    await captureView({
      urlPath: '#settings',
      filename: '06-theme-palettes-dracula.png',
      label: '10套程序员主题画廊 (Dracula)',
      palette: 'dracula',
      theme: 'dark',
      extraWait: 1600,
      evalBeforeCapture: `(() => {
        const el = document.querySelector('.palette-selection-section') || document.querySelector('.theme-palette-grid');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
      })()`,
    });

    // 07. Multi-Provider AI Config (Gruvbox Dark - 复古暖棕)
    await captureView({
      urlPath: '#settings',
      filename: '07-ai-configuration-gruvbox.png',
      label: '本地多模型 AI 配置面板 (Gruvbox Dark)',
      palette: 'gruvbox-dark',
      theme: 'dark',
      extraWait: 1600,
      evalBeforeCapture: `(() => {
        const el = document.querySelector('.ai-settings-form')?.closest('.preference-row') || document.querySelector('.ai-settings-form');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
      })()`,
    });

    // 08. BYOD Ingestion Workspace & Clean Light (GitHub Light - 极简明亮)
    await captureView({
      urlPath: '#catalog-import',
      filename: '08-catalog-import-githublight.png',
      label: '极简明亮模式与自持题库导入 (GitHub Light)',
      palette: 'github-light',
      theme: 'light',
      extraWait: 1600,
    });

    // 09. Theme Matrix Showcase
    await captureView({
      urlPath: 'theme-matrix.html',
      filename: '09-theme-matrix-showcase.png',
      label: '10款程序员专属调色板横向对比矩阵 (Theme Matrix)',
      palette: 'default',
      extraWait: 900,
    });

  } finally {
    console.log('  [6/6] 正在安全清理无头浏览器与临时数据库...');
    await cdp.close();
    chromeProcess.kill();
    await app.close();
    db.close();

    try {
      // Delete only this run's resolved child directory, never a shared profile or parent directory.
      const resolvedTemp = path.resolve(tempDir);
      if (path.dirname(resolvedTemp) !== localRoot || !path.basename(resolvedTemp).startsWith('temp-social-assets-')) {
        throw new Error('Unexpected temporary directory');
      }
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    } catch {}
  }

  console.log('\n🎉 全套中文多主题社交发帖宣传资产已成功生成至 `docs/assets/social-zh/`！');
}

main().catch((err) => {
  console.error('Fatal error generating social assets:', err);
  process.exit(1);
});

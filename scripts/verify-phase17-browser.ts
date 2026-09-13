/** Desktop settings acceptance with isolated SQLite, Chrome and synthetic provider responses.
 * Browser plugin not available; reuse the repository's isolated Chrome/CDP acceptance harness.
 * Requires npm run build. Never opens the user's database or calls a paid provider.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { LLMAssistant } from '../apps/server/src/llm/assistant.ts';


const root = process.cwd();
const out = path.resolve(root, '.local/evidence/phase17/browser');
const profile = path.join(out, 'chrome-' + Date.now());
await mkdir(profile, { recursive: true });
const db = new DatabaseSync(':memory:');
const store = new CatalogStore(db, { skipBackup: true });
const report = { screenshots: [] as string[], layouts: [] as unknown[], flows: [] as string[], errors: [] as unknown[], consoleMessages: [] as any[], externalRequests: [] as string[], failure: '' };
await store.updateSettings({ timezone: 'UTC', language: 'en', theme: 'light',
  geminiApiKey: 'synthetic-gemini', openaiApiKey: 'synthetic-openai', deepseekApiKey: 'synthetic-deepseek',
  openaiFallbackModels: [], deepseekFallbackModels: [] });
const assistant = new LLMAssistant({ providers: {
  gemini: { apiKey: 'synthetic-gemini' }, openai: { apiKey: 'synthetic-openai' }, deepseek: { apiKey: 'synthetic-deepseek' },
}, generateContentFn: async () => ({ text: '{"candidates":[]}' }), customGenerateFn: async () => ({ text: '{"candidates":[]}' }) });
const app = await buildApp({ store, geminiAssistant: assistant, staticRoot: path.resolve(root, 'apps/web/dist') });
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('No loopback address');
const origin = 'http://127.0.0.1:' + address.port;
const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    'about:blank',
  ],
  { windowsHide: true, stdio: 'ignore' },
);
let socket: WebSocket | undefined;
/** Poll only a local rendering milestone with a short bounded delay. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let port = 0;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      break;
    } catch {
      await delay(100);
    }
  }
  if (!port) throw new Error('Isolated Chrome did not start');
  const target = (await (
    await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })
  ).json()) as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve();
    socket!.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  /** Time-bound CDP requests make a failed interaction stop with evidence instead of hanging. */
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket!.send(JSON.stringify({ id, method, params }));
    });
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const operation = pending.get(message.id);
      pending.delete(message.id);
      if (operation)
        message.error
          ? operation.reject(new Error(JSON.stringify(message.error)))
          : operation.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') report.errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type))
      report.consoleMessages.push({ type: message.params.type, args: message.params.args.map((arg: any) => arg.value ?? arg.description) });
    if (message.method === 'Network.requestWillBeSent') {
      const url = message.params.request.url as string;
      if (/^https?:/.test(url) && !url.startsWith(origin)) report.externalRequests.push(url);
    }

  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  /** Propagate page exceptions and only return serializable DOM values. */
  const evaluate = async (expression: string) => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails)
      throw new Error(
        value.exceptionDetails.exception?.description ?? JSON.stringify(value.exceptionDetails),
      );
    return value.result.value;
  };
  /** Wait for an explicit DOM condition; timeout includes the actual visible text for diagnosis. */
  const until = async (condition: string) => {
    for (let n = 0; n < 70; n++) {
      if (await evaluate(`Boolean(${condition})`)) return;
      await delay(80);
    }
    throw new Error(
      'DOM timeout: ' + condition + '\n' + (await evaluate('document.body.innerText.slice(-3500)')),
    );
  };
  const visible = "e => e.getClientRects().length && !e.closest('[hidden], [inert]')";
  /** Click real visible controls by text without invoking application internals. */
  const click = async (label: string, selector = 'button') => {
    // Hit-test the settled control, not coordinates from a moving entrance frame.
    await until("document.getAnimations().every(a=>a.playState!=='running'||!['dialog-enter','drawer-enter'].includes(a.animationName))");
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const point = await evaluate(
          `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible}).find(e => e.textContent.trim() === ${JSON.stringify(label)} || e.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!e || e.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(label)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
        );
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        await delay(100);
        if (await evaluate("Boolean(document.querySelector('.overlay-backdrop.is-closing'))")) {
          await until("!document.querySelector('.overlay-backdrop.is-closing')");
        }
        return;
      } catch (err) {
        if (attempt === 29) throw err;
        await delay(60);
      }
    }
  };
  /** Native value setters trigger the same React change handlers as browser editing. */
  const fill = async (selector: string, value: string) => {
    await evaluate(
      `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(${visible}); if (!e) throw new Error('Missing input'); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); })()`,
    );
    await delay(100);
  };
  const navigate = async (view: string) => {
    await evaluate('location.hash=' + JSON.stringify(view));
    await until(`document.getElementById('view-${view}') && !document.getElementById('view-${view}').hidden`);
    await delay(200);
  };
  const screenshot = async (name: string) => {
    await delay(240);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
    report.screenshots.push(name + '.png');
  };
  const reload = async (view = 'today') => {
    // Hash-only navigation is same-document: force a new document before testing persisted preferences.
    await send('Page.navigate', { url: 'about:blank' });
    await until("!document.querySelector('.sidebar')");
    await send('Page.navigate', { url: origin + '/#' + view });
    await until("document.querySelector('.sidebar') && document.querySelector('h1')");
    await delay(400);
  };

  for (const width of [1024, 1440]) for (const language of ['en', 'zh'] as const) for (const theme of ['light', 'dark'] as const) {
    await store.updateSettings({ language, theme });
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await reload('settings');
    await until("document.querySelector('.ai-settings-form fieldset:not(:disabled)')");
    assert.equal(await evaluate('document.title'), 'LeetCode Tracker — Local Catalog Workbench');
    for (const provider of ['gemini', 'openai', 'deepseek'] as const) {
      await click({ gemini: 'Google Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' }[provider]);
      assert.equal(await evaluate("document.querySelector('.ai-settings-form input').type"), 'password');
      assert.equal(await evaluate("document.querySelector('.ai-settings-form input').value"), 'synthetic-' + provider);
      await click(language === 'en' ? 'Test Connection' : '测试连接');
      await until("document.querySelector('.ai-settings-form fieldset:not(:disabled)')");
      await click(language === 'en' ? 'Save AI settings' : '保存 AI 配置');
      await until("document.querySelector('.ai-settings-form fieldset:not(:disabled)')");
      assert.equal(store.getSettings().llmProvider, provider);
      assert.equal(assistant.getStatus().provider, provider);
      await evaluate("document.querySelector('.ai-settings-form').scrollIntoView({block:'start'})");
      const layout = await evaluate('({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth})');
      assert.ok(layout.scroll <= layout.width + 1, 'Desktop horizontal overflow');
      assert.equal(await evaluate("Boolean(document.querySelector('vite-error-overlay'))"), false);
      report.layouts.push({ width, language, theme, provider, ...layout });
      await screenshot(`${width}-${language}-${theme}-${provider}`);
    }
  }
  await store.updateSettings({ language: 'en', theme: 'light' });
  await reload('settings');
  await until("document.querySelector('.ai-settings-form fieldset:not(:disabled)')");
  await click('OpenAI');
  await fill('.ai-settings-form input', 'synthetic-draft');
  await click('DeepSeek');
  await click('OpenAI');
  assert.equal(await evaluate("document.querySelector('.ai-settings-form input').value"), 'synthetic-draft');
  await click('Save AI settings');
  await until("document.querySelector('.ai-settings-form fieldset:not(:disabled)')");
  await reload('settings');
  await until("document.querySelector('.ai-settings-form input').value === 'synthetic-draft'");
  assert.equal(store.getSettings().geminiApiKey, 'synthetic-gemini');
  assert.equal(store.getSettings().deepseekApiKey, 'synthetic-deepseek');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.ok(await evaluate("document.activeElement?.tagName !== 'BODY'"));
  report.flows.push('24 desktop provider/language/theme/width cases', 'Synthetic connection probes', 'Independent drafts and persisted reload', 'Keyboard focus');
  assert.equal(report.errors.length, 0);
  assert.equal(report.consoleMessages.length, 0);
  assert.equal(report.externalRequests.length, 0);
} catch (error) {
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  socket?.close();
  chrome.kill();
  await app.close();
  db.close();
  console.log(JSON.stringify({ cases: report.layouts.length, screenshots: report.screenshots.length, flows: report.flows.length, errors: report.errors.length, externalRequests: report.externalRequests.length, failure: report.failure }));
}

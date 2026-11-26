/**
 * Floating AI chat in the web client: event decoding, turn selection and the rendered panel.
 *
 * The local service is a synthetic `fetch` that streams scripted events; no provider is involved.
 */
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ChatStreamEvent } from '../packages/contracts/src/chat.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, location: dom.window.location, HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent, Event: dom.window.Event, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
const React = await import('react');
const { render, fireEvent, screen, act, cleanup, waitFor } = await import('@testing-library/react');
const { api } = await import('../apps/web/src/api.ts');
const { createChatEventDecoder } = await import('../apps/web/src/chat/chat-stream.ts');
const { requestTurns } = await import('../apps/web/src/chat/useChat.ts');
const { setChatProblem } = await import('../apps/web/src/chat/chat-context.ts');
const { ChatLauncher, LAUNCHER_REST_MS } = await import('../apps/web/src/components/ChatLauncher.tsx');
const { DEFAULT_CHAT_POSITION, dockAt, dockForPanel, launcherPoint, panelPoint } = await import('../apps/web/src/chat/chat-position.ts');

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  localStorage.clear();
  setChatProblem(null);
});

const encode = (events: ChatStreamEvent[]) => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));

/** Local service stub: records request bodies and answers each call with the next script. */
function serveChat(...scripts: Array<ChatStreamEvent[] | { status: number; body: unknown }>) {
  const requests: Array<{ messages: Array<{ role: string; content: string }>; context?: Record<string, unknown>; lang?: string }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), 'http://localhost/api/v1/chat/stream');
    requests.push(JSON.parse(String(init!.body)));
    const script = scripts[Math.min(requests.length - 1, scripts.length - 1)];
    if (!Array.isArray(script)) return new Response(JSON.stringify(script.body), { status: script.status });
    const bytes = encode(script);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // Uneven chunks split events and multi-byte characters.
        for (let offset = 0; offset < bytes.length; offset += 11) controller.enqueue(bytes.slice(offset, offset + 11));
        controller.close();
      },
    }), { status: 200 });
  }) as typeof fetch;
  return requests;
}

async function openPanel(lang: 'en' | 'zh' = 'en', onToday = false) {
  const settings = mock.fn();
  await act(async () => { render(<ChatLauncher lang={lang} onToday={onToday} onOpenAiSettings={settings} />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: lang === 'zh' ? '问 AI' : 'Ask AI' })); });
  await waitFor(() => screen.getByRole('complementary'));
  return settings;
}

const ask = async (text: string) => {
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(field, { target: { value: text } }); });
  await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
};

it('decodes chat events across arbitrary chunk boundaries and skips malformed blocks', () => {
  const seen: ChatStreamEvent[] = [];
  const decoder = createChatEventDecoder(event => seen.push(event));
  const bytes = new TextEncoder().encode(
    'data: {"type":"delta","text":"单调栈 ✓"}\r\n\r\n: comment\n\ndata: not json\n\ndata: {"type":"done","provider":"openai","model":"m"}');
  for (let offset = 0; offset < bytes.length; offset += 3) decoder.push(bytes.slice(offset, offset + 3));
  assert.deepEqual(seen, [{ type: 'delta', text: '单调栈 ✓' }]);
  // The final event had no terminating blank line.
  decoder.end();
  assert.deepEqual(seen.at(-1), { type: 'done', provider: 'openai', model: 'm' });
});

it('sends the newest turns within the request limits and never starts with an answer', () => {
  const entry = (role: 'user' | 'assistant', content: string) => ({ id: content.slice(0, 8) + Math.random(), role, content, state: 'done' as const });
  assert.deepEqual(requestTurns([entry('user', 'a'), entry('assistant', ''), entry('user', ' b ')]),
    [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);

  const long = Array.from({ length: 30 }, (_, index) => [entry('user', `q${index}`), entry('assistant', `a${index}`)]).flat();
  const kept = requestTurns([...long, entry('user', 'latest')]);
  assert.equal(kept.length, 39);
  assert.equal(kept[0].role, 'user');
  assert.equal(kept.at(-1)?.content, 'latest');

  // A huge earlier answer is dropped whole rather than pushing the request over the total limit.
  const heavy = requestTurns([entry('user', 'old'), entry('assistant', 'x'.repeat(24_000)), ...Array.from({ length: 5 }, () => entry('user', 'y'.repeat(24_000))), entry('user', 'now')]);
  assert.equal(heavy.reduce((total, turn) => total + turn.content.length, 0) <= 120_000, true);
  assert.equal(heavy.at(-1)?.content, 'now');
  assert.equal(heavy.some(turn => turn.content === 'old'), false);
});

it('streams an answer, shows the context that was used and keeps the conversation', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const requests = serveChat([
    { type: 'context', context: { today: { date: '2026-11-25', totalCount: 3 } } },
    { type: 'delta', text: 'Start with **Two' },
    { type: 'delta', text: ' Sum**, 先做简单题。' },
    { type: 'done', provider: 'openai', model: 'gpt-6-luna' },
  ]);
  await openPanel('en', true);
  assert.equal(screen.getByText('OpenAI · gpt-6-luna').tagName, 'P');
  assert.match(screen.getByText(/are sent to OpenAI/).textContent ?? '', /local data selected below/);
  // Opened from Today, so the plan is attached by default; no problem is in view.
  assert.equal(screen.getByRole('button', { name: "Today's plan" }).getAttribute('aria-pressed'), 'true');

  await ask('What first?');
  await waitFor(() => screen.getByText(/先做简单题/));
  assert.equal(screen.getByText('Two Sum').tagName, 'STRONG');
  assert.equal(screen.getByText("Used: Today's plan (3)").tagName, 'P');
  assert.deepEqual(requests[0], { messages: [{ role: 'user', content: 'What first?' }], context: { today: true }, lang: 'en' });
  assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, '');

  // The follow-up carries the earlier turns, because the server keeps none.
  await ask('Why?');
  await waitFor(() => assert.equal(requests.length, 2));
  assert.deepEqual(requests[1].messages.map(turn => turn.role), ['user', 'assistant', 'user']);
  assert.equal(requests[1].messages[1].content, 'Start with **Two Sum**, 先做简单题。');

  // Closing keeps the conversation; a reload restores it from this device.
  await waitFor(() => assert.equal(JSON.parse(localStorage.getItem('leetcode_tracker_chat_v1') ?? '[]').length, 4));
  await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); });
  assert.equal(screen.queryByRole('complementary'), null);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask AI' })); });
  await waitFor(() => screen.getByText('What first?'));

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New chat' })); });
  assert.equal(screen.queryByText('What first?'), null);
  await waitFor(() => assert.equal(localStorage.getItem('leetcode_tracker_chat_v1'), '[]'));
});

it('attaches the problem in view and lets the user leave it out', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'gemini', model: 'models/gemini-4-hydrogen' }));
  const requests = serveChat([{ type: 'context', context: {} }, { type: 'delta', text: 'ok' }, { type: 'done', provider: 'gemini', model: 'm' }]);
  setChatProblem({ frontendId: '42', title: 'Trapping Rain Water' });
  await openPanel('zh');
  assert.equal(screen.getByText('Gemini · gemini-4-hydrogen').tagName, 'P');
  const chip = screen.getByRole('button', { name: '#42 Trapping Rain Water' });
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.equal(screen.getByRole('button', { name: '今日计划' }).getAttribute('aria-pressed'), 'false');

  // A suggestion sends at once with the problem attached.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '给我一点这道题的提示，先不要给答案' })); });
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0].context, { frontendId: '42' });
  assert.equal(requests[0].lang, 'zh');

  await waitFor(() => screen.getByText('ok'));
  await act(async () => { fireEvent.click(chip); });
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  await ask('再问一次');
  await waitFor(() => assert.equal(requests.length, 2));
  assert.deepEqual(requests[1].context, {});

  // Leaving the note removes the chip.
  await act(async () => { setChatProblem(null); });
  assert.equal(screen.queryByRole('button', { name: '#42 Trapping Rain Water' }), null);
});

it('keeps partial text on a failure and retries the same question', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'deepseek', model: 'deepseek-flash' }));
  const requests = serveChat(
    [{ type: 'context', context: {} }, { type: 'delta', text: 'Half an ans' }, { type: 'error', error: 'CHAT_INTERRUPTED', message: 'The answer was interrupted.' }],
    // The stream closes without a terminal event.
    [{ type: 'context', context: {} }, { type: 'delta', text: 'Cut' }],
    { status: 503, body: { error: 'CHAT_NOT_CONFIGURED', message: 'Configure an AI provider in Settings.' } },
  );
  const settings = await openPanel();
  await ask('Explain');
  await waitFor(() => screen.getByRole('alert'));
  assert.equal(screen.getByText('Half an ans').tagName, 'P');
  assert.match(screen.getByRole('alert').textContent ?? '', /interrupted before it finished/);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  await waitFor(() => screen.getByText('Cut'));
  await waitFor(() => screen.getByRole('alert'));
  // The retry replaced the failed answer and resent only the question.
  assert.equal(screen.queryByText('Half an ans'), null);
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'Explain' }]);
  assert.match(screen.getByRole('alert').textContent ?? '', /interrupted before it finished/);

  // A refusal before the stream opened points to Settings instead of offering another try.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  await waitFor(() => screen.getByRole('button', { name: 'Open AI settings' }));
  assert.equal(screen.queryByRole('button', { name: 'Try again' }), null);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open AI settings' })); });
  assert.equal(settings.mock.callCount(), 1);
  assert.equal(screen.queryByRole('complementary'), null);
});

it('explains a missing provider and toggles with the keyboard shortcut', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: false, model: '' }));
  const requests = serveChat([]);
  await act(async () => { render(<ChatLauncher lang="en" onToday={false} onOpenAiSettings={() => {}} />); });
  await act(async () => { fireEvent.keyDown(window, { key: 'j', ctrlKey: true }); });
  await waitFor(() => screen.getByText('Connect an AI provider to ask questions here.'));
  assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).disabled, true);
  assert.equal((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, true);
  assert.equal(requests.length, 0);

  await act(async () => { fireEvent.keyDown(window, { key: 'j', ctrlKey: true }); });
  assert.equal(screen.queryByRole('complementary'), null);
  // A plain J, or the shortcut while a modal dialog is open, does nothing.
  await act(async () => { fireEvent.keyDown(window, { key: 'j' }); });
  const overlay = document.body.appendChild(Object.assign(document.createElement('div'), {}));
  overlay.setAttribute('data-overlay-host', '');
  await act(async () => { fireEvent.keyDown(window, { key: 'j', ctrlKey: true }); });
  assert.equal(screen.queryByRole('complementary'), null);
  overlay.remove();
});

it('does not send while an IME candidate is being confirmed', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const requests = serveChat([{ type: 'context', context: {} }, { type: 'delta', text: 'ok' }, { type: 'done', provider: 'openai', model: 'm' }]);
  await openPanel('zh');
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(field, { target: { value: '动态规划' } }); });
  await act(async () => { fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 }); });
  await act(async () => { fireEvent.keyDown(field, { key: 'Enter', shiftKey: true }); });
  assert.equal(requests.length, 0);
  assert.equal(field.value, '动态规划');
  await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
  await waitFor(() => assert.equal(requests.length, 1));
});

it('docks the launcher beside the nearer edge and opens the panel next to it', () => {
  const viewport = { width: 1280, height: 800 };
  assert.deepEqual(launcherPoint(DEFAULT_CHAT_POSITION.dock, viewport, false), { left: 1228, top: 736 });
  // Tucked, it sits flush against its edge, where it is drawn as a bar.
  assert.deepEqual(launcherPoint(DEFAULT_CHAT_POSITION.dock, viewport, true), { left: 1240, top: 736 });
  assert.deepEqual(launcherPoint({ side: 'left', bottom: 300 }, viewport, true), { left: 0, top: 460 });

  assert.deepEqual(dockAt({ left: 60, top: 100 }, viewport), { side: 'left', bottom: 660 });
  assert.deepEqual(dockAt({ left: 1230, top: 500 }, viewport), { side: 'right', bottom: 260 });
  assert.deepEqual(panelPoint({ dock: { side: 'left', bottom: 660 } }, viewport), { left: 24, top: 24 });
  assert.deepEqual(panelPoint(DEFAULT_CHAT_POSITION, viewport), { left: 836, top: 156 });

  // A dragged panel is kept where it was dropped, and pulled back inside a smaller window.
  assert.deepEqual(panelPoint({ dock: DEFAULT_CHAT_POSITION.dock, panel: { left: 300, top: 60 } }, viewport), { left: 300, top: 60 });
  assert.deepEqual(panelPoint({ dock: DEFAULT_CHAT_POSITION.dock, panel: { left: 900, top: 400 } }, { width: 1024, height: 700 }), { left: 596, top: 72 });
  assert.deepEqual(dockForPanel({ left: 100, top: 60 }, viewport, DEFAULT_CHAT_POSITION.dock), { side: 'left', bottom: 120 });

  // The top and bottom edges dock too: the nearest edge wins and the horizontal spot is kept.
  assert.deepEqual(dockAt({ left: 600, top: 30 }, viewport), { side: 'top', left: 600 });
  assert.deepEqual(dockAt({ left: 1200, top: 770 }, viewport), { side: 'bottom', left: 1200 });
  assert.deepEqual(dockAt({ left: 20, top: 400 }, viewport), { side: 'left', bottom: 360 });
  assert.deepEqual(launcherPoint({ side: 'top', left: 600 }, viewport, false), { left: 600, top: 12 });
  assert.deepEqual(launcherPoint({ side: 'top', left: 600 }, viewport, true), { left: 600, top: 0 });
  assert.deepEqual(launcherPoint({ side: 'bottom', left: 600 }, viewport, true), { left: 600, top: 760 });
  assert.deepEqual(panelPoint({ dock: { side: 'top', left: 600 } }, viewport), { left: 600, top: 24 });
  assert.deepEqual(panelPoint({ dock: { side: 'bottom', left: 1228 } }, viewport), { left: 836, top: 156 });
  // A dragged panel leaves the launcher on the kind of edge it was on.
  assert.deepEqual(dockForPanel({ left: 300, top: 150 }, viewport, { side: 'top', left: 600 }), { side: 'bottom', left: 300 });
});

it('drags the launcher to an edge, remembers it and tucks away when left alone', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: false, model: '' }));
  const stored = () => JSON.parse(localStorage.getItem('leetcode_tracker_chat_position_v1') ?? 'null');
  const view = await act(async () => render(<ChatLauncher lang="en" onToday={false} onOpenAiSettings={() => {}} />));
  const button = screen.getByRole('button', { name: 'Ask AI' });
  const dock = button.closest('.chat-launcher') as HTMLElement;
  const width = window.innerWidth;
  const height = window.innerHeight;
  assert.equal(dock.style.transform, `translate3d(${width - 52}px, ${height - 64}px, 0)`);

  // A small wobble is still a click.
  await act(async () => { fireEvent.pointerDown(button, { button: 0, clientX: 500, clientY: 500 }); });
  await act(async () => { fireEvent.pointerMove(window, { clientX: 502, clientY: 501 }); });
  await act(async () => { fireEvent.pointerUp(window, { clientX: 502, clientY: 501 }); });
  assert.equal(stored(), null);

  await act(async () => { fireEvent.pointerDown(button, { button: 0, clientX: width - 30, clientY: height - 40 }); });
  await act(async () => { fireEvent.pointerMove(window, { clientX: 130, clientY: 240 }); });
  assert.equal(dock.classList.contains('is-dragging'), true);
  assert.equal(dock.style.transform, `translate3d(108px, ${240 - 24}px, 0)`);
  // The click that a browser reports for the release does not open the panel.
  await act(async () => {
    fireEvent.pointerUp(window, { clientX: 130, clientY: 240 });
    fireEvent.click(button);
  });
  assert.equal(screen.queryAllByRole('complementary').length, 0);
  assert.deepEqual(stored(), { dock: { side: 'left', bottom: height - 216 - 40 } });
  assert.equal(dock.style.transform, `translate3d(12px, 216px, 0)`);

  await waitFor(() => assert.equal(dock.classList.contains('is-tucked'), true), { timeout: LAUNCHER_REST_MS + 1500 });
  assert.equal(dock.style.transform, 'translate3d(0px, 216px, 0)');
  assert.equal(dock.getAttribute('data-side'), 'left');
  await act(async () => { fireEvent.pointerEnter(button); });
  assert.equal(dock.classList.contains('is-tucked'), false);

  // The panel opens on the launcher's side; dragging its header moves it and the dock with it.
  await act(async () => { fireEvent.click(button); });
  const panel = await waitFor(() => screen.getByRole('complementary'));
  assert.equal(panel.getAttribute('data-side'), 'left');
  assert.equal(panel.style.left, '24px');
  await act(async () => { fireEvent.pointerDown(screen.getByRole('heading', { name: 'Ask AI' }), { button: 0, clientX: 100, clientY: 100 }); });
  await act(async () => { fireEvent.pointerMove(window, { clientX: 100 + width, clientY: 100 }); });
  await act(async () => { fireEvent.pointerUp(window, { clientX: 100 + width, clientY: 100 }); });
  assert.equal(panel.style.left, `${width - 420 - 8}px`);
  assert.equal(stored().dock.side, 'right');
  assert.equal(stored().panel.left, width - 420 - 8);

  // A reload restores the placement.
  view.unmount();
  await act(async () => { render(<ChatLauncher lang="en" onToday={false} onOpenAiSettings={() => {}} />); });
  await act(async () => { fireEvent.keyDown(window, { key: 'j', ctrlKey: true }); });
  assert.equal((await waitFor(() => screen.getByRole('complementary'))).style.left, `${width - 420 - 8}px`);
});

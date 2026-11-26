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
const { CHAT_CLEAR_UNDO_MS, requestTurns } = await import('../apps/web/src/chat/useChat.ts');
const { GENERAL_THREAD, MAX_THREADS, THREAD_IDLE_MS, loadChatState, problemThread, pruneThreads, saveChatState } = await import('../apps/web/src/chat/chat-threads.ts');
const { setChatProblem } = await import('../apps/web/src/chat/chat-context.ts');
const { getChatDataAccess, setChatDataAccess } = await import('../apps/web/src/chat/chat-settings.ts');
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
  const requests: Array<{ messages: Array<{ role: string; content: string }>; context?: Record<string, unknown>; lang?: string; dataAccess?: boolean; provider?: string }> = [];
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

async function openPanel(lang: 'en' | 'zh' = 'en') {
  const settings = mock.fn();
  await act(async () => { render(<ChatLauncher lang={lang} onOpenAiSettings={settings} />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: lang === 'zh' ? '问 AI' : 'Ask AI' })); });
  await waitFor(() => screen.getByRole('complementary'));
  return settings;
}

const ask = async (text: string) => {
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(field, { target: { value: text } }); });
  await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
};

async function clearConversation(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Clear conversation: ${name}` })); });
}

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
  // Twelve turns at most; the oldest of them was an answer, which cannot lead.
  assert.equal(kept.length, 11);
  assert.equal(kept[0].role, 'user');
  assert.equal(kept.at(-1)?.content, 'latest');

  // A huge earlier answer is dropped whole rather than pushing the request over the total limit.
  const heavy = requestTurns([entry('user', 'old'), entry('assistant', 'x'.repeat(24_000)), ...Array.from({ length: 5 }, () => entry('user', 'y'.repeat(24_000))), entry('user', 'now')]);
  assert.equal(heavy.reduce((total, turn) => total + turn.content.length, 0) <= 120_000, true);
  assert.equal(heavy.at(-1)?.content, 'now');
  assert.equal(heavy.some(turn => turn.content === 'old'), false);
});

it('streams an answer, lists what the AI looked up and keeps the conversation', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const requests = serveChat([
    { type: 'context', context: {} },
    { type: 'tool', name: 'tracker_get_today' },
    { type: 'tool', name: 'tracker_list_practices' },
    // A repeated lookup is listed once; a tool this build cannot name keeps its name.
    { type: 'tool', name: 'tracker_get_today' },
    { type: 'tool', name: 'tracker_future_tool' },
    { type: 'delta', text: 'Start with **Two' },
    { type: 'delta', text: ' Sum**, 先做简单题。' },
    { type: 'done', provider: 'openai', model: 'gpt-6-luna' },
  ]);
  await openPanel();
  assert.equal(screen.getByText('OpenAI · gpt-6-luna').tagName, 'P');
  const privacy = screen.getByText('What goes to OpenAI');
  assert.equal(privacy.closest('details')?.open, false);
  await act(async () => { fireEvent.click(privacy); });
  assert.equal(privacy.closest('details')?.open, true);
  assert.match(privacy.closest('details')?.textContent ?? '', /look up and send data from your catalog/);
  // With no problem in view the composer is the text field alone.
  assert.equal(document.querySelector('.chat-context'), null);

  await ask('What first?');
  await waitFor(() => screen.getByText(/先做简单题/));
  assert.equal(screen.getByText('Two Sum').tagName, 'STRONG');
  assert.equal(screen.getByText("Used: today's plan, practice records, tracker_future_tool").tagName, 'P');
  assert.deepEqual(requests[0], { messages: [{ role: 'user', content: 'What first?' }], context: {}, lang: 'en', provider: 'openai' });
  assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, '');

  // The follow-up carries the earlier turns, because the server keeps none.
  await ask('Why?');
  await waitFor(() => assert.equal(requests.length, 2));
  assert.deepEqual(requests[1].messages.map(turn => turn.role), ['user', 'assistant', 'user']);
  assert.equal(requests[1].messages[1].content, 'Start with **Two Sum**, 先做简单题。');

  // Closing keeps the conversation; a reload restores it from this device.
  const stored = () => JSON.parse(localStorage.getItem('leetcode_tracker_chat_threads_v1') ?? '{"threads":[]}') as { threads: Array<{ key: string; entries: unknown[] }> };
  await waitFor(() => assert.deepEqual(stored().threads.map(thread => [thread.key, thread.entries.length]), [['general', 4]]));
  await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); });
  assert.equal(screen.queryByRole('complementary'), null);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask AI' })); });
  await waitFor(() => screen.getByText('What first?'));

  assert.equal(screen.queryByRole('button', { name: /clear conversation/i }), null);
  await act(async () => { fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsaved follow-up' } }); });
  await clearConversation('General');
  assert.equal(screen.queryByText('What first?'), null);
  assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, '');
  await waitFor(() => assert.deepEqual(stored().threads, []));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo clear' })); });
  assert.ok(screen.getByText('What first?'));
  assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, 'Unsaved follow-up');
  await waitFor(() => assert.deepEqual(stored().threads.map(thread => [thread.key, thread.entries.length]), [['general', 4]]));
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
  await act(async () => { render(<ChatLauncher lang="en" onOpenAiSettings={() => {}} />); });
  await act(async () => { fireEvent.keyDown(window, { key: 'j', ctrlKey: true }); });
  await waitFor(() => screen.getByText('Connect an AI provider to ask questions here.'));
  assert.equal(screen.queryByRole('button', { name: 'Retry connection' }), null);
  assert.ok(screen.getByRole('button', { name: 'Open AI settings' }));
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

it('retries a failed connection check in the panel and preserves the draft', async () => {
  let available = true;
  const status = mock.method(api, 'getChatStatus', async () => {
    if (!available) throw new Error('Local service unavailable');
    return { configured: true, provider: 'openai', model: 'gpt-6-luna' };
  });
  const requests = serveChat(answer('Recovered.'));
  const settings = await openPanel();
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(field, { target: { value: 'My pending question' } }); });
  available = false;
  await act(async () => { fireEvent.focus(window); });
  const retry = await screen.findByRole('button', { name: 'Retry connection' });
  assert.match(screen.getByRole('alert').textContent ?? '', /Could not check the AI connection/);
  assert.equal(screen.queryByRole('button', { name: 'Open AI settings' }), null);
  assert.equal(field.disabled, true);
  assert.equal(field.value, 'My pending question');
  available = true;
  await act(async () => { fireEvent.click(retry); });
  await waitFor(() => assert.equal(field.disabled, false));
  assert.equal(document.activeElement, field);
  assert.equal(field.value, 'My pending question');
  assert.equal(status.mock.callCount(), 3);
  assert.equal(settings.mock.callCount(), 0);
  assert.equal(requests.length, 0);
  await ask(field.value);
  await screen.findByText('Recovered.');
});

it('expires clear undo and keeps a new draft if the conversation is restored', async t => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  serveChat(answer('Done.'));
  await openPanel();
  await ask('Original question');
  await screen.findByText('Done.');
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(field, { target: { value: 'Original draft' } }); });
  await clearConversation('General');
  await act(async () => { fireEvent.change(field, { target: { value: 'New draft' } }); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo clear' })); });
  assert.equal(field.value, 'New draft');
  assert.ok(screen.getByText('Original question'));

  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  await clearConversation('General');
  await act(async () => { t.mock.timers.tick(CHAT_CLEAR_UNDO_MS - 1); });
  assert.ok(screen.getByRole('button', { name: 'Undo clear' }));
  await act(async () => { t.mock.timers.tick(1); });
  assert.equal(screen.queryByRole('button', { name: 'Undo clear' }), null);
  assert.equal(screen.queryByText('Original question'), null);
  assert.equal(loadChatState().threads.general, undefined);
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
  const view = await act(async () => render(<ChatLauncher lang="en" onOpenAiSettings={() => {}} />));
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

  await act(async () => { await new Promise(resolve => setTimeout(resolve, LAUNCHER_REST_MS + 50)); });
  assert.equal(dock.classList.contains('is-tucked'), false);
  assert.equal(button.textContent, 'Ask AI');

  // The panel opens on the launcher's side; dragging its header moves it and the dock with it.
  await act(async () => { fireEvent.click(button); });
  const panel = await waitFor(() => screen.getByRole('complementary'));
  assert.equal(panel.getAttribute('data-side'), 'left');
  assert.equal(panel.style.left, '24px');
  await act(async () => { fireEvent.pointerDown(screen.getByRole('heading', { name: 'General' }), { button: 0, clientX: 100, clientY: 100 }); });
  await act(async () => { fireEvent.pointerMove(window, { clientX: 100 + width, clientY: 100 }); });
  await act(async () => { fireEvent.pointerUp(window, { clientX: 100 + width, clientY: 100 }); });
  assert.equal(panel.style.left, `${width - 420 - 8}px`);
  assert.equal(stored().dock.side, 'right');
  assert.equal(stored().panel.left, width - 420 - 8);

  // A reload restores the placement.
  view.unmount();
  await act(async () => { render(<ChatLauncher lang="en" onOpenAiSettings={() => {}} />); });
  const returningButton = screen.getByRole('button', { name: 'Ask AI' });
  const returningDock = returningButton.closest('.chat-launcher') as HTMLElement;
  assert.equal(returningButton.textContent, '');
  await waitFor(() => assert.equal(returningDock.classList.contains('is-tucked'), true), { timeout: LAUNCHER_REST_MS + 1500 });
  assert.equal(returningDock.getAttribute('data-side'), 'right');
  await act(async () => { fireEvent.pointerEnter(returningButton); });
  assert.equal(returningDock.classList.contains('is-tucked'), false);
  await act(async () => { fireEvent.keyDown(window, { key: 'j', ctrlKey: true }); });
  assert.equal((await waitFor(() => screen.getByRole('complementary'))).style.left, `${width - 420 - 8}px`);
});

const { attemptLabel, hintLabel, hintPrompt, nextHintLevel, reviewPrompt, saveNotePrompt, similarPrompt } = await import('../apps/web/src/chat/chat-presets.ts');
const { WorkspaceContext } = await import('../apps/web/src/workspace.tsx');
const { TodayProblemRow } = await import('../apps/web/src/components/TodayProblemRow.tsx');
const { PracticeRecordCard } = await import('../apps/web/src/components/PracticeRecordCard.tsx');

const rain = { frontendId: '42', title: 'Trapping Rain Water' };
const threeSum = { frontendId: '15', title: '3Sum' };
const answer = (text: string): ChatStreamEvent[] => [
  { type: 'context', context: { problem: { frontendId: '42', title: 'Trapping Rain Water' } } },
  { type: 'delta', text },
  { type: 'done', provider: 'openai', model: 'gpt-6-luna' },
];

it('climbs the hint ladder one answered rung at a time and describes an attempt', () => {
  const turn = (level: number, text: string, frontendId = '42') => [
    { id: `q${level}${Math.random()}`, role: 'user' as const, content: hintPrompt(level, 'en', rain), state: 'done' as const, hint: { frontendId, level } },
    { id: `a${level}${Math.random()}`, role: 'assistant' as const, content: text, state: text ? 'done' as const : 'error' as const },
  ];
  assert.equal(nextHintLevel([], '42'), 1);
  assert.equal(nextHintLevel(turn(1, 'Think about two pointers.'), '42'), 2);
  // A rung whose answer produced no text is asked again, and each problem has its own ladder.
  assert.equal(nextHintLevel([...turn(1, 'ok'), ...turn(2, '')], '42'), 2);
  assert.equal(nextHintLevel(turn(1, 'ok'), '11'), 1);
  assert.equal(nextHintLevel([1, 2, 3, 4].flatMap(level => turn(level, 'ok')), '42'), 5);
  // A tag that came back from storage in the wrong shape is ignored.
  const [question, reply] = turn(1, 'ok');
  assert.equal(nextHintLevel([{ ...question, hint: { frontendId: '42', level: 'x' } }, reply] as never, '42'), 1);

  assert.deepEqual([1, 2, 3, 4, 5].map(level => hintLabel(level, 'en')),
    ['Give me a hint', 'Next hint (2/3)', 'Next hint (3/3)', 'Show the solution', null]);
  assert.deepEqual([1, 2, 3, 4, 5].map(level => hintLabel(level, 'zh')),
    ['给个提示', '下一个提示（2/3）', '下一个提示（3/3）', '看完整解法', null]);
  assert.match(hintPrompt(1, 'en', rain), /^Hint 1 of 3 for #42 Trapping Rain Water: /);
  assert.match(hintPrompt(3, 'zh', rain), /^#42 Trapping Rain Water 的提示 3\/3：/);
  // A problem known only by its number is named by the number.
  assert.match(hintPrompt(4, 'en', { frontendId: '7' }), /^Show me the full solution to #7 with code\./);

  const record = { practicedAt: '2026-11-20', timePrecision: 'date' as const, completed: true, outcome: 'assisted' as const, durationMinutes: 35 };
  assert.equal(attemptLabel(record, 'en', 'UTC'), '2026-11-20 (solved with help, 35 min)');
  assert.equal(attemptLabel(record, 'zh', 'UTC'), '2026-11-20（借助提示或题解完成，35 分钟）');
  const timed = { practicedAt: '2026-11-20T15:04:00Z', timePrecision: 'datetime' as const, completed: false, outcome: null, durationMinutes: null };
  assert.match(attemptLabel(timed, 'en', 'Asia/Shanghai'), /^Nov 20, 2026, 11:04\sPM \(not solved\)$/);
  // Nothing recorded beyond the time: the label is the time alone.
  assert.match(attemptLabel({ ...timed, completed: true }, 'en', null), /^Nov 20, 2026, 3:04\sPM$/);
  assert.match(reviewPrompt('en', rain), /^Review my latest attempt at #42 Trapping Rain Water\./);
  assert.match(reviewPrompt('zh', rain, '2026-11-20（未解出）'), /^复盘我做 #42 Trapping Rain Water 的这次练习：2026-11-20（未解出）。/);
});

it('offers graded hints for the attached problem, then the solution, and a review as a starter', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const practice = mock.method(api, 'getPracticeRecords', async () => ({ total: 1, page: 1, limit: 1, items: [] }));
  const requests = serveChat(
    answer('Think about what bounds the water.'),
    // The second rung fails before any text arrives.
    [{ type: 'context', context: {} }, { type: 'error', error: 'CHAT_UNAVAILABLE', message: 'The AI provider is unavailable.' }],
    answer('ok'),
  );
  setChatProblem({ frontendId: '42', title: 'Trapping Rain Water' });
  await openPanel();
  const lastQuestion = () => requests.at(-1)!.messages.at(-1)!.content;
  const nextHint = () => document.querySelector('.chat-context .chat-action')?.textContent ?? null;
  /** Click the next rung once the previous answer has finished. */
  const press = async (name: string, sent: number) => {
    await waitFor(() => assert.equal((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, false));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
    await waitFor(() => assert.equal(requests.length, sent));
  };

  // The empty conversation offers the presets as starters; the next rung appears beside the problem afterwards.
  assert.equal(nextHint(), null);
  assert.ok(await screen.findByRole('button', { name: 'Review practice' }));
  assert.deepEqual(practice.mock.calls[0].arguments[0], { questionFrontendId: '42', limit: 1, status: 'active' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Give me a hint' })); });
  await waitFor(() => screen.getByText('Think about what bounds the water.'));
  assert.deepEqual(requests[0], { messages: [{ role: 'user', content: hintPrompt(1, 'en', rain) }], context: { frontendId: '42' }, lang: 'en', provider: 'openai' });
  // The short label expands to the exact prompt sent to the model.
  const hint = screen.getByText('Hint 1/3 · Give me a direction');
  assert.equal(hint.closest('details')?.open, false);
  await act(async () => { fireEvent.click(hint); });
  assert.equal(hint.closest('details')?.open, true);
  assert.equal(screen.getByText(hintPrompt(1, 'en', rain)).tagName, 'P');

  await press('Next hint (2/3)', 2);
  assert.equal(lastQuestion(), hintPrompt(2, 'en', rain));
  await waitFor(() => screen.getByRole('alert'));
  // The failed rung is offered again instead of being skipped.
  await press('Next hint (2/3)', 3);
  assert.equal(lastQuestion(), hintPrompt(2, 'en', rain));
  await press('Next hint (3/3)', 4);
  assert.equal(lastQuestion(), hintPrompt(3, 'en', rain));
  await press('Show the solution', 5);
  assert.equal(lastQuestion(), hintPrompt(4, 'en', rain));
  // Nothing is left on the ladder.
  await waitFor(() => screen.getByRole('button', { name: 'Send' }));
  assert.equal(nextHint(), null);

  // Clearing the conversation starts the ladder over, and offers the review as a starter.
  await clearConversation('#42 Trapping Rain Water');
  const review = await screen.findByRole('button', { name: 'Review practice' });
  await act(async () => { fireEvent.click(review); });
  await waitFor(() => assert.equal(requests.length, 6));
  assert.deepEqual(requests[5], { messages: [{ role: 'user', content: reviewPrompt('en', rain) }], context: { frontendId: '42' }, lang: 'en', provider: 'openai' });
  await press('Give me a hint', 7);
  assert.equal(lastQuestion(), hintPrompt(1, 'en', rain));
});

it('sends only the attached problem once data access is turned off', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const requests = serveChat(answer('ok'));
  assert.equal(getChatDataAccess(), true);
  setChatProblem(rain);
  await openPanel();
  await act(async () => { setChatDataAccess(false); });
  // The notice changes with the setting, and the starter that needs a lookup is withdrawn.
  assert.match(screen.getByText('What goes to OpenAI').closest('details')?.textContent ?? '', /recent attempts and your saved note/);
  assert.equal(screen.queryByText(/look up and send data/), null);
  assert.equal(screen.queryByRole('button', { name: "Which problem in today's plan should I start with?" }), null);
  await ask('Why is this hard?');
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0], { messages: [{ role: 'user', content: 'Why is this hard?' }], context: { frontendId: '42' }, lang: 'en', dataAccess: false, provider: 'openai' });

  // The choice is kept on this device and applies again from the next question.
  assert.equal(getChatDataAccess(), false);
  await act(async () => { setChatDataAccess(true); });
  await waitFor(() => screen.getByRole('button', { name: 'Send' }));
  await ask('And now?');
  await waitFor(() => assert.equal(requests.length, 2));
  assert.equal('dataAccess' in requests[1], false);
});

it('opens on the asked problem and sends the preset when another view asks', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'gemini', model: 'models/gemini-4-hydrogen' }));
  const requests = serveChat(answer('ok'));
  const launcher = (ask?: Parameters<typeof ChatLauncher>[0]['ask']) => <ChatLauncher lang="zh" onOpenAiSettings={() => {}} ask={ask} />;
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(launcher()); });
  assert.equal(screen.queryByRole('complementary'), null);

  await act(async () => { view.rerender(launcher({ id: 1, problem: { frontendId: '15', title: '3Sum' }, action: { kind: 'hint' } })); });
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0], { messages: [{ role: 'user', content: hintPrompt(1, 'zh', threeSum) }], context: { frontendId: '15' }, lang: 'zh', provider: 'gemini' });
  assert.equal(screen.getByRole('heading', { name: '#15 3Sum' }).tagName, 'H2');

  // A later request continues that problem's conversation, here with a review of one named attempt.
  await waitFor(() => screen.getByRole('button', { name: '发送' }));
  await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); });
  await act(async () => {
    view.rerender(launcher({ id: 2, problem: { frontendId: '15', title: '3Sum' }, action: { kind: 'review', attempt: '2026-11-20（未解出）' } }));
  });
  await waitFor(() => assert.equal(requests.length, 2));
  assert.equal(requests[1].messages.length, 3);
  assert.equal(requests[1].messages[2].content, reviewPrompt('zh', threeSum, '2026-11-20（未解出）'));

  // Opening another problem's note shows that problem's conversation; leaving the note keeps it.
  await act(async () => { setChatProblem({ frontendId: '42', title: 'Trapping Rain Water' }); });
  assert.equal(screen.getByRole('heading', { name: '#42 Trapping Rain Water' }).tagName, 'H2');
  assert.equal(screen.queryByText(hintPrompt(1, 'zh', threeSum)), null);
  await act(async () => { setChatProblem(null); });
  assert.equal(screen.getByRole('heading', { name: '#42 Trapping Rain Water' }).tagName, 'H2');

  // Asking about the first problem again returns to its conversation, with its history.
  await act(async () => { view.rerender(launcher({ id: 3, problem: { frontendId: '15', title: '3Sum' }, action: { kind: 'review' } })); });
  await waitFor(() => assert.equal(requests.length, 3));
  assert.equal(requests[2].messages.length, 5);
  assert.equal(screen.getByText(hintPrompt(1, 'zh', threeSum)).tagName, 'P');
});

it('opens without sending a preset when no provider is connected', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: false, model: '' }));
  const requests = serveChat([]);
  await act(async () => {
    render(<ChatLauncher lang="en" onOpenAiSettings={() => {}}
      ask={{ id: 1, problem: { frontendId: '15', title: '3Sum' }, action: { kind: 'hint' } }} />);
  });
  await waitFor(() => screen.getByText('Connect an AI provider to ask questions here.'));
  assert.equal(requests.length, 0);
  assert.equal(screen.queryByText(hintPrompt(1, 'en', threeSum)), null);
});

it('asks for a hint from an open task, and for a review from a finished one or a practice record', async () => {
  const askAi = mock.fn();
  const workspace = { revision: 0, timezone: 'UTC', navigate() {}, notifyMutation() {}, openPractice() {}, askAi };
  const item = {
    id: 'item-1', kind: 'new' as const, reason: { en: 'Next in the list', zh: '清单中的下一题' }, addedAt: 1000, evidenceIds: [], completed: false,
    problem: {
      questionId: 'p42', questionFrontendId: '42', title: 'Trapping Rain Water', titleSlug: 'trapping-rain-water',
      url: 'https://leetcode.com/problems/trapping-rain-water/', difficulty: 'Hard' as const, isPaidOnly: false,
      topicTags: [{ id: 'two-pointers', name: 'Two Pointers', slug: 'two-pointers' }], source: 'jsonl' as const,
    },
  };
  const row = (completed: boolean, value: typeof workspace | Omit<typeof workspace, 'askAi'> = workspace) => (
    <WorkspaceContext.Provider value={value}>
      <TodayProblemRow item={{ ...item, completed } as never} lang="en" isSaving={false} replacingBatch={false} replacingItemId={null}
        onComplete={() => {}} onReplaceOne={() => {}} />
    </WorkspaceContext.Provider>
  );
  const problem = { frontendId: '42', title: 'Trapping Rain Water' };
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(row(false)); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask AI for a hint' })); });
  assert.deepEqual(askAi.mock.calls[0].arguments, [{ problem, action: { kind: 'hint' } }]);
  await act(async () => { view.rerender(row(true)); });
  assert.equal(screen.queryByRole('button', { name: 'Ask AI for a hint' }), null);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Review my attempt with AI' })); });
  assert.deepEqual(askAi.mock.calls[1].arguments, [{ problem, action: { kind: 'review' } }]);
  // A render outside the app has no chat to hand the question to, so it offers none.
  const { askAi: _unused, ...withoutChat } = workspace;
  await act(async () => { view.rerender(row(false, withoutChat)); });
  assert.equal(screen.queryByRole('button', { name: 'Ask AI for a hint' }), null);
  cleanup();

  const record = {
    id: 'rec-1', questionId: 'p42', questionFrontendId: '42', problemTitle: 'Trapping Rain Water', completed: true, practicedAt: '2026-11-20',
    timePrecision: 'date' as const, notes: 'Forgot the right-max pass', durationMinutes: 35, sourceTimezone: 'UTC', revision: 1,
    status: 'active' as const, createdAt: 100, updatedAt: 100, revokedAt: null, outcome: 'assisted' as const,
  };
  const card = (status: 'active' | 'revoked') => (
    <WorkspaceContext.Provider value={workspace}>
      <PracticeRecordCard record={{ ...record, status } as never} lang="en" edit={() => {}} onChange={() => {}} />
    </WorkspaceContext.Provider>
  );
  await act(async () => { view = render(card('active')); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Review with AI' })); });
  assert.deepEqual(askAi.mock.calls[2].arguments,
    [{ problem, action: { kind: 'review', attempt: '2026-11-20 (solved with help, 35 min)' } }]);
  await act(async () => { view.rerender(card('revoked')); });
  assert.equal(screen.queryByRole('button', { name: 'Review with AI' }), null);
});

it('drops a preset that was still waiting when the panel closed', async () => {
  // The first status request never answers, so the preset cannot be sent before the panel closes.
  const status = mock.method(api, 'getChatStatus', () => new Promise<never>(() => {}));
  const requests = serveChat(answer('ok'));
  await act(async () => {
    render(<ChatLauncher lang="en" onOpenAiSettings={() => {}} ask={{ id: 1, problem: threeSum, action: { kind: 'hint' } }} />);
  });
  await waitFor(() => screen.getByRole('complementary'));
  await act(async () => { fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' }); });
  assert.equal(screen.queryByRole('complementary'), null);

  status.mock.mockImplementation(async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }) as never);
  await act(async () => { fireEvent.keyDown(window, { key: 'j', ctrlKey: true }); });
  // The problem is still offered, but asking is left to the user.
  await waitFor(() => screen.getByRole('button', { name: 'Give me a hint' }));
  assert.equal(screen.getByRole('heading', { name: '#15 3Sum' }).tagName, 'H2');
  assert.equal(requests.length, 0);
});

it('keeps one conversation per problem and a general one, switched from the title', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'gemini', model: 'models/gemini-4-hydrogen' }));
  const requests = serveChat([{ type: 'context', context: {} }, { type: 'delta', text: 'ok' }, { type: 'done', provider: 'gemini', model: 'm' }]);
  setChatProblem(rain);
  await openPanel('zh');
  // A note in view opens that problem's conversation; nothing sits above the text field.
  assert.equal(screen.getByRole('heading', { name: '#42 Trapping Rain Water' }).tagName, 'H2');
  assert.ok(screen.getByText('发送给 Gemini 的数据'));
  assert.equal(document.querySelector('.chat-context'), null);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '给个提示' })); });
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0].context, { frontendId: '42' });
  assert.equal(requests[0].lang, 'zh');
  await waitFor(() => screen.getByRole('button', { name: '发送' }));

  // The title lists the conversations; the general one is always there.
  const openList = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /切换对话|#42 Trapping Rain Water|通用对话/, expanded: false })); }); };
  await openList();
  const rows = () => [...document.querySelectorAll('.chat-thread-row')].map(row => row.querySelector('.chat-thread-name')!.textContent);
  assert.deepEqual(rows(), ['通用对话', '#42 Trapping Rain Water']);
  assert.equal(document.querySelector('.chat-thread-row [aria-current="true"] .chat-thread-name')!.textContent, '#42 Trapping Rain Water');
  assert.equal(document.querySelector('.chat-thread-time')!.textContent, '刚刚');

  // A question in the general conversation carries no problem and none of the other history.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '通用对话' })); });
  assert.equal(screen.getByRole('heading', { name: '通用对话' }).tagName, 'H2');
  assert.equal(screen.queryByText('ok'), null);
  await ask('动态规划怎么入门？');
  await waitFor(() => assert.equal(requests.length, 2));
  assert.deepEqual(requests[1], { messages: [{ role: 'user', content: '动态规划怎么入门？' }], context: {}, lang: 'zh', provider: 'gemini' });
  await waitFor(() => screen.getByRole('button', { name: '发送' }));

  // Back in the problem's conversation the hint ladder is where it was left.
  await openList();
  await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('.chat-thread-row:last-child .notes-dropdown-item')!); });
  assert.equal(screen.getByRole('heading', { name: '#42 Trapping Rain Water' }).tagName, 'H2');
  assert.equal(screen.getByRole('button', { name: '下一个提示（2/3）' }).tagName, 'BUTTON');
  assert.equal(screen.queryByText('动态规划怎么入门？'), null);

  // Clearing from the list removes only that conversation. Undo keeps the problem in view.
  await openList();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '清空对话：通用对话' })); });
  await waitFor(() => assert.deepEqual(
    (JSON.parse(localStorage.getItem('leetcode_tracker_chat_threads_v1')!) as { threads: Array<{ key: string }>; current: { key: string } }).threads.map(thread => thread.key),
    ['problem:42']));
  assert.equal(JSON.parse(localStorage.getItem('leetcode_tracker_chat_threads_v1')!).current.key, 'problem:42');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销清空' })); });
  assert.equal(loadChatState().threads.general.entries[0].content, '动态规划怎么入门？');
  assert.ok(screen.getByRole('heading', { name: '#42 Trapping Rain Water' }));
});

it('lets an answer finish in its own conversation while another one is shown', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  // The first answer stays open until released; the second completes at once.
  let release!: () => void;
  const requests: Array<{ context?: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init!.body)));
    const first = requests.length === 1;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (events: ChatStreamEvent[]) => controller.enqueue(encode(events));
        send([{ type: 'context', context: {} }, { type: 'delta', text: first ? 'Slow ' : 'Quick answer' }]);
        const finish = () => { send([...(first ? [{ type: 'delta' as const, text: 'answer' }] : []), { type: 'done', provider: 'openai', model: 'm' }]); controller.close(); };
        if (first) release = finish; else finish();
      },
    }), { status: 200 });
  }) as typeof fetch;

  setChatProblem(rain);
  await openPanel();
  await ask('First');
  await waitFor(() => screen.getByText('Slow'));
  // Switch away mid-answer: the other conversation can be used at once.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '#42 Trapping Rain Water' })); });
  assert.equal(document.querySelector('.chat-thread-time')!.textContent, 'answering');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'General' })); });
  assert.equal(screen.queryByText('Slow'), null);
  await ask('Second');
  await waitFor(() => screen.getByText('Quick answer'));
  assert.deepEqual(requests.map(request => request.context), [{ frontendId: '42' }, {}]);
  await waitFor(() => screen.getByRole('button', { name: 'Send' }));

  // The first answer arrives where it was asked, and only then are the conversations stored.
  assert.deepEqual(JSON.parse(localStorage.getItem('leetcode_tracker_chat_threads_v1')!).threads, []);
  await act(async () => { release(); });
  await act(async () => { setChatProblem({ ...rain }); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'General' })); });
  await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('.chat-thread-row:last-child .notes-dropdown-item')!); });
  await waitFor(() => screen.getByText('Slow answer'));
  await waitFor(() => assert.equal(JSON.parse(localStorage.getItem('leetcode_tracker_chat_threads_v1')!).threads.length, 2));
});

it('stores conversations per device, adopts the old single one and lets old ones go', () => {
  const entry = (content: string) => ({ id: content, role: 'user' as const, content, state: 'done' as const });
  const now = Date.UTC(2026, 10, 26);
  const thread = (frontendId: string, usedAt: number) => ({ ...problemThread({ frontendId, title: `Problem ${frontendId}` }), entries: [entry(`q${frontendId}`)], usedAt });

  // The conversation from before the split becomes the general one, and is rewritten on save.
  localStorage.setItem('leetcode_tracker_chat_v1', JSON.stringify([entry('old question'), { id: 'a', role: 'assistant', content: 'half', state: 'streaming' }]));
  const adopted = loadChatState(now);
  assert.deepEqual(Object.keys(adopted.threads), ['general']);
  // An answer that was streaming when the app closed can only be partial.
  assert.deepEqual(adopted.threads.general.entries.map(item => item.state), ['done', 'stopped']);
  assert.deepEqual(adopted.current, GENERAL_THREAD);
  saveChatState(adopted);
  assert.equal(localStorage.getItem('leetcode_tracker_chat_v1'), null);

  // A round trip keeps the conversations and the one that was open.
  saveChatState({ threads: { 'problem:42': thread('42', now - 1000), general: { ...GENERAL_THREAD, entries: [entry('hi')], usedAt: now } }, current: problemThread({ frontendId: '42' }) });
  const loaded = loadChatState(now);
  assert.deepEqual(Object.keys(loaded.threads).sort(), ['general', 'problem:42']);
  assert.deepEqual(loaded.threads['problem:42'].problem, { frontendId: '42', title: 'Problem 42' });
  assert.equal(loaded.current.key, 'problem:42');

  // Idle conversations go after thirty days, and the least recently used beyond the cap.
  const many = Object.fromEntries(Array.from({ length: MAX_THREADS + 5 }, (_, index) => thread(String(index), now - index * 1000)).map(item => [item.key, item]));
  many['problem:stale'] = thread('stale', now - THREAD_IDLE_MS - 1);
  many['problem:empty'] = { ...problemThread({ frontendId: 'empty' }), entries: [], usedAt: now };
  const kept = pruneThreads(many, now);
  assert.equal(Object.keys(kept).length, MAX_THREADS);
  assert.equal('problem:stale' in kept || 'problem:empty' in kept, false);
  assert.equal('problem:0' in kept && !(`problem:${MAX_THREADS}` in kept), true);
  // A conversation that is still answering is never the one dropped.
  assert.equal('problem:stale' in pruneThreads(many, now, new Set(['problem:stale'])), true);

  // Anything that is not a conversation is skipped rather than trusted.
  localStorage.setItem('leetcode_tracker_chat_threads_v1', JSON.stringify({
    threads: [{ key: 'problem:7', problem: { frontendId: '8' }, entries: [entry('x')] }, { key: 'general', entries: [{ role: 'system', content: 'x' }, entry('kept')], usedAt: now }, null],
    current: { key: 'elsewhere' },
  }));
  const cleaned = loadChatState(now);
  assert.deepEqual(Object.keys(cleaned.threads), ['general']);
  assert.deepEqual(cleaned.threads.general.entries.map(item => item.content), ['kept']);
  assert.deepEqual(cleaned.current, GENERAL_THREAD);
  localStorage.setItem('leetcode_tracker_chat_threads_v1', '{broken');
  assert.deepEqual(loadChatState(now), { threads: {}, current: GENERAL_THREAD });
});

const { ApiError } = await import('../apps/web/src/platform/index.ts');
const { within } = await import('@testing-library/react');
type Proposal = Extract<ChatStreamEvent, { type: 'action' }>['action'];

const practiceCard: Proposal = {
  id: 'p1', name: 'tracker_create_practices',
  args: { operationId: '6f1d2c3b-0a4e-4f5a-9b6c-7d8e9f0a1b2c', dryRun: false, records: [
    { questionFrontendId: '1', completed: true, outcome: 'independent', durationMinutes: 20, practicedAt: '2026-03-02T09:30:00Z' },
  ] },
  labels: { problems: { 1: 'Two Sum' }, folders: {}, lists: {} },
};
const noteCard: Proposal = {
  id: 'n1', name: 'tracker_patch_note',
  args: { frontendId: '42', heading: 'Pitfalls', mode: 'append', content: 'Track the **right max** too.', expectedContentHash: 'hash-1' },
  labels: { problems: { 42: 'Trapping Rain Water' }, folders: {}, lists: {} },
};
const starCard: Proposal = {
  id: 's1', name: 'tracker_add_favorites',
  args: { frontendIds: ['1', '42'], folderIds: ['f1'], newFolder: { id: 'f1', name: 'Review' } },
  labels: { problems: { 1: 'Two Sum', 42: 'Trapping Rain Water' }, folders: { f1: 'Review' }, lists: {} },
};

it('shows a proposed change as a card and writes only when it is confirmed', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const applied: Array<{ name: string; args: Record<string, unknown> }> = [];
  let busy = true;
  mock.method(api, 'applyChatAction', async (input: { name: string; args: Record<string, unknown> }) => {
    applied.push(input);
    if (input.name === 'tracker_patch_note') throw new ApiError(409, 'NOTE_CHANGED', 'The note for problem 42 changed since it was read.');
    if (input.name === 'tracker_add_favorites' && busy) {
      busy = false;
      throw new ApiError(409, 'PROFILE_BUSY', 'Wait for active operations to finish, then retry.');
    }
    return { result: {} };
  });
  const requests = serveChat([
    { type: 'context', context: {} },
    { type: 'action', action: practiceCard },
    { type: 'action', action: noteCard },
    { type: 'action', action: starCard },
    { type: 'delta', text: 'Confirm the cards to save these.' },
    { type: 'done', provider: 'openai', model: 'gpt-6-luna' },
  ], answer('ok'));
  const changed = mock.fn();
  await act(async () => { render(<ChatLauncher lang="en" onOpenAiSettings={() => {}} onDataChanged={changed} />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask AI' })); });
  await waitFor(() => screen.getByRole('complementary'));
  await ask('Log #1, note the pitfall and star both.');
  await waitFor(() => screen.getByText('Confirm the cards to save these.'));
  const card = (name: string) => within(screen.getByRole('region', { name }));
  const press = async (name: string, label: string) => { await act(async () => { fireEvent.click(card(name).getByRole('button', { name: label })); }); };

  // Each card says what it will do, in the user's terms; nothing was written by proposing.
  assert.match(card('Record an attempt').getByRole('listitem').textContent ?? '', /^#1 Two Sum · solved independently · 20 min · Mar 2, 2026, 9:30/);
  assert.deepEqual(card('Add to the note').getAllByRole('listitem').map(item => item.textContent), ['#42 Trapping Rain Water', 'Adds to section: Pitfalls']);
  assert.equal(card('Add to the note').getByText('right max').tagName, 'STRONG');
  assert.deepEqual(card('Star problems').getAllByRole('listitem').map(item => item.textContent), ['#1 Two Sum, #42 Trapping Rain Water', 'Folders: Review (new)']);
  assert.equal(applied.length, 0);
  // An answer whose changes may be applied is not offered for regeneration.
  assert.equal(screen.queryByRole('button', { name: 'Answer again' }), null);

  await press('Record an attempt', 'Record');
  await waitFor(() => card('Record an attempt').getByText('Recorded'));
  assert.deepEqual(applied[0], { name: practiceCard.name, args: practiceCard.args });
  assert.equal(changed.mock.callCount(), 1);
  // A decided card has no buttons left.
  assert.equal(card('Record an attempt').queryByRole('button'), null);

  // A refusal names the way forward and keeps the card open for another try.
  await press('Star problems', 'Star');
  await waitFor(() => assert.equal(card('Star problems').getByRole('alert').textContent, 'Wait for active operations to finish, then retry.'));
  assert.equal(changed.mock.callCount(), 1);
  await press('Star problems', 'Try again');
  await waitFor(() => card('Star problems').getByText('Starred'));
  assert.equal(changed.mock.callCount(), 2);

  // A change built on an older note cannot succeed by retrying, so only dismissing is left.
  await press('Add to the note', 'Add');
  await waitFor(() => assert.equal(card('Add to the note').getByRole('alert').textContent, 'The note changed after the AI read it. Ask it to prepare the change again.'));
  assert.deepEqual(card('Add to the note').getAllByRole('button').map(button => button.textContent), ['Dismiss']);
  await press('Add to the note', 'Dismiss');
  assert.ok(card('Add to the note').getByText('Dismissed, nothing changed'));
  assert.equal(applied.length, 4);
  assert.equal(changed.mock.callCount(), 2);

  // The next question tells the model what became of each proposal.
  await ask('Thanks');
  await waitFor(() => assert.equal(requests.length, 2));
  assert.equal(requests[1].messages[1].content, [
    'Confirm the cards to save these.',
    '',
    '[Proposed change tracker_create_practices: the user confirmed it and it was applied]',
    '[Proposed change tracker_patch_note: the user dismissed it; nothing changed]',
    '[Proposed change tracker_add_favorites: the user confirmed it and it was applied]',
  ].join('\n'));

  // A confirmation cut off by closing the app is offered again; a malformed proposal is dropped.
  localStorage.setItem('leetcode_tracker_chat_threads_v1', JSON.stringify({ current: { key: 'general' }, threads: [{ key: 'general', usedAt: Date.now(), entries: [
    { id: 'q', role: 'user', content: 'Log it', state: 'done' },
    { id: 'a', role: 'assistant', content: 'Confirm it.', state: 'done', changes: [{ ...practiceCard, state: 'applying' }, { id: 'broken', state: 'pending' }] },
  ] }] }));
  const restored = loadChatState().threads.general.entries[1].changes!;
  assert.deepEqual(restored.map(change => [change.id, change.state]), [['p1', 'pending']]);
  assert.deepEqual(requestTurns(loadChatState().threads.general.entries).at(-1),
    { role: 'assistant', content: 'Confirm it.\n\n[Proposed change tracker_create_practices: not confirmed yet; nothing changed]' });
});

it('copies and regenerates an answer, keeps a draft, recalls the last question and resizes', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const requests = serveChat([
    { type: 'context', context: {} },
    { type: 'delta', text: 'Use a map.\n\n```python\nseen = {}\n```' },
    { type: 'done', provider: 'openai', model: 'gpt-6-luna' },
  ], [
    { type: 'context', context: {} },
    { type: 'delta', text: 'Second take.' },
    { type: 'done', provider: 'openai', model: 'gpt-6-luna' },
  ]);
  await openPanel();
  await ask('How?');
  await waitFor(() => screen.getByText('Use a map.'));

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy answer' })); });
  await waitFor(() => screen.getByRole('button', { name: 'Copied' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy code' })); });
  assert.deepEqual(copied, ['Use a map.\n\n```python\nseen = {}\n```', 'seen = {}\n']);

  // Asking again replaces the answer with a fresh one to the same question.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Answer again' })); });
  await waitFor(() => screen.getByText('Second take.'));
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'How?' }]);
  assert.equal(screen.queryByText('Use a map.'), null);

  // Text typed but not sent survives closing the panel.
  const field = () => screen.getByRole('textbox') as HTMLTextAreaElement;
  await act(async () => { fireEvent.change(field(), { target: { value: 'half a thought' } }); });
  await act(async () => { fireEvent.keyDown(field(), { key: 'Escape' }); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask AI' })); });
  await waitFor(() => assert.equal(field().value, 'half a thought'));
  // Up leaves a draft alone and fills an empty field with the last question.
  await act(async () => { fireEvent.keyDown(field(), { key: 'ArrowUp' }); });
  assert.equal(field().value, 'half a thought');
  await act(async () => { fireEvent.change(field(), { target: { value: '' } }); });
  await act(async () => { fireEvent.keyDown(field(), { key: 'ArrowUp' }); });
  assert.equal(field().value, 'How?');

  // The enlarged size is remembered with the placement.
  const position = () => JSON.parse(localStorage.getItem('leetcode_tracker_chat_position_v1') ?? '{}') as { large?: boolean };
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enlarge panel' })); });
  assert.equal(screen.getByRole('complementary').getAttribute('data-size'), 'large');
  assert.equal(position().large, true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore panel size' })); });
  assert.equal(screen.getByRole('complementary').hasAttribute('data-size'), false);
  assert.equal('large' in position(), false);
  // The enlarged panel fills the window height and still fits a narrow window.
  assert.deepEqual(panelPoint({ ...DEFAULT_CHAT_POSITION, large: true }, { width: 1440, height: 900 }), { left: 696, top: 24 });
  assert.deepEqual(panelPoint({ ...DEFAULT_CHAT_POSITION, large: true }, { width: 700, height: 600 }), { left: 24, top: 24 });
});

it('offers to save a plain answer to the note and to find similar problems', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  mock.method(api, 'getPracticeRecords', async () => ({ total: 0, page: 1, limit: 1, items: [] }));
  const requests = serveChat(answer('Related: 11 and 407.'), answer('Use two pointers.'), [
    { type: 'context', context: { problem: rain } },
    { type: 'action', action: noteCard },
    { type: 'delta', text: 'Confirm to save it.' },
    { type: 'done', provider: 'openai', model: 'gpt-6-luna' },
  ]);
  setChatProblem(rain);
  await openPanel();
  const saveNote = () => screen.queryByRole('button', { name: 'Save to my note' });
  assert.equal(saveNote(), null);
  assert.equal(screen.queryByRole('button', { name: 'Review practice' }), null);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Find similar problems' })); });
  await waitFor(() => screen.getByText('Related: 11 and 407.'));
  assert.equal(requests[0].messages[0].content, similarPrompt('en', rain));

  await ask('How do I solve it?');
  await waitFor(() => screen.getByText('Use two pointers.'));
  await waitFor(() => assert.equal((saveNote() as HTMLButtonElement).disabled, false));
  assert.equal(saveNote()?.closest('.chat-entry-assistant'), screen.getByText('Use two pointers.').closest('.chat-entry-assistant'));
  await act(async () => { fireEvent.click(saveNote()!); });
  await waitFor(() => screen.getByText('Confirm to save it.'));
  assert.equal(requests[2].messages.at(-1)!.content, saveNotePrompt('en', rain));
  // The answer that proposes the note change is not itself offered for saving.
  assert.ok(screen.getByRole('region', { name: 'Add to the note' }));
  await waitFor(() => screen.getByRole('button', { name: 'Send' }));
  assert.equal(saveNote(), null);

  // Proposing a change takes data access, so the offers go away with it.
  await act(async () => { setChatDataAccess(false); });
  await clearConversation('#42 Trapping Rain Water');
  assert.equal(screen.queryByRole('button', { name: 'Find similar problems' }), null);
  assert.equal(screen.queryByText(/You confirm each change first/), null);
});

it('names a lookup under earlier text, marks an answer that finished behind a closed panel and confirms a card once', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  let applied = 0;
  mock.method(api, 'applyChatAction', async () => { applied += 1; return { result: {} }; });
  // The answer pauses on a lookup until released.
  let release!: () => void;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode([{ type: 'context', context: {} }, { type: 'delta', text: 'Let me check.' }, { type: 'tool', name: 'tracker_get_today' }]));
      release = () => {
        controller.enqueue(encode([
          { type: 'delta', text: '\n\nStart with Two Sum.' },
          { type: 'action', action: practiceCard },
          { type: 'done', provider: 'openai', model: 'm' },
        ]));
        controller.close();
      };
    },
  }), { status: 200 })) as typeof fetch;

  await openPanel();
  await ask('What first?');
  // The text so far stays, with what is being read under it.
  await waitFor(() => screen.getByText("Reading today's plan…"));
  assert.ok(screen.getByText('Let me check.'));

  await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); });
  assert.ok(screen.getByRole('button', { name: 'Ask AI (answering)' }));
  await act(async () => { release(); });
  await waitFor(() => screen.getByRole('button', { name: 'Ask AI (new answer)' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask AI (new answer)' })); });
  await waitFor(() => screen.getByText('Start with Two Sum.'));
  assert.equal(screen.queryByText("Reading today's plan…"), null);

  // Two presses before the card redraws still send one confirmation.
  const record = screen.getByRole('button', { name: 'Record' });
  await act(async () => { fireEvent.click(record); fireEvent.click(record); });
  await waitFor(() => screen.getByText('Recorded'));
  assert.equal(applied, 1);

  // Once read, the launcher is plain again.
  await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); });
  assert.ok(screen.getByRole('button', { name: 'Ask AI' }));

  // A decided note change is stored without the text it carried; an open one keeps it.
  const entry = (state: 'applied' | 'pending') => ({ id: state, role: 'assistant' as const, content: 'Confirm it.', state: 'done' as const, changes: [{ ...noteCard, id: state, state }] });
  saveChatState({ current: GENERAL_THREAD, threads: { general: { ...GENERAL_THREAD, usedAt: Date.now(), entries: [entry('applied'), entry('pending')] } } });
  const kept = loadChatState().threads.general.entries.map(item => item.changes![0].args);
  assert.deepEqual(kept.map(args => 'content' in args), [false, true]);
  assert.equal(kept[0].heading, 'Pitfalls');
});

it('lets a proposal be adjusted before confirming and an applied change be taken back', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const applied: Array<{ name: string; args: Record<string, unknown> }> = [];
  const practiceUndo = { kind: 'practices' as const, records: [{ id: 'r1', revision: 1 }] };
  const noteUndo = { kind: 'note' as const, frontendId: '42', content: '## Idea', expectedContentHash: 'hash-2' };
  mock.method(api, 'applyChatAction', async (input: { name: string; args: Record<string, unknown> }) => {
    applied.push(input);
    return { result: {}, undo: input.name === 'tracker_patch_note' ? noteUndo : practiceUndo };
  });
  const undone: unknown[] = [];
  mock.method(api, 'undoChatAction', async (undo: { kind: string }) => {
    undone.push(undo);
    if (undo.kind === 'note') throw new ApiError(409, 'CHAT_UNDO_STALE', 'This data changed after the change was applied, so it was not undone automatically.');
    return { ok: true as const };
  });
  const requests = serveChat([
    { type: 'context', context: {} },
    { type: 'action', action: practiceCard },
    { type: 'action', action: noteCard },
    { type: 'delta', text: 'Confirm the cards to save these.' },
    { type: 'done', provider: 'openai', model: 'gpt-6-luna' },
  ], answer('ok'));
  const changed = mock.fn();
  await act(async () => { render(<ChatLauncher lang="en" onOpenAiSettings={() => {}} onDataChanged={changed} />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask AI' })); });
  await waitFor(() => screen.getByRole('complementary'));
  await ask('Log #1 and note the pitfall.');
  await waitFor(() => screen.getByText('Confirm the cards to save these.'));
  const card = (name: string) => within(screen.getByRole('region', { name }));
  const press = async (name: string, label: string) => { await act(async () => { fireEvent.click(card(name).getByRole('button', { name: label })); }); };

  // The practice card turns into its own fields; a value the tracker would refuse cannot be sent.
  await press('Record an attempt', 'Edit');
  const attempt = within(card('Record an attempt').getByRole('group', { name: '#1 Two Sum' }));
  const minutes = attempt.getByRole('spinbutton', { name: 'Duration in minutes' }) as HTMLInputElement;
  assert.equal((attempt.getByRole('combobox', { name: 'Result' }) as HTMLSelectElement).value, 'independent');
  assert.equal(minutes.value, '20');
  await act(async () => { fireEvent.change(attempt.getByRole('combobox', { name: 'Result' }), { target: { value: 'assisted' } }); });
  await act(async () => { fireEvent.change(minutes, { target: { value: '0' } }); });
  assert.equal((card('Record an attempt').getByRole('button', { name: 'Record' }) as HTMLButtonElement).disabled, true);
  await act(async () => { fireEvent.change(minutes, { target: { value: '35' } }); });
  await press('Record an attempt', 'Record');
  await waitFor(() => card('Record an attempt').getByText('Recorded'));
  // Only the adjusted values differ from the proposal; the rest, such as the operation ID, is kept.
  const proposed = (practiceCard.args.records as Array<Record<string, unknown>>)[0];
  assert.deepEqual(applied[0], { name: practiceCard.name, args: { ...practiceCard.args, records: [{ ...proposed, completed: true, outcome: 'assisted', durationMinutes: 35 }] } });
  assert.match(card('Record an attempt').getByRole('listitem').textContent ?? '', /solved with help · 35 min/);

  // Edits can be discarded, which leaves the proposal as it was.
  const noteText = () => card('Add to the note').getByRole('textbox', { name: 'Text to be written' }) as HTMLTextAreaElement;
  await press('Add to the note', 'Edit');
  await act(async () => { fireEvent.change(noteText(), { target: { value: 'Thrown away.' } }); });
  await press('Add to the note', 'Discard edits');
  assert.equal(card('Add to the note').getByText('right max').tagName, 'STRONG');
  await press('Add to the note', 'Edit');
  assert.equal(noteText().value, noteCard.args.content);
  await act(async () => { fireEvent.change(noteText(), { target: { value: '   ' } }); });
  assert.equal((card('Add to the note').getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled, true);
  await act(async () => { fireEvent.change(noteText(), { target: { value: 'My own wording.' } }); });
  await press('Add to the note', 'Add');
  await waitFor(() => card('Add to the note').getByText('Saved to the note'));
  assert.deepEqual(applied[1], { name: noteCard.name, args: { ...noteCard.args, content: 'My own wording.' } });
  assert.equal(changed.mock.callCount(), 2);

  // An applied change is taken back with what its receipt said, and the views reload again.
  await press('Record an attempt', 'Undo');
  await waitFor(() => card('Record an attempt').getByText('Undone. The data is as it was before.'));
  assert.deepEqual(undone, [practiceUndo]);
  assert.equal(changed.mock.callCount(), 3);
  assert.equal(card('Record an attempt').queryByRole('button'), null);
  // A change the data has moved past stays applied, says why, and stops offering the undo.
  await press('Add to the note', 'Undo');
  await waitFor(() => assert.match(card('Add to the note').getByRole('alert').textContent ?? '', /^This data changed after you confirmed, so it was not undone\./));
  assert.ok(card('Add to the note').getByText('Saved to the note'));
  assert.equal(card('Add to the note').queryByRole('button'), null);
  assert.equal(changed.mock.callCount(), 3);

  // The model hears what the user did with each proposal.
  await ask('Thanks');
  await waitFor(() => assert.equal(requests.length, 2));
  assert.equal(requests[1].messages[1].content, [
    'Confirm the cards to save these.',
    '',
    '[Proposed change tracker_create_practices: the user confirmed it, then undid it; nothing changed]',
    '[Proposed change tracker_patch_note: the user edited its values, then confirmed it and it was applied]',
  ].join('\n'));

  // What an undo needs stays in memory; a change caught mid-undo is stored as applied.
  await waitFor(() => screen.getByText('ok'));
  await waitFor(() => assert.ok(localStorage.getItem('leetcode_tracker_chat_threads_v1')?.includes('undone')));
  assert.doesNotMatch(localStorage.getItem('leetcode_tracker_chat_threads_v1')!, /"undo":|hash-2/);
  localStorage.setItem('leetcode_tracker_chat_threads_v1', JSON.stringify({ current: { key: 'general' }, threads: [{ key: 'general', usedAt: Date.now(), entries: [
    { id: 'a', role: 'assistant', content: 'Confirm it.', state: 'done', changes: [{ ...practiceCard, state: 'undoing', undo: practiceUndo }] },
  ] }] }));
  assert.deepEqual(loadChatState().threads.general.entries[0].changes, [{ ...practiceCard, state: 'applied' }]);
});

it('opens a problem conversation from a row and follows the problem a timer starts on', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const requests = serveChat(answer('ok'));
  const { AskAiButton } = await import('../apps/web/src/components/AskAiButton.tsx');
  const { startTimer, TIMER_CHANGE_EVENT } = await import('../apps/web/src/timer-service.ts');

  // A row hands over its problem without a question; a view without the chat offers nothing.
  const askAi = mock.fn();
  const workspace = { revision: 0, timezone: 'UTC', navigate() {}, notifyMutation() {}, openPractice() {} };
  const row = (value: typeof workspace & { askAi?: typeof askAi }) => (
    <WorkspaceContext.Provider value={value}><AskAiButton lang="en" frontendId="15" title="3Sum" /></WorkspaceContext.Provider>
  );
  const view = render(row({ ...workspace, askAi }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask AI about #15' })); });
  assert.deepEqual(askAi.mock.calls[0].arguments, [{ problem: threeSum }]);
  view.rerender(row(workspace));
  assert.equal(screen.queryByRole('button', { name: 'Ask AI about #15' }), null);
  view.unmount();

  // The panel opens on that problem and sends nothing.
  const launcher = (ask?: Parameters<typeof ChatLauncher>[0]['ask']) => <ChatLauncher lang="en" onOpenAiSettings={() => {}} ask={ask} />;
  let chat!: ReturnType<typeof render>;
  await act(async () => { chat = render(launcher()); });
  await act(async () => { chat.rerender(launcher({ id: 1, problem: threeSum })); });
  await waitFor(() => screen.getByRole('heading', { name: '#15 3Sum' }));
  await waitFor(() => screen.getByRole('button', { name: 'Give me a hint' }));
  assert.equal(requests.length, 0);

  // Starting a timer on another problem brings that problem's conversation up.
  await act(async () => {
    startTimer(rain);
    window.dispatchEvent(new dom.window.CustomEvent(TIMER_CHANGE_EVENT));
  });
  await waitFor(() => screen.getByRole('heading', { name: '#42 Trapping Rain Water' }));
  // A later timer event for the same problem does not pull the user back from another conversation.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '#42 Trapping Rain Water' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'General' })); });
  await act(async () => { window.dispatchEvent(new dom.window.CustomEvent(TIMER_CHANGE_EVENT)); });
  assert.ok(screen.getByRole('heading', { name: 'General' }));
});

const { applyDraft, draftOf } = await import('../apps/web/src/chat/chat-changes.ts');
const { mergeChatThreads, readStoredThreads } = await import('../apps/web/src/chat/chat-threads.ts');
const STORAGE = 'leetcode_tracker_chat_threads_v1';

it('names the provider in use after Settings change, and sends each question to the one it names', async () => {
  const status = mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const requests = serveChat(
    [{ type: 'context', context: {} }, { type: 'error', error: 'CHAT_PROVIDER_CHANGED', message: 'The AI provider settings changed. Ask again to use the current provider.' }],
    answer('ok'),
  );
  const workspace = (revision: number) => ({ revision, timezone: 'UTC', navigate() {}, notifyMutation() {}, openPractice() {} });
  const launcher = (revision: number) => (
    <WorkspaceContext.Provider value={workspace(revision)}><ChatLauncher lang="en" onOpenAiSettings={() => {}} /></WorkspaceContext.Provider>
  );
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(launcher(0)); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ask AI' })); });
  await waitFor(() => screen.getByText('OpenAI · gpt-6-luna'));

  // Saving AI settings while the panel stays open bumps the workspace revision.
  status.mock.mockImplementation(async () => ({ configured: true, provider: 'deepseek', model: 'deepseek-flash' }) as never);
  await act(async () => { view.rerender(launcher(1)); });
  await waitFor(() => screen.getByText('DeepSeek · deepseek-flash'));
  assert.ok(screen.getByText('What goes to DeepSeek'));

  // Changed elsewhere without the panel noticing: the server refuses, and the panel reads it again.
  status.mock.mockImplementation(async () => ({ configured: true, provider: 'gemini', model: 'models/gemini-4-hydrogen' }) as never);
  await ask('Explain');
  await waitFor(() => screen.getByRole('alert'));
  assert.equal(requests[0].provider, 'deepseek');
  assert.match(screen.getByRole('alert').textContent ?? '', /provider in Settings changed/);
  await waitFor(() => screen.getByText('Gemini · gemini-4-hydrogen'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  await waitFor(() => screen.getByText('ok'));
  assert.equal(requests[1].provider, 'gemini');

  // Coming back to the window reads it again too.
  status.mock.mockImplementation(async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }) as never);
  await act(async () => { fireEvent.focus(window); });
  await waitFor(() => screen.getByText('OpenAI · gpt-6-luna'));
});

it('sends a preset about the problem it was asked about, even once another one is shown', async () => {
  let resolveStatus!: (value: unknown) => void;
  mock.method(api, 'getChatStatus', () => new Promise(resolve => { resolveStatus = resolve; }));
  const requests = serveChat(answer('ok'));
  await act(async () => {
    render(<ChatLauncher lang="en" onOpenAiSettings={() => {}} ask={{ id: 1, problem: threeSum, action: { kind: 'hint' } }} />);
  });
  await waitFor(() => screen.getByRole('heading', { name: '#15 3Sum' }));
  // The user opens another note before the provider status arrives.
  await act(async () => { setChatProblem(rain); });
  await waitFor(() => screen.getByRole('heading', { name: '#42 Trapping Rain Water' }));
  await act(async () => { resolveStatus({ configured: true, provider: 'openai', model: 'gpt-6-luna' }); });

  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0], { messages: [{ role: 'user', content: hintPrompt(1, 'en', threeSum) }], context: { frontendId: '15' }, lang: 'en', provider: 'openai' });
  // The answer lands in the conversation of #15; the one in view stays the one the user chose.
  assert.ok(screen.getByRole('heading', { name: '#42 Trapping Rain Water' }));
  assert.equal(screen.queryByText(hintPrompt(1, 'en', threeSum)), null);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '#42 Trapping Rain Water' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^#15 3Sum/ })); });
  await waitFor(() => screen.getByText('ok'));
  assert.equal(screen.getByText(hintPrompt(1, 'en', threeSum)).tagName, 'P');
});

it('keeps a confirmed change and its undo when an interrupted answer is asked again', async () => {
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  const practiceUndo = { kind: 'practices' as const, records: [{ id: 'r1', revision: 1 }] };
  mock.method(api, 'applyChatAction', async () => ({ result: {}, undo: practiceUndo }));
  const requests = serveChat(
    [
      { type: 'context', context: {} },
      { type: 'action', action: practiceCard },
      { type: 'delta', text: 'Recording that.' },
      { type: 'error', error: 'CHAT_INTERRUPTED', message: 'The answer was interrupted.' },
    ],
    [{ type: 'context', context: {} }, { type: 'delta', text: 'It is recorded.' }, { type: 'done', provider: 'openai', model: 'gpt-6-luna' }],
  );
  await openPanel();
  await ask('Log #1');
  await waitFor(() => screen.getByRole('alert'));
  const card = () => within(screen.getByRole('region', { name: 'Record an attempt' }));
  await act(async () => { fireEvent.click(card().getByRole('button', { name: 'Record' })); });
  await waitFor(() => card().getByText('Recorded'));

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  await waitFor(() => screen.getByText('It is recorded.'));
  // The interrupted answer stays with its card, which still offers the undo.
  assert.equal(screen.getByText('Recording that.').tagName, 'P');
  assert.ok(card().getByRole('button', { name: 'Undo' }));
  // The model hears that the change was applied, then the same question again.
  assert.deepEqual(requests[1].messages.map(message => message.role), ['user', 'assistant', 'user']);
  assert.match(requests[1].messages[1].content, /tracker_create_practices: the user confirmed it and it was applied/);
  assert.equal(requests[1].messages[2].content, 'Log #1');
});

it('changes only the values the user adjusted on a practice card', () => {
  const card = { ...practiceCard, args: { ...practiceCard.args, records: [{ questionFrontendId: '1', completed: true, durationMinutes: 20 }] } };
  const draft = draftOf(card);
  assert.ok(draft?.kind === 'practices');
  // A solved attempt with no stated outcome is shown as solved independently.
  assert.equal(draft.attempts[0].outcome, 'independent');
  const records = (attempt: Partial<(typeof draft.attempts)[number]>) =>
    applyDraft(card, { kind: 'practices', attempts: [{ ...draft.attempts[0], ...attempt }] })?.records;
  // Changing the minutes alone does not state an outcome the user never chose.
  assert.deepEqual(records({ minutes: '25' }), [{ questionFrontendId: '1', completed: true, durationMinutes: 25 }]);
  assert.deepEqual(records({}), card.args.records);
  assert.deepEqual(records({ outcome: 'assisted' }), [{ questionFrontendId: '1', completed: true, outcome: 'assisted', durationMinutes: 20 }]);
  assert.deepEqual(records({ outcome: 'unsolved', minutes: '' }), [{ questionFrontendId: '1', completed: false, outcome: 'unsolved', durationMinutes: null }]);
});

it('keeps conversations another tab stored, both when storing and while open', async () => {
  const now = Date.now();
  const entry = (content: string) => ({ id: content, role: 'user' as const, content, state: 'done' as const });
  const thread = (frontendId: string, content: string) => ({ ...problemThread({ frontendId }), entries: [entry(content)], usedAt: now });

  // Two tabs start from the same stored state and each asks about another problem.
  saveChatState({ threads: { general: { ...GENERAL_THREAD, entries: [entry('shared')], usedAt: now - 10 } }, current: GENERAL_THREAD });
  const tabA = loadChatState(now);
  const tabB = loadChatState(now);
  const a: typeof tabA = { ...tabA, threads: { ...tabA.threads, 'problem:1': thread('1', 'about one') } };
  saveChatState(a, tabA.threads);
  saveChatState({ ...tabB, threads: { ...tabB.threads, 'problem:42': thread('42', 'about forty-two') } }, tabB.threads);
  assert.deepEqual(Object.keys(loadChatState(now).threads).sort(), ['general', 'problem:1', 'problem:42']);
  // A conversation one tab deleted stays deleted, and the other tab's stays.
  const { general: _general, ...withoutGeneral } = a.threads;
  saveChatState({ ...a, threads: withoutGeneral }, a.threads);
  assert.deepEqual(Object.keys(loadChatState(now).threads).sort(), ['problem:1', 'problem:42']);

  // An unchanged copy of this tab's own conversation is not adopted, so an undo held only in memory survives.
  const practiceUndo = { kind: 'practices' as const, records: [{ id: 'r1', revision: 1 }] };
  const applied = { ...thread('1', 'Log it'), entries: [
    { id: 'r', role: 'assistant' as const, content: 'Done.', state: 'done' as const, changes: [{ ...practiceCard, state: 'applied' as const, undo: practiceUndo }] },
  ] };
  const mine = { 'problem:1': applied };
  saveChatState({ threads: mine, current: GENERAL_THREAD });
  assert.equal(mergeChatThreads(mine, mine, readStoredThreads()!), mine);

  // An open panel picks up what another tab stores, and its own next write keeps it.
  localStorage.clear();
  mock.method(api, 'getChatStatus', async () => ({ configured: true, provider: 'openai', model: 'gpt-6-luna' }));
  serveChat(answer('ok'));
  await openPanel();
  localStorage.setItem(STORAGE, JSON.stringify({ current: GENERAL_THREAD, threads: [thread('42', 'from the other tab')] }));
  await act(async () => { window.dispatchEvent(new dom.window.StorageEvent('storage', { key: STORAGE })); });
  await ask('Mine');
  await waitFor(() => screen.getByText('ok'));
  await waitFor(() => assert.deepEqual(Object.keys(loadChatState().threads).sort(), ['general', 'problem:42']));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'General' })); });
  assert.ok(screen.getByRole('button', { name: /^#42/ }));
});

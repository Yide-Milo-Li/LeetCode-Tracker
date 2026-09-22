/** Built-in practice timer: duration math, persistence, and row/pill controls. */
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  CustomEvent: dom.window.CustomEvent,
  StorageEvent: dom.window.StorageEvent,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

const React = await import('react');
const { render, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const service = await import('../apps/web/src/timer-service.ts');
const { PracticeTimerButton, PracticeTimerPill } = await import('../apps/web/src/components/PracticeTimer.tsx');

afterEach(() => {
  cleanup();
  dom.window.localStorage.clear();
});

it('converts elapsed seconds to whole minutes with a 1-minute floor', () => {
  assert.equal(service.toMinutes(0), 1);
  assert.equal(service.toMinutes(1), 1);
  assert.equal(service.toMinutes(60), 1);
  assert.equal(service.toMinutes(61), 2);
  assert.equal(service.toMinutes(3599), 60);
  assert.equal(service.toMinutes(Number.NaN), 1);
});

it('formats elapsed clocks as MM:SS and H:MM:SS', () => {
  assert.equal(service.formatElapsed(0), '00:00');
  assert.equal(service.formatElapsed(65), '01:05');
  assert.equal(service.formatElapsed(3599), '59:59');
  assert.equal(service.formatElapsed(3661), '1:01:01');
});

it('stops the active timer into pending minutes and only for the matching problem', () => {
  service.startTimer({ frontendId: '1', title: 'Two Sum' }, 1_000);
  assert.equal(service.stopTimerFor('2', 61_000), null);
  assert.notEqual(service.loadActiveTimer(), null);

  const stopped = service.stopTimerFor('1', 91_000);
  assert.equal(stopped?.elapsedSeconds, 90);
  assert.equal(stopped?.minutes, 2);
  assert.equal(service.loadActiveTimer(), null);
  assert.equal(service.getPendingMinutes('1'), 2);
});

it('switching problems discards the previous run without keeping minutes', () => {
  service.startTimer({ frontendId: '1', title: 'A' }, 1_000);
  service.startTimer({ frontendId: '2', title: 'B' }, 2_000);
  assert.equal(service.loadActiveTimer()?.frontendId, '2');
  assert.equal(service.getPendingMinutes('1'), null);
});

it('discards corrupt active entries instead of crashing', () => {
  dom.window.localStorage.setItem('leetcode-tracker-active-timer', '{broken');
  assert.equal(service.loadActiveTimer(), null);
  assert.equal(dom.window.localStorage.getItem('leetcode-tracker-active-timer'), null);
});

it('toggles the row timer button and keeps minutes pending for the next record', async () => {
  await act(async () => {
    render(<PracticeTimerButton lang="en" frontendId="1" title="Two Sum" />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Start timer/ }));
  });
  assert.equal(service.loadActiveTimer()?.frontendId, '1');

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Stop timer/ }));
  });
  assert.equal(service.loadActiveTimer(), null);
  assert.ok((service.getPendingMinutes('1') ?? 0) >= 1);
});

it('shows the global pill with a live clock while timing', async () => {
  service.startTimer({ frontendId: '7', title: 'Reverse' }, Date.now() - 65_000);
  await act(async () => {
    render(<PracticeTimerPill lang="zh" />);
  });
  assert.ok(screen.getByRole('status', { name: /计时中/ }));
  assert.ok(screen.getByText('01:05'));
});

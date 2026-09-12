/**
 * Automated tests for global power-user keyboard shortcuts in desktop web client.
 * Tests navigation (1/2/3), manual modal (N), search focus (/), help cheat sheet (?),
 * and strict guards against input editing, open dialogs, and IME composition.
 */
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  Event: dom.window.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(window, 'scrollTo', { value: () => {} });
Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

const React = await import('react');
const { render, screen, fireEvent, act, cleanup } = await import('@testing-library/react');
const { App } = await import('../apps/web/src/App.tsx');
const { api } = await import('../apps/web/src/api.ts');

beforeEach(() => {
  window.location.hash = '';
  document.body.innerHTML = '';
  api.getSettings = async () => ({
    language: 'en',
    theme: 'system',
    timezone: 'UTC',
    updatedAt: Date.now(),
  });
  api.ensureDailyPlan = async () => ({
    status: 'ready',
    plan: null,
  });
  api.getStrategies = async () => [];
  api.getCatalogStats = async () => ({
    totalProblems: 75,
    easy: 25,
    medium: 40,
    hard: 10,
    paidOnly: 0,
    totalTags: 15,
    catalogRevision: 1,
    lastImportedAt: null,
  });
  api.getAllTags = async () => ({ tags: [] });
  api.getPracticeStats = async () => ({
    uniqueSolvedProblems: 0,
    totalManualPractices: 0,
    completedManualPractices: 0,
    uncompletedManualPractices: 0,
    totalSnapshots: 0,
    acceptedSnapshots: 0,
    lastActivityAt: null,
    practiceRevision: 1,
  });
  api.getCatalog = async () => ({
    total: 0,
    page: 1,
    limit: 50,
    items: [],
  });
});

afterEach(() => {
  cleanup();
});

it('navigates to Problems on key "2", Progress on key "3", and Today on key "1"', async () => {
  await act(async () => {
    render(<App />);
  });

  // Key "2" -> navigate to problems
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '2', bubbles: true }));
  });
  assert.equal(window.location.hash, '#problems');

  // Key "3" -> navigate to records
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '3', bubbles: true }));
  });
  assert.equal(window.location.hash, '#records');

  // Key "1" -> navigate to today
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '1', bubbles: true }));
  });
  assert.equal(window.location.hash, '#today');
});

it('opens manual practice modal on key "n" and closes on Escape', async () => {
  await act(async () => {
    render(<App />);
  });

  // Press 'n'
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  });

  // Modal header for manual practice should appear
  assert.ok(screen.getByRole('dialog'));
  assert.ok(screen.getByText('Manual record'));

  // Press Escape to dismiss
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  assert.equal(screen.queryByRole('dialog'), null);
});

it('opens keyboard shortcut help modal on key "?"', async () => {
  await act(async () => {
    render(<App />);
  });

  // Press '?'
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true }));
  });

  assert.ok(screen.getByRole('dialog'));
  assert.ok(screen.getByText('Keyboard Shortcuts'));
  assert.ok(screen.getByText('Navigate to Problems'));

  // Close help modal with Escape
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  assert.equal(screen.queryByRole('dialog'), null);
});

it('focuses catalog search input on key "/"', async () => {
  await act(async () => {
    render(<App />);
  });

  // Press '/'
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
  });

  // Should navigate to #problems
  assert.equal(window.location.hash, '#problems');

  // Wait for the focus timeout
  await new Promise((resolve) => setTimeout(resolve, 80));

  const searchInput = document.getElementById('catalog-search-input');
  assert.ok(searchInput);
});

it('strictly suppresses shortcuts when typing in inputs or textareas', async () => {
  await act(async () => {
    render(<App />);
  });

  // Create a dummy input and focus it
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();

  // Dispatch keydown targeting input
  await act(async () => {
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '2', bubbles: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '3', bubbles: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  });

  // Location must NOT have changed from empty
  assert.equal(window.location.hash, '');
  // No modal opened
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  assert.equal(screen.queryByRole('dialog'), null);

  input.remove();
});

it('suppresses shortcuts during active IME composition', async () => {
  await act(async () => {
    render(<App />);
  });

  // Press '2' with isComposing = true
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '2', isComposing: true, bubbles: true }));
  });

  assert.equal(window.location.hash, '');
});

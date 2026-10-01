/**
 * Automated UI test suite for Phase 36: SettingsView Background Runtime & AI Connection (MCP).
 * Verifies headless autostart controls, external AI access pause/resume toggle,
 * named client connections listing, token rotation, revocation, and configuration guide expansion.
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
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
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const mockClipboard = {
  writeText: async (_text: string) => {},
  readText: async () => '',
};

Object.defineProperty(dom.window.navigator, 'clipboard', {
  configurable: true,
  value: mockClipboard,
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
Object.defineProperty(window, 'scrollTo', { value: () => {} });
Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

const React = await import('react');
const { render, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const { DesktopWorkspaceProvider } = await import('../apps/web/src/workspace-adapter.tsx');
const { SettingsView } = await import('../apps/web/src/components/SettingsView.tsx');
const { api, mcpApi } = await import('../apps/web/src/api.ts');
import * as platform from '../apps/web/src/platform/index.ts';

describe('SettingsView: Background Runtime & AI Connection (MCP)', () => {
  beforeEach(() => {
    localStorage.clear();
    mock.method(api, 'getSettings', async () => ({
      language: 'zh',
      theme: 'system',
      timezone: 'Asia/Shanghai',
      ai: { hasApiKey: false },
    }));

    mock.method(mcpApi, 'getConfig', async () => ({
      port: 30138,
      clientToken: '0123456789abcdef0123456789abcdef',
      clients: [
        {
          id: 'claude-desktop',
          name: 'Claude Desktop',
          token: 'token-claude-desktop-123456',
          createdAt: 1700000000000,
          lastUsedAt: null,
          revoked: false,
        },
        {
          id: 'cursor',
          name: 'Cursor',
          token: 'token-cursor-123456',
          createdAt: 1700000000000,
          lastUsedAt: 1727700000000,
          revoked: false,
        },
      ],
      aiAccessPaused: false,
    }));
  });

  afterEach(() => {
    cleanup();
    mock.reset();
  });

  it('renders Background Runtime and AI Connection sections in Chinese', async () => {
    await act(async () => {
      render(
        <DesktopWorkspaceProvider>
          <SettingsView
            lang="zh"
            currentTheme="light"
            onLanguageChange={() => {}}
            onThemeChange={() => {}}
          />
        </DesktopWorkspaceProvider>
      );
    });

    // Check Background Runtime headers
    assert.ok(screen.getByText('后台运行'));
    assert.ok(screen.getByText('Runtime 状态'));
    assert.ok(screen.getByText('开机静默启动'));

    // Check AI Connection headers
    assert.ok(screen.getByText('AI 连接'));
    assert.ok(screen.getByText('外部 AI 访问状态'));
    assert.ok(screen.getByText('MCP 服务端点'));
    assert.ok(screen.getByText('专用连接凭证 (Named Connections)'));
    assert.ok(screen.getByText('Claude Desktop'));
    assert.ok(screen.getByText('Cursor'));
    assert.ok(screen.getByText('从未调用'));
  });

  it('renders Background Runtime and AI Connection sections in English', async () => {
    await act(async () => {
      render(
        <DesktopWorkspaceProvider>
          <SettingsView
            lang="en"
            currentTheme="light"
            onLanguageChange={() => {}}
            onThemeChange={() => {}}
          />
        </DesktopWorkspaceProvider>
      );
    });

    assert.ok(screen.getByText('Background Runtime'));
    assert.ok(screen.getByText('AI Connection'));
    assert.ok(screen.getByText('External AI Access State'));
    assert.ok(screen.getByText('MCP Server Endpoint'));
    assert.ok(screen.getByText('Named Connections & Credentials'));
    assert.ok(screen.getByText('Never called'));
  });

  it('toggles external AI access pause/resume', async () => {
    let currentPaused = false;
    mock.method(mcpApi, 'updateConfig', async (patch: any) => {
      if (typeof patch.aiAccessPaused === 'boolean') {
        currentPaused = patch.aiAccessPaused;
      }
      return {
        port: 30138,
        clientToken: 'token123',
        clients: [],
        aiAccessPaused: currentPaused,
      };
    });

    await act(async () => {
      render(
        <DesktopWorkspaceProvider>
          <SettingsView
            lang="zh"
            currentTheme="light"
            onLanguageChange={() => {}}
            onThemeChange={() => {}}
          />
        </DesktopWorkspaceProvider>
      );
    });

    const pauseBtn = screen.getByText('暂停外部 AI 访问');
    assert.ok(pauseBtn);

    await act(async () => {
      fireEvent.click(pauseBtn);
    });

    assert.equal(currentPaused, true);
    assert.ok(screen.getByText('恢复外部 AI 访问'));
  });

  it('expands configuration guide snippet for a client connection', async () => {
    await act(async () => {
      render(
        <DesktopWorkspaceProvider>
          <SettingsView
            lang="zh"
            currentTheme="light"
            onLanguageChange={() => {}}
            onThemeChange={() => {}}
          />
        </DesktopWorkspaceProvider>
      );
    });

    const guideButtons = screen.getAllByText('查看接入配置指南');
    assert.ok(guideButtons.length >= 1);

    await act(async () => {
      fireEvent.click(guideButtons[0]);
    });

    assert.ok(screen.getByText(/Claude Desktop \/ Cursor \/ Cline/));
    assert.ok(screen.getByText(/desktop-mcp-proxy\.mjs/));
    assert.ok(screen.getByText(/ChatGPT 网页版/));
  });

  it('rotates and revokes client credentials', async () => {
    let rotatedCalled = false;
    let revokedCalled = false;

    mock.method(mcpApi, 'rotateClient', async (id: string) => {
      rotatedCalled = true;
      return { client: { id, name: 'Claude Desktop', token: 'new-token-999', createdAt: 1, lastUsedAt: null, revoked: false } };
    });

    mock.method(mcpApi, 'revokeClient', async (id: string) => {
      revokedCalled = true;
      return { success: true };
    });

    await act(async () => {
      render(
        <DesktopWorkspaceProvider>
          <SettingsView
            lang="zh"
            currentTheme="light"
            onLanguageChange={() => {}}
            onThemeChange={() => {}}
          />
        </DesktopWorkspaceProvider>
      );
    });

    const rotateButtons = screen.getAllByText('轮换');
    assert.ok(rotateButtons.length >= 1);

    await act(async () => {
      fireEvent.click(rotateButtons[0]);
    });
    assert.equal(rotatedCalled, true);

    const revokeButtons = screen.getAllByText('撤销');
    assert.ok(revokeButtons.length >= 1);

    await act(async () => {
      fireEvent.click(revokeButtons[0]);
    });
    assert.equal(revokedCalled, true);
  });
});

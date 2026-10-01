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
  it('shows unknown access on load failure and a conflicting listener without readiness', async () => {
    mock.method(mcpApi, 'getConfig', async () => { throw new Error('synthetic read failure'); });
    await act(async () => { render(<DesktopWorkspaceProvider><SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} /></DesktopWorkspaceProvider>); });
    assert.ok(screen.getByText('Unavailable')); assert.ok(screen.getByText('Runtime status unknown'));
    assert.equal(screen.queryByText('Active'), null);
    cleanup();
    mock.method(mcpApi, 'getConfig', async () => ({ port: 32000, clients: [], aiAccessPaused: false }));
    mock.method(mcpApi, 'getStatus', async () => ({ state: 'unavailable', configuredPort: 32000, listeningPort: null, restartRequired: false, aiAccessPaused: false, errorCode: 'MCP_PORT_IN_USE' }));
    await act(async () => { render(<DesktopWorkspaceProvider><SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} /></DesktopWorkspaceProvider>); });
    assert.ok(screen.getByText('MCP_PORT_IN_USE')); assert.ok(screen.getByText('Not listening'));
    assert.equal(screen.queryByText('Active'), null);
  });

  it('shows actual and pending ports together', async () => {
    mock.method(mcpApi, 'getStatus', async () => ({ state: 'ready', configuredPort: 32000, listeningPort: 30138, restartRequired: true, aiAccessPaused: false, errorCode: null }));
    await act(async () => { render(<DesktopWorkspaceProvider><SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} /></DesktopWorkspaceProvider>); });
    assert.ok(screen.getByText('http://127.0.0.1:30138/mcp')); assert.ok(screen.getByText('Pending restart port: 32000'));
    assert.ok(screen.getByRole('button', { name: 'Create Codex connection' }));
  });
  beforeEach(() => {
    localStorage.clear();
    mock.method(api, 'getSettings', async () => ({
      language: 'zh',
      theme: 'system',
      timezone: 'Asia/Shanghai',
      ai: { hasApiKey: false },
    }));

    mock.method(mcpApi, 'getStatus', async () => ({state:'ready',configuredPort:30138,listeningPort:30138,restartRequired:false,aiAccessPaused:false,errorCode:null}));
    mock.method(mcpApi, 'getConfig', async () => ({
      connection: {nodePath:'C:/安装 with spaces/node.exe',proxyPath:'C:/安装 with spaces/desktop-mcp-proxy.mjs',configPath:'C:/资料 with spaces/mcp-config.json'},
      port: 30138,
      clientToken: '0123456789abcdef0123456789abcdef',
      clients: [
        {
          id: 'claude-desktop',
          name: 'Claude Desktop',
          token: 'token-claude-desktop-123456',
          createdAt: 1700000000000,
          lastSuccessfulCallAt: null,
          revoked: false,
        },
        {
          id: 'cursor',
          name: 'Cursor',
          token: 'token-cursor-123456',
          createdAt: 1700000000000,
          lastSuccessfulCallAt: 1727700000000,
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
    assert.ok(screen.getAllByText(/desktop-mcp-proxy\.mjs/)[0]);
    assert.ok(screen.getByText(/ChatGPT 网页版/));
    const guide = document.body.textContent!;
    assert.ok(guide.includes('[mcp_servers.leetcode_tracker]'));
    assert.ok(guide.includes('@deepseek-ai/dsh-mcp-client'));
    assert.ok(guide.includes('--config'));
    assert.ok(guide.includes('mcp.discovery-extra-headers'));
    assert.ok(!guide.includes('npx @modelcontextprotocol/tunnel-cli'));
    assert.ok(!guide.includes('Bearer token-claude-desktop-123456'));
  });

  it('rotates and revokes client credentials', async () => {
    let rotatedCalled = false;
    let revokedCalled = false;

    mock.method(mcpApi, 'rotateClient', async (id: string) => {
      rotatedCalled = true;
      return { client: { id, name: 'Claude Desktop', token: 'new-token-999', createdAt: 1, lastSuccessfulCallAt: null, revoked: false } };
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

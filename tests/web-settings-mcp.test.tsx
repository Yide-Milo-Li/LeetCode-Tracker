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
  FileReader: dom.window.FileReader,
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
const { render: renderUi, fireEvent, screen, act, cleanup, waitFor } = await import('@testing-library/react');
const { DesktopWorkspaceProvider } = await import('../apps/web/src/workspace-adapter.tsx');
const { SettingsView } = await import('../apps/web/src/components/SettingsView.tsx');
const { api, mcpApi } = await import('../apps/web/src/api.ts');
import * as platform from '../apps/web/src/platform/index.ts';
// These legacy management checks explicitly open the manual configuration section.
const render = (...args: Parameters<typeof renderUi>) => {
  const result = renderUi(...args);
  document.querySelector<HTMLDetailsElement>('#plugin-manual-setup')?.setAttribute('open', '');
  return result;
};

describe('SettingsView: Background Runtime & AI Connection (MCP)', () => {
  it('refreshes successful-call metadata on focus without resetting unsaved port or connection name', async () => {
    const initial = await mcpApi.getConfig();
    const config = {...initial, clients: initial.clients.map(client => ({...client, credentialVersion:1}))};
    let timestamp: number | null = null;
    mock.method(api, 'getBusinessVersions', async () => ({approvals:0}) as any);
    mock.method(mcpApi, 'getConfig', async () => ({...config, clients:config.clients.map(client => ({...client,lastSuccessfulCallAt:client.id==='claude-desktop'?timestamp:client.lastSuccessfulCallAt}))}));
    await act(async () => {render(<DesktopWorkspaceProvider><SettingsView lang="en" currentTheme="light" onLanguageChange={()=>{}} onThemeChange={()=>{}}/></DesktopWorkspaceProvider>);});
    const port = screen.getByRole('button',{name:'Save Port'}).closest('form')!.querySelector('input')!;
    const name = screen.getByPlaceholderText('Connection Name (e.g. Work Laptop Cursor)');
    fireEvent.change(port,{target:{value:'32001'}});
    fireEvent.change(name,{target:{value:'Unsaved connection'}});
    timestamp = 1791388800000;
    await act(async () => {fireEvent.focus(window);});
    await waitFor(() => assert.ok(screen.getByText(new Date(timestamp!).toLocaleString())));
    timestamp += 1000;
    await waitFor(() => assert.ok(screen.getByText(new Date(timestamp!).toLocaleString())),{timeout:3500});
    assert.equal(port.value,'32001');
    assert.equal((name as HTMLInputElement).value,'Unsaved connection');
  });

  it('refreshes external pause changes while retaining visible metadata on a failed config read', async () => {
    const initial = await mcpApi.getConfig();
    let config = {...initial,accessRevision:1,aiAccessPaused:false};
    let failed = false;
    mock.method(api, 'getBusinessVersions', async () => ({approvals:0}) as any);
    mock.method(mcpApi, 'getConfig', async () => {if(failed)throw new Error('Synthetic read failure');return config;});
    mock.method(mcpApi, 'getStatus', async () => ({state:'ready',listeningPort:30138,aiAccessPaused:config.aiAccessPaused}) as any);
    await act(async () => {render(<DesktopWorkspaceProvider><SettingsView lang="en" currentTheme="light" onLanguageChange={()=>{}} onThemeChange={()=>{}}/></DesktopWorkspaceProvider>);});
    config = {...config,accessRevision:2,aiAccessPaused:true};
    await act(async () => {fireEvent.focus(window);});
    await waitFor(() => assert.ok(screen.getByRole('button',{name:'Resume Access'})));
    failed = true;
    await act(async () => {fireEvent.focus(window);});
    assert.ok(screen.getByRole('button',{name:'Resume Access'}));
    assert.ok(screen.getByText('Claude Desktop'));
  });

  it('does not apply late call metadata from a credential that rotated during refresh', {timeout:10000}, async () => {
    const initial = await mcpApi.getConfig();
    let config = {...initial, clients:initial.clients.map(client=>({...client,credentialVersion:1}))};
    let release!: (value:any)=>void;
    let defer = false;
    mock.method(api, 'getBusinessVersions', async () => ({approvals:0}) as any);
    mock.method(mcpApi, 'getConfig', async () => defer ? new Promise(resolve=>{release=resolve;}) : config);
    mock.method(mcpApi, 'rotateClient', async (id:string) => {
      config = {...config,clients:config.clients.map(client=>client.id===id?{...client,credentialVersion:2,token:'rotated-token',lastSuccessfulCallAt:null}:client)};
      defer = false;
      return {client:config.clients.find(client=>client.id===id)!};
    });
    await act(async () => {render(<DesktopWorkspaceProvider><SettingsView lang="en" currentTheme="light" onLanguageChange={()=>{}} onThemeChange={()=>{}}/></DesktopWorkspaceProvider>);});
    const stale = {...config,clients:config.clients.map(client=>client.id==='claude-desktop'?{...client,lastSuccessfulCallAt:1791388800000}:client)};
    defer = true;
    fireEvent.focus(window);
    await waitFor(() => assert.equal(typeof release,'function'));
    assert.equal(typeof release,'function');
    // Rotation loads the replacement connection while the old background read remains outstanding.
    await act(async () => {fireEvent.click(screen.getAllByRole('button',{name:'Rotate'})[0]);});
    if (release) await act(async () => {release(stale);});
    assert.equal(screen.queryByText(new Date(1791388800000).toLocaleString()),null);
  });
  it('previews v1 partial and v2/v3/v4 complete migrations without restoring on file selection', async () => {
    const {DatabaseSync}=await import('node:sqlite');
    const {CatalogStore}=await import('../packages/database/src/store.ts');
    const {waitFor}=await import('@testing-library/react');
    const store=new CatalogStore(new DatabaseSync(':memory:'),{skipBackup:true});
    let restores=0;
    mock.method(api,'importBundle',async()=>{restores++;return {} as any;});
    try {
      await act(async()=>{render(<DesktopWorkspaceProvider><SettingsView lang="en" currentTheme="light" onLanguageChange={()=>{}} onThemeChange={()=>{}}/></DesktopWorkspaceProvider>);});
      const input=document.querySelector<HTMLInputElement>('input[type="file"][accept=".json"]') ?? [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(item=>item.accept.includes('json'))!;
      assert.ok(input);
      for(const version of [1,2,3,4] as const) {
        const bundle=version===1?store.exportSnapshotBundle():store.exportMigrationBundle(version);
        const file=new dom.window.File([JSON.stringify(bundle)],`bundle-v${version}.json`,{type:'application/json'});
        fireEvent.change(input,{target:{files:[file]}});
        await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Confirm & Restore'})),{timeout:5000});
        if(version===1)assert.ok(screen.getByText(/Legacy v1: partial restore/));
        else {
          assert.ok(screen.getByText(new RegExp(`Complete migration.*Bundle v${version}.*App v${'appVersion' in bundle ? bundle.appVersion : ''}`)));
          assert.equal(screen.queryByText(/Legacy v1/),null);
        }
        assert.equal(restores,0);
        fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
      }
    } finally {store.db.close();}
  });
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
    mock.method(mcpApi, 'listPendingOperations', async () => ({ operations: [] }));
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
    assert.ok(screen.getByText('Plugin / AI 连接'));
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
    assert.ok(screen.getByText('Plugin / AI Connection'));
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

  it('switches client connection mode and displays full access boundary badge', async () => {
    let updatedId = '';
    let updatedMode = '';

    mock.method(mcpApi, 'updateClientMode', async (id: string, mode: any) => {
      updatedId = id;
      updatedMode = mode;
      return { client: { id, name: 'Claude Desktop', token: 'tok', createdAt: 1, lastSuccessfulCallAt: null, revoked: false, mode } };
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

    const modeSelects = screen.getAllByLabelText(/访问权限/);
    assert.ok(modeSelects.length >= 1);

    await act(async () => {
      fireEvent.change(modeSelects[0], { target: { value: 'full_access' } });
    });

    assert.equal(updatedId, 'claude-desktop');
    assert.equal(updatedMode, 'full_access');
    assert.ok(screen.getByText('仅 Tracker 练习、笔记和计划'));
  });

  it('displays pending approvals and supports Proceed and Reject actions', async () => {
    let proceedCalled = '';
    let rejectCalled = '';

    mock.method(mcpApi, 'listPendingOperations', async () => ({
      operations: [
        {
          id: 'op-test-123',
          clientId: 'claude-desktop',
          toolName: 'tracker_create_practice',
          fingerprint: 'fp-123',
          status: 'pending',
          reviewState: 'complete',
          preview: {action:'create_practice',target:'Problem 1',libraryGeneration:1,changes:[
            {label:'Note text',before:'Original synthetic text',after:'Edited synthetic text'},
            {label:'Replace problem 2',before:{problemId:'2'},after:{problemId:'7'}},
          ],cascades:[{recordId:'practice-cascade-1',revision:3}],planDate:'2026-10-01',timezone:'UTC'},
          summaryJson: JSON.stringify({
            action: 'create_practice',
            target: 'Problem 1: Two Sum',
            diffSummary: 'Record practice for problem 1 (Completed) at 2026-10-01.',
            riskLevel: 'medium',
            reviewReason: 'Automated logging verification required',
          }),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: Date.now() + 25 * 60 * 1000,
        },
      ],
    }));

    mock.method(mcpApi, 'proceedOperation', async (id: string) => {
      proceedCalled = id;
      return { status: 'applied' };
    });

    mock.method(mcpApi, 'rejectOperation', async (id: string) => {
      rejectCalled = id;
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

    assert.ok(screen.getByText('待批准操作 (Pending Approvals)'));
    assert.ok(screen.getByText('tracker_create_practice'));
    assert.ok(screen.getByText(/Problem 1: Two Sum/));
    assert.ok(screen.getByText(/Record practice for problem 1/));
    assert.ok(screen.getByText('Risk: medium'));
    assert.ok(screen.getByText('Original synthetic text'));
    assert.ok(screen.getByText('Edited synthetic text'));
    assert.ok(screen.getByText('Replace problem 2'));
    assert.ok(screen.getByText(/practice-cascade-1/));
    assert.ok(screen.getByText(/Automated logging verification required/));

    const proceedBtn = screen.getByText('批准 (Proceed)');
    await act(async () => {
      fireEvent.click(proceedBtn);
    });
    assert.equal(proceedCalled, 'op-test-123');

    const rejectBtn = screen.getByText('拒绝 (Reject)');
    await act(async () => {
      fireEvent.click(rejectBtn);
    });
    assert.equal(rejectCalled, 'op-test-123');
  });
});

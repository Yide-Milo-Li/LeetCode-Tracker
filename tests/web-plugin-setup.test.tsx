/** Synthetic native-bridge tests protect setup consent, recovery, credential isolation and fresh-call proof. */
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
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
Object.defineProperty(navigator, 'platform', {
  configurable: true,
  value: 'Win32',
});
const React = await import('react');
const { render, fireEvent, screen, act, cleanup, waitFor } = await import(
  '@testing-library/react'
);
const { TunnelSettings } = await import(
  '../apps/web/src/components/TunnelSettings.tsx'
);
const { tunnelApi, hasFreshHostCall, pluginSetupLinks } = await import(
  '../apps/web/src/platform/plugin-setup.ts'
);
const { mcpApi } = await import('../apps/web/src/api.ts');
import type { TunnelStatus } from '../apps/web/src/platform/plugin-setup.ts';
import type { McpClientMode, McpSettingsConfig } from '../apps/web/src/api.ts';
let index = 0;
let status: TunnelStatus;
let config: McpSettingsConfig;
let commands: { command: string; args: unknown }[];
const grant = {
  id: 'chosen',
  name: 'ChatGPT',
  token: 'synthetic-token-only',
  createdAt: 1,
  credentialVersion: 1,
  revoked: false,
  mode: 'read_only' as const,
  lastSuccessfulCallAt: null as number | null,
};
function Harness({ lang = 'en' }: { lang?: 'en' | 'zh' }) {
  const [value, setValue] = React.useState(config);
  return (
    <TunnelSettings
      lang={lang}
      config={value}
      runtime={{
        state: 'ready',
        configuredPort: 30138,
        listeningPort: 30138,
        restartRequired: false,
        aiAccessPaused: value.aiAccessPaused,
        errorCode: null,
      }}
      onConfig={setValue}
    />
  );
}
describe('ChatGPT connection setup', () => {
  beforeEach(() => {
    commands = [];
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          commands.push({ command, args });
        },
      },
    });
    config = {
      schemaVersion: 3,
      accessRevision: 1,
      port: 30138,
      connection: {
        configPath: `C:/synthetic-library-${++index}/mcp-config.json`,
        nodePath: 'C:/private/node.exe',
        proxyPath: 'C:/private/proxy.mjs',
      },
      clients: [],
      aiAccessPaused: true,
      reviewModel: null,
    };
    status = {
      state: 'disabled',
      code: null,
      ready: false,
      configuration: { enabled: false, tunnelId: '', clientId: '' },
      credentialSaved: false,
      credentialPending: false,
      verification: null,
    };
    mock.method(tunnelApi, 'status', async () => structuredClone(status));
    mock.method(tunnelApi, 'promptKey', async () => {
      status.credentialPending = true;
      return true;
    });
    mock.method(mcpApi, 'createClient', async () => ({ client: { ...grant } }));
    mock.method(mcpApi, 'updateConfig', async (patch: object) => {
      config = { ...config, ...patch };
      return config;
    });
  });
  afterEach(() => {
    cleanup();
    mock.reset();
  });

  it('creates one connection, stages a key, and requires explicit global resume before enabling', async () => {
    let creations = 0,
      saved = 0,
      resumed = 0;
    mock.method(mcpApi, 'createClient', async () => {
      creations++;
      config = { ...config, clients: [{ ...grant }] };
      return { client: { ...grant } };
    });
    mock.method(
      tunnelApi,
      'save',
      async (configuration: any, reuse: boolean) => {
        saved++;
        assert.equal(reuse, false);
        status = {
          ...status,
          configuration,
          credentialSaved: true,
          credentialPending: false,
          verification: {
            clientId: grant.id,
            credentialVersion: 1,
            startedAt: 100,
          },
        };
      },
    );
    mock.method(mcpApi, 'updateConfig', async (patch: any) => {
      resumed++;
      config = { ...config, ...patch };
      return config;
    });
    await act(async () => {
      render(<Harness />);
    });
    assert.equal(
      (
        screen.getByRole('combobox', {
          name: 'Access mode',
        }) as HTMLSelectElement
      ).value,
      'read_only',
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Create dedicated ChatGPT connection',
        }),
      );
    });
    assert.equal(creations, 1);
    assert.equal(
      (
        screen.getByRole('button', {
          name: 'Create dedicated ChatGPT connection',
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: /Connection details/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Tunnel ID' }), {
      target: { value: 'tunnel_synthetic' },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Enter runtime key' }),
      );
    });
    assert.equal(document.querySelector('input[type=password]'), null);
    fireEvent.click(screen.getByRole('button', { name: /Enable & check/ }));
    assert.equal(
      (
        screen.getByRole('button', {
          name: 'Save and enable connection',
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
    assert.equal(saved, 0);
    assert.equal(resumed, 0);
    fireEvent.click(screen.getByRole('checkbox', { name: /Resume global/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Save and enable connection' }),
      );
    });
    assert.equal(saved, 1);
    assert.equal(resumed, 1);
    assert.ok(screen.getByText(/waiting for a new call/));
    assert.ok(!document.body.textContent!.includes('synthetic-token-only'));
  });

  it('restores the bound grant, requires changed-Tunnel key consent, and keeps input through polling and remount', async () => {
    config = { ...config, clients: [{ ...grant }], aiAccessPaused: false };
    status = {
      ...status,
      configuration: {
        enabled: true,
        tunnelId: 'tunnel_old',
        clientId: grant.id,
      },
      credentialSaved: true,
    };
    const first = render(<Harness />);
    await waitFor(() => assert.ok(screen.getByText('tunnel_old')));
    fireEvent.click(screen.getByRole('button', { name: /Connection details/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Tunnel ID' }), {
      target: { value: 'tunnel_new' },
    });
    await act(async () => {
      fireEvent.focus(window);
    });
    assert.equal(
      (screen.getByRole('textbox', { name: 'Tunnel ID' }) as HTMLInputElement)
        .value,
      'tunnel_new',
    );
    fireEvent.click(screen.getByRole('button', { name: /Enable & check/ }));
    assert.equal(
      (
        screen.getByRole('button', {
          name: 'Save and enable connection',
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: /Connection details/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Confirm reuse/ }));
    fireEvent.click(screen.getByRole('button', { name: /Enable & check/ }));
    assert.equal(
      (
        screen.getByRole('button', {
          name: 'Save and enable connection',
        }) as HTMLButtonElement
      ).disabled,
      false,
    );
    first.unmount();
    await act(async () => {
      render(<Harness />);
    });
    fireEvent.click(screen.getByRole('button', { name: /Connection details/ }));
    assert.equal(
      (screen.getByRole('textbox', { name: 'Tunnel ID' }) as HTMLInputElement)
        .value,
      'tunnel_new',
    );
    assert.equal(
      (
        screen.getByRole('checkbox', {
          name: /Confirm reuse/,
        }) as HTMLInputElement
      ).checked,
      false,
    );
  });

  it('cancelled native entry and failed save retain the existing configuration and do not resume access', async () => {
    config = { ...config, clients: [{ ...grant }] };
    status = {
      ...status,
      configuration: {
        enabled: true,
        tunnelId: 'tunnel_old',
        clientId: grant.id,
      },
      credentialSaved: true,
    };
    mock.method(tunnelApi, 'promptKey', async () => false);
    mock.method(tunnelApi, 'save', async () => {
      throw 'TUNNEL_CONFIG_WRITE_FAILED';
    });
    let resumed = 0;
    mock.method(mcpApi, 'updateConfig', async () => {
      resumed++;
      return config;
    });
    await act(async () => {
      render(<Harness />);
    });
    fireEvent.click(screen.getByRole('button', { name: /Connection details/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Replace runtime key' }),
      );
    });
    assert.equal(status.credentialPending, false);
    assert.equal(status.configuration.tunnelId, 'tunnel_old');
    fireEvent.click(screen.getByRole('button', { name: /Enable & check/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Resume global/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Save and enable connection' }),
      );
    });
    assert.ok(screen.getByText(/previous configuration is retained/));
    assert.equal(resumed, 0);
    assert.equal(status.configuration.tunnelId, 'tunnel_old');
  });

  it('keeps the created grant after a mode-save failure and requires an explicit retry', async () => {
    let creations = 0,
      changes = 0;
    mock.method(mcpApi, 'createClient', async () => {
      creations++;
      return { client: { ...grant } };
    });
    mock.method(mcpApi, 'updateClientMode', async (_id: string, mode: McpClientMode) => {
      changes++;
      if (changes === 1) throw new Error('synthetic permission save failure');
      return { client: { ...grant, mode } };
    });
    await act(async () => {
      render(<Harness />);
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Access mode' }), {
      target: { value: 'model_review' },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Create dedicated ChatGPT connection',
        }),
      );
    });
    assert.equal(creations, 1);
    assert.equal(
      (
        screen.getByRole('button', {
          name: 'Create dedicated ChatGPT connection',
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
    assert.ok(screen.getByRole('button', { name: 'Save access mode' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save access mode' }));
    });
    assert.equal(creations, 1);
    assert.equal(changes, 2);
    assert.ok(screen.getByText('Connection access mode saved.'));
  });

  it('restores progress after Settings starts with an asynchronously loaded configuration', async () => {
    const first = render(<Harness />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Connection details/ }),
      );
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Tunnel ID' }), {
      target: { value: 'tunnel_unsaved' },
    });
    first.unmount();
    const loading = render(
      <TunnelSettings
        lang="en"
        config={null}
        runtime={null}
        onConfig={() => {}}
      />,
    );
    assert.ok(screen.getByText('Loading connection settings…'));
    await act(async () => {
      loading.rerender(
        <TunnelSettings
          lang="en"
          config={config}
          runtime={null}
          onConfig={() => {}}
        />,
      );
    });
    assert.equal(
      (screen.getByRole('textbox', { name: 'Tunnel ID' }) as HTMLInputElement)
        .value,
      'tunnel_unsaved',
    );
  });

  it('opens fixed official destinations and never sends credentials or filenames to the bridge', async () => {
    await act(async () => {
      render(<Harness lang="zh" />);
    });
    fireEvent.click(screen.getByRole('button', { name: /官方连接/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '打开 Tunnel 管理' }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: '打开 API 密钥页面' }),
      );
    });
    assert.deepEqual(commands, [
      { command: 'open_external', args: { url: pluginSetupLinks.tunnels } },
      { command: 'open_external', args: { url: pluginSetupLinks.keys } },
    ]);
    assert.equal(screen.queryByPlaceholderText(/C:\\/), null);
    fireEvent.click(screen.getByRole('button', { name: /Plugin 与验证/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: '打开 ChatGPT Plugins' }),
      );
    });
    assert.deepEqual(commands.at(-1), {
      command: 'open_external',
      args: { url: pluginSetupLinks.plugins },
    });
  });

  it('does not count history, a different grant, rotated credentials, paused readiness or health checks as fresh proof', () => {
    const current = { ...grant, lastSuccessfulCallAt: 99 };
    const checked = {
      ...status,
      ready: true,
      configuration: {
        enabled: true,
        tunnelId: 'tunnel_synthetic',
        clientId: grant.id,
      },
      verification: {
        clientId: grant.id,
        credentialVersion: 1,
        startedAt: 100,
      },
    };
    assert.equal(hasFreshHostCall(checked, current), false);
    assert.equal(
      hasFreshHostCall(checked, { ...current, lastSuccessfulCallAt: 101 }),
      true,
    );
    assert.equal(
      hasFreshHostCall(checked, {
        ...current,
        id: 'other',
        lastSuccessfulCallAt: 101,
      }),
      false,
    );
    assert.equal(
      hasFreshHostCall(checked, {
        ...current,
        credentialVersion: 2,
        lastSuccessfulCallAt: 101,
      }),
      false,
    );
    assert.equal(
      hasFreshHostCall(checked, {
        ...current,
        revoked: true,
        lastSuccessfulCallAt: 101,
      }),
      false,
    );
    assert.equal(
      hasFreshHostCall(
        { ...checked, ready: false },
        { ...current, lastSuccessfulCallAt: 101 },
      ),
      false,
    );
    assert.equal(
      hasFreshHostCall(
        { ...checked, verification: null },
        { ...current, lastSuccessfulCallAt: 101 },
      ),
      false,
    );
  });
});

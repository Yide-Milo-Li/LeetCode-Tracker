/** Guided ChatGPT setup; credentials stay in native code and account steps use official destinations. */
import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { isTauri, openExternalUrl } from '../platform/index.ts';
import {
  mcpApi,
  type McpClientMode,
  type McpSettingsConfig,
  type McpStatus,
} from '../api.ts';
import {
  hasFreshHostCall,
  pluginSetupLinks,
  tunnelApi,
  type TunnelStatus,
} from '../platform/plugin-setup.ts';
import { Feedback } from '../../../../packages/workspace/src/components/ui.tsx';

type Draft = {
  step: number;
  clientId: string;
  tunnelId: string;
  mode: McpClientMode;
};
// Non-secret drafts survive Settings unmounts and are isolated by the owning library configuration.
const drafts = new Map<string, Draft>();
const steps = [
  ['Access', '访问权限'],
  ['Official setup', '官方连接'],
  ['Connection details', '连接信息'],
  ['Enable & check', '启用并检查'],
  ['Plugin & verification', 'Plugin 与验证'],
];

/** Safe codes map to recovery advice; raw native output never becomes UI copy. */
export function tunnelRecovery(code: string, zh: boolean): string {
  const messages: Record<string, [string, string]> = {
    TUNNEL_KEY_INVALID: [
      'Invalid key format. Enter a key starting with sk-, without spaces.',
      '密钥格式无效。请重新录入以 sk- 开头且不含空格的运行密钥。',
    ],
    TUNNEL_KEY_MISSING: [
      'No runtime key is saved. Enter a key first.',
      '尚未保存运行密钥。请先录入密钥。',
    ],
    TUNNEL_KEY_REUSE_REQUIRED: [
      'The Tunnel changed. Confirm reuse of the saved key or enter a new key.',
      'Tunnel 已更改。请确认沿用现有密钥，或录入新密钥。',
    ],
    TUNNEL_AUTHENTICATION_FAILED: [
      'Authentication failed. Check the key, organization and Tunnels Read + Use permissions; diagnostics cannot identify which failed.',
      '认证失败。请核对密钥、对应组织以及 Tunnels Read + Use 权限；当前诊断无法确定是哪一项。',
    ],
    TUNNEL_ACCESS_PAUSED: [
      'External AI access is paused. Explicitly resume access before connecting.',
      '外部 AI 访问已暂停。明确恢复访问后再连接。',
    ],
    TUNNEL_GRANT_REVOKED: [
      'The connection is revoked or missing. Select an active connection or create one.',
      '专用连接已撤销或不存在。请选择有效连接，或创建新连接。',
    ],
    TUNNEL_RUNTIME_UNAVAILABLE: [
      'The local service is not ready. Check Runtime and the listening port, then retry.',
      '本地服务尚未就绪。检查 Runtime 状态和监听端口，再重试。',
    ],
    TUNNEL_RETRY_LIMIT: [
      'Retries reached their limit. Check network, key and permissions, then retry.',
      '自动重试已达到上限。检查网络、密钥和权限后点击重试连接。',
    ],
    TUNNEL_ACL_FAILED: [
      'Cannot protect app-data storage. Check current-user permissions and retry.',
      '无法保护应用数据目录。检查当前用户的目录权限后重试。',
    ],
    TUNNEL_CONFIG_WRITE_FAILED: [
      'Cannot save configuration. Check app-data permissions and retry; the previous configuration is retained.',
      '无法保存配置。检查应用数据目录权限后重试；原配置保留。',
    ],
    TUNNEL_CONFIG_INVALID: [
      'Invalid configuration. Check the Tunnel ID and dedicated connection.',
      '连接配置无效。请检查 Tunnel ID 和专用连接。',
    ],
    TUNNEL_KEY_DIALOG_FAILED: [
      'Cannot open native key entry. Retry, or import an existing key file in advanced options.',
      '无法打开原生密钥输入框。请重试，或在高级选项中导入已有密钥文件。',
    ],
  };
  return (
    messages[code]?.[zh ? 1 : 0] ??
    (zh
      ? '操作未完成。检查本地服务、网络及官方账号配置后重试；可运行诊断。'
      : 'The operation did not complete. Check local service, network and official account setup, then retry or run diagnostics.')
  );
}

type SetupProps = {
  lang: 'en' | 'zh';
  config: McpSettingsConfig | null;
  runtime: McpStatus | null;
  onConfig: (config: McpSettingsConfig) => void;
};

/** Mount drafts only after the owning library is known; asynchronous Settings loading must not lose progress. */
export function TunnelSettings(props: SetupProps) {
  if (!props.config)
    return (
      <p role="status">
        {props.lang === 'zh'
          ? '正在读取连接设置…'
          : 'Loading connection settings…'}
      </p>
    );
  return <TunnelSetup key={props.config.connection?.configPath ?? 'source'} {...props} />;
}

function TunnelSetup({ lang, config, runtime, onConfig }: SetupProps) {
  const zh = lang === 'zh',
    supported = isTauri() && /Win/.test(navigator.platform);
  const library = config?.connection?.configPath ?? 'source',
    previous = drafts.get(library);
  const [draft, setDraft] = useState<Draft>(
    () =>
      previous ?? { step: 0, clientId: '', tunnelId: '', mode: 'read_only' },
  );
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [resume, setResume] = useState(false),
    [reuse, setReuse] = useState(false);
  const hydrated = useRef(false),
    edited = useRef(false),
    working = useRef(false),
    active = useRef(true);
  const update = (patch: Partial<Draft>) => {
    edited.current = true;
    setDraft((value) => ({ ...value, ...patch }));
  };
  useEffect(() => {
    if (config) drafts.set(library, draft);
  }, [library, draft, Boolean(config)]);
  useEffect(() => {
    active.current = true;
    if (!supported || !config)
      return () => {
        active.current = false;
      };
    let checking = false;
    const refresh = async () => {
      if (checking || working.current || document.visibilityState === 'hidden')
        return;
      checking = true;
      try {
        const next = await tunnelApi.status();
        if (!active.current) return;
        setStatus((value) =>
          (value?.verification?.startedAt ?? 0) >
          (next.verification?.startedAt ?? 0)
            ? value
            : next,
        );
        if (!hydrated.current) {
          hydrated.current = true;
          if (!previous && !edited.current) {
            const binding = next.configuration;
            setDraft((value) => ({
              ...value,
              clientId: binding.clientId,
              tunnelId: binding.tunnelId,
              mode:
                config.clients.find((c) => c.id === binding.clientId)?.mode ??
                'read_only',
              step: binding.tunnelId && next.credentialSaved ? 3 : 0,
            }));
          }
        }
      } catch {
        if (active.current)
          setError(tunnelRecovery('TUNNEL_RUNTIME_UNAVAILABLE', zh));
      } finally {
        checking = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active.current = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [supported, library, Boolean(config)]);
  const client = config?.clients.find(
    (c) => c.id === draft.clientId && !c.revoked,
  );
  const bound = config?.clients.find(
    (c) => c.id === status?.configuration.clientId,
  );
  const unchanged = Boolean(
    status &&
      status.configuration.clientId === draft.clientId &&
      status.configuration.tunnelId === draft.tunnelId.trim(),
  );
  const fresh =
    unchanged && !config?.aiAccessPaused && hasFreshHostCall(status, bound);
  const changedTunnel = Boolean(
    status?.configuration.tunnelId &&
      status.configuration.tunnelId !== draft.tunnelId.trim(),
  );
  const perform = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      if (supported && active.current) setStatus(await tunnelApi.status());
    } catch (e) {
      if (active.current)
        setError(
          tunnelRecovery(
            typeof e === 'string' ? e : e instanceof Error ? e.message : '',
            zh,
          ),
        );
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  const create = () =>
    perform(async () => {
      const { client: created } = await mcpApi.createClient('ChatGPT');
      // Retain the ID before subsequent requests so retry never creates another grant.
      update({ clientId: created.id });
      onConfig({ ...config!, clients: [...config!.clients, created] });
      if (draft.mode !== created.mode) {
        const { client: updated } = await mcpApi.updateClientMode(
          created.id,
          draft.mode,
        );
        onConfig({ ...config!, clients: [...config!.clients, updated] });
      }
      setMessage(zh ? '已创建专用连接。' : 'Dedicated connection created.');
    });
  const save = () =>
    perform(async () => {
      if (!client || !config) return;
      await tunnelApi.save(
        { enabled: true, tunnelId: draft.tunnelId.trim(), clientId: client.id },
        reuse,
      );
      // Global resume is authorized by the adjacent checkbox, never by saving configuration alone.
      if (config.aiAccessPaused && resume) {
        const resumed = await mcpApi.updateConfig({ aiAccessPaused: false });
        onConfig(resumed);
      }
      setReuse(false);
      setResume(false);
      update({ step: 4 });
      setMessage(
        zh
          ? '配置已保存。正在检查后台连接；宿主调用尚待验证。'
          : 'Configuration saved. Checking background access; host calls still need verification.',
      );
    });
  const link = (url: string, label: string) => (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={busy}
      onClick={() =>
        void perform(async () => {
          await openExternalUrl(url);
        })
      }
    >
      <ExternalLink size={14} aria-hidden="true" />
      {label}
    </button>
  );
  const labels = steps.map((s) => s[zh ? 1 : 0]),
    text = (en: string, cn: string) => (zh ? cn : en);
  return (
    <section
      className="tunnel-settings"
      aria-label={text('Connect ChatGPT', '连接 ChatGPT')}
    >
      <div className="plugin-hosts">
        <strong>{text('ChatGPT connection setup', 'ChatGPT 连接向导')}</strong>
        <span className="muted">
          {text(
            'Codex / DSH automatic setup: planned. Manual setup remains below.',
            'Codex / DSH 自动配置：待办；下方保留手动接入。',
          )}
        </span>
      </div>
      {!supported ? (
        <>
          <p>
            {text(
              'Managed setup requires LCT for Windows. Prepare your official account here; manual setup is in advanced options.',
              '托管连接向导需要 Windows 桌面版 LCT。当前环境可准备官方账号；手动接入位于高级选项。',
            )}
          </p>
          <div className="settings-actions">
            {link(
              pluginSetupLinks.tunnels,
              text('Open Tunnel settings', '打开 Tunnel 管理'),
            )}
            {link(
              pluginSetupLinks.tunnelGuide,
              text('Official Tunnel guide', '官方 Tunnel 说明'),
            )}
          </div>
        </>
      ) : (
        <>
          <nav
            className="plugin-steps"
            aria-label={text('Setup steps', '连接步骤')}
          >
            {labels.map((label, step) => (
              <button
                type="button"
                key={step}
                aria-current={draft.step === step ? 'step' : undefined}
                disabled={busy}
                onClick={() => update({ step })}
              >
                <span>{step + 1}</span>
                {label}
              </button>
            ))}
          </nav>
          {error && <Feedback tone="error">{error}</Feedback>}
          {message && <p role="status">{message}</p>}
          <div className="plugin-step-body">
            <h3>{labels[draft.step]}</h3>
            {draft.step === 0 && (
              <>
                <p className="muted">
                  {text(
                    'Use a dedicated ChatGPT connection and choose what it can read or change.',
                    '为 ChatGPT 使用专用连接，选择它能访问和修改的内容。',
                  )}
                </p>
                <label className="form-field">
                  <span>{text('Access mode', '访问模式')}</span>
                  <select
                    disabled={busy}
                    value={draft.mode}
                    onChange={(e) =>
                      update({ mode: e.target.value as McpClientMode })
                    }
                  >
                    <option value="read_only">
                      {text('Read only (default)', '只读（默认）')}
                    </option>
                    <option value="model_review">
                      {text('Model review', '模型审核')}
                    </option>
                    <option value="full_access">Full access</option>
                  </select>
                </label>
                <p>
                  {draft.mode === 'read_only'
                    ? text(
                        'Read problems, plans, notes and progress without changing study data.',
                        '检索题目、计划、笔记和进度，不修改学习数据。',
                      )
                    : draft.mode === 'model_review'
                      ? text(
                          'Writes are reviewed by a model, with your confirmation when needed.',
                          '写入先由审核模型评估，必要时由你确认。',
                        )
                      : text(
                          'Allow supported Tracker practice, note and plan writes; operations requiring confirmation still ask you.',
                          '允许 Tracker 支持的练习、笔记和计划写入；覆盖等需要确认的操作仍由你确认。',
                        )}
                </p>
                {draft.mode === 'model_review' && (
                  <a
                    href="#plugin-review-model"
                    onClick={(e) => {
                      e.preventDefault();
                      document
                        .getElementById('plugin-review-model')
                        ?.scrollIntoView({ block: 'center' });
                      document
                        .getElementById('plugin-review-model')
                        ?.querySelector('select')
                        ?.focus();
                    }}
                  >
                    {text(
                      'Go to operation review settings',
                      '前往写入审核模型设置',
                    )}
                  </a>
                )}
                <label className="form-field">
                  <span>{text('Dedicated connection', '专用连接')}</span>
                  <select
                    disabled={busy}
                    value={draft.clientId}
                    onChange={(e) => {
                      const selected = config?.clients.find(
                        (c) => c.id === e.target.value,
                      );
                      update({
                        clientId: e.target.value,
                        mode: selected?.mode ?? draft.mode,
                      });
                    }}
                  >
                    <option value="">
                      {text(
                        'Create or select a connection',
                        '创建新连接或选择已有连接',
                      )}
                    </option>
                    {config?.clients
                      .filter((c) => !c.revoked)
                      .map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !config || Boolean(client)}
                  onClick={() => void create()}
                >
                  {text(
                    'Create dedicated ChatGPT connection',
                    '创建 ChatGPT 专用连接',
                  )}
                </button>
                {client && client.mode !== draft.mode && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const { client: updated } =
                          await mcpApi.updateClientMode(client.id, draft.mode);
                        onConfig({
                          ...config!,
                          clients: config!.clients.map((c) =>
                            c.id === updated.id ? updated : c,
                          ),
                        });
                        setMessage(
                          text(
                            'Connection access mode saved.',
                            '连接访问模式已保存。',
                          ),
                        );
                      })
                    }
                  >
                    {text('Save access mode', '保存访问模式')}
                  </button>
                )}
              </>
            )}
            {draft.step === 1 && (
              <>
                <p>
                  {text(
                    'Create or select a Tunnel in Platform, associate the intended ChatGPT workspace, and copy its Tunnel ID.',
                    '在 Platform 创建或选择 Tunnel，关联你将在 ChatGPT 使用的工作区，复制 Tunnel ID。',
                  )}
                </p>
                <div className="settings-actions">
                  {link(
                    pluginSetupLinks.tunnels,
                    text('Open Tunnel settings', '打开 Tunnel 管理'),
                  )}
                  {link(
                    pluginSetupLinks.keys,
                    text('Open API keys', '打开 API 密钥页面'),
                  )}
                </div>
                <p className="muted">
                  {text(
                    'Creating a Tunnel requires Tunnels Read + Manage; running it requires Tunnels Read + Use in its organization. Use a key belonging to that organization, separate from LCT model settings.',
                    '创建 Tunnel 需要 Tunnels Read + Manage；运行连接需要对应组织的 Tunnels Read + Use。密钥应属于该组织，与 LCT 内的模型密钥设置分开。',
                  )}
                </p>
                <p className="muted">
                  {text(
                    'Permission to add custom MCP servers is managed separately by the ChatGPT workspace. If the Tunnel is missing, check workspace association and Use permission. Return to enter the ID and key.',
                    'ChatGPT 添加自定义 MCP 的权限由目标工作区单独管理。Tunnel 不可见时，检查工作区关联及 Use 权限。返回后填入 ID 并录入密钥。',
                  )}
                </p>
                {link(
                  pluginSetupLinks.tunnelGuide,
                  text(
                    'View official permissions and Tunnel guide',
                    '查看官方权限与 Tunnel 说明',
                  ),
                )}
              </>
            )}
            {draft.step === 2 && (
              <>
                <label className="form-field">
                  <span>Tunnel ID</span>
                  <input
                    disabled={busy}
                    value={draft.tunnelId}
                    onChange={(e) => {
                      update({ tunnelId: e.target.value });
                      setReuse(false);
                    }}
                    placeholder="tunnel_…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <p role="status">
                  {status?.credentialPending
                    ? text(
                        'Key staged; save the connection to apply',
                        '密钥已暂存，保存连接后生效',
                      )
                    : status?.credentialSaved
                      ? text('Runtime key saved', '运行密钥已保存')
                      : text('Runtime key not configured', '运行密钥未配置')}
                </p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      if (await tunnelApi.promptKey(lang))
                        setMessage(
                          text(
                            'Key staged. Save the connection to apply it.',
                            '密钥已暂存。保存连接后生效。',
                          ),
                        );
                    })
                  }
                >
                  {status?.credentialSaved
                    ? text('Replace runtime key', '更换运行密钥')
                    : text('Enter runtime key', '录入运行密钥')}
                </button>
                <p className="muted">
                  {text(
                    'LCT opens native password entry and manages required files. No text file or path entry is needed.',
                    'LCT 打开原生密码输入框并管理所需文件；无需创建文本文件或填写路径。',
                  )}
                </p>
                {changedTunnel &&
                  status?.credentialSaved &&
                  !status.credentialPending && (
                    <label className="settings-checkbox">
                      <input
                        disabled={busy}
                        type="checkbox"
                        checked={reuse}
                        onChange={(e) => setReuse(e.target.checked)}
                      />
                      {text(
                        'Confirm reuse of the saved runtime key for the changed Tunnel',
                        '确认更改 Tunnel 后沿用已保存的运行密钥',
                      )}
                    </label>
                  )}
                <details>
                  <summary>
                    {text(
                      'Advanced: import an existing key file',
                      '高级：导入已有密钥文件',
                    )}
                  </summary>
                  <p className="muted">
                    {text(
                      'Compatibility import for an existing key file. Native code reads its contents.',
                      '仅用于已有密钥文件的兼容导入。文件内容由原生层读取。',
                    )}
                  </p>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        if (await tunnelApi.importKey())
                          setMessage(
                            text(
                              'Key staged. Save the connection to apply it.',
                              '密钥已暂存。保存连接后生效。',
                            ),
                          );
                      })
                    }
                  >
                    {text('Choose key file', '选择密钥文件')}
                  </button>
                </details>
              </>
            )}
            {draft.step === 3 && (
              <>
                <p>
                  {text(
                    'Save local configuration and enable background access. Closing the window keeps it running; pausing access or quitting LCT stops it.',
                    '保存本地配置并启用后台连接。关闭窗口后连接继续运行；暂停外部访问或退出 LCT 会停止连接。',
                  )}
                </p>
                <dl className="plugin-summary">
                  <dt>Tunnel ID</dt>
                  <dd>{draft.tunnelId || '—'}</dd>
                  <dt>{text('Dedicated connection', '专用连接')}</dt>
                  <dd>{client?.name ?? '—'}</dd>
                  <dt>{text('Access mode', '访问模式')}</dt>
                  <dd>{draft.mode}</dd>
                </dl>
                {config?.aiAccessPaused && (
                  <label className="settings-checkbox">
                    <input
                      disabled={busy}
                      type="checkbox"
                      checked={resume}
                      onChange={(e) => setResume(e.target.checked)}
                    />
                    {text(
                      'Resume global external AI access: other active connections will also regain access.',
                      '恢复全局外部 AI 访问：其他有效连接也将恢复访问。',
                    )}
                  </label>
                )}
                {client && client.mode !== draft.mode && (
                  <p>
                    {text(
                      'Save the access mode in step 1 before enabling this connection.',
                      '请先在步骤 1 保存访问模式，再启用连接。',
                    )}
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    busy ||
                    !client ||
                    client.mode !== draft.mode ||
                    !/^tunnel_[a-zA-Z0-9_]+$/.test(draft.tunnelId.trim()) ||
                    draft.tunnelId.trim().length > 100 ||
                    !(status?.credentialSaved || status?.credentialPending) ||
                    (changedTunnel && !status?.credentialPending && !reuse) ||
                    (config?.aiAccessPaused && !resume)
                  }
                  onClick={() => void save()}
                >
                  {busy
                    ? text('Working…', '处理中…')
                    : text('Save and enable connection', '保存并启用连接')}
                </button>
              </>
            )}
            {draft.step === 4 && (
              <>
                <p>
                  {text(
                    'Open ChatGPT Plugins, find the custom MCP entry, and select Tunnel with the same Tunnel ID. Complete sign-in, permissions and adding the connection on the official page.',
                    '打开 ChatGPT Plugins，进入添加自定义 MCP 的入口，选择 Tunnel 和同一 Tunnel ID。登录、权限及添加操作由你在官方页面完成。',
                  )}
                </p>
                <div className="settings-actions">
                  {link(
                    pluginSetupLinks.plugins,
                    text('Open ChatGPT Plugins', '打开 ChatGPT Plugins'),
                  )}
                  {link(
                    pluginSetupLinks.customMcp,
                    text(
                      'View official connection instructions',
                      '查看官方连接说明',
                    ),
                  )}
                </div>
                <p className="muted">
                  {text(
                    'Ask the intended host: “Read my LCT progress without changing data.” Return here to check. Record Windows desktop and Web verification separately.',
                    '在目标宿主发起只读查询，例如“读取 LCT 的学习进度，不修改数据”。返回这里查看结果。Windows 桌面与 Web 的验证应分别记录。',
                  )}
                </p>
                <ul
                  className="plugin-checks"
                  aria-label={text('Connection checks', '连接检查')}
                >
                  <li>
                    {unchanged && status?.credentialSaved && (
                      <Check size={16} aria-hidden="true" />
                    )}
                    {text('Local configuration', '本地配置')}:{' '}
                    {unchanged && status?.credentialSaved
                      ? text('saved', '已保存')
                      : text('not saved', '待保存')}
                  </li>
                  <li>
                    {text('Local service', '本地服务')}:{' '}
                    {runtime?.state === 'ready'
                      ? text('ready', '就绪')
                      : text(
                          'unavailable; check Runtime / port',
                          '不可用，请检查 Runtime / 端口',
                        )}
                  </li>
                  <li>
                    {text('External access', '外部访问')}:{' '}
                    {config?.aiAccessPaused
                      ? text('paused', '已暂停')
                      : text('enabled', '已启用')}
                  </li>
                  <li>
                    Tunnel:{' '}
                    {status?.ready
                      ? text('ready', '就绪')
                      : text('not ready', '尚未就绪')}
                  </li>
                  <li>
                    {text('Successful host call', '宿主成功调用')}:{' '}
                    {fresh
                      ? text(
                          'new call received for the current credential',
                          '已收到当前凭证的新调用',
                        )
                      : text(
                          'waiting for a new call on the current connection',
                          '等待当前连接的新调用',
                        )}
                  </li>
                </ul>
                {status?.code && (
                  <Feedback tone="error">
                    {tunnelRecovery(status.code, zh)}
                  </Feedback>
                )}
                <div className="settings-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !status?.configuration.clientId}
                    onClick={() =>
                      void perform(async () => {
                        await tunnelApi.beginVerification();
                        setMessage(
                          text(
                            'A new verification window started. Make a read-only query in the intended host.',
                            '新的验证窗口已开始。请在目标宿主发起只读查询。',
                          ),
                        );
                      })
                    }
                  >
                    {text('Start a new host check', '开始新的宿主验证')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await tunnelApi.diagnose();
                        setMessage(
                          text(
                            'Local diagnostics completed. This does not verify a host call.',
                            '本地诊断已完成。它不代表宿主调用验证通过。',
                          ),
                        );
                      })
                    }
                  >
                    {text('Run diagnostics', '运行诊断')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await tunnelApi.retry();
                      })
                    }
                  >
                    {text('Retry connection', '重试连接')}
                  </button>
                  <button
                    type="button"
                    className="text-link"
                    disabled={busy}
                    onClick={() => update({ step: 2 })}
                  >
                    {text('Check ID or replace key', '检查 ID 或更换密钥')}
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="plugin-navigation">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || draft.step === 0}
              onClick={() => update({ step: draft.step - 1 })}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              {text('Back', '上一步')}
            </button>
            {draft.step < 4 && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || (draft.step === 0 && !client)}
                onClick={() => update({ step: draft.step + 1 })}
              >
                {text('Next', '下一步')}
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

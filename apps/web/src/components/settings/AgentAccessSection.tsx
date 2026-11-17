/** Background runtime, external AI (MCP) access, ChatGPT tunnel and pending agent approvals. */
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  Key,
  Pause,
  Play,
  RefreshCw,
  Server,
  Shield,
  ShieldAlert,
} from 'lucide-react';
import type { McpClientMode } from '../../api.ts';
import type { Language } from '../../i18n.ts';
import { Feedback, InfoPopover } from '../ui.tsx';
import { TunnelSettings } from '../TunnelSettings.tsx';
import type { AgentAccessSettings } from './useAgentAccessSettings.ts';

interface AgentAccessSectionProps {
  lang: Language;
  access: AgentAccessSettings;
  /** Preset models of the active AI provider, offered as operation review models. */
  currentPresetModels: readonly string[];
}

/** Render the agent access rows of the General tab; all state and actions come from the hook. */
export function AgentAccessSection({ lang, access, currentPresetModels }: AgentAccessSectionProps) {
  const zh = lang === 'zh';
  const {
    isDesktop, autostartEnabled, autostartLoading, mcpConfig, setMcpConfig, mcpStatus, mcpError, mcpSuccess,
    copiedTokenId, mcpPortDraft, setMcpPortDraft, savingPort, newClientName, setNewClientName, creatingClient,
    expandedClientId, setExpandedClientId, showTokens, setShowTokens, pendingOperations,
    handleToggleAutostart, handleToggleAiPause, handleSavePort, handleCreateClient, handleRotateClient,
    handleRevokeClient, handleUpdateClientMode, handleSaveReviewModel, handleProceedOperation,
    handleRejectOperation, copyToClipboard,
  } = access;

  return (
    <>
        {/* Background Runtime row */}
        <section className="preference-row">
          <div>
            <h2>{zh ? '后台运行' : 'Background Runtime'}</h2>
            <p className="muted">
              {zh
                ? '开机静默启动与托盘常驻守护，随时为外部 AI 工具响应请求。'
                : 'Headless autostart and system tray daemon for external AI clients.'}
            </p>
            <InfoPopover
              label={zh ? '后台运行说明' : 'Background runtime help'}
              content={
                <div>
                  <p>
                    {zh
                      ? '开启开机自启后，Windows 登录时在后台以 --background 参数静默启动服务，无窗口、无控制台窗口，系统托盘常驻。'
                      : 'When login autostart is enabled, LeetCode Tracker launches headlessly with --background on Windows login without opening a window.'}
                  </p>
                  <p>
                    {zh
                      ? '主窗口关闭时将自动最小化隐藏到系统托盘，后台 HTTP 与 MCP 保持运行；如需完全退出请在托盘菜单点击“退出”。'
                      : 'Closing the main window hides it to the system tray, keeping HTTP and MCP active. Use "Quit" in tray to stop.'}
                  </p>
                </div>
              }
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div
              style={{
                padding: '16px',
                backgroundColor: 'var(--surface-muted)',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                  <Cpu size={18} />
                  <span>{zh ? 'Runtime 状态' : 'Runtime Status'}</span>
                </div>
                <span
                  style={{
                    fontSize: '0.8125rem',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    backgroundColor: 'var(--success-subtle, #e6f4ea)',
                    color: 'var(--success, #137333)',
                    fontWeight: 500,
                  }}
                >
                  {mcpStatus ? (zh ? 'Runtime 已就绪' : 'Runtime ready') : (zh ? 'Runtime 状态未知' : 'Runtime status unknown')}
                </span>
              </div>

              <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                {zh
                  ? '关闭主窗口时自动最小化到系统托盘，持续监听本地 API 与 MCP 请求，不中断正在执行的后台任务。'
                  : 'Closing the window minimizes to system tray. Local API and MCP continue listening in the background.'}
              </p>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingTop: '8px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>
                    {zh ? '开机静默启动' : 'Start Silently on Login'}
                  </div>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                    {isDesktop
                      ? autostartEnabled === null ? (zh ? '自启状态未知' : 'Autostart status unknown') : autostartEnabled
                        ? (zh ? '已启用：开机后无窗口后台常驻' : 'Enabled: Headless tray on system boot')
                        : (zh ? '未启用：仅在手动启动时运行' : 'Disabled: Manual launch only')
                      : (zh ? '当前为浏览器模式，开机自启需在桌面应用中配置' : 'Browser mode: configure autostart in desktop app')}
                  </div>
                </div>
                <button
                  type="button"
                  className={`btn ${autostartEnabled ? 'btn-secondary' : 'btn-primary'} btn-sm`}
                  onClick={() => void handleToggleAutostart()}
                  disabled={!isDesktop || autostartLoading || autostartEnabled === null}
                >
                  {autostartLoading ? '…' : autostartEnabled ? (zh ? '禁用自启' : 'Disable') : (zh ? '启用自启' : 'Enable')}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* AI Connection (MCP) row */}
        <section className="preference-row">
          <div>
            <h2>{zh ? 'Plugin / AI 连接' : 'Plugin / AI Connection'}</h2>
            <p className="muted">
              {zh
                ? '通过连接向导接入 ChatGPT；其他客户端可使用高级手动配置。'
                : 'Connect ChatGPT with guided setup; other clients can use advanced manual configuration.'}
            </p>
            <InfoPopover
              label={zh ? 'AI 连接与安全说明' : 'AI connection & security help'}
              content={
                <div>
                  <p>
                    {zh
                      ? '默认只读。模型审核模式评估写入风险；Full access 允许支持的练习、笔记与计划写入，需确认的操作仍由你确认。'
                      : 'Read only by default. Model review evaluates write risk; Full access permits supported practice, note and plan writes, retaining required confirmations.'}
                  </p>
                  <p>
                    {zh
                      ? '只读查询由外部客户端发起；模型审核与需要 AI 的业务操作会使用 LCT 中配置的提供商。'
                      : 'Read-only queries originate from the external client; model review and AI business actions use the provider configured in LCT.'}
                  </p>
                  <p>
                    {zh
                      ? '支持一键暂停所有外部访问，暂停期间任何工具调用均被拦截并不返回业务数据。'
                      : 'You can pause external access at any time. When paused, all tools return an explicit pause message.'}
                  </p>
                </div>
              }
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <TunnelSettings lang={lang} config={mcpConfig} runtime={mcpStatus} onConfig={setMcpConfig}/>
            {/* Global Pause Card */}
            <div
              style={{
                padding: '16px',
                backgroundColor: mcpConfig?.aiAccessPaused ? 'var(--warning-bg)' : 'var(--surface-muted)',
                borderRadius: '8px',
                border: `1px solid ${mcpConfig?.aiAccessPaused ? 'var(--warning, #f9ab00)' : 'var(--border)'}`,
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                  <Shield size={18} />
                  <span>{zh ? '外部 AI 访问状态' : 'External AI Access State'}</span>
                </div>
                <span
                  style={{
                    fontSize: '0.8125rem',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    backgroundColor: !mcpStatus || mcpStatus.state !== 'ready' ? 'var(--surface-muted)' : mcpConfig?.aiAccessPaused ? 'var(--warning-bg)' : 'var(--success-bg)',
                    color: !mcpStatus || mcpStatus.state !== 'ready' ? 'var(--text-muted)' : mcpConfig?.aiAccessPaused ? 'var(--warning, #b06000)' : 'var(--success, #137333)',
                    fontWeight: 600,
                  }}
                >
                  {!mcpStatus || mcpStatus.state !== 'ready' ? (zh ? '外部访问不可用' : 'Unavailable') : mcpStatus.aiAccessPaused ? (zh ? '外部访问已暂停' : 'Paused') : (zh ? '外部访问就绪' : 'Active')}
                </span>
              </div>

              <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                {mcpConfig?.aiAccessPaused
                  ? (zh ? '当前已全局暂停外部 AI 访问。所有外部 MCP 请求将收到拦截提示，无法读取题库、笔记与做题历史。'
                    : 'External AI access is paused. External MCP clients receive a paused notice and cannot read your data.')
                  : (zh ? '外部 AI 可按照专用连接的访问模式读取或修改支持的数据。你可以随时从托盘或在此处暂停。'
                    : 'External AI clients can read or modify supported data according to their connection mode. You can pause anytime here or from the tray.')}
              </p>

              <div>
                <button
                  type="button"
                  className={`btn ${mcpConfig?.aiAccessPaused ? 'btn-primary' : 'btn-secondary'} btn-sm`}
                  onClick={() => void handleToggleAiPause()}
                  disabled={!mcpConfig}
                >
                  {mcpConfig?.aiAccessPaused ? <Play size={14} /> : <Pause size={14} />}
                  <span>{mcpConfig?.aiAccessPaused ? (zh ? '恢复外部 AI 访问' : 'Resume Access') : (zh ? '暂停外部 AI 访问' : 'Pause Access')}</span>
                </button>
              </div>
            </div>

            <details id="plugin-manual-setup" className="plugin-advanced">
            <summary>{zh ? '高级：端口、连接凭证与手动接入' : 'Advanced: port, credentials and manual setup'}</summary>
            <div className="plugin-advanced-body">
            {/* MCP Server Endpoint & Port Config */}
            <div
              style={{
                padding: '16px',
                backgroundColor: 'var(--surface-muted)',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                <Server size={18} />
                <span>{zh ? 'MCP 服务端点' : 'MCP Server Endpoint'}</span>
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', fontSize: '0.875rem' }}>
                  {mcpStatus?.listeningPort ? `http://127.0.0.1:${mcpStatus.listeningPort}/mcp` : (zh ? '未监听' : 'Not listening')}
                </code>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!mcpStatus?.listeningPort}
                  onClick={() => copyToClipboard(`http://127.0.0.1:${mcpStatus?.listeningPort}/mcp`, 'endpoint')}
                >
                  {copiedTokenId === 'endpoint' ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copiedTokenId === 'endpoint' ? (zh ? '已复制' : 'Copied') : (zh ? '复制地址' : 'Copy URL')}</span>
                </button>
              </div>

              <form className="settings-actions" onSubmit={handleSavePort} style={{ alignItems: 'flex-end', marginTop: '4px' }}>
                <div style={{ flex: 1, maxWidth: '180px' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: '4px', color: 'var(--text-muted)' }}>
                    {zh ? '监听端口 (Port)' : 'Port'}
                  </label>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={mcpPortDraft}
                    onChange={(e) => setMcpPortDraft(parseInt(e.target.value, 10) || 30138)}
                    style={{ width: '100%' }}
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-secondary btn-sm"
                  disabled={savingPort || mcpPortDraft === mcpConfig?.port}
                >
                  {savingPort ? '…' : (zh ? '更新端口' : 'Save Port')}
                </button>
              </form>
              <p role="status">
                {mcpStatus?.restartRequired && (zh ? `待重启生效端口：${mcpStatus.configuredPort}` : `Pending restart port: ${mcpStatus.configuredPort}`)}
                {mcpStatus?.errorCode && ` ${mcpStatus.errorCode}`}
              </p>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {zh ? '默认端口 30138。端口冲突时 MCP 会报错停用，不静默改端口；修改后需重启应用生效。' : 'Default port is 30138. Port conflicts disable MCP rather than silently changing ports. Restart app to apply.'}
              </p>
            </div>

            {/* Named Client Credentials */}
            <div
              style={{
                padding: '16px',
                backgroundColor: 'var(--surface-muted)',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                  <Key size={18} />
                  <span>{zh ? '专用连接凭证 (Named Connections)' : 'Named Connections & Credentials'}</span>
                </div>
              </div>

              <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                {zh
                  ? '每个客户端（Claude Desktop、Cursor、Cline、ChatGPT 网页）拥有独立凭据，支持随时轮换或撤销，日志与命令不泄露密钥。'
                  : 'Each client connection has an isolated bearer token with rotation and revocation support.'}
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {(mcpConfig?.clients || []).map((client) => {
                  const isExpanded = expandedClientId === client.id;
                  const isVisible = Boolean(showTokens[client.id]);
                  const lastUsedText = client.lastSuccessfulCallAt
                    ? new Date(client.lastSuccessfulCallAt).toLocaleString()
                    : (zh ? '从未调用' : 'Never called');

                  return (
                    <div
                      key={client.id}
                      style={{
                        padding: '12px 14px',
                        backgroundColor: 'var(--surface)',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        opacity: client.revoked ? 0.6 : 1,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{client.name}</span>
                          <span
                            style={{
                              fontSize: '0.75rem',
                              padding: '1px 6px',
                              borderRadius: '10px',
                              backgroundColor: client.revoked ? 'var(--error-subtle, #fce8e6)' : 'var(--success-subtle, #e6f4ea)',
                              color: client.revoked ? 'var(--error, #c5221f)' : 'var(--success, #137333)',
                            }}
                          >
                            {client.revoked ? (zh ? '已撤销' : 'Revoked') : (zh ? '凭证有效' : 'Credential valid')}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                          {zh ? '最近成功调用：' : 'Last successful call: '}
                          <strong style={{ color: client.lastSuccessfulCallAt ? 'var(--text-primary)' : 'inherit' }}>{lastUsedText}</strong>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '10px' }}>
                        <input
                          type={isVisible ? 'text' : 'password'}
                          readOnly
                          value={client.token}
                          style={{
                            flex: 1,
                            fontSize: '0.8125rem',
                            fontFamily: 'monospace',
                            padding: '4px 8px',
                            backgroundColor: 'var(--surface-muted)',
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          title={zh ? '显示/隐藏' : 'Show/Hide'}
                          onClick={() => setShowTokens((prev) => ({ ...prev, [client.id]: !prev[client.id] }))}
                        >
                          {isVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          title={zh ? '复制密钥' : 'Copy Token'}
                          onClick={() => copyToClipboard(client.token, client.id)}
                        >
                          {copiedTokenId === client.id ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          title={zh ? '轮换重置密钥' : 'Rotate Token'}
                          onClick={() => void handleRotateClient(client.id)}
                        >
                          <RefreshCw size={14} />
                          <span>{zh ? '轮换' : 'Rotate'}</span>
                        </button>
                        {!client.revoked && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            title={zh ? '撤销此连接' : 'Revoke Connection'}
                            onClick={() => void handleRevokeClient(client.id)}
                          >
                            <span>{zh ? '撤销' : 'Revoke'}</span>
                          </button>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{zh ? '访问权限：' : 'Access Mode: '}</span>
                        <select
                          aria-label={zh ? `${client.name} 访问权限` : `${client.name} Access Mode`}
                          disabled={client.revoked}
                          value={client.mode ?? 'read_only'}
                          onChange={(e) => void handleUpdateClientMode(client.id, e.target.value as McpClientMode)}
                          style={{ fontSize: '0.8125rem', padding: '3px 8px', borderRadius: '4px' }}
                        >
                          <option value="read_only">{zh ? '只读' : 'Read-only'}</option>
                          <option value="model_review">{zh ? '模型审核' : 'Model review'}</option>
                          <option value="full_access">Full access</option>
                        </select>
                        {client.mode === 'full_access' && (
                          <span
                            style={{
                              fontSize: '0.75rem',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              backgroundColor: 'var(--warning-subtle, #fef7e0)',
                              color: 'var(--warning-text, #b06000)',
                              border: '1px solid var(--warning, #f9ab00)',
                            }}
                          >
                            {zh ? '仅 Tracker 练习、笔记和计划' : 'Tracker practice, notes & plan only'}
                          </span>
                        )}
                      </div>

                      <div style={{ marginTop: '8px' }}>
                        <button
                          type="button"
                          className="text-link"
                          style={{ fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                          onClick={() => setExpandedClientId(isExpanded ? null : client.id)}
                        >
                          <span>{isExpanded ? (zh ? '收起配置指南' : 'Hide Config Guide') : (zh ? '查看接入配置指南' : 'View Config Guide')}</span>
                          {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>

                        {isExpanded && (
                          <div
                            style={{
                              marginTop: '10px',
                              padding: '12px',
                              backgroundColor: 'var(--surface-muted)',
                              borderRadius: '6px',
                              border: '1px solid var(--border)',
                              fontSize: '0.8125rem',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '10px',
                            }}
                          >
                            {mcpConfig?.connection ? <>
                              <div>
                                <strong>Codex Desktop — config.toml ({zh ? '自动配置待办' : 'automatic setup planned'})</strong>
                                <pre style={{overflowX:'auto'}}>{'[mcp_servers.leetcode_tracker]\ncommand = '+JSON.stringify(mcpConfig.connection.nodePath)+'\nargs = '+JSON.stringify([mcpConfig.connection.proxyPath,'--config',mcpConfig.connection.configPath,'--client',client.id])}</pre>
                              </div>
                              <div>
                                <strong>DSH — cordis.patch.yml ({zh ? '自动配置待办' : 'automatic setup planned'})</strong>
                                <pre style={{overflowX:'auto'}}>{'- insert:\n    - id: tracker-readonly\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: leetcode_tracker\n        transport: stdio\n        command: '+JSON.stringify(mcpConfig.connection.nodePath)+'\n        args: '+JSON.stringify([mcpConfig.connection.proxyPath,'--config',mcpConfig.connection.configPath,'--client',client.id])}</pre>
                              </div>
                              <div>
                                <strong>Claude Desktop / Cursor / Cline</strong>
                                <pre style={{overflowX:'auto'}}>{JSON.stringify({mcpServers:{'leetcode-tracker':{command:mcpConfig.connection.nodePath,args:[mcpConfig.connection.proxyPath,'--config',mcpConfig.connection.configPath,'--client',client.id]}}},null,2)}</pre>
                              </div>
                            </> : <p>{zh ? '运行时路径不可用，请重新加载设置。' : 'Runtime paths unavailable. Reload Settings.'}</p>}
                            {!isDesktop && <div>
                              <strong>{zh ? 'ChatGPT 网页版 — Secure MCP Tunnel' : 'ChatGPT Web — Secure MCP Tunnel'}</strong>
                              <p>{zh ? '从官方发布页安装 tunnel-client。在 Platform 创建 Tunnel，并关联目标 ChatGPT workspace。控制面凭证由 Tunnel 管理。将复制的 Tracker Token 保存为私有文本文件，内容为 Bearer 加空格和 Token。普通请求与启动探测使用同一文件；请在 Tracker 中明确恢复 AI 访问。轮换后更新该文件并重启 Tunnel。' : 'Install official tunnel-client, create a Tunnel in Platform and associate its ChatGPT workspace. Tunnel owns its control-plane credential. Save the copied Tracker Token in a private text file as Bearer, a space and the Token. Use the same file for calls and startup probes; explicitly resume AI access in Tracker. After rotation, update the file and restart Tunnel.'}</p>
                              <a href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels" target="_blank" rel="noreferrer">{zh ? '官方 Tunnel 指南' : 'Official Tunnel guide'}</a>
                              <pre style={{overflowX:'auto'}}>{'tunnel-client init --sample sample_mcp_remote_no_auth --profile tracker --tunnel-id <TUNNEL_ID> --mcp-server-url http://127.0.0.1:'+ (mcpStatus?.listeningPort ?? mcpConfig?.port ?? 30138)+'/mcp\n'+
                                'tunnel-client doctor --profile tracker --explain --mcp.extra-headers "Authorization: file:C:/private/tracker-auth.txt" --mcp.discovery-extra-headers "Authorization: file:C:/private/tracker-auth.txt"\n'+
                                'tunnel-client run --profile tracker --mcp.extra-headers "Authorization: file:C:/private/tracker-auth.txt" --mcp.discovery-extra-headers "Authorization: file:C:/private/tracker-auth.txt"'}</pre>
                              <p>{zh ? '在 ChatGPT 开发者模式中创建连接，选择 Tunnel 和同一 Tunnel ID。Tracker 不创建或自动管理 Tunnel。' : 'Create a developer-mode connection in ChatGPT, select Tunnel and the same Tunnel ID. Tracker does not create or manage tunnels.'}</p>
                            </div>}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Create Custom Connection Form */}
              <div className="settings-actions">
                {['Codex', 'DSH', 'ChatGPT'].map(name => <button key={name} className="btn btn-secondary btn-sm" disabled={creatingClient || !mcpConfig} onClick={e => void handleCreateClient(e, name)}>
                  {zh ? `创建 ${name} 连接` : `Create ${name} connection`}
                </button>)}
              </div>
              <form className="settings-actions" onSubmit={handleCreateClient} style={{ marginTop: '6px' }}>
                <input
                  type="text"
                  placeholder={zh ? '新连接名称（如：Work Laptop Cursor）' : 'Connection Name (e.g. Work Laptop Cursor)'}
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  style={{ flex: '1 1 220px', fontSize: '0.875rem' }}
                />
                <button
                  type="submit"
                  className="btn btn-secondary btn-sm"
                  disabled={creatingClient || !newClientName.trim()}
                >
                  {creatingClient ? '…' : (zh ? '添加连接' : 'Add Connection')}
                </button>
              </form>

              {mcpSuccess && <Feedback tone="success">{mcpSuccess}</Feedback>}
              {mcpError && <Feedback tone="error">{mcpError}</Feedback>}
            </div>

            </div>
            </details>
            {/* Operation Review Model */}
            <div
              id="plugin-review-model"
              style={{
                padding: '16px',
                backgroundColor: 'var(--surface-muted)',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                <Shield size={18} />
                <span>{zh ? '写入审核模型 (Operation Review Model)' : 'Operation Review Model'}</span>
              </div>
              <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                {zh
                  ? '在“模型审核”模式下，外部 AI 发起的操作由独立的审核模型评估风险。默认使用当前主模型。'
                  : 'In Model Review mode, an independent model evaluates operation risk. Uses active primary model by default.'}
              </p>
              <div style={{ maxWidth: '360px' }}>
                <select
                  aria-label={zh ? '写入审核模型' : 'Operation Review Model'}
                  value={mcpConfig?.reviewModel ?? ''}
                  onChange={(e) => void handleSaveReviewModel(e)}
                  style={{ width: '100%', fontSize: '0.875rem' }}
                >
                  <option value="">{zh ? '使用当前主模型（默认）' : 'Use active primary model (default)'}</option>
                  {currentPresetModels.map((m) => (
                    <option key={m} value={m}>
                      {m.replace('models/', '')}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Pending Approvals */}
            <div
              style={{
                padding: '16px',
                backgroundColor: 'var(--surface-muted)',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                  <ShieldAlert size={18} />
                  <span>{zh ? '待批准操作 (Pending Approvals)' : 'Pending Approvals'}</span>
                  {pendingOperations.length > 0 && (
                    <span
                      style={{
                        fontSize: '0.75rem',
                        padding: '1px 8px',
                        borderRadius: '10px',
                        backgroundColor: 'var(--warning-subtle, #fef7e0)',
                        color: 'var(--warning, #e37400)',
                        fontWeight: 700,
                      }}
                    >
                      {pendingOperations.length}
                    </span>
                  )}
                </div>
              </div>

              {pendingOperations.length === 0 ? (
                <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                  {zh
                    ? '暂无待批准操作。当外部 AI 在模型审核模式下发起高风险修改（如覆盖笔记、批量换题）时，将在此列出等待批准。'
                    : 'No pending approvals. High-impact operations from external agents in review mode will appear here.'}
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {pendingOperations.map((op) => {
                    let summary: { action?: string; target?: string; diffSummary?: string; riskLevel?: string; reviewReason?: string } = {};
                    try {
                      summary = JSON.parse(op.summaryJson ?? '{}');
                    } catch {}
                    const client = mcpConfig?.clients.find((c) => c.id === op.clientId);
                    const clientName = client?.name || op.clientId;
                    const remainingMins = Math.max(0, Math.round((op.expiresAt - Date.now()) / 60000));
                    return (
                      <div
                        key={op.id}
                        style={{
                          padding: '14px',
                          backgroundColor: 'var(--surface)',
                          borderRadius: '6px',
                          border: '1px solid var(--border)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '8px',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <code style={{ fontWeight: 600, fontSize: '0.875rem' }}>{op.toolName}</code>
                            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>via {clientName}</span>
                            {summary.riskLevel && (
                              <span
                                style={{
                                  fontSize: '0.75rem',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  backgroundColor:
                                    summary.riskLevel === 'high'
                                      ? 'var(--error-subtle, #fce8e6)'
                                      : summary.riskLevel === 'medium'
                                      ? 'var(--warning-subtle, #fef7e0)'
                                      : 'var(--success-subtle, #e6f4ea)',
                                  color:
                                    summary.riskLevel === 'high'
                                      ? 'var(--error, #c5221f)'
                                      : summary.riskLevel === 'medium'
                                      ? 'var(--warning, #e37400)'
                                      : 'var(--success, #137333)',
                                }}
                              >
                                Risk: {summary.riskLevel}
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                            {zh ? `剩余 ${remainingMins} 分钟有效` : `${remainingMins}m remaining`}
                          </span>
                        </div>
                        {summary.target && (
                          <div style={{ fontSize: '0.8125rem' }}>
                            <span style={{ color: 'var(--text-muted)' }}>{zh ? '目标：' : 'Target: '}</span>
                            <strong>{summary.target}</strong>
                          </div>
                        )}
                        {summary.diffSummary && (
                          <div
                            style={{
                              fontSize: '0.8125rem',
                              padding: '6px 10px',
                              backgroundColor: 'var(--surface-muted)',
                              borderRadius: '4px',
                              fontFamily: 'monospace',
                            }}
                          >
                            {summary.diffSummary}
                          </div>
                        )}
                        {op.preview && (
                          <details className="agent-approval-details">
                            <summary>{zh ? '查看实际修改前后差异' : 'Inspect actual before and after changes'}</summary>
                            {op.preview.changes.map((change,index) => (
                              <section key={index} style={{marginTop:'12px'}}>
                                <strong>{change.label}</strong>
                                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'16px',marginTop:'6px'}}>
                                  {[['before',zh?'修改前':'Before',change.before],['after',zh?'修改后':'After',change.after]].map(([key,label,value]) => (
                                    <div key={String(key)}><span style={{color:'var(--text-muted)'}}>{String(label)}</span>
                                      <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'280px',overflow:'auto',padding:'8px',background:'var(--surface-muted)',fontSize:'0.8125rem'}}>{typeof value==='string'?value:JSON.stringify(value,null,2)}</pre>
                                    </div>
                                  ))}
                                </div>
                              </section>
                            ))}
                            {op.preview.cascades.length>0 && <section style={{marginTop:'12px'}}>
                              <strong>{zh ? '将连带撤销以下练习记录' : 'These practice records will also be revoked'}</strong>
                              <ul>{op.preview.cascades.map(record=><li key={record.recordId}>{record.recordId} · v{record.revision}</li>)}</ul>
                            </section>}
                            {op.preview.planDate && <p>{op.preview.planDate} · {op.preview.timezone}</p>}
                          </details>
                        )}
                        {summary.reviewReason && (
                          <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                            <em>{zh ? `审核理由：${summary.reviewReason}` : `Review reason: ${summary.reviewReason}`}</em>
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={op.reviewState === 'reviewing' || op.reviewState === 'unreviewed'}
                            onClick={() => void handleProceedOperation(op.id)}
                          >
                            <Check size={14} />
                            <span>{zh ? '批准 (Proceed)' : 'Proceed'}</span>
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => void handleRejectOperation(op.id)}
                          >
                            <span>{zh ? '拒绝 (Reject)' : 'Reject'}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
    </>
  );
}

/** "AI clients" Settings tab content (desktop only): MCP write access, client setup and recent activity. */
import { useId, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { api } from '../../api.ts';
import { activityLabel, AI_CLIENTS, AI_CLIENT_CONFIG_FILES, clientConfig, skillInstallCommand, type AiClient } from '../../desktop-agent-copy.ts';
import { localizeApiError } from '../../error-i18n.ts';
import type { Language } from '../../i18n.ts';
import type { DesktopAgentStatus } from '../../../../../packages/contracts/src/desktop-agent.ts';
import { Feedback } from '../ui.tsx';
import { SettingSwitch } from './SettingSwitch.tsx';

/** Read-only snippet with a copy button; falls back to selecting the text when the clipboard is blocked. */
function CopySnippet({ value, label, button, rows, lang }: { value: string; label: string; button: string; rows: number; lang: Language }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const zh = lang === 'zh';

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(zh ? '已复制。' : 'Copied.');
    } catch {
      field.current?.focus();
      field.current?.select();
      setCopyStatus(zh ? '无法访问剪贴板，请手动复制选中的内容。' : 'Clipboard unavailable. Copy the selected text manually.');
    }
  }

  return (
    <div className="settings-stack">
      <textarea className="agent-config-snippet" ref={field} rows={rows} readOnly value={value} aria-label={label} spellCheck={false} />
      <div className="action-row">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()}>
          <Copy size={14} aria-hidden="true" />
          <span>{button}</span>
        </button>
        <span className="field-status" role="status">{copyStatus}</span>
      </div>
    </div>
  );
}

/**
 * Render the AI client rows.
 *
 * `status` comes from the desktop host; while it is missing the write switch stays disabled and
 * no setup rows are shown. Toggling writes calls the API and keeps the result per host instance.
 */
export function DesktopAgentPanel({ lang, status }: { lang: Language; status?: DesktopAgentStatus }) {
  const zh = lang === 'zh';
  const [updated, setUpdated] = useState<DesktopAgentStatus>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [client, setClient] = useState<AiClient>('Claude Code');
  const descriptionId = useId();
  const enabled = updated?.instance === status?.instance ? updated?.enabled : status?.enabled;
  const config = status?.launch ? clientConfig(client, status.launch) : '';
  const install = status?.launch ? skillInstallCommand(client, status.launch) : null;
  const writeLabel = zh ? '允许 AI 客户端写入' : 'Allow AI client writes';
  const clientLabel = zh ? '客户端' : 'Client';

  async function toggle() {
    if (saving || enabled === undefined) return;
    setSaving(true);
    setError('');
    try { setUpdated(await api.setDesktopAgentEnabled(!enabled)); }
    catch (cause) { setError(localizeApiError(cause, lang)); }
    finally { setSaving(false); }
  }

  return (
    <>
      <section className="preference-row">
        <div className="preference-label">
          <h2>{writeLabel}</h2>
          <p id={descriptionId}>
            {zh ? '允许本机的 AI 客户端（通过 MCP）在桌面应用运行时修改数据。关闭后，客户端仍可读取，并可在桌面应用退出后写入。'
              : 'Let local AI clients update your data over MCP while the desktop app is running. When off, clients can still read, and can write after the desktop app quits.'}
          </p>
        </div>
        <div className="settings-stack">
          <SettingSwitch
            lang={lang}
            checked={enabled ?? false}
            onChange={() => void toggle()}
            label={writeLabel}
            describedBy={descriptionId}
            disabled={enabled === undefined || saving}
          />
          {error && <Feedback>{error}</Feedback>}
        </div>
      </section>

      {config && (
        <section className="preference-row">
          <div className="preference-label">
            <h2>{zh ? '配置 MCP' : 'Configure MCP'}</h2>
            <p>{zh ? '选择你使用的客户端，把下面的条目合并到它的配置文件，然后重启客户端。连接后即可用自然语言操作 LCT。'
              : 'Pick your client, merge the entry below into its configuration file, then restart the client. Once connected, you can use LCT in natural language.'}</p>
          </div>
          <div className="settings-stack">
            <div className="segmented-control" role="group" aria-label={clientLabel}>
              {AI_CLIENTS.map((name) => (
                <button key={name} type="button" aria-pressed={client === name} onClick={() => setClient(name)}>
                  {name}
                </button>
              ))}
            </div>
            <p className="settings-hint">
              {zh ? '配置文件：' : 'Configuration file: '}
              <code>{AI_CLIENT_CONFIG_FILES[client]}</code>
            </p>
            <CopySnippet key={config} value={config} label={zh ? '客户端配置内容' : 'Client configuration text'}
              button={zh ? '复制配置' : 'Copy configuration'} rows={7} lang={lang} />
          </div>
        </section>
      )}

      {install && (
        <section className="preference-row">
          <div className="preference-label">
            <h2>{zh ? '安装 LCT 快捷命令' : 'Install LCT shortcuts'}</h2>
            <p>{zh ? `可选。在 Windows PowerShell 或 macOS 终端运行命令，再打开新的 ${client} 会话。`
              : `Optional. Run the command in Windows PowerShell or macOS Terminal, then open a new ${client} session.`}</p>
          </div>
          <div className="settings-stack">
            <p className="settings-hint">
              {zh ? '安装后可以输入 ' : 'Then try '}
              <code>{client === 'Codex' ? '$lct note 42' : '/lct note 42'}</code>
            </p>
            {client === 'Antigravity' && (
              <p className="settings-hint">{zh ? '适用于 Antigravity App 和 CLI。在 IDE 中可以说「用 LCT 给第 42 题写笔记」。'
                : 'For Antigravity App and CLI. In the IDE, try “Use LCT to write a note for problem 42.”'}</p>
            )}
            <CopySnippet key={install} value={install} label={zh ? 'LCT Skill 安装命令' : 'LCT skill install command'}
              button={zh ? '复制安装命令' : 'Copy install command'} rows={3} lang={lang} />
          </div>
        </section>
      )}

      {status && !config && <Feedback tone="info">{zh ? '当前构建缺少 MCP 文件，请重新安装完整的桌面应用。' : 'The MCP files are missing from this build. Reinstall the full desktop app.'}</Feedback>}

      {status && (
        <section className="preference-row">
          <div className="preference-label">
            <h2>{zh ? '本次运行的 AI 客户端活动' : 'AI client activity this session'}</h2>
          </div>
          {status.activity.length > 0 ? (
            <ul className="agent-activity-list">
              {status.activity.map(activity => (
                <li key={activity.revision}>
                  <time dateTime={activity.at}>{new Date(activity.at).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en')}</time>
                  <span>{activityLabel(activity, lang)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-hint">{zh ? '暂无活动。' : 'No activity yet.'}</p>
          )}
        </section>
      )}
    </>
  );
}

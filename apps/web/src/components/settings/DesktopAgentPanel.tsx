import { useId, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { activityLabel, AI_CLIENTS, AI_CLIENT_CONFIG_FILES, clientConfig, skillInstallCommand, type AiClient } from '../../desktop-agent-copy.ts';
import { localizeApiError } from '../../error-i18n.ts';
import type { Language } from '../../i18n.ts';
import type { DesktopAgentStatus } from '../../../../../packages/contracts/src/desktop-agent.ts';
import { Feedback } from '../ui.tsx';

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
    <>
      <p><textarea className="agent-config-snippet" ref={field} rows={rows} readOnly value={value} aria-label={label} /></p>
      <button type="button" className="btn btn-secondary" onClick={() => void copy()}>{button}</button>
      <p role="status">{copyStatus}</p>
    </>
  );
}

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
          <h2>{zh ? '连接 AI 客户端' : 'Connect an AI client'}</h2>
          <p id={descriptionId}>
            {zh ? '允许本机 AI 客户端在桌面应用运行时更新数据。关闭后，客户端仍可读取，并可在桌面应用退出后写入。'
              : 'Allow local AI clients to update data while the desktop app is running. When disabled, clients can still read and can write after the desktop app quits.'}
          </p>
        </div>
        <label>
          <input type="checkbox" checked={enabled ?? false} disabled={enabled === undefined || saving} aria-describedby={descriptionId} onChange={() => void toggle()} />
          {' '}{zh ? '允许 AI 客户端写入' : 'Allow AI client writes'}
        </label>
      </section>
      {error && <Feedback>{error}</Feedback>}
      {config && (
        <section className="preference-row">
          <div className="preference-label">
            <h2>{zh ? '配置 MCP' : 'Configure MCP'}</h2>
            <p>{zh ? '把该条目合并到客户端配置文件，再重启客户端。连接后即可用自然语言操作 LCT。' : 'Merge this entry into the client configuration file and restart the client. Once connected, you can use LCT in natural language.'}</p>
            <code>{AI_CLIENT_CONFIG_FILES[client]}</code>
          </div>
          <div>
            <label>
              {zh ? '客户端' : 'Client'}{' '}
              <select value={client} onChange={event => setClient(event.target.value as AiClient)}>
                {AI_CLIENTS.map(name => <option key={name}>{name}</option>)}
              </select>
            </label>
            <CopySnippet key={config} value={config} label={zh ? '客户端配置内容' : 'Client configuration text'}
              button={zh ? '复制配置' : 'Copy configuration'} rows={6} lang={lang} />
          </div>
        </section>
      )}
      {install && (
        <section className="preference-row">
          <div className="preference-label">
            <h2>{zh ? '安装 LCT 快捷命令' : 'Install LCT shortcuts'}</h2>
            <p>{zh ? '可选。在 Windows PowerShell 或 macOS 终端运行命令，再打开新的客户端会话。'
              : 'Optional. Run the command in Windows PowerShell or macOS Terminal, then open a new client session.'}</p>
            <code>{client === 'Codex' ? '$lct note 42' : '/lct note 42'}</code>
            {client === 'Antigravity' && (
              <p>{zh ? '适用于 Antigravity App 和 CLI。在 IDE 中可以说「用 LCT 给第 42 题写笔记」。'
                : 'For Antigravity App and CLI. In the IDE, try “Use LCT to write a note for problem 42.”'}</p>
            )}
          </div>
          <div>
            <CopySnippet key={install} value={install} label={zh ? 'LCT Skill 安装命令' : 'LCT skill install command'}
              button={zh ? '复制安装命令' : 'Copy install command'} rows={3} lang={lang} />
          </div>
        </section>
      )}
      {status && !config && <Feedback tone="info">{zh ? '当前构建缺少 MCP 文件，请重新安装完整的桌面应用。' : 'The MCP files are missing from this build. Reinstall the full desktop app.'}</Feedback>}
      {status && status.activity.length > 0 && (
        <section className="preference-row">
          <div className="preference-label"><h2>{zh ? '本次运行的 AI 客户端活动' : 'AI client activity this session'}</h2></div>
          <ul>
            {status.activity.map(activity => (
              <li key={activity.revision}>
                <time dateTime={activity.at}>{new Date(activity.at).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en')}</time>{' '}
                {activityLabel(activity, lang)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

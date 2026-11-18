import { useId, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { activityLabel, AI_CLIENTS, clientConfig, type AiClient } from '../../desktop-agent-copy.ts';
import { localizeApiError } from '../../error-i18n.ts';
import type { Language } from '../../i18n.ts';
import type { DesktopAgentStatus } from '../../../../../packages/contracts/src/desktop-agent.ts';
import { Feedback } from '../ui.tsx';

export function DesktopAgentPanel({ lang, status }: { lang: Language; status?: DesktopAgentStatus }) {
  const zh = lang === 'zh';
  const [updated, setUpdated] = useState<DesktopAgentStatus>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [client, setClient] = useState<AiClient>('Claude Code');
  const [copyStatus, setCopyStatus] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const descriptionId = useId();
  const enabled = updated?.instance === status?.instance ? updated?.enabled : status?.enabled;
  const config = status?.launch ? clientConfig(client, status.launch) : '';
  const configFile = client === 'Claude Code' ? '.mcp.json' : client === 'Claude Desktop' ? 'claude_desktop_config.json' : '~/.codex/config.toml';

  async function toggle() {
    if (saving || enabled === undefined) return;
    setSaving(true);
    setError('');
    try { setUpdated(await api.setDesktopAgentEnabled(!enabled)); }
    catch (cause) { setError(localizeApiError(cause, lang)); }
    finally { setSaving(false); }
  }

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(config);
      setCopyStatus(zh ? '已复制配置。' : 'Configuration copied.');
    } catch {
      field.current?.focus();
      field.current?.select();
      setCopyStatus(zh ? '无法访问剪贴板，请手动复制选中的配置。' : 'Clipboard unavailable. Copy the selected configuration manually.');
    }
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
            <h2>{zh ? '客户端配置' : 'Client configuration'}</h2>
            <p>{zh ? '把该条目合并到客户端配置文件，再重启客户端。' : 'Merge this entry into the client configuration file and restart the client.'}</p>
            <code>{configFile}</code>
          </div>
          <div>
            <label>
              {zh ? '客户端' : 'Client'}{' '}
              <select value={client} onChange={event => { setClient(event.target.value as AiClient); setCopyStatus(''); }}>
                {AI_CLIENTS.map(name => <option key={name}>{name}</option>)}
              </select>
            </label>
            <p><textarea className="agent-config-snippet" ref={field} rows={6} readOnly value={config} aria-label={zh ? '客户端配置内容' : 'Client configuration text'} /></p>
            <button type="button" className="btn btn-secondary" onClick={() => void copyConfig()}>{zh ? '复制配置' : 'Copy configuration'}</button>
            <p role="status">{copyStatus}</p>
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

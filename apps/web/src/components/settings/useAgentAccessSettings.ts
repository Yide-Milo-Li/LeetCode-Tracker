/**
 * Background runtime and external AI (MCP) access state for the Settings view.
 *
 * Owned by `SettingsView` rather than its General tab so polling, drafts and feedback survive tab
 * switches. On mount it loads the MCP configuration, status and pending agent operations, reads
 * the desktop autostart state, then polls every 2s (and on focus/visibility/hash changes) while the
 * settings view is visible. An older configuration read never overwrites newer access state.
 * Handler failures surface through `mcpError`; successes set a transient `mcpSuccess` message.
 */
import React, { useEffect, useState, type RefObject } from 'react';
import {
  api,
  mcpApi,
  type McpClientMode,
  type McpSettingsConfig,
  type McpStatus,
  type PendingAgentOperation,
} from '../../api.ts';
import type { Language } from '../../i18n.ts';
import { getAutostartStatus, isTauri, setAutostartStatus } from '../../platform/index.ts';
import { useWorkspace } from '../../workspace.tsx';

/** Own background-runtime and MCP settings; `rootRef` pauses polling while the view is hidden. */
export function useAgentAccessSettings(lang: Language, rootRef: RefObject<HTMLElement | null>) {
  const workspace = useWorkspace();
  const zh = lang === 'zh';

  // Desktop background runtime state
  const isDesktop = isTauri();
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  const [autostartLoading, setAutostartLoading] = useState(false);

  // MCP AI Connection State
  const [mcpConfig, setMcpConfig] = useState<McpSettingsConfig | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpSuccess, setMcpSuccess] = useState<string | null>(null);
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const [mcpPortDraft, setMcpPortDraft] = useState<number>(30138);
  const [savingPort, setSavingPort] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [creatingClient, setCreatingClient] = useState(false);
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null);
  const [showTokens, setShowTokens] = useState<Record<string, boolean>>({});
  const [pendingOperations, setPendingOperations] = useState<PendingAgentOperation[]>([]);

  const loadMcpConfigData = async () => {
    setMcpLoading(true);
    try {
      const [cfg, status, ops] = await Promise.all([
        mcpApi.getConfig(),
        mcpApi.getStatus(),
        mcpApi.listPendingOperations().catch(() => ({ operations: [] })),
      ]);
      setMcpConfig(cfg);
      setMcpStatus(status);
      setPendingOperations(ops.operations);
      setMcpPortDraft(cfg.port);
    } catch {
      setMcpConfig(null); setMcpStatus(null);
      setMcpError(zh ? 'MCP 配置不可用' : 'MCP configuration unavailable');
    } finally {
      setMcpLoading(false);
    }
  };

  useEffect(() => {
    if (isTauri()) {
      getAutostartStatus().then(setAutostartEnabled).catch(() => {});
    }
    void loadMcpConfigData();
    let active = true;
    let previousApprovals: number | null = null;
    let polling = false;
    const handleFocus = () => {
      if (polling || document.visibilityState === 'hidden' || rootRef.current?.closest('[hidden]')) return;
      polling = true;
      void (async () => {
        try {
          const [status,versions,config] = await Promise.all([
            mcpApi.getStatus(),api.getBusinessVersions(),mcpApi.getConfig().catch(()=>null),
          ]);
          if (!active) return;
          setMcpStatus(status);
          setMcpConfig(current => {
            if (!current) return current;
            const freshAccess = config && (config.accessRevision ?? 0) >= (current.accessRevision ?? 0);
            // Merge display metadata only; an old read cannot resurrect connections or overwrite drafts.
            const authoritative = config && (config.accessRevision ?? 0) > (current.accessRevision ?? 0);
            const clients = authoritative ? config.clients : current.clients.map(client => {
              const refreshed = config?.clients.find(candidate => candidate.id === client.id);
              if (!refreshed || refreshed.createdAt !== client.createdAt ||
                  refreshed.credentialVersion !== client.credentialVersion ||
                  refreshed.revoked !== client.revoked || refreshed.mode !== client.mode) return client;
              const timestamp = Math.max(client.lastSuccessfulCallAt ?? 0, refreshed.lastSuccessfulCallAt ?? 0);
              return timestamp === (client.lastSuccessfulCallAt ?? 0)
                ? client : {...client,lastSuccessfulCallAt:timestamp || null};
            });
            return {...current,clients,
              accessRevision:freshAccess ? config.accessRevision : current.accessRevision,
              aiAccessPaused:freshAccess ? config.aiAccessPaused : current.aiAccessPaused};
          });
          if (previousApprovals !== versions.approvals) {
            const res=await mcpApi.listPendingOperations();
            if (active) setPendingOperations(res.operations);
            previousApprovals=versions.approvals;
          }
        } catch { /* Preserve the visible queue on transient runtime failures. */ }
        finally { polling=false; }
      })();
    };
    const poll = setInterval(handleFocus, 2000);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('hashchange', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      active = false;
      clearInterval(poll);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('hashchange', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, []);

  const handleToggleAutostart = async () => {
    setAutostartLoading(true);
    try {
      const next = !autostartEnabled;
      await setAutostartStatus(next);
      setAutostartEnabled(next);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutostartLoading(false);
    }
  };

  const handleToggleAiPause = async () => {
    if (!mcpConfig) return;
    try {
      const next = !mcpConfig.aiAccessPaused;
      const updated = await mcpApi.updateConfig({ aiAccessPaused: next });
      setMcpConfig(updated);
      setMcpStatus(await mcpApi.getStatus());
      setMcpSuccess(
        next
          ? (zh ? '已暂停外部 AI 访问' : 'External AI access paused')
          : (zh ? '已恢复外部 AI 访问' : 'External AI access resumed')
      );
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSavePort = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mcpConfig || mcpPortDraft <= 0 || mcpPortDraft > 65535) return;
    setSavingPort(true);
    try {
      const updated = await mcpApi.updateConfig({ port: mcpPortDraft });
      setMcpConfig(updated);
      setMcpStatus(await mcpApi.getStatus());
      setMcpSuccess(
        zh
          ? '端口已更新，请重启桌面应用以使新端口生效。'
          : 'Port updated. Restart LeetCode Tracker for changes to take effect.'
      );
      setTimeout(() => setMcpSuccess(null), 5000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPort(false);
    }
  };

  const handleCreateClient = async (e: React.FormEvent, name = newClientName) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreatingClient(true);
    try {
      await mcpApi.createClient(name.trim());
      setNewClientName('');
      await loadMcpConfigData();
      setMcpSuccess(zh ? '已创建新连接凭证' : 'New connection created');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingClient(false);
    }
  };

  const handleRotateClient = async (id: string) => {
    try {
      await mcpApi.rotateClient(id);
      await loadMcpConfigData();
      setMcpSuccess(zh ? '凭据密钥已重新生成' : 'Connection token rotated');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevokeClient = async (id: string) => {
    try {
      await mcpApi.revokeClient(id);
      await loadMcpConfigData();
      setMcpSuccess(zh ? '连接已撤销' : 'Connection revoked');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpdateClientMode = async (id: string, mode: McpClientMode) => {
    try {
      await mcpApi.updateClientMode(id, mode);
      setMcpConfig((prev) =>
        prev
          ? {
              ...prev,
              clients: prev.clients.map((c) => (c.id === id ? { ...c, mode } : c)),
            }
          : prev
      );
      setMcpSuccess(zh ? '已更新连接访问模式' : 'Connection mode updated');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveReviewModel = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value.trim() || null;
    try {
      const updated = await mcpApi.updateConfig({ reviewModel: val });
      setMcpConfig(updated);
      setMcpSuccess(zh ? '已更新写入审核模型' : 'Review model updated');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleProceedOperation = async (id: string) => {
    try {
      await mcpApi.proceedOperation(id);
      // Approval can change business data while other desktop views remain mounted.
      workspace.notifyMutation();
      setMcpSuccess(zh ? '操作已批准执行' : 'Operation approved and applied');
      const ops = await mcpApi.listPendingOperations();
      setPendingOperations(ops.operations);
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRejectOperation = async (id: string) => {
    try {
      await mcpApi.rejectOperation(id, 'User rejected from desktop UI');
      setMcpSuccess(zh ? '操作已拒绝' : 'Operation rejected');
      const ops = await mcpApi.listPendingOperations();
      setPendingOperations(ops.operations);
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedTokenId(id);
    setTimeout(() => setCopiedTokenId(null), 2000);
  };

  return {
    isDesktop,
    autostartEnabled,
    autostartLoading,
    mcpConfig,
    setMcpConfig,
    mcpStatus,
    mcpLoading,
    mcpError,
    mcpSuccess,
    copiedTokenId,
    mcpPortDraft,
    setMcpPortDraft,
    savingPort,
    newClientName,
    setNewClientName,
    creatingClient,
    expandedClientId,
    setExpandedClientId,
    showTokens,
    setShowTokens,
    pendingOperations,
    handleToggleAutostart,
    handleToggleAiPause,
    handleSavePort,
    handleCreateClient,
    handleRotateClient,
    handleRevokeClient,
    handleUpdateClientMode,
    handleSaveReviewModel,
    handleProceedOperation,
    handleRejectOperation,
    copyToClipboard,
  };
}

/** Agent access state and actions consumed by {@link AgentAccessSection}. */
export type AgentAccessSettings = ReturnType<typeof useAgentAccessSettings>;

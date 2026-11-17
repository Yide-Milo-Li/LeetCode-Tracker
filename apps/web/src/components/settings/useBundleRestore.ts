/**
 * Migration bundle import state for the Settings "Data" tab.
 *
 * Owned by `SettingsView` (not the Data tab) so a selected bundle awaiting confirmation and the
 * last restore message survive switching between Settings tabs.
 */
import React, { useRef, useState } from 'react';
import { snapshotBundleSchema, type SnapshotBundle } from '../../../../../packages/contracts/src/notes.ts';
import { MAX_BUNDLE_BYTES } from '../../../../../packages/contracts/src/migration.ts';
import { api } from '../../api.ts';
import { clearPracticeIntents } from '../../practice-service.ts';
import type { Language } from '../../i18n.ts';
import { localizeApiError } from '../../error-i18n.ts';
import { useWorkspace } from '../../workspace.tsx';

/**
 * Parse a chosen bundle file into a pending restore and run the confirmed restore.
 *
 * Side effects: a successful restore notifies the workspace, clears practice intents and reloads
 * the page. Size, parse, read and API failures surface as localized `bundleError` text.
 */
export function useBundleRestore(lang: Language) {
  const workspace = useWorkspace();
  const zh = lang === 'zh';

  // Bundle export / import state
  const [importingBundle, setImportingBundle] = useState(false);
  const [bundleSuccess, setBundleSuccess] = useState('');
  const [bundleError, setBundleError] = useState('');
  const [pendingBundle, setPendingBundle] = useState<SnapshotBundle | null>(null);
  const bundleFileInputRef = useRef<HTMLInputElement | null>(null);

  /** Read selected JSON snapshot bundle file. */
  function handleSelectBundleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBundleError('');
    setBundleSuccess('');

    setPendingBundle(null);
    if (file.size > MAX_BUNDLE_BYTES) {
      setBundleError(zh ? '迁移文件不能超过 64 MiB。' : 'Migration files must not exceed 64 MiB.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const parsed = snapshotBundleSchema.parse(JSON.parse(text));
        setPendingBundle(parsed);
      } catch {
        setBundleError(zh ? '无效或不支持的迁移文件。' : 'Invalid or unsupported migration file.');
      }
    };
    reader.onerror = () => {
      setBundleError(zh ? '读取文件失败。' : 'Failed to read file.');
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  /** Execute atomic snapshot bundle restoration with automatic safety backup. */
  async function handleConfirmRestore() {
    if (!pendingBundle) return;
    setImportingBundle(true);
    setBundleError('');
    setBundleSuccess('');

    try {
      const res = await api.importBundle(pendingBundle);
      if (res.ok) {
        setBundleSuccess(
          zh
            ? `还原成功！已恢复 ${res.result.restoredRecords} 条做题记录与 ${res.result.restoredNotes} 篇笔记。系统安全快照已自动归档至：${res.result.safetyBackupPath}`
            : `Restore complete! Restored ${res.result.restoredRecords} records and ${res.result.restoredNotes} notes. Pre-restore safety backup created at: ${res.result.safetyBackupPath}`
        );
        workspace.notifyMutation();
        clearPracticeIntents();
        // Reload drops every old workspace draft and reapplies the imported language/theme/settings.
        window.location.reload();
      } else {
        setBundleError(zh ? '还原失败。' : 'Restore failed.');
      }
    } catch (err) {
      setBundleError(localizeApiError(err, lang, zh ? '还原失败。' : 'Restore failed.'));
    } finally {
      setImportingBundle(false);
      setPendingBundle(null);
    }
  }

  return {
    importingBundle,
    bundleSuccess,
    bundleError,
    pendingBundle,
    setPendingBundle,
    bundleFileInputRef,
    handleSelectBundleFile,
    handleConfirmRestore,
  };
}

/** State and actions returned by {@link useBundleRestore}. */
export type BundleRestore = ReturnType<typeof useBundleRestore>;

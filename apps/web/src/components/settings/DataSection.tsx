/** "Data" Settings tab: device sync, cross-device migration bundle export/restore and note-app exports. */
import { Download, Upload, Archive, AlertTriangle } from 'lucide-react';
import { api } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';
import { ExportLink } from '../ExportLink.tsx';
import { Feedback, InfoPopover } from '../ui.tsx';
import type { BundleRestore } from './useBundleRestore.ts';
import type { DeviceSync } from './useDeviceSync.ts';
import { SyncSection } from './SyncSection.tsx';

interface DataSectionProps {
  lang: Language;
  /** Restore state owned by the parent so a pending bundle survives tab switches. */
  bundle: BundleRestore;
  /** Device sync state owned by the parent so an open receive preview survives tab switches. */
  sync: DeviceSync;
}

/** Render the Data tab panel; exports are plain links and restores go through `bundle`. */
export function DataSection({ lang, bundle, sync }: DataSectionProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const {
    importingBundle,
    bundleSuccess,
    bundleError,
    pendingBundle,
    setPendingBundle,
    bundleFileInputRef,
    handleSelectBundleFile,
    handleConfirmRestore,
  } = bundle;

  return (
    <div role="tabpanel" id="settings-panel-data" aria-labelledby="settings-tab-data" className="settings-panel">
      <SyncSection lang={lang} sync={sync} />

      <section className="preference-row">
        <div className="preference-label">
          <h2>{zh ? '跨设备迁移' : 'Move to another device'}</h2>
          <InfoPopover
            label={zh ? '数据安全与迁移说明' : 'Data portability help'}
            content={
              <div>
                <p>
                  {zh
                    ? '所有做题记录、笔记与配置保存在本地 SQLite 中，完全离线运行。'
                    : 'All practice logs, notes, and settings reside in your local SQLite database, 100% offline.'}
                </p>
                <p>
                  {zh
                    ? '执行还原前，系统会自动在本地生成一份时间戳安全快照，确保随时可回退。'
                    : 'Before restoring a bundle, the app creates a timestamped safety backup so you can always roll back.'}
                </p>
              </div>
            }
          />
          <p>
            {zh
              ? '一个文件包含题库、进度、笔记、学习安排和设置，可在 Windows 与 Mac 间互相导入。API Key 不会导出。'
              : 'One file holds your catalog, progress, notes, study schedule and settings. Works across Windows and Mac. API keys are not exported.'}
          </p>
        </div>

        <div className="settings-stack">
          <div className="action-row">
            <ExportLink
              lang={lang}
              onExport={() => api.exportBundleFile()}
              href={api.getBundleExportUrl()}
              className="btn btn-primary"
              download
            >
              <Download size={16} />
              <span>{zh ? '导出迁移包' : 'Export migration file'}</span>
            </ExportLink>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => bundleFileInputRef.current?.click()}
              disabled={importingBundle}
            >
              <Upload size={16} />
              <span>{importingBundle ? (zh ? '正在还原…' : 'Restoring…') : zh ? '导入迁移包' : 'Import migration file'}</span>
            </button>
            <input
              ref={bundleFileInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={handleSelectBundleFile}
            />
          </div>

          {pendingBundle && (
            <div className="restore-confirm" role="alertdialog" aria-labelledby="restore-confirm-title">
              <div className="restore-confirm-title" id="restore-confirm-title">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{zh ? '确认替换当前设备的数据？' : 'Replace This Device’s Data?'}</span>
              </div>
              <p>
                {pendingBundle.version !== 1
                  ? `${zh ? '完整迁移' : 'Complete migration'} · v${pendingBundle.appVersion} · ${pendingBundle.tables.problems.length} ${zh ? '题目' : 'problems'} · ${pendingBundle.tables.practice_records.length} ${zh ? '练习记录' : 'practice records'} · ${pendingBundle.tables.progress_snapshots.length} ${zh ? '进度记录' : 'progress snapshots'} · ${pendingBundle.tables.problem_notes.length} ${zh ? '笔记' : 'notes'}`
                  : zh ? '旧版 v1：仅部分恢复，不包含题库或完整历史。请先确保本机已有对应题库。' : 'Legacy v1: partial restore only; no catalog or complete history. The matching catalog must already exist.'}
              </p>
              <p className="restore-confirm-note">
                {zh
                  ? '这不是合并操作。确认后会先备份当前数据库，再替换相应数据；失败将保留原库。目标设备已有 API Key 保留。请先保存未完成编辑，成功后页面会重新加载。'
                  : 'This replaces data; it does not merge devices. A safety backup is created before writing, and failed restores preserve the original database. Local API keys remain. Save unfinished edits first; the app reloads after success.'}
              </p>
              <div className="action-row">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void handleConfirmRestore()}
                  disabled={importingBundle}
                >
                  {importingBundle ? '…' : zh ? '确认并还原' : 'Confirm & Restore'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPendingBundle(null)}
                  disabled={importingBundle}
                >
                  {zh ? '取消' : 'Cancel'}
                </button>
              </div>
            </div>
          )}

          {bundleSuccess && <Feedback tone="success">{bundleSuccess}</Feedback>}
          {bundleError && <Feedback tone="error">{bundleError}</Feedback>}
        </div>
      </section>

      <section className="preference-row">
        <div className="preference-label">
          <h2>{zh ? '导出到笔记工具' : 'Export to note apps'}</h2>
          <p>
            {zh
              ? 'Obsidian 题库与笔记骨架（.zip），或 Notion 可导入的 CSV 表格。'
              : 'An Obsidian vault of problems and note skeletons (.zip), or CSV tables for Notion.'}
          </p>
        </div>
        <div className="action-row">
          <ExportLink
            lang={lang}
            onExport={() => api.exportObsidianZip('all', lang)}
            href={api.getObsidianZipUrl('all', lang)}
            className="btn btn-secondary btn-sm"
            title={t.exportObsidianTitle}
          >
            <Archive size={14} />
            <span>{t.exportObsidianVault}</span>
          </ExportLink>
          <ExportLink
            lang={lang}
            onExport={() => api.exportNotionCsv('summary')}
            href={api.getNotionCsvUrl('summary')}
            className="btn btn-secondary btn-sm"
            title={t.exportNotionSummaryTitle}
          >
            <Download size={14} />
            <span>{t.exportNotionSummary}</span>
          </ExportLink>
          <ExportLink
            lang={lang}
            onExport={() => api.exportNotionCsv('history')}
            href={api.getNotionCsvUrl('history')}
            className="btn btn-secondary btn-sm"
            title={t.exportNotionHistoryTitle}
          >
            <Download size={14} />
            <span>{t.exportNotionHistory}</span>
          </ExportLink>
        </div>
      </section>
    </div>
  );
}

/** Unified export & copy menu for current-problem actions and full-library knowledge exports. */
import { Archive, ChevronDown, Download, FileDown, Table } from 'lucide-react';
import { api, type ProblemNoteSummary } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';
import { CopyNotionCard } from '../CopyNotionCard.tsx';
import { ExportLink } from '../ExportLink.tsx';
import { useActionPopover } from '../ui.tsx';

interface NotesExportMenuProps {
  lang: Language;
  summary?: ProblemNoteSummary | null;
  noteContent?: string;
  onCopied?: () => void;
}

/** Group per-problem copy/Markdown export with library-wide Obsidian/Notion exports in one popover. */
export function NotesExportMenu({ lang, summary, noteContent, onCopied }: NotesExportMenuProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const menu = useActionPopover({ align: 'end' });
  const triggerLabel = zh ? '导出与复制' : 'Export & copy';

  return (
    <div className="notes-dropdown">
      <button
        type="button"
        className="btn btn-secondary btn-sm nw-export-trigger"
        {...menu.triggerProps}
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        <Download size={13} aria-hidden="true" />
        <span>{zh ? '导出' : 'Export'}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {menu.rendered && (
        <div {...menu.panelProps} className="notes-dropdown-menu notes-dropdown-menu-right nw-export-menu">
          {summary && (
            <>
              <div className="nw-menu-section-label">{zh ? '当前题目' : 'Current problem'}</div>
              <CopyNotionCard
                lang={lang}
                className="notes-dropdown-item nw-menu-item-btn"
                problem={{
                  frontendId: summary.questionFrontendId,
                  title: summary.title,
                  url: summary.url,
                  difficulty: summary.difficulty,
                  tags: summary.tags,
                }}
                record={{
                  durationMinutes: null,
                  notes: summary.latestPracticeNotes,
                }}
                customNote={noteContent ?? ''}
                onCopied={() => {
                  menu.close();
                  onCopied?.();
                }}
              />
              <ExportLink
                lang={lang}
                onExport={async () => {
                  await api.exportSingleMarkdown(summary.questionFrontendId, lang);
                  menu.close();
                }}
                href={api.getSingleMarkdownUrl(summary.questionFrontendId, lang)}
                className="notes-dropdown-item"
                title={t.exportSingleMarkdown}
              >
                <span className="notes-dropdown-label">
                  <FileDown size={13} aria-hidden="true" />
                  <span>{t.exportSingleMarkdown}</span>
                </span>
              </ExportLink>
              <div className="nw-menu-divider" role="separator" />
            </>
          )}

          <div className="nw-menu-section-label">{zh ? '全部知识库' : 'Full library'}</div>
          <ExportLink
            lang={lang}
            onExport={async () => {
              await api.exportObsidianZip('all', lang);
              menu.close();
            }}
            href={api.getObsidianZipUrl('all', lang)}
            className="notes-dropdown-item"
            title={t.exportObsidianTitle}
          >
            <span className="notes-dropdown-label">
              <Archive size={13} aria-hidden="true" />
              <span>{t.exportObsidianVault}</span>
            </span>
          </ExportLink>
          <ExportLink
            lang={lang}
            onExport={async () => {
              await api.exportNotionCsv('summary');
              menu.close();
            }}
            href={api.getNotionCsvUrl('summary')}
            className="notes-dropdown-item"
            title={t.exportNotionSummaryTitle}
          >
            <span className="notes-dropdown-label">
              <Table size={13} aria-hidden="true" />
              <span>{t.exportNotionSummary}</span>
            </span>
          </ExportLink>
        </div>
      )}
    </div>
  );
}

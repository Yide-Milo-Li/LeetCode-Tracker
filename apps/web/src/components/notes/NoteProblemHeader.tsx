/** Selected problem header: title, metadata chips, quick copy, Markdown export and the zen toggle. */
import { ExternalLink, Download, Maximize2, Minimize2 } from 'lucide-react';
import { api, type ProblemNoteSummary } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';
import { ExportLink } from '../ExportLink.tsx';
import { QuickCopyButtons } from '../QuickCopyButtons.tsx';

interface NoteProblemHeaderProps {
  lang: Language;
  summary: ProblemNoteSummary;
  /** Current editor draft, offered by the quick copy menu. */
  noteContent: string;
  zenMode: boolean;
  onToggleZen: () => void;
  /** Platform-specific tooltip that names the zen shortcut. */
  zenModeTitle: string;
}

/** Render the problem header and its copy/export bar. Purely presentational. */
export function NoteProblemHeader({ lang, summary, noteContent, zenMode, onToggleZen, zenModeTitle }: NoteProblemHeaderProps) {
  const t = translations[lang];
  const zh = lang === 'zh';

  return (
    <div className="nw-problem-header">
      <div className="nw-problem-heading">
        <div className="nw-title-row">
          <h2 className="nw-title">
            <span>#{summary.questionFrontendId}. {summary.title}</span>
            <a
              href={summary.url}
              target="_blank"
              rel="noreferrer"
              className="btn-icon nw-external-link"
              title={zh ? '在 LeetCode 打开 ↗' : 'Open on LeetCode ↗'}
            >
              <ExternalLink size={14} />
            </a>
          </h2>
        </div>

        {/* Row 2: Metadata row */}
        <div className="nw-meta-row">
          <span className={`notes-diff-badge ${summary.difficulty}`}>
            {zh
              ? summary.difficulty === 'Easy'
                ? t.statEasy
                : summary.difficulty === 'Medium'
                ? t.statMedium
                : t.statHard
              : summary.difficulty}
          </span>

          {summary.hasAccepted && (
            <span className="nw-solved-label">
              ✓ {zh ? '已解出' : 'Solved'}
            </span>
          )}

          {Boolean(summary.reviewStage) && (
            <span className="nw-review-stage">
              {zh ? `复习 · 第 ${summary.reviewStage} 阶段` : `Review · Stage ${summary.reviewStage}`}
            </span>
          )}

          {/* Subtle tags */}
          {summary.tags && summary.tags.length > 0 && (
            <div className="nw-tags">
              {summary.tags.map((tag) => (
                <span key={tag} className="notes-tag-chip nw-tag-chip">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Actions: Quick Copy, single Markdown download, and Zen Mode */}
      <div className="nw-header-tools">
        <QuickCopyButtons
          lang={lang}
          problem={{
            frontendId: summary.questionFrontendId,
            title: summary.title,
            url: summary.url,
            difficulty: summary.difficulty,
            tags: summary.tags,
            slug: summary.titleSlug,
          }}
          record={{
            durationMinutes: null,
            notes: summary.latestPracticeNotes,
          }}
          customNote={noteContent}
          align="right"
        />

        <ExportLink
          lang={lang}
          onExport={() => api.exportSingleMarkdown(summary.questionFrontendId, lang)}
          href={api.getSingleMarkdownUrl(summary.questionFrontendId, lang)}
          className="btn btn-secondary btn-sm nw-md-export"
          title={t.exportSingleMarkdown}
        >
          <Download size={13} />
          <span>.md</span>
        </ExportLink>

        <button
          type="button"
          className={`btn btn-secondary btn-sm nw-zen-btn ${zenMode ? 'active' : ''}`}
          onClick={onToggleZen}
          title={zenModeTitle}
        >
          {zenMode ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          <span>{zenMode ? (zh ? '退出专注' : 'Exit Zen') : (zh ? '专注' : 'Zen')}</span>
        </button>
      </div>
    </div>
  );
}

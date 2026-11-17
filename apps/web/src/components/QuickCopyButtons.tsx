/**
 * Quick Copy dropdown button for generating Obsidian Callout or Notion Rich Card snippets.
 */
import React, { useState } from 'react';
import { Copy, Check, FileText, ChevronDown } from 'lucide-react';
import { formatObsidianCallout, formatNotionCard } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { useActionPopover } from './ui.tsx';

export interface QuickCopyButtonsProps {
  lang: Language;
  problem: {
    frontendId: string;
    title: string;
    url: string;
    difficulty: string;
    tags: string[];
    slug: string;
  };
  record?: {
    durationMinutes: number | null;
    practicedAt?: string;
    completed?: boolean;
    notes: string | null;
  };
  customNote?: string | null;
  compact?: boolean;
  /** Alignment of the dropdown menu relative to the trigger button ('left' | 'right'). Defaults to 'left'. */
  align?: 'left' | 'right';
}

export function QuickCopyButtons({
  lang,
  problem,
  record,
  customNote,
  compact = false,
  align = 'left',
}: QuickCopyButtonsProps) {
  const t = translations[lang];
  const [copiedType, setCopiedType] = useState<'obsidian' | 'notion' | null>(null);
  // Native popover handles outside clicks, Escape and the top layer; see useActionPopover.
  const menu = useActionPopover({ align: align === 'right' ? 'end' : 'start' });

  async function copyToClipboard(text: string, type: 'obsidian' | 'notion') {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(type);
      menu.close();
      setTimeout(() => setCopiedType(null), 2000);
    } catch {
      // ignore clipboard error
    }
  }

  function handleCopyObsidian(e: React.MouseEvent) {
    e.stopPropagation();
    const text = formatObsidianCallout(problem, record, customNote, lang);
    void copyToClipboard(text, 'obsidian');
  }

  function handleCopyNotion(e: React.MouseEvent) {
    e.stopPropagation();
    const text = formatNotionCard(problem, record, customNote, lang);
    void copyToClipboard(text, 'notion');
  }

  if (compact) {
    return (
      <div className="quick-copy-group compact" style={{ display: 'inline-flex', gap: '4px' }}>
        <button
          type="button"
          className="btn-icon"
          title={copiedType === 'obsidian' ? t.cardCopied : t.copyObsidianCard}
          aria-label={t.copyObsidianCard}
          onClick={handleCopyObsidian}
        >
          {copiedType === 'obsidian' ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Copy size={14} />}
        </button>
      </div>
    );
  }

  return (
    <div className="notes-dropdown">
      <button
        type="button"
        className="btn btn-secondary btn-sm notes-dropdown-trigger"
        {...menu.triggerProps}
        title={copiedType ? t.cardCopied : (lang === 'zh' ? '复制题目卡片' : 'Copy Problem Card')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
      >
        {copiedType ? (
          <>
            <Check size={13} style={{ color: 'var(--success)' }} />
            <span>{t.cardCopied}</span>
          </>
        ) : (
          <>
            <Copy size={13} />
            <span>{lang === 'zh' ? '复制' : 'Copy'}</span>
            <ChevronDown size={11} style={{ opacity: 0.7 }} />
          </>
        )}
      </button>

      {menu.rendered && (
        <div
          {...menu.panelProps}
          className={`notes-dropdown-menu${align === 'right' ? ' notes-dropdown-menu-right' : ''}`}
          style={{ minWidth: '210px' }}
        >
          <button
            type="button"
            className="notes-dropdown-item"
            onClick={handleCopyObsidian}
            title={t.copyObsidianCard}
            aria-label={t.copyObsidianCard}
          >
            <span className="notes-dropdown-label">
              <Copy size={13} className="notes-dropdown-icon" aria-hidden="true" />
              <span>{t.copyObsidianCard}</span>
            </span>
            <span className="notes-dropdown-hint" aria-hidden="true">.md</span>
          </button>

          <button
            type="button"
            className="notes-dropdown-item"
            onClick={handleCopyNotion}
            title={t.copyNotionCard}
            aria-label={t.copyNotionCard}
          >
            <span className="notes-dropdown-label">
              <FileText size={13} className="notes-dropdown-icon is-secondary" aria-hidden="true" />
              <span>{t.copyNotionCard}</span>
            </span>
            <span className="notes-dropdown-hint" aria-hidden="true">Rich</span>
          </button>
        </div>
      )}
    </div>
  );
}

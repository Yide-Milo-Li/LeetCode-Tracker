/**
 * Quick Copy buttons for generating Obsidian Callout or Notion Rich Card snippets.
 */
import React, { useState } from 'react';
import { Copy, Check, FileText } from 'lucide-react';
import { formatObsidianCallout, formatNotionCard } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

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
}

export function QuickCopyButtons({
  lang,
  problem,
  record,
  customNote,
  compact = false,
}: QuickCopyButtonsProps) {
  const t = translations[lang];
  const [copiedType, setCopiedType] = useState<'obsidian' | 'notion' | null>(null);

  async function copyToClipboard(text: string, type: 'obsidian' | 'notion') {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(type);
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
    <div className="quick-copy-actions" style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={handleCopyObsidian}
        title={t.copyObsidianCard}
      >
        {copiedType === 'obsidian' ? (
          <>
            <Check size={14} style={{ color: 'var(--success)' }} />
            <span>{t.cardCopied}</span>
          </>
        ) : (
          <>
            <Copy size={14} />
            <span>{t.copyObsidianCard}</span>
          </>
        )}
      </button>

      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={handleCopyNotion}
        title={t.copyNotionCard}
      >
        {copiedType === 'notion' ? (
          <>
            <Check size={14} style={{ color: 'var(--success)' }} />
            <span>{t.cardCopied}</span>
          </>
        ) : (
          <>
            <FileText size={14} />
            <span>{t.copyNotionCard}</span>
          </>
        )}
      </button>
    </div>
  );
}

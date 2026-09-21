/**
 * Quick Copy dropdown button for generating Obsidian Callout or Notion Rich Card snippets.
 */
import React, { useState, useRef, useEffect } from 'react';
import { Copy, Check, FileText, ChevronDown } from 'lucide-react';
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
  const [isOpen, setIsOpen] = useState(false);
  const [copiedType, setCopiedType] = useState<'obsidian' | 'notion' | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  async function copyToClipboard(text: string, type: 'obsidian' | 'notion') {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(type);
      setIsOpen(false);
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
    <div className="notes-dropdown" ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="btn btn-secondary btn-sm notes-dropdown-trigger"
        onClick={() => setIsOpen((open) => !open)}
        title={copiedType ? t.cardCopied : (lang === 'zh' ? '复制题目卡片' : 'Copy Problem Card')}
        aria-expanded={isOpen}
        aria-haspopup="true"
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

      {isOpen && (
        <div className="notes-dropdown-menu notes-dropdown-menu-right" role="menu" style={{ minWidth: '210px', whiteSpace: 'nowrap' }}>
          <button
            type="button"
            className="notes-dropdown-item"
            onClick={handleCopyObsidian}
            title={t.copyObsidianCard}
            aria-label={t.copyObsidianCard}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Copy size={13} style={{ color: 'var(--primary)' }} />
              <span>{t.copyObsidianCard}</span>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>.md</span>
          </button>

          <button
            type="button"
            className="notes-dropdown-item"
            onClick={handleCopyNotion}
            title={t.copyNotionCard}
            aria-label={t.copyNotionCard}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FileText size={13} style={{ color: 'var(--accent, #6366f1)' }} />
              <span>{t.copyNotionCard}</span>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Rich</span>
          </button>
        </div>
      )}
    </div>
  );
}

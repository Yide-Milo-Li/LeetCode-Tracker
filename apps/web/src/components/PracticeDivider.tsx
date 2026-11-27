import React, { useRef } from 'react';
import type { Language } from '../i18n.ts';

const PREFERENCE = 'lct_practice_page_fraction';

export function readPracticeSplit(): number | null {
  try {
    const fraction = Number(localStorage.getItem(PREFERENCE));
    if (Number.isFinite(fraction) && fraction > 0 && fraction < 1) return fraction;
  } catch { /* The divider can still be used without storage. */ }
  return null;
}

export function savePracticeSplit(fraction: number | null) {
  try {
    if (fraction === null) localStorage.removeItem(PREFERENCE);
    else localStorage.setItem(PREFERENCE, String(fraction));
  } catch { /* Retain the choice for the current visit. */ }
}

/** Shrinking the window clamps the displayed widths without replacing the user's preference. */
export function practiceSplitBounds(width: number) {
  return { min: Math.min(360, width / 2), max: width - Math.min(300, width / 2) };
}

interface Props {
  lang: Language;
  pageId: string;
  width: number;
  pageWidth: number;
  preference: number | null;
  onChange(fraction: number | null): void;
}

export function PracticeDivider({ lang, pageId, width, pageWidth, preference, onChange }: Props) {
  const zh = lang === 'zh';
  const { min, max } = practiceSplitBounds(width);
  const drag = useRef<{ id: number; offset: number; start: number | null } | null>(null);
  const percent = (pixels: number) => Math.round(100 * pixels / width);
  const fractionAt = (pixels: number) => Math.max(min, Math.min(max, pixels)) / width;
  function commit(value: number | null) {
    onChange(value);
    savePracticeSplit(value);
  }
  function cancel() {
    if (!drag.current) return;
    onChange(drag.current.start);
    drag.current = null;
  }
  return <div className="practice-divider" role="separator" tabIndex={0}
    aria-label={zh ? '题目区域宽度' : 'Problem pane width'} aria-orientation="vertical" aria-controls={pageId}
    aria-valuemin={percent(min)} aria-valuemax={percent(max)} aria-valuenow={percent(pageWidth)}
    aria-valuetext={zh ? `题目占 ${percent(pageWidth)}%` : `Problem occupies ${percent(pageWidth)}%`}
    title={zh ? '拖动调整宽度，双击恢复默认' : 'Drag to resize. Double-click to reset.'}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, offset: event.clientX - pageWidth, start: preference };
    }}
    onPointerMove={event => {
      if (drag.current?.id === event.pointerId) onChange(fractionAt(event.clientX - drag.current.offset));
    }}
    onPointerUp={event => {
      if (drag.current?.id !== event.pointerId) return;
      const value = fractionAt(event.clientX - drag.current.offset);
      drag.current = null;
      commit(value);
    }}
    onLostPointerCapture={cancel} onPointerCancel={cancel} onDoubleClick={() => commit(null)}
    onKeyDown={event => {
      const step = width * (event.shiftKey ? 0.1 : 0.02);
      switch (event.key) {
        case 'ArrowLeft': commit(fractionAt(pageWidth - step)); break;
        case 'ArrowRight': commit(fractionAt(pageWidth + step)); break;
        case 'Home': commit(fractionAt(min)); break;
        case 'End': commit(fractionAt(max)); break;
        case 'Enter': commit(null); break;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
    }} />;
}

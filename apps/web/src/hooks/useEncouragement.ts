/**
 * React hook providing time-aware and timezone-aware algorithmic practice encouragement.
 * Recomputes deterministically when time passes time-period boundaries (06:00, 11:00, 17:00, 22:00),
 * when the tab regains visibility, or when user timezone changes.
 */

import { useEffect, useState } from 'react';
import type { Language } from '../i18n.ts';
import { type EncouragementQuote } from '../data/encouragements.ts';
import { getEncouragement } from '../encouragement.ts';

export interface UseEncouragementOptions {
  timeZone?: string | null;
  lang: Language;
}

export interface UseEncouragementResult {
  quote: EncouragementQuote;
  text: string;
}

/**
 * Hook to retrieve the current periodic encouragement quote.
 *
 * @param options Configuration with optional timezone and active language
 * @returns The current quote object and localized display text
 */
export function useEncouragement({
  timeZone,
  lang,
}: UseEncouragementOptions): UseEncouragementResult {
  const [quote, setQuote] = useState<EncouragementQuote>(() =>
    getEncouragement(new Date(), timeZone),
  );

  useEffect(() => {
    // Recompute immediately on timezone update
    setQuote(getEncouragement(new Date(), timeZone));

    const checkTime = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const next = getEncouragement(new Date(), timeZone);
      setQuote((curr) => (curr.id === next.id ? curr : next));
    };

    // Periodic check every minute
    const timer = setInterval(checkTime, 60000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', checkTime);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', checkTime);
    }

    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', checkTime);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', checkTime);
      }
    };
  }, [timeZone]);

  const text = quote[lang] || quote.en;

  return {
    quote,
    text,
  };
}

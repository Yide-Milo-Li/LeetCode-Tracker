import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatNotionCard } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

export function CopyNotionCard({ lang, problem, record, customNote, disabled = false }: {
  lang: Language;
  problem: Parameters<typeof formatNotionCard>[0];
  record?: Parameters<typeof formatNotionCard>[1];
  customNote?: string | null;
  disabled?: boolean;
}) {
  const t = translations[lang];
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);

  async function copy() {
    clearTimeout(reset.current);
    setFailed(false);
    try {
      await navigator.clipboard.writeText(formatNotionCard(problem, record, customNote, lang));
      setCopied(true);
      reset.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  }
  return <>
    <button type="button" className="btn btn-secondary btn-sm" disabled={disabled} onClick={() => void copy()}>
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      {copied ? t.cardCopied : t.copyNotionCard}
    </button>
    {failed && <small role="alert">{lang === 'zh' ? '无法写入剪贴板。' : 'Could not write to the clipboard.'}</small>}
  </>;
}

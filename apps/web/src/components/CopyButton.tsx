/** Icon button that copies text to the clipboard and confirms it in place for a moment. */
import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { IconButton } from './ui.tsx';

/** How long the confirmation stays before the button offers to copy again. */
const COPIED_MS = 1600;

export function CopyButton({ text, label, copiedLabel, className, size = 14 }: {
  /** Read when the button is pressed, so the text may come from the rendered page. */
  text: () => string;
  label: string;
  copiedLabel: string;
  className?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    // Without clipboard access nothing was copied, so nothing is confirmed.
    void navigator.clipboard?.writeText(text()).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    }, () => {});
  };

  return <IconButton icon={copied ? Check : Copy} label={copied ? copiedLabel : label} size={size} className={className} onClick={copy} />;
}

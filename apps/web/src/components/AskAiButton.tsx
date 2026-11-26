/**
 * Row action that opens the AI chat on one problem's conversation, without sending anything.
 * Renders nothing in a view that has no chat to hand over to, such as an isolated render.
 */
import { MessageSquareText } from 'lucide-react';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { IconButton } from './ui.tsx';

export function AskAiButton({ lang, frontendId, title, disabled = false }: {
  lang: Language;
  frontendId: string;
  title?: string;
  disabled?: boolean;
}) {
  const { askAi } = useWorkspace();
  if (!askAi) return null;
  return (
    <IconButton icon={MessageSquareText} disabled={disabled}
      label={lang === 'zh' ? `问 AI：#${frontendId}` : `Ask AI about #${frontendId}`}
      onClick={() => askAi({ problem: { frontendId, ...(title ? { title } : {}) } })} />
  );
}

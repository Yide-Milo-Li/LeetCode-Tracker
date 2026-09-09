/** Accessible statistics drilldown using the same source-aware records as Progress. */
import React from 'react';
import type { Language } from '../i18n.ts';
import { Dialog } from './ui.tsx';
import { ActivityRecords } from './ActivityRecords.tsx';

/** Closing the drawer restores focus to the heatmap or history trigger. */
export function ActivityHistoryDrawer({
  isOpen,
  onClose,
  lang,
  initialDate = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
  initialDate?: string | null;
}) {
  return isOpen ? (
    <Dialog lang={lang} onClose={onClose} title={lang === 'zh' ? '活动历史' : 'Activity history'} drawer wide>
      <ActivityRecords lang={lang} initialDate={initialDate} />
    </Dialog>
  ) : null;
}

/** Compatibility entry for catalog callers; all recording behavior lives in the shared editor. */
import React from 'react';
import type { CatalogProblem } from '../api.ts';
import type { Language } from '../i18n.ts';
import { Dialog } from './ui.tsx';
import { PracticeEditor, PracticeHistory } from './PracticeWorkspace.tsx';

/** Open a preselected manual form without creating records until its explicit save. */
export function PracticeLogModal({
  problem,
  lang,
  onClose,
  onRecordSaved,
}: {
  problem: CatalogProblem;
  lang: Language;
  onClose: () => void;
  onRecordSaved?: () => void;
}) {
  return (
    <Dialog lang={lang} onClose={onClose} title={lang === 'zh' ? '记录练习' : 'Record practice'}>
      <PracticeEditor
        lang={lang}
        problem={problem}
        onCancel={onClose}
        onSaved={() => {
          onRecordSaved?.();
          onClose();
        }}
      />
      <PracticeHistory problem={problem} lang={lang} />
    </Dialog>
  );
}

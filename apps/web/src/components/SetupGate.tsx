/** Check setup before loading the first-run wizard. Returning users can render Today immediately. */
import React, { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { Language } from '../i18n.ts';
import type { ThemePalette } from '../../../../packages/contracts/src/sync.ts';
import type { ThemeMode } from './settings/settings-model.ts';
import { useWorkspace } from '../workspace.tsx';

const SetupGuide = React.lazy(() => import('./SetupGuide.tsx').then(module => ({ default: module.SetupGuide })));

export const SETUP_DONE_KEY = 'leetcode_tracker_setup_done';

/** Read the persisted completion flag; storage failures count as "not done" so the check still runs. */
function readDone(): boolean {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDone() {
  try {
    localStorage.setItem(SETUP_DONE_KEY, 'true');
  } catch {
    // Storage is unavailable; the guide simply re-checks on the next mount.
  }
}

/** Facts the guide needs; each maps to one step. */
export interface SetupStatus {
  timezone: string | null;
  problemCount: number;
  hasSchedule: boolean;
}

export type Step = 0 | 1 | 2 | 3;

/** Index of the first unfinished step, or the finish screen when everything is in place. */
function firstOpenStep(status: SetupStatus): Step {
  if (!status.timezone) return 0;
  if (status.problemCount === 0) return 1;
  if (!status.hasSchedule) return 2;
  return 3;
}

export interface SetupGateProps {
  lang: Language;
  theme: ThemeMode;
  palette: ThemePalette;
  onLanguageChange: (lang: Language) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onPaletteChange: (palette: ThemePalette) => void;
  onTimezoneSaved: (zone: string | null) => void;
  /** Called once the guide closes so the daily plan can be generated with the new setup. */
  onFinish: () => void;
  /** Close the guide and open the AI tab in Settings. */
  onOpenAiSettings: () => void;
  children: ReactNode;
}

/** Show the guide while setup is incomplete; otherwise render the regular Today view. */
export function SetupGate({ children, ...props }: SetupGateProps) {
  const workspace = useWorkspace();
  const [phase, setPhase] = useState<'checking' | 'guide' | 'done'>(() => (readDone() ? 'done' : 'checking'));
  const [status, setStatus] = useState<SetupStatus | null>(null);

  useEffect(() => {
    if (phase === 'done') return;
    let active = true;
    Promise.all([api.getSettings(), api.getCatalogStats(), api.getStrategies(), api.getGoalListSummaries(1, { limit: 1 })])
      .then(([settings, stats, strategies, goals]) => {
        if (!active) return;
        const next: SetupStatus = {
          timezone: settings.timezone ?? null,
          problemCount: stats.totalProblems,
          hasSchedule: strategies.some((s) => !s.deleted && s.weekdays.length > 0),
        };
        if (goals.items.length || (phase === 'checking' && firstOpenStep(next) === 3)) {
          // Existing installs (or a restored migration) skip the guide entirely.
          writeDone();
          setPhase('done');
        } else if (phase === 'checking') {
          setStatus(next);
          setPhase('guide');
        }
      })
      .catch(() => {
        // Never block Today on the check; its own views report load failures.
        if (active && phase === 'checking') setPhase('done');
      });
    return () => {
      active = false;
    };
  }, [phase, workspace.revision]);

  if (phase === 'done') return <>{children}</>;
  const loading = <div className="setup-loading" role="status">
    {props.lang === 'zh' ? '正在检查设置…' : 'Checking your setup…'}
  </div>;
  if (phase === 'checking' || !status) return loading;
  return (
    <React.Suspense fallback={loading}>
      <SetupGuide
        {...props}
        initialStatus={status}
        initialStep={firstOpenStep(status)}
        onClose={() => {
          writeDone();
          setPhase('done');
        }}
      />
    </React.Suspense>
  );
}

/** Optional future-plan policies; edits remain drafts until the parent explicitly submits. */
import React, { useId } from 'react';
import type { RulePatch } from '../../../../packages/contracts/src/recommendations.ts';
import type { Language } from '../i18n.ts';

type Options = Pick<RulePatch, 'reviewPolicy' | 'adaptiveReviewEnabled' | 'personalDurationCalibration' | 'timeBudgetMinutes'>;
type ReviewPolicy = NonNullable<Options['reviewPolicy']>;

/**
 * User-facing review spacing copy. Internal ids (`duration-v1`, `outcome-v2`) never reach the UI.
 * Each description builds on the previous one, so a single sentence explains the difference.
 */
const POLICY_COPY: Record<ReviewPolicy, { label: Record<Language, string>; hint: Record<Language, string> }> = {
  fixed: {
    label: { zh: '固定间隔', en: 'Fixed spacing' },
    hint: {
      zh: '每次复习后间隔依次拉长：1、3、7、14、30 天。',
      en: 'Each review pushes the next one further out: 1, 3, 7, 14, then 30 days.',
    },
  },
  'duration-v1': {
    label: { zh: '参考用时', en: 'Adjust by time spent' },
    hint: {
      zh: '在固定间隔上，用时超过参考线（简单 30、中等 45、困难 60 分钟）时下次间隔减半。',
      en: 'Fixed spacing, but a solve slower than the reference (Easy 30, Medium 45, Hard 60 min) halves the next gap.',
    },
  },
  'outcome-v2': {
    label: { zh: '参考用时与结果', en: 'Adjust by time and outcome' },
    hint: {
      zh: '在参考用时之上，再看你记录的结果：借助提示时间隔减半，未解决则第二天再练。',
      en: 'Adds your recorded outcome on top of time spent: assisted solves halve the gap, unsolved ones return the next day.',
    },
  },
};

/** Localized name for a stored review policy id; unknown ids fall back to the raw value. */
export function reviewPolicyLabel(policy: string, lang: Language): string {
  return POLICY_COPY[policy as ReviewPolicy]?.label[lang] ?? policy;
}

/** Copy only present experiment fields so saving a legacy draft preserves its shape. */
export function readRecommendationOptions(value: Options): Options {
  return { ...(value.reviewPolicy !== undefined ? { reviewPolicy: value.reviewPolicy } : {}),
    ...(value.personalDurationCalibration !== undefined ? { personalDurationCalibration: value.personalDurationCalibration } : {}),
    ...(value.timeBudgetMinutes !== undefined ? { timeBudgetMinutes: value.timeBudgetMinutes } : {}) };
}

/** Preserve absent legacy settings while exposing independent, labeled opt-in controls. */
export function RecommendationOptions({ lang, reviewEnabled, value, onChange }: {
  lang: Language; reviewEnabled: boolean; value: Options; onChange: (patch: Options) => void;
}) {
  const id = useId(), zh = lang === 'zh';
  return <fieldset className="form-group recommendation-options">
    <legend className="form-label">{zh ? '推荐策略与用时' : 'Recommendation policy and effort'}</legend>
    {reviewEnabled && <div className="form-group">
      <label htmlFor={id + '-policy'} className="form-label">{zh ? '复习间隔' : 'Review spacing'}</label>
      <select id={id + '-policy'} className="form-input" value={value.reviewPolicy ?? ''}
        aria-describedby={id + '-policy-help'}
        onChange={event => {
          const reviewPolicy = event.target.value as NonNullable<Options['reviewPolicy']>;
          onChange({ reviewPolicy, adaptiveReviewEnabled: reviewPolicy === 'duration-v1' });
        }}>
        {!value.reviewPolicy && <option value="" disabled>{zh ? '保留现有策略' : 'Keep existing policy'}</option>}
        {(Object.keys(POLICY_COPY) as ReviewPolicy[]).map(policy =>
          <option key={policy} value={policy}>{POLICY_COPY[policy].label[lang]}</option>)}
      </select>
      {/* Describe only the selected option; the three descriptions stack, so one line shows the difference. */}
      <p id={id + '-policy-help'} className="text-muted">{value.reviewPolicy
        ? POLICY_COPY[value.reviewPolicy].hint[lang]
        : zh ? '选择一种方式后才会改变复习安排；只影响之后的计划。' : 'Pick one to change how reviews are spaced. Only future plans are affected.'}</p>
    </div>}
    <div className="form-group">
      <label htmlFor={id + '-calibration'} className="checkbox-label">
        <input id={id + '-calibration'} type="checkbox" checked={!!value.personalDurationCalibration}
          aria-describedby={id + '-calibration-help'}
          onChange={event => onChange({ personalDurationCalibration: event.target.checked })} />
        <span>{zh ? '个人用时实验（影子对照）' : 'Personal duration experiment (shadow)'}</span>
      </label>
      <p id={id + '-calibration-help'} className="text-muted">{zh
        ? '90 天内同难度至少 12 个独立完成题目日样本、6 道题和 4 天才启用个人用时估计。调度仍使用静态阈值；该实验不改变复习日期。'
        : 'Personal effort estimates require 12 independent question/day samples across 6 problems and 4 days in 90 days for that difficulty. Review scheduling keeps static thresholds; this experiment does not change due dates.'}</p>
    </div>
    <div className="form-group">
      <label htmlFor={id + '-budget'} className="form-label">{zh ? '每日时间预算（分钟，可选）' : 'Daily time budget (minutes, optional)'}</label>
      <input id={id + '-budget'} className="form-input" type="number" min="1" max="1440" step="1"
        value={value.timeBudgetMinutes ?? ''} aria-describedby={id + '-budget-help'}
        aria-invalid={value.timeBudgetMinutes != null && (!Number.isInteger(value.timeBudgetMinutes) || value.timeBudgetMinutes < 1 || value.timeBudgetMinutes > 1440)}
        onChange={event => onChange({ timeBudgetMinutes: event.target.value === '' ? null : Number(event.target.value) })} />
      <p id={id + '-budget-help'} className="text-muted">{zh
        ? '留空即不设预算。估计会分别列出新题和复习；预算不足时仍保留严格题数与难度，需明确调整。'
        : 'Leave blank for no budget. New and review effort are shown separately. An infeasible budget never silently changes counts or difficulty.'}</p>
    </div>
  </fieldset>;
}

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { studyPlanInputSchema, type StudyPlanEdit, type StudyPlanView } from '../../../../packages/contracts/src/study-plan.ts';
import { difficulties } from '../../../../packages/contracts/src/recommendations.ts';
import { localDate } from '../../../../packages/contracts/src/time.ts';
import { ApiError } from '../platform/index.ts';
import { useWorkspace } from '../workspace.tsx';
import { GoalRouteEditor, detailedStages, type RouteStages } from './GoalRouteEditor.tsx';
import { GoalProblemPicker } from './GoalProblemPicker.tsx';
import { reviewCountForRules } from '../strategy-counts.ts';
import { api, type Strategy } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import { translations, type Language } from '../i18n.ts';
import { reviewPolicyLabel } from './RecommendationOptions.tsx';
import { parseGoalIds, StudyProblemListEditor } from './StudyProblemListEditor.tsx';
import { Dialog } from './ui.tsx';

const studyWeekdays = [1, 2, 3, 4, 5, 6, 0];

export function StudyGoalEditor({ lang, timezone, editing, strategies = [], onSaved, onClose }: {
  lang: Language;
  timezone: string | null;
  editing?: StudyPlanView;
  strategies?: Strategy[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const zh = lang === 'zh';
  const t = translations[lang];
  const formId = useId();
  const settings = editing?.settings;
  const [originalTexts] = useState(() => editing?.stages.map((_, stage) =>
    editing.nodes.filter(node => node.stage === stage).map(node => node.frontendId).join('\n')) ?? []);
  const [listDraft, setListDraft] = useState<string[] | null>(null);
  const [problemText, setProblemText] = useState('');
  const [advanced, setAdvanced] = useState<RouteStages | null>(null);
  const [template, setTemplate] = useState<Strategy | null>(null);
  const templateKey = template ? template.id + ':' + template.version : 'custom';
  const templateCount = template ? Math.min(30, template.rules.dailyCount) : 2;
  const workspace = useWorkspace();
  const paceField = useRef<HTMLSelectElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const errorSummary = useRef<HTMLParagraphElement>(null);
  const operation = useRef<{ key: string; id: string } | null>(null);
  const [today] = useState(() => localDate(Date.now(), timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'preview' | 'save' | null>(null);
  const [deadlineMode, setDeadlineMode] = useState(Boolean(editing?.deadline));
  const [difficultyMix, setDifficultyMix] = useState(Boolean(settings?.difficulty));
  const [adaptive, setAdaptive] = useState(settings?.adaptivePace ?? true);
  const [globalOpen, setGlobalOpen] = useState(false);
  const [globalSummary, setGlobalSummary] = useState('');
  useEffect(() => {
    if (!globalOpen) return;
    let active = true;
    api.getSettings().then(value => {
      if (active) setGlobalSummary([reviewPolicyLabel(value.reviewPolicy ?? 'fixed', lang), value.reviewIntervals?.join(' / ')].filter(Boolean).join(' · '));
    }).catch(() => { if (active) setGlobalSummary(zh ? '未能读取复习设置' : 'Could not load review settings'); });
    return () => { active = false; };
  }, [globalOpen, workspace.revision, lang, zh]);
  const [preview, setPreview] = useState<StudyPlanView | null>(null);
  const previewSummary = useRef<HTMLElement>(null);
  const saving = pending !== null;

  useEffect(() => {
    if (preview) previewSummary.current?.focus();
  }, [preview]);

  useEffect(() => {
    if (error) errorSummary.current?.focus();
  }, [error]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const dryRun = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'preview';
    const data = new FormData(event.currentTarget);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    const stageProblemIds = !advanced && listDraft ? listDraft.map(parseGoalIds) : undefined;
    const ids = parseGoalIds(value('problemIds'));
    const allIds = advanced?.flatMap(stage => stage.items.map(item => item.frontendId)) ?? stageProblemIds?.flat() ?? ids;
    if (advanced) {
      const prior = new Set<string>();
      for (const stage of advanced) {
        if (!stage.name.trim() || !stage.items.length) { setError(zh ? '每个阶段需要名称和至少一道题。' : 'Give every stage a name and at least one problem.'); return; }
        for (const item of stage.items) {
          if (!item.purpose.trim() || item.requires.some(id => !prior.has(id))) {
            setError(zh ? `请检查 #${item.frontendId} 的练习目的及前置题顺序。` : `Check the purpose and prerequisite order for #${item.frontendId}.`); return;
          }
          prior.add(item.frontendId);
        }
      }
    }
    if (stageProblemIds && (!allIds.length || allIds.length > 150 || allIds.some(id => id.length > 100))) {
      setError(zh ? '题单须有 1 至 150 道题，每个题号最多 100 个字符。' : 'Use 1–150 problems with IDs of at most 100 characters each.');
      return;
    }
    const weekdays = data.getAll('weekdays').map(Number).sort();
    const dailyCount = deadlineMode ? undefined : Number(value('dailyCount'));
    const reviewCap = Number(value('reviewCap'));
    const maxDailyCount = (deadlineMode || adaptive) && value('maxDailyCount') ? Number(value('maxDailyCount')) : undefined;
    const startDate = value('startDate');
    const deadline = deadlineMode ? value('deadline') : undefined;
    const difficulty = difficultyMix
      ? { Easy: Number(value('Easy')), Medium: Number(value('Medium')), Hard: Number(value('Hard')) }
      : undefined;

    const seen = new Set<string>();
    for (const id of allIds) {
      if (seen.has(id)) {
        setError(zh ? `题号 #${id} 重复了，请保留一次。` : `Keep only one copy of problem #${id}.`);
        return;
      }
      seen.add(id);
    }
    if (!weekdays.length) {
      setError(zh ? '请至少选择一个学习日。' : 'Choose at least one study day.');
      return;
    }
    if (dailyCount !== undefined && reviewCap > dailyCount) {
      setError(zh ? '每日复习上限不能超过你选的日常题量。' : 'The review cap exceeds your daily count.');
      return;
    }
    if (dailyCount !== undefined && maxDailyCount !== undefined && maxDailyCount < dailyCount) {
      setError(zh ? '每日总量上限不能低于日常题量。' : 'The daily maximum must cover your daily count.');
      return;
    }
    if (difficulty && Math.abs(difficulty.Easy + difficulty.Medium + difficulty.Hard - 100) > 1e-8) {
      setError(zh ? '简单、中等和困难的占比之和须为 100%。' : 'The three difficulty percentages must add up to 100%.');
      return;
    }
    if (deadline && deadline < startDate) {
      setError(zh ? '截止日须在开始日期当天或之后。' : 'Choose a deadline on or after the start date.');
      return;
    }

    const tags = value('tags').split(/[,，\n]+/u).map(tag => tag.trim()).filter(Boolean);
    const common = { weekdays, dailyCount, reviewCap, maxDailyCount, deadline, difficulty, premium: data.has('premium'),
      tags, filterReviewTags: data.has('filterReviewTags'),
      ...(!deadlineMode && { adaptivePace: adaptive }) };
    const operationId = (draft: unknown) => {
      const key = JSON.stringify(draft);
      if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
      return operation.current.id;
    };
    setPending(dryRun ? 'preview' : 'save');
    setPreview(null);
    setError('');
    try {
      let result;
      if (editing) {
        const proposed = { ...common, deadline: deadline ?? null, difficulty: difficulty ?? null,
          maxDailyCount: deadlineMode || adaptive ? maxDailyCount ?? null : editing.settings.maxDailyCount };
        const original = { ...editing.settings, weekdays: [...editing.settings.weekdays].sort() };
        const changes: StudyPlanEdit['changes'] = Object.fromEntries(Object.entries(proposed).filter(([key, next]) =>
          next !== undefined && JSON.stringify(next) !== JSON.stringify(original[key as keyof typeof original])));
        if (value('name') !== editing.name) changes.name = value('name');
        if (value('goal') !== editing.goal) changes.goal = value('goal');
        if (startDate !== editing.startDate) changes.startDate = startDate;
        if (advanced && JSON.stringify(advanced) !== JSON.stringify(detailedStages(originalTexts.map(parseGoalIds), lang, editing))) changes.stages = advanced;
        if (stageProblemIds && JSON.stringify(stageProblemIds) !== JSON.stringify(originalTexts.map(parseGoalIds))) changes.stageProblemIds = stageProblemIds;
        if (!Object.keys(changes).length) {
          if (dryRun) setPreview(editing);
          else onClose();
          return;
        }
        const draft = { id: editing.id, expectedVersion: editing.version, changes };
        result = await api.updateStudyPlan({ ...draft, dryRun, operationId: operationId(draft) });
      } else {
        const parsed = studyPlanInputSchema.safeParse({
          ...common, name: value('name'), goal: value('goal'), startDate,
          ...(template && { strategyId: template.id, strategyVersion: template.version, difficulty: difficulty ?? null }),
          stages: advanced ?? [{
            name: zh ? '目标题单' : 'Goal problem list',
            items: ids.map((frontendId, index) => ({
              frontendId,
              purpose: zh ? `题单中的第 ${index + 1} 题` : `Problem ${index + 1} in the goal`,
            })),
          }],
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0].path[0] === 'stages'
            ? (zh ? '请输入 1 到 150 道题的题号，每个题号最多 100 个字符。' : 'Enter 1 to 150 problem IDs of up to 100 characters each.')
            : (zh ? '请检查计划名称、日期和题量。' : 'Check the goal name, dates and problem counts.'));
          return;
        }
        const draft = { plan: parsed.data };
        result = await api.createStudyPlan({ ...draft, dryRun, operationId: operationId(draft) });
      }
      if (dryRun) setPreview(result.plan);
      else onSaved();
    } catch (err) {
      if (err instanceof ApiError && ['STALE_STUDY_PLAN', 'STALE_STRATEGY'].includes(err.code)) workspace.notifyMutation();
      setError(localizeApiError(err, lang, zh ? '保存目标失败，请重试。' : 'Could not save the goal. Try again.'));
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog
      title={editing ? (zh ? `调整「${editing.name}」` : `Edit “${editing.name}”`) : (zh ? '新建目标计划' : 'New Goal')}
      lang={lang}
      onClose={onClose}
      closeDisabled={saving}
      initialFocusRef={editing ? paceField : firstField}
      drawer
      footer={
        <div className="u-display-flex u-justify-content-flex-end u-gap-0-5rem">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>{t.cancel}</button>
          <button type="submit" form={formId} value="preview" className="btn btn-secondary" disabled={saving}>
            {pending === 'preview' ? (zh ? '计算中…' : 'Calculating…') : (zh ? '预览安排' : 'Preview schedule')}
          </button>
          <button type="submit" form={formId} value="save" className="btn btn-primary" disabled={saving}>
            {pending === 'save' ? t.saving : editing ? (zh ? '保存并重排' : 'Save and reschedule') : (zh ? '保存目标' : 'Save Goal')}
          </button>
        </div>
      }
    >
      <form id={formId} method="post" onSubmit={save} onChange={() => { setError(''); setPreview(null); }} aria-busy={saving}>
        {error && <p ref={errorSummary} tabIndex={-1} role="alert" className="alert alert-danger">{error}</p>}
        <fieldset className="study-goal-fields" disabled={saving}>
          <legend className="visually-hidden">{zh ? '目标计划详情' : 'Goal details'}</legend>
          <label className="form-group">
            <span className="form-label">{zh ? '目标名称' : 'Goal Name'}</span>
            <input ref={firstField} defaultValue={editing?.name} name="name" type="text" className="form-input" required maxLength={250} />
          </label>
          <label className="form-group"><span className="form-label">{zh ? '目标说明（可选）' : 'Goal description (optional)'}</span>
            <input name="goal" className="form-input" maxLength={1000} defaultValue={editing?.goal ?? ''} /></label>
          {!editing && strategies.length > 0 && <label className="form-group">{zh ? '复制周策略配置' : 'Copy weekly strategy settings'}
            <select className="form-input" value={template?.id ?? ''} onChange={e => {
              const source = strategies.find(item => item.id === e.target.value) ?? null;
              setTemplate(source); setDifficultyMix(!!source);
            }}>
              <option value="">{zh ? '自行设置' : 'Custom settings'}</option>
              {strategies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {template && <small>{zh ? '复制一次，可继续修改。目标每天最多 30 题。' : 'Copied once and editable. Goals allow up to 30 problems per day.'}</small>}
          </label>}
          {advanced ? <GoalRouteEditor stages={advanced} lang={lang} onChange={next => { setAdvanced(next); setPreview(null); setError(''); }} /> : <>
          {editing ? <><p className="text-muted">{zh
            ? `已完成 ${editing.completedCore}/${editing.totalCore} 道必做题。保存后会重排剩余题目，已生成的每日题单会保留。`
            : `${editing.completedCore}/${editing.totalCore} core problems complete. Saving reschedules remaining work and keeps saved daily assignments.`}</p>
          <StudyProblemListEditor goal={editing} texts={listDraft ?? originalTexts} lang={lang}
            onChange={next => { setListDraft(next); setPreview(null); setError(''); }} />
          </> : <>
          <div className="form-group">
            <label className="form-label" htmlFor={`${formId}-ids`}>{zh ? '题号列表' : 'Problem IDs'}</label>
            <textarea value={problemText} onChange={e => setProblemText(e.target.value)} id={`${formId}-ids`} name="problemIds" className="form-textarea" rows={4} autoCapitalize="none" spellCheck={false}
              required aria-describedby={`${formId}-ids-help`} />
            <small id={`${formId}-ids-help`} className="text-muted">
              {zh ? '按练习顺序填写本地题库中的题号，用逗号或换行分隔，最多 150 道。'
                : 'Enter up to 150 IDs from your catalog in practice order, separated by commas or newlines.'}
            </small>
          </div>
          <GoalProblemPicker lang={lang} selected={parseGoalIds(problemText)} onAdd={id => { setProblemText(text => [...parseGoalIds(text), id].join('\n')); setPreview(null); }} />
          </>}
          <button type="button" className="btn btn-secondary" onClick={() => {
            const groups = editing ? (listDraft ?? originalTexts).map(parseGoalIds) : [parseGoalIds(problemText)];
            setAdvanced(detailedStages(groups, lang, editing)); setPreview(null);
          }}>{zh ? '编辑阶段与前置题' : 'Edit stages and prerequisites'}</button></>}
          <div className="study-goal-row">
            <label className="form-group">
              <span className="form-label">{zh ? '开始日期' : 'Start Date'}</span>
              <input name="startDate" type="date" className="form-input" defaultValue={editing?.startDate ?? today} readOnly={!!editing && editing.startDate <= today} min={editing && editing.startDate > today ? today : undefined} required />
            </label>
            <label className="form-group">
              <span className="form-label">{zh ? '排题方式' : 'Pacing'}</span>
              <select ref={paceField} className="form-input" value={deadlineMode ? 'deadline' : 'flexible'}
                onChange={e => setDeadlineMode(e.target.value === 'deadline')}>
                <option value="flexible">{zh ? '按日常题量' : 'Set my daily count'}</option>
                <option value="deadline">{zh ? '按截止日倒排' : 'Work toward a deadline'}</option>
              </select>
            </label>
          </div>
          <label className="form-group" hidden={!deadlineMode}>
            <span className="form-label">{zh ? '截止日' : 'Deadline'}</span>
            <input name="deadline" type="date" className="form-input" min={today} defaultValue={editing?.deadline ?? ''} required={deadlineMode} disabled={!deadlineMode} />
          </label>
          <label className="form-group" hidden={deadlineMode}>
            <span className="form-label">{zh ? '每个学习日的题量（含复习）' : 'Problems per study day (including reviews)'}</span>
            <input key={templateKey} name="dailyCount" type="number" className="form-input" min={1} max={30} defaultValue={settings?.dailyCount ?? templateCount} required={!deadlineMode} disabled={deadlineMode} />
          </label>
          {deadlineMode && <p className="text-muted">{zh
            ? '系统把剩余题目分配到截止日之前（含当天）的学习日，并计入到期复习。'
            : 'Remaining problems are spread over your study days through the deadline, with due reviews included.'}</p>}
          <fieldset className="study-goal-fields">
            <legend className="form-label">{zh ? '学习日' : 'Study Days'}</legend>
            <div className="weekday-selector-row">
              {studyWeekdays.map((day) => (
                <label key={templateKey + day} className="form-checkbox-label">
                  <input name="weekdays" value={day} type="checkbox" defaultChecked={settings ? settings.weekdays.includes(day) : template?.weekdays.length ? template.weekdays.includes(day) : day >= 1 && day <= 5} />
                  <span>{t.weekdays[day]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <details className="study-goal-options">
            <summary>{zh ? '题量、难度与复习偏好' : 'Workload, difficulty and reviews'}</summary>
            <div className="study-goal-preferences">
              {!deadlineMode && <label className="form-checkbox-label">
                <input type="checkbox" checked={adaptive} onChange={event => setAdaptive(event.target.checked)} />
                <span>{zh ? '参考多次手动加减题和完成记录，微调日常题量' : 'Adapt my pace after repeated manual edits and completions'}</span>
              </label>}
              <div className="study-goal-row">
                <label className="form-group" hidden={!deadlineMode && !adaptive}>
                  <span className="form-label">{zh ? '每日总量上限（可选）' : 'Daily maximum (optional)'}</span>
                  <input name="maxDailyCount" defaultValue={settings?.maxDailyCount ?? ''} disabled={!deadlineMode && !adaptive} type="number" className="form-input" min={1} max={30} placeholder={zh ? '最多 30' : 'Up to 30'} />
                </label>
                <label className="form-group">
                  <span className="form-label">{zh ? '每日复习上限' : 'Daily review cap'}</span>
                  <input key={templateKey} name="reviewCap" type="number" className="form-input" min={0} max={30} defaultValue={settings?.reviewCap ?? (template ? Math.min(templateCount, reviewCountForRules(template.rules)) : 1)} required />
                </label>
              </div>
              <p className="text-muted">{zh ? '优先安排最早到期的复习。上限填 0 即关闭复习。' : 'The oldest due reviews go first. Enter 0 to turn reviews off.'}</p>
              <label className="form-group">
                <span className="form-label">{zh ? '新题顺序' : 'New problem order'}</span>
                <select className="form-input" value={difficultyMix ? 'mix' : 'list'} onChange={e => setDifficultyMix(e.target.value === 'mix')}>
                  <option value="list">{zh ? '按题单顺序' : 'Follow list order'}</option>
                  <option value="mix">{zh ? '按难度比例调序' : 'Balance by difficulty'}</option>
                </select>
              </label>
              <fieldset className="study-goal-fields" hidden={!difficultyMix} disabled={!difficultyMix}>
                <legend className="form-label">{zh ? '新题难度占比' : 'New problem mix'}</legend>
                <div className="study-goal-row">
                  {difficulties.map((d, i) => <label key={templateKey + d} className="form-group">
                    <span className="form-label">{zh ? ['简单', '中等', '困难'][i] : d} (%)</span>
                    <input name={d} className="form-input" type="number" min={0} max={100} step="any" defaultValue={settings?.difficulty?.[d] ?? template?.rules.difficulty[d] ?? [30, 50, 20][i]} required />
                  </label>)}
                </div>
                <small className="text-muted">{zh ? '总计 100%。在已解锁的题目中跨天平衡难度，填 0 会排除该难度。'
                  : 'Use 100% in total. Difficulty is balanced across days within unlocked problems. A zero excludes that difficulty.'}</small>
              </fieldset>
              <label>{zh ? '题目标签（标识用逗号分隔）' : 'Topic tag slugs (comma separated)'}
                <input className="form-input" key={templateKey} name="tags" defaultValue={(settings?.tags ?? template?.rules.tags ?? []).join(', ')} /></label>
              <label><input key={templateKey} type="checkbox" name="filterReviewTags" defaultChecked={settings?.filterReviewTags ?? (template?.rules.reviewScope === 'matching')} />
                {zh ? '仅复习与标签匹配的题目' : 'Limit reviews to matching tags'}</label>
              <label className="form-checkbox-label">
                <input key={templateKey} type="checkbox" name="premium" defaultChecked={settings?.premium ?? template?.rules.premium ?? false} />
                <span>{zh ? '允许安排会员题' : 'Allow Premium problems'}</span>
              </label>
            </div>
          </details>
        </fieldset>
      </form>
      <details className="study-goal-options" onToggle={event => { if (event.currentTarget.open) setGlobalOpen(true); }}>
        <summary>{zh ? '全局复习间隔' : 'Review spacing for all plans'}</summary>
        {globalOpen && <p>{globalSummary} {zh ? '可在「设置 → 练习与笔记」中修改。' : 'Edit in Settings → Practice & notes.'}</p>}
      </details>
      {preview && <section ref={previewSummary} tabIndex={-1} className="study-goal-preview"
        aria-label={zh ? '排题预览' : 'Schedule preview'}>
        <h3>{zh ? '排题预览' : 'Schedule preview'}</h3>
        {(advanced || listDraft) && <p>{zh ? `修改后已完成 ${preview.completedCore}/${preview.totalCore} 道必做题。`
          : `${preview.completedCore}/${preview.totalCore} core problems complete after your edits.`}</p>}
        <p>{preview.completedCore === preview.totalCore
          ? (zh ? '题单中的必做题都已完成。' : 'You have completed every core problem in this list.')
          : preview.deadlineShortfall
          ? (zh ? `截止日仍差 ${preview.deadlineShortfall} 道必做题。可以增加学习日、提高总量上限或延后截止日。`
            : `${preview.deadlineShortfall} ${preview.deadlineShortfall === 1 ? 'core problem falls' : 'core problems fall'} beyond the deadline. Add study days, raise the maximum or move the deadline.`)
          : preview.estimatedFinish && (zh ? `预计完成于 ${preview.estimatedFinish}` : `Estimated finish ${preview.estimatedFinish}`)}</p>
        {preview.calendar.length > 5 && <p className="text-muted">{zh ? '前 5 个学习日' : 'First 5 study days'}</p>}
        <ol className="study-calendar">
          {preview.calendar.slice(0, 5).map(day => {
            const fresh = day.items.filter(item => item.kind === 'new').length;
            const reviews = day.items.length - fresh;
            return <li key={day.date}><time dateTime={day.date}>{day.date}{day.saved && (zh ? '（已生成）' : ' (saved)')}</time><span>
              {zh ? `${fresh} 道新题 · ${reviews} 道复习` : `${fresh} new · ${reviews} review`}</span>
              {(advanced || listDraft) && fresh > 0 && <small className="text-muted"> {day.items.filter(item => item.kind === 'new').map(item => '#' + item.frontendId).join(', ')}</small>}</li>;
          })}
        </ol>
      </section>}
    </Dialog>
  );
}

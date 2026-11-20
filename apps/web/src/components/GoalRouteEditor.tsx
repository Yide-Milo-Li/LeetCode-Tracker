import { useId, useState } from 'react';
import type { StudyPlanInput, StudyPlanView } from '../../../../packages/contracts/src/study-plan.ts';
import type { Language } from '../i18n.ts';
import { GoalProblemPicker } from './GoalProblemPicker.tsx';
import { parseGoalIds } from './StudyProblemListEditor.tsx';

export type RouteStages = StudyPlanInput['stages'];
type RouteItem = RouteStages[number]['items'][number];
function newItem(id: string, lang: Language): RouteItem {
  return {
    frontendId: id,
    purpose: (lang === 'zh' ? '练习 #' : 'Practice #') + id,
    optional: false,
    requires: [],
  };
}
export function detailedStages(groups: string[][], lang: Language, view?: StudyPlanView): RouteStages {
  const byFrontendId = new Map(view?.nodes.map((node) => [node.frontendId, node]));
  const ids = new Map(view?.nodes.map((node) => [node.questionId, node.frontendId]));
  return groups.map((group, index) => ({
    name: view?.stages[index] ?? (lang === 'zh' ? '目标题单' : 'Goal problem list'),
    items: group.map((id) => {
      const old = byFrontendId.get(id);
      return old
        ? {
            frontendId: id,
            purpose: old.purpose,
            optional: old.optional,
            requires: old.requires.map((key) => ids.get(key)!),
          }
        : newItem(id, lang);
    }),
  }));
}

export function GoalRouteEditor({
  stages,
  onChange,
  lang,
}: {
  stages: RouteStages;
  onChange(next: RouteStages): void;
  lang: Language;
}) {
  const zh = lang === 'zh';
  const id = useId();
  const [stageIndex, setStageIndex] = useState(0);
  const [itemIndex, setItemIndex] = useState(0);
  const [bulk, setBulk] = useState('');
  const [error, setError] = useState('');
  const stage = stages[stageIndex];
  const index = Math.min(itemIndex, stage.items.length - 1);
  const item = stage.items[index];
  const ids = stages.flatMap((group) => group.items.map((node) => node.frontendId));
  const earlier = [
    ...stages.slice(0, stageIndex).flatMap((group) => group.items),
    ...stage.items.slice(0, Math.max(0, index)),
  ].map((node) => node.frontendId);
  function change(next: RouteStages) {
    setError('');
    onChange(next);
  }
  function updateStage(next: RouteStages[number]) {
    change(stages.map((group, i) => (i === stageIndex ? next : group)));
  }
  function updateItem(patch: Partial<RouteItem>) {
    updateStage({ ...stage, items: stage.items.map((node, i) => (i === index ? { ...node, ...patch } : node)) });
  }
  function add(next: string[]) {
    if (!next.length) return;
    const all = [...ids, ...next];
    if (all.length > 150 || new Set(all).size !== all.length) {
      setError(zh ? '整份题单最多 150 题，各题号须唯一。' : 'Use up to 150 unique IDs across the route.');
      return;
    }
    updateStage({ ...stage, items: [...stage.items, ...next.map((value) => newItem(value, lang))] });
    setItemIndex(stage.items.length);
    setBulk('');
  }
  function moveStage(step: number) {
    const next = [...stages],
      target = stageIndex + step;
    [next[stageIndex], next[target]] = [next[target], next[stageIndex]];
    change(next);
    setStageIndex(target);
  }
  function moveItem(target: number, position: number) {
    const next = stages.map((group) => ({ ...group, items: [...group.items] }));
    next[stageIndex].items.splice(index, 1);
    next[target].items.splice(position, 0, item);
    change(next);
    setStageIndex(target);
    setItemIndex(position);
  }
  return (
    <fieldset className="study-goal-fields goal-route-editor">
      <legend>{zh ? '阶段与前置题' : 'Stages and prerequisites'}</legend>
      <label htmlFor={id + '-stage'}>{zh ? '学习阶段' : 'Stage'}</label>
      <select
        id={id + '-stage'}
        className="form-input"
        value={stageIndex}
        onChange={(e) => {
          setStageIndex(Number(e.target.value));
          setItemIndex(0);
          setBulk('');
        }}
      >
        {stages.map((group, i) => (
          <option value={i} key={i}>
            {i + 1}. {group.name} ({group.items.length})
          </option>
        ))}
      </select>
      <label>
        {zh ? '阶段名称' : 'Stage name'}
        <input
          className="form-input"
          required
          maxLength={250}
          value={stage.name}
          onChange={(e) => updateStage({ ...stage, name: e.target.value })}
        />
      </label>
      <div className="action-row">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={stages.length >= 30}
          onClick={() => {
            change([...stages, { name: (zh ? '阶段 ' : 'Stage ') + (stages.length + 1), items: [] }]);
            setStageIndex(stages.length);
            setItemIndex(0);
            setBulk('');
          }}
        >
          {zh ? '新增阶段' : 'Add stage'}
        </button>
        <button type="button" className="text-link" disabled={stageIndex === 0} onClick={() => moveStage(-1)}>
          {zh ? '前移阶段' : 'Earlier stage'}
        </button>
        <button
          type="button"
          className="text-link"
          disabled={stageIndex === stages.length - 1}
          onClick={() => moveStage(1)}
        >
          {zh ? '后移阶段' : 'Later stage'}
        </button>
        <button
          type="button"
          className="text-link"
          disabled={stages.length === 1 || !!stage.items.length}
          onClick={() => {
            change(stages.filter((_, i) => i !== stageIndex));
            setStageIndex(Math.max(0, stageIndex - 1));
            setItemIndex(0);
          }}
        >
          {zh ? '删除空阶段' : 'Delete empty stage'}
        </button>
      </div>
      <GoalProblemPicker lang={lang} selected={ids} onAdd={(problem) => add([problem])} />
      <label>
        {zh ? '批量加入本阶段' : 'Paste IDs into this stage'}
        <textarea className="form-textarea" rows={2} value={bulk} onChange={(e) => setBulk(e.target.value)} />
      </label>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!bulk.trim()}
        onClick={() => add(parseGoalIds(bulk))}
      >
        {zh ? '加入题号' : 'Add IDs'}
      </button>
      {item && (
        <>
          <label>
            {zh ? '编辑题目' : 'Edit route problem'}
            <select className="form-input" value={index} onChange={(e) => setItemIndex(Number(e.target.value))}>
              {stage.items.map((node, i) => (
                <option key={i} value={i}>
                  {i + 1}. #{node.frontendId}
                </option>
              ))}
            </select>
          </label>
          <div className="action-row">
            <button
              type="button"
              className="text-link"
              disabled={!index}
              onClick={() => moveItem(stageIndex, index - 1)}
            >
              {zh ? '上移题目' : 'Move up'}
            </button>
            <button
              type="button"
              className="text-link"
              disabled={index === stage.items.length - 1}
              onClick={() => moveItem(stageIndex, index + 1)}
            >
              {zh ? '下移题目' : 'Move down'}
            </button>
            <button
              type="button"
              className="text-link"
              onClick={() => {
                if (stages.some((group) => group.items.some((node) => node.requires.includes(item.frontendId)))) {
                  setError(zh ? '请先移除其他题目对此题的依赖。' : 'Remove dependencies on this problem first.');
                  return;
                }
                updateStage({ ...stage, items: stage.items.filter((_, i) => i !== index) });
              }}
            >
              {zh ? '移除题目' : 'Remove problem'}
            </button>
          </div>
          {stages.length > 1 && (
            <label>
              {zh ? '移到阶段' : 'Move to stage'}
              <select
                className="form-input"
                value={stageIndex}
                onChange={(e) => {
                  const target = Number(e.target.value);
                  moveItem(target, stages[target].items.length);
                }}
              >
                {stages.map((group, i) => (
                  <option value={i} key={i}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {zh ? '练习目的' : 'Practice purpose'}
            <input
              className="form-input"
              required
              maxLength={250}
              value={item.purpose}
              onChange={(e) => updateItem({ purpose: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={item.optional}
              onChange={(e) => updateItem({ optional: e.target.checked })}
            />{' '}
            {zh ? '选做题' : 'Optional problem'}
          </label>
          <fieldset className="study-goal-fields">
            <legend>{zh ? '前置题' : 'Prerequisite problems'}</legend>
            <div className="tag-chips-scroll">
              {[...new Set([...earlier, ...item.requires])].map((dep) => (
                <label key={dep}>
                  <input
                    type="checkbox"
                    checked={item.requires.includes(dep)}
                    onChange={(e) =>
                      updateItem({
                        requires: e.target.checked
                          ? [...item.requires, dep]
                          : item.requires.filter((value) => value !== dep),
                      })
                    }
                  />{' '}
                  #{dep}
                  {!earlier.includes(dep) && (zh ? '（须排在前面）' : ' (must come earlier)')}
                </label>
              ))}
            </div>
            {!earlier.length && !item.requires.length && (
              <small>
                {zh ? '前面的题目可设为前置题。' : 'Earlier problems can be selected as prerequisites.'}
              </small>
            )}
          </fieldset>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}

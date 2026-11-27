import React, { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ChatModelSelection, ChatProviderOption, ChatStatus } from '../../../../packages/contracts/src/chat.ts';
import { chatModelPresets, getSupportedReasoningEfforts, resolveModelReasoningEffort, type LLMProvider, type ReasoningEffort } from '../../../../packages/contracts/src/llm-models.ts';
import { api } from '../api.ts';
import { CHAT_REQUEST_TURNS } from '../chat/chat-history.ts';
import { useAsyncResource } from '../hooks/useAsyncResource.ts';
import type { Language } from '../i18n.ts';
import type { ActionPopover } from './ui.tsx';

export const providerNames: Record<LLMProvider, string> = { openai: 'OpenAI', deepseek: 'DeepSeek', gemini: 'Gemini' };
const effortNames: Record<ReasoningEffort, [string, string]> = {
  none: ['Off', '关闭'], low: ['Low', '低'], medium: ['Medium', '中'], high: ['High', '高'],
  xhigh: ['Extra high', '超高'], max: ['Max', '最高'],
};
const shortModel = (model: string) => model.replace(/^models\//, '');

/** Never copy provider configuration fields into a chat request. */
function selectionOf({ provider, model, reasoningEffort }: ChatModelSelection): ChatModelSelection {
  return { provider, model, reasoningEffort };
}

export function conversationRecipient(status: ChatStatus | null, saved?: ChatModelSelection) {
  const provider = saved?.provider ?? status?.provider;
  const option = status?.providers?.find(item => item.provider === provider);
  const selection = saved ?? (option && selectionOf(option));
  const unavailableModel = Boolean(saved && option && !option.accountModels && saved.model !== option.model
    && !chatModelPresets[option.provider].includes(saved.model));
  return {
    ready: !unavailableModel && (option?.configured ?? (!saved && !status?.providers && status?.configured === true)),
    selection, provider, unavailableModel,
  };
}

function ProviderMark({ provider }: { provider: LLMProvider }) {
  return <span aria-hidden="true" className="chat-provider-mark" data-provider={provider} />;
}

interface PickerProps {
  lang: Language;
  active: ChatModelSelection;
  providers: ChatProviderOption[];
  hasHistory: boolean;
  hasProblem: boolean;
  busy: boolean;
  onApply: (selection: ChatModelSelection) => void;
  onSettings: () => void;
}

function ModelChoices({ lang, active, providers, hasHistory, hasProblem, busy, onApply, onSettings }: PickerProps) {
  const zh = lang === 'zh';
  const [draft, setDraft] = useState(active);
  const [reload, setReload] = useState(0);
  const config = providers.find(item => item.provider === draft.provider)!;
  const accountList = config.configured && config.accountModels;
  const account = useAsyncResource(() => api.getOpenAIChatGPTModels(reload > 0), [reload], accountList);
  const accountModels = accountList ? account.data?.models ?? [] : [];
  const accountModel = accountModels.find(item => item.slug === draft.model);
  const efforts = accountModel?.reasoningEfforts ?? getSupportedReasoningEfforts(draft.provider, draft.model);
  const effort = efforts.includes(draft.reasoningEffort) ? draft.reasoningEffort : accountModel?.defaultEffort ?? efforts[0];
  const models = [...new Set([
    ...(config.accountModels ? accountModels.map(item => item.slug) : chatModelPresets[draft.provider]),
    config.model,
    ...(accountList && (!account.data || account.error) ? [draft.model] : []),
  ])];
  const name = providerNames[draft.provider];
  const historyLimit = CHAT_REQUEST_TURNS - 1;
  const changedProvider = active.provider !== draft.provider;
  const changed = changedProvider || active.model !== draft.model || active.reasoningEffort !== effort;
  const selectProvider = (option: ChatProviderOption) => {
    if (option.provider !== draft.provider) setDraft(selectionOf(option.provider === active.provider ? active : option));
  };

  return <>
    <div className="chat-model-grid">
      <div className="chat-provider-rail" role="group" aria-label={zh ? '供应商' : 'Provider'}>
        {providers.map(option => {
          const label = providerNames[option.provider] + (option.configured ? '' : (zh ? '（未连接）' : ' (not connected)'));
          return <button key={option.provider} type="button" aria-label={label} title={label}
            aria-pressed={option.provider === draft.provider} data-connected={option.configured}
            onClick={() => selectProvider(option)}><ProviderMark provider={option.provider} /></button>;
        })}
      </div>
      <div className="chat-model-choices">
        <strong>{config.accountModels ? 'Codex · ChatGPT' : name}</strong>
        {config.configured ? <>
          <div className="chat-model-list" role="group" aria-label={zh ? '模型' : 'Model'}>
            {models.map(model => <button type="button" key={model} aria-pressed={model === draft.model}
              onClick={() => setDraft({ ...draft, model, reasoningEffort: resolveModelReasoningEffort(draft.provider, model, draft.reasoningEffort) })}>
              <span>{accountModels.find(item => item.slug === model)?.displayName ?? shortModel(model)}</span>
              {model === draft.model && <Check size={14} aria-hidden="true" />}
            </button>)}
          </div>
          {!models.includes(draft.model) && <small role="status">{zh ? '原模型已不在列表中，请选择其他模型。' : 'The previous model is no longer listed. Choose another model.'}</small>}
          {accountList && account.loading && <small role="status">{zh ? '正在读取账号模型…' : 'Loading account models…'}</small>}
          {accountList && !account.loading && Boolean(account.error) && <small role="status">
            {zh ? '暂时无法读取账号模型。' : 'Could not load account models.'}{' '}
            <button type="button" className="chat-model-link" onClick={() => setReload(count => count + 1)}>{zh ? '重试' : 'Retry'}</button>
          </small>}
          <label className="chat-effort-field">
            <span>{zh ? '推理强度' : 'Reasoning effort'}</span>
            <select value={effort} onChange={event => setDraft({ ...draft, reasoningEffort: event.target.value as ReasoningEffort })}>
              {efforts.map(effort =>
                <option key={effort} value={effort}>{effortNames[effort][zh ? 1 : 0]}</option>)}
            </select>
          </label>
        </> : <div className="chat-model-disconnected">
          <p>{zh ? `连接 ${name} 后即可在此对话中使用。` : `Connect ${name} to use it in this conversation.`}</p>
          <button type="button" className="chat-model-link" onClick={onSettings}>{zh ? '打开 AI 设置' : 'Open AI settings'}</button>
        </div>}
      </div>
    </div>
    {config.configured && <div className="chat-model-apply">
      {changedProvider && <p role="status">{zh
        ? `下次发送时，${name} 会收到你的提问${hasHistory ? `、最近的问答和选取的早期片段（本对话最多 ${historyLimit} 条历史消息）` : ''}${hasProblem ? '，以及随题附带的题目、练习和笔记资料' : ''}。`
        : `Your next message goes to ${name}${hasHistory ? ` with recent messages and selected earlier excerpts (up to ${historyLimit} messages from this chat)` : ''}${hasProblem ? ', including any attached problem, practice, and note details' : ''}.`}</p>}
      {busy && changed && <p>{zh ? '当前回答会继续使用原模型。' : 'The current reply will finish with its original model.'}</p>}
      <button className="btn btn-primary" type="button" disabled={!changed || !models.includes(draft.model)} onClick={() => onApply({ ...selectionOf(draft), reasoningEffort: effort })}>
        {zh ? '应用到此对话' : 'Apply to this chat'}
      </button>
    </div>}
  </>;
}

export function ChatModelPicker({ popover, ...props }: PickerProps & { popover: ActionPopover }) {
  const { active, lang } = props;
  const zh = lang === 'zh';
  const model = shortModel(active.model);
  const effort = effortNames[active.reasoningEffort][zh ? 1 : 0];
  const label = `${zh ? '选择模型' : 'Choose model'} · ${providerNames[active.provider]} · ${model} · ${effort}`;
  return <>
    <button type="button" className="chat-model-trigger" {...popover.triggerProps}
      disabled={!props.providers.length} aria-label={label} title={label}>
      <ProviderMark provider={active.provider} /><span className="chat-model-name">{model}</span>
      <span className="chat-model-effort">{effort}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {popover.rendered && <div className="notes-dropdown-menu chat-model-popover" {...popover.panelProps}
      role="group" aria-label={zh ? '对话模型' : 'Conversation model'}>
      {popover.open && props.providers.some(item => item.provider === active.provider) && <ModelChoices {...props} />}
    </div>}
  </>;
}

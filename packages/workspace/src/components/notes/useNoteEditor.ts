/**
 * Selected-note editor state for the notes workspace: loading the note and its practice
 * timeline, the draft revision counter, the serialized save chain, format-on-save undo and
 * the AI format review.
 *
 * These pieces share one revision model (`draft.revision`, `editorSession`, `aiSerial`), so
 * they deliberately live together: every async result is checked against the visit and draft
 * revision that started it before it may touch state.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { BusinessVersions } from '../../../../contracts/src/agent-operations.ts';
import { problemNoteSchema } from '../../../../contracts/src/notes.ts';
import {
  type ProblemNote,
  type ProblemNoteSummary,
  type PracticeRecord,
  type NoteFormatResponse,
  hasMeaningfulNoteContent,
} from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';
import { localizeApiError } from '../../error-i18n.ts';
import { OperationStateError, operationMessage } from '../../client.ts';
import { useWorkspaceEnvironment } from '../../context.tsx';
import { createDraftSession } from '../../draft-session.ts';
import { formatNoteInWorker } from '../../markdown-format-client.ts';
import type { FormatOnSaveSetting } from './useFormatOnSaveSetting.ts';

/** One visit of one selected problem; `active` turns false when the selection changes or unmounts. */
export type EditorSession = { active: boolean; saving: boolean; saveVersion: number };

/** AI format review bound to the visit and draft revision it was opened for. */
export type AiReview = {
  session: EditorSession;
  revision: number;
  source: string;
  selection?: { start: number; end: number };
  range?: { start: number; end: number };
  stage: 'preparing' | 'ready' | 'generating' | 'review' | 'error';
  configured?: boolean;
  provider?: string;
  result?: NoteFormatResponse;
  error?: string;
};

interface UseNoteEditorOptions {
  lang: Language;
  selectedId: string | null;
  /** Raw controlled prop; `boolean` wins over the resolved setting refs at save time. */
  controlledFormatOnSave: boolean | null | undefined;
  formatSetting: FormatOnSaveSetting;
  /** List-owned setters patched after a save and cleared when nothing is selected. */
  setSelectedSummary: Dispatch<SetStateAction<ProblemNoteSummary | null>>;
  setItems: Dispatch<SetStateAction<ProblemNoteSummary[]>>;
  setListRevision: Dispatch<SetStateAction<number>>;
  /** Workspace root; polling pauses while a retained view is hidden. */
  rootRef: RefObject<HTMLDivElement | null>;
  /** Reported after each save with whether newer unsaved edits remain. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * Own the editor for the selected problem.
 *
 * Side effects: resets the visit on every selection change; fetches the note and practice
 * records for the selection (cancellable, retryable); registers a `beforeunload` guard while
 * unsaved edits exist; saves through a per-problem promise chain and refreshes the list after
 * a successful save. Save failures surface as a localized `saveError`.
 *
 * Host integration: reads and writes go through the host client; drafts are retained through
 * the host draft store when available; host operation receipts, refresh events and a business
 * version poll keep the saved baseline current without discarding unsaved edits.
 */
export function useNoteEditor({
  lang,
  selectedId,
  controlledFormatOnSave,
  formatSetting,
  setSelectedSummary,
  setItems,
  setListRevision,
  rootRef,
  onDirtyChange,
}: UseNoteEditorOptions) {
  const environment = useWorkspaceEnvironment();
  const api = environment.client;
  const zh = lang === 'zh';
  const t = translations[lang];
  const { settingReady, settingValue } = formatSetting;

  const [noteContent, setNoteContentState] = useState('');
  const draft = useRef({ value: '', revision: 0 });
  const [formatUndo, setFormatUndo] = useState<{ before: string; revision: number; session: EditorSession } | null>(null);
  const bypassFormatRevision = useRef<number | null>(null);
  /** Increment the draft revision on every editor mutation, including undo and template insertion. */
  const setNoteContent = useCallback((value: string) => {
    draft.current = { value, revision: draft.current.revision + 1 };
    bypassFormatRevision.current = null;
    setFormatUndo(null);
    setNoteContentState(value);
  }, []);
  const [savedContent, setSavedContent] = useState('');
  const [savedRevision, setSavedRevision] = useState(0);
  const [savedGeneration, setSavedGeneration] = useState(0);
  const [remoteNote, setRemoteNote] = useState<{ content: string; revision: number; libraryGeneration: number } | null>(null);
  const [loadingNote, setLoadingNote] = useState(false);
  const [noteLoadError, setNoteLoadError] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [formatNotice, setFormatNotice] = useState('');
  const [aiReview, setAiReview] = useState<AiReview | null>(null);
  const aiSerial = useRef(0);
  const [retryRevision, setRetryRevision] = useState(0);
  const recovery = useRef<ReturnType<typeof createDraftSession> | null>(null);
  const [draftStatus, setDraftStatus] = useState('');
  const [externalChange, setExternalChange] = useState(false);
  const draftActivity = useRef({ dirty: false, saving: false });
  const editorSession = useRef({ active: false, saving: false, saveVersion: 0 });
  const savingRevision = useRef<number | null>(null);
  const problemSaveVersion = useRef<Map<string, number>>(new Map());
  const problemSaveChain = useRef<Map<string, Promise<{ note: ProblemNote; baseRevision: number; baseGeneration: number } | null>>>(new Map());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // A -> B -> A creates a new visit too; comparing question IDs alone is insufficient.
    const session = { active: true, saving: false, saveVersion: 0 };
    editorSession.current = session;
    savingRevision.current = null;
    setSavingNote(false);
    setFormatUndo(null);
    setAiReview(null);
    setFormatNotice('');
    aiSerial.current++;
    return () => { session.active = false; };
  }, [selectedId]);

  /** Restore the last automatically formatted snapshot without immediately formatting it again. */
  function handleUndoFormat() {
    if (!formatUndo || formatUndo.session !== editorSession.current || draft.current.revision !== formatUndo.revision) return;
    const before = formatUndo.before;
    setNoteContent(before);
    bypassFormatRevision.current = draft.current.revision;
    setSaveSuccess(false);
  }

  /** Invalidate any pending proposal when the review closes. */
  const closeAiReview = useCallback(() => { aiSerial.current++; setAiReview(null); }, []);

  /** Determine the exact block scope and provider status before sending any note text. */
  async function openAiReview() {
    const session = editorSession.current;
    const source = draft.current.value;
    if (!session.active || !source.trim()) return;
    const revision = draft.current.revision;
    const el = textareaRef.current;
    const selection = el && el.selectionEnd > el.selectionStart
      ? { start: el.selectionStart, end: el.selectionEnd } : undefined;
    const serial = ++aiSerial.current;
    const review: AiReview = { session, revision, source, selection, stage: 'preparing' };
    setAiReview(review);
    try {
      const [markdown, status] = await Promise.all([
        import('../../../../markdown/src/index.ts'), api.getNoteFormatStatus(),
      ]);
      const prepared = markdown.prepareAiFormat(source, selection);
      if (aiSerial.current !== serial || !session.active) return;
      if (draft.current.revision !== revision) { setAiReview({ ...review, stage: 'error', error: t.notesAiStale }); return; }
      setAiReview({ ...review, stage: 'ready', range: prepared.range, configured: status.configured, provider: status.provider });
    } catch (err) {
      if (aiSerial.current !== serial || !session.active) return;
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      setAiReview({ ...review, stage: 'error', error: code.includes('TOO_LARGE') ? t.notesAiTooLarge : t.notesAiFailed });
    }
  }

  /** A stale response can never be shown or applied to a later draft or problem visit. */
  async function generateAiSuggestion() {
    const review = aiReview;
    if (!review || review.stage !== 'ready' || !review.configured || !review.range) return;
    if (!review.session.active || draft.current.revision !== review.revision) {
      setAiReview({ ...review, stage: 'error', error: t.notesAiStale });
      return;
    }
    const serial = ++aiSerial.current;
    setAiReview({ ...review, stage: 'generating' });
    try {
      const result = await api.formatNote({ content: review.source, selection: review.selection });
      if (aiSerial.current !== serial || !review.session.active) return;
      if (draft.current.revision !== review.revision) { setAiReview({ ...review, stage: 'error', error: t.notesAiStale }); return; }
      if (result.range.start !== review.range.start || result.range.end !== review.range.end
        || result.content.length > 100000 || !result.content.startsWith(review.source.slice(0, review.range.start))
        || !result.content.endsWith(review.source.slice(review.range.end))
        || hasMeaningfulNoteContent(result.content) !== hasMeaningfulNoteContent(review.source)) {
        throw new Error('Unsafe candidate');
      }
      setAiReview({ ...review, stage: 'review', result });
    } catch (err) {
      if (aiSerial.current !== serial || !review.session.active) return;
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      setAiReview({ ...review, stage: 'error', error: code.includes('TOO_LARGE') ? t.notesAiTooLarge : t.notesAiFailed });
    }
  }

  /** Apply only to the unchanged source visit; persistence remains an explicit save. */
  function applyAiSuggestion() {
    const review = aiReview;
    if (!review?.result || !review.session.active || draft.current.revision !== review.revision) {
      if (review) setAiReview({ ...review, stage: 'error', error: t.notesAiStale });
      return;
    }
    const before = draft.current.value;
    setNoteContent(review.result.content);
    setFormatUndo({ before, revision: draft.current.revision, session: review.session });
    closeAiReview();
  }

  // Selected problem practice timeline
  const [practices, setPractices] = useState<PracticeRecord[]>([]);
  const [loadingPractices, setLoadingPractices] = useState(false);

  /** Helper to wrap or insert markdown text at current selection cursor */
  const wrapTextareaSelection = useCallback(
    (prefix: string, suffix: string, defaultPlaceholder: string) => {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const val = el.value;
      const selected = val.substring(start, end) || defaultPlaceholder;
      const replacement = `${prefix}${selected}${suffix}`;
      const nextVal = val.substring(0, start) + replacement + val.substring(end);
      setNoteContent(nextVal);
      setTimeout(() => {
        el.focus();
        el.selectionStart = start + prefix.length;
        el.selectionEnd = start + prefix.length + selected.length;
      }, 0);
    },
    []
  );

  draftActivity.current = { dirty: noteContent !== savedContent, saving: savingNote };

  useEffect(() => {
    if (!api.drafts || !selectedId || loadingNote || noteLoadError || !recovery.current) return;
    let active = true;
    const session = recovery.current;
    setDraftStatus(zh ? '草稿尚未保留' : 'Draft not yet retained');
    const timer = setTimeout(() => {
      void session
        .write(noteContent === savedContent ? null : noteContent, savedRevision, savedGeneration)
        .then(() => { if (active) setDraftStatus(noteContent === savedContent ? '' : zh ? '草稿已保留' : 'Draft retained'); })
        .catch((e) => { if (active) setDraftStatus(String(e.message)); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [api, selectedId, noteContent, savedContent, savedRevision, savedGeneration, loadingNote, noteLoadError, zh, environment.connected]);

  useEffect(() => environment.host.subscribe((event) => {
    if (event.type !== 'operation' || event.operation.target !== `note:${selectedId}`) return;
    if (event.operation.status === 'applied') {
      const result = event.operation.data as { note?: unknown } | undefined;
      const parsed = problemNoteSchema.safeParse(result?.note);
      if (!parsed.success) return;
      const note = parsed.data;
      setSavedContent(note.content); setSavedRevision(note.revision); setSavedGeneration(note.libraryGeneration);
      setSaveError(''); setSaveSuccess(true); setRemoteNote(null); setExternalChange(false);
      setListRevision((value) => value + 1);
    } else {
      setSaveSuccess(false); setSaveError(operationMessage(new OperationStateError(event.operation), lang));
      if (event.operation.status === 'external_change') setExternalChange(true);
    }
  }), [environment.host, selectedId, lang]);

  useEffect(() => environment.host.subscribe((event) => {
    if (event.type !== 'refresh' && !(event.type === 'connection' && event.connected)) return;
    setListRevision((value) => value + 1);
    if (draftActivity.current.dirty || draftActivity.current.saving) setExternalChange(true);
    else setRetryRevision((value) => value + 1);
  }), [environment.host]);

  // A changed generation invalidates drafts even when restored notes reuse or lower their revision.
  useEffect(() => {
    let active = true;
    let checking = false;
    let previous: BusinessVersions | null = null;
    const check = async () => {
      if (!active || checking || loadingNote || document.visibilityState === 'hidden' || rootRef.current?.closest('[hidden]')) return;
      checking = true;
      try {
        const versions = await api.getBusinessVersions();
        if (!active) return;
        const libraryChanged = previous?.libraryGeneration !== versions.libraryGeneration;
        const notesChanged = libraryChanged || previous?.notes !== versions.notes;
        const practiceChanged = libraryChanged || previous?.practice !== versions.practice;
        if (notesChanged || practiceChanged || previous?.catalog !== versions.catalog) setListRevision((v) => v + 1);
        previous = versions;
        if (!selectedId) return;
        if (practiceChanged) {
          const history = await api.getPracticeRecords({ questionFrontendId: selectedId, page: 1, limit: 100 });
          if (active) setPractices(history.items);
        }
        if (!notesChanged) return;
        const res = await api.getNote(selectedId);
        if (!active) return;
        const revision = res.note?.revision ?? 0;
        const generation = res.libraryGeneration;
        if (revision !== savedRevision || generation !== savedGeneration) {
          if (draftActivity.current.dirty || draftActivity.current.saving) {
            setRemoteNote({ content: res.note?.content ?? '', revision, libraryGeneration: generation });
            setExternalChange(true);
          } else {
            const content = res.note?.content ?? '';
            setNoteContent(content); setSavedContent(content); setSavedRevision(revision);
            setSavedGeneration(generation); setRemoteNote(null); setExternalChange(false);
          }
        }
      } catch { /* A failed poll cannot replace or discard the current editor session. */ }
      finally { checking = false; }
    };
    const focus = () => { void check(); };
    const interval = setInterval(focus, 2000);
    window.addEventListener('focus', focus);
    window.addEventListener('hashchange', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener('focus', focus);
      window.removeEventListener('hashchange', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [api, selectedId, savedRevision, savedGeneration, loadingNote]);

  // Initial loads and retries share cancellation, independently of list and language changes.
  useEffect(() => {
    if (!selectedId) {
      setSelectedSummary(null);
      setNoteContent('');
      setSavedContent('');
      setSavedRevision(0);
      setSavedGeneration(0);
      setRemoteNote(null);
      setPractices([]);
      setNoteLoadError(false);
      return;
    }

    let active = true;
    setLoadingNote(true);
    setSaveSuccess(false);
    setSaveError('');
    setNoteLoadError(false);
    recovery.current = null;
    setDraftStatus('');

    // Fetch note content, then restore a retained draft for the same problem when one exists.
    api
      .getNote(selectedId)
      .then(async (res) => {
        if (!active) return;
        const content = res.note?.content ?? '';
        const session = api.drafts ? createDraftSession(api.drafts, 'note', selectedId) : null;
        const restored = session ? await session.read() : null;
        if (!active) return;
        recovery.current = session;
        setNoteContent(restored?.draft?.content ?? content);
        setSavedContent(content);
        setSavedRevision(res.note?.revision ?? 0);
        const conflict = Boolean(restored?.draft && (
          restored.draft.baseRevision !== (res.note?.revision ?? 0) || restored.draft.libraryGeneration !== res.libraryGeneration
        ));
        setSavedGeneration(res.libraryGeneration);
        setRemoteNote(conflict ? { content, revision: res.note?.revision ?? 0, libraryGeneration: res.libraryGeneration } : null);
        setExternalChange(conflict);
      })
      .catch(() => {
        if (active) {
          setNoteLoadError(true);
        }
      })
      .finally(() => {
        if (active) setLoadingNote(false);
      });

    // Fetch practice timeline
    setLoadingPractices(true);
    api
      .getPracticeRecords({ questionFrontendId: selectedId, page: 1, limit: 100 })
      .then((res) => {
        if (!active) return;
        setPractices(res.items);
      })
      .catch(() => {
        if (active) setPractices([]);
      })
      .finally(() => {
        if (active) setLoadingPractices(false);
      });

    return () => {
      active = false;
    };
  }, [selectedId, retryRevision]);

  /** Retry through the cancellable loading effect rather than a separate unguarded request. */
  const handleRetryLoad = useCallback(() => {
    if (selectedId) setRetryRevision((current) => current + 1);
  }, [selectedId]);

  // Meaningful note validity check & save eligibility
  const isModified = noteContent !== savedContent;
  const isBlank = noteContent.trim().length === 0;
  const hasMeaningful = hasMeaningfulNoteContent(noteContent);
  const canSave =
    environment.host.capabilities.noteEditing &&
    !loadingNote &&
    !savingNote &&
    !noteLoadError &&
    !remoteNote &&
    savedGeneration > 0 &&
    isModified &&
    (isBlank ? savedContent.trim().length > 0 : hasMeaningful);

  // Phase 30: Unsaved note modifications check
  // A saved snapshot may switch safely, but newer edits made while saving still need protection.
  const hasUnsavedChanges =
    !loadingNote &&
    (!savingNote || draft.current.revision !== savingRevision.current) &&
    isModified &&
    (savedContent.trim().length > 0 || noteContent.trim().length > 0);

  // The undo button only belongs to the visit and draft revision that produced the format.
  const canUndoFormat = Boolean(
    formatUndo && formatUndo.session === editorSession.current && formatUndo.revision === draft.current.revision,
  );

  // Phase 30: Browser beforeunload guard when unsaved changes exist
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  /** Persist one snapshot, serializing writes and retaining newer edits from the same visit. Resolves true when the editor is clean. */
  async function handleSaveNote(): Promise<boolean> {
    const session = editorSession.current;
    if (!selectedId || !canSave || !session.active || session.saving) return false;
    // Synchronous guard also blocks repeated shortcuts before React commits savingNote.
    session.saving = true;
    const saveVersion = ++session.saveVersion;
    const targetId = selectedId;
    const problemVersion = (problemSaveVersion.current.get(targetId) ?? 0) + 1;
    problemSaveVersion.current.set(targetId, problemVersion);
    const isLatestProblemSave = () =>
      editorSession.current.active && problemSaveVersion.current.get(targetId) === problemVersion;
    const targetContent = draft.current.value;
    const targetRevision = draft.current.revision;
    savingRevision.current = targetRevision;
    const bypass = bypassFormatRevision.current === targetRevision;
    const formatEnabled =
      typeof controlledFormatOnSave === 'boolean'
        ? controlledFormatOnSave
        : controlledFormatOnSave === null
          ? false
          : settingReady.current && settingValue.current;
    const shouldFormat = environment.host.capabilities.noteFormatting && !bypass && formatEnabled;
    setSavingNote(true);
    setSaveSuccess(false);
    setSaveError('');
    setFormatNotice('');

    try {
      let formatted = { content: targetContent, status: 'unchanged' as 'unchanged' | 'formatted' | 'skipped' };
      if (shouldFormat && targetContent.trim()) {
        formatted = await formatNoteInWorker(targetContent);
        if (!isLatestProblemSave()) return false;
        if (hasMeaningfulNoteContent(targetContent) !== hasMeaningfulNoteContent(formatted.content)) {
          formatted = { content: targetContent, status: 'skipped' };
        }
      }
      const previousWrite = problemSaveChain.current.get(targetId) ?? Promise.resolve(null);
      const currentWrite = previousWrite
        .catch(() => null)
        .then(async (previous) => {
          if (!isLatestProblemSave()) return null;
          // Advance only from our own acknowledged write of the same captured baseline.
          const expectedRevision = previous && previous.baseRevision === savedRevision &&
            previous.baseGeneration === savedGeneration && previous.note.libraryGeneration === savedGeneration
            ? previous.note.revision : savedRevision;
          const result = await api.upsertNote(targetId, formatted.content, expectedRevision, savedGeneration);
          return { note: result.note, baseRevision: savedRevision, baseGeneration: savedGeneration };
        });
      problemSaveChain.current.set(targetId, currentWrite);
      const result = await currentWrite;
      if (!result || !isLatestProblemSave()) return false;
      const { note } = result;
      if (session.active) {
        setSavedContent(note.content);
        setSavedRevision(note.revision);
        setSavedGeneration(note.libraryGeneration);
        setRemoteNote(null);
        setExternalChange(false);
        setSaveSuccess(true);
        if (formatted.status === 'skipped') setFormatNotice(t.notesFormatSkipped);
        if (formatted.status === 'formatted' && note.content === formatted.content && draft.current.revision === targetRevision) {
          setNoteContent(note.content);
          setFormatUndo({ before: targetContent, revision: draft.current.revision, session });
        }
        if (bypass && bypassFormatRevision.current === targetRevision) bypassFormatRevision.current = null;
        setTimeout(() => {
          if (session.active && session.saveVersion === saveVersion) setSaveSuccess(false);
        }, 2500);

        const isMeaningful = hasMeaningfulNoteContent(note.content);
        setSelectedSummary((prev) =>
          prev && prev.questionFrontendId === targetId
            ? {
                ...prev,
                hasCustomNote: isMeaningful,
                customNoteUpdatedAt: isMeaningful ? note.updatedAt : null,
              }
            : prev
        );

        setItems((prev) =>
          prev.map((it) =>
            it.questionFrontendId === targetId
              ? {
                  ...it,
                  hasCustomNote: isMeaningful,
                  customNoteUpdatedAt: isMeaningful ? note.updatedAt : null,
                }
              : it
          )
        );
      }
      // A saved note can change list membership even after switching problems. Refresh
      // the latest filters while mounted, without reloading the current editor draft.
      if (editorSession.current.active) setListRevision((current) => current + 1);
      const clean = session.active && editorSession.current === session && draft.current.value === note.content;
      if (session.active && editorSession.current === session) onDirtyChange?.(!clean);
      return clean;
    } catch (err) {
      if (session.active && isLatestProblemSave()) {
        setSaveError(err instanceof OperationStateError ? operationMessage(err, lang) : localizeApiError(err, lang));
      }
      return false;
    } finally {
      session.saving = false;
      if (session.active) {
        savingRevision.current = null;
        setSavingNote(false);
      }
    }
  }

  /** Delete the retained draft before discarding edits; false (with `saveError`) keeps the visit. */
  async function discardDraft(): Promise<boolean> {
    try {
      await recovery.current?.closeAndDelete();
      return true;
    } catch (e) {
      setSaveError(String(e));
      return false;
    }
  }

  /** Accept the compared library version as the new baseline while keeping the preserved draft. */
  function adoptRemoteBaseline() {
    if (!remoteNote) return;
    setSavedContent(remoteNote.content);
    setSavedRevision(remoteNote.revision);
    setSavedGeneration(remoteNote.libraryGeneration);
    setRemoteNote(null);
    setExternalChange(false);
  }

  return {
    noteContent,
    setNoteContent,
    textareaRef,
    wrapTextareaSelection,
    loadingNote,
    noteLoadError,
    handleRetryLoad,
    savingNote,
    saveSuccess,
    saveError,
    formatNotice,
    canUndoFormat,
    handleUndoFormat,
    isModified,
    isBlank,
    canSave,
    hasUnsavedChanges,
    handleSaveNote,
    practices,
    loadingPractices,
    aiReview,
    openAiReview,
    closeAiReview,
    generateAiSuggestion,
    applyAiSuggestion,
    draftStatus,
    externalChange,
    remoteNote,
    adoptRemoteBaseline,
    discardDraft,
  };
}

/** Editor state and actions consumed by the notes workspace panels. */
export type NoteEditorState = ReturnType<typeof useNoteEditor>;

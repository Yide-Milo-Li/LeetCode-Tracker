/**
 * Bounded undo/redo stack for the Notes Workspace `<textarea>` editor.
 * Unifies coalesced keyboard typing bursts with discrete programmatic edits (shortcuts,
 * toolbar actions, template insertion, paste/cut, and formatting) so Ctrl/Cmd+Z works
 * predictably across both.
 */

export interface HistorySnapshot {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

interface TypingMeta {
  kind: 'insert' | 'delete';
  time: number;
  caret: number;
}

/** Maintain a bounded history stack with time-and-cursor-coalesced typing snapshots. */
export class TextHistory {
  private entries: HistorySnapshot[];
  private index: number;
  private lastMeta: TypingMeta | null = null;
  private forceBoundary = false;
  private readonly maxEntries: number;
  private readonly coalesceWindowMs: number;

  constructor(initialValue = '', maxEntries = 200, coalesceWindowMs = 600) {
    this.maxEntries = maxEntries;
    this.coalesceWindowMs = coalesceWindowMs;
    this.entries = [{ value: initialValue, selectionStart: 0, selectionEnd: 0 }];
    this.index = 0;
  }

  /** Replace the entire history with a single clean baseline snapshot. */
  reset(value: string, selectionStart = 0, selectionEnd = 0): void {
    this.entries = [{ value, selectionStart, selectionEnd }];
    this.index = 0;
    this.lastMeta = null;
    this.forceBoundary = false;
  }

  /** Force the next text mutation to create a separate undo step instead of coalescing. */
  markBoundary(): void {
    this.forceBoundary = true;
    this.lastMeta = null;
  }

  /** Update the current snapshot's selection when the text value itself has not changed. */
  updateCurrentSelection(selectionStart: number, selectionEnd: number): void {
    this.entries[this.index] = {
      ...this.entries[this.index],
      selectionStart,
      selectionEnd,
    };
  }

  /** Record a user typing change, coalescing contiguous single-char bursts within the window. */
  recordTyping(snapshot: HistorySnapshot, now = Date.now()): void {
    const prev = this.entries[this.index];
    if (snapshot.value === prev.value) {
      this.entries[this.index] = { ...snapshot };
      return;
    }

    if (this.index < this.entries.length - 1) {
      this.entries.splice(this.index + 1);
    }

    const deltaLen = snapshot.value.length - prev.value.length;
    let kind: 'insert' | 'delete' | null = null;
    let isNewlineEdit = false;
    let isContiguous = false;

    if (deltaLen === 1 && snapshot.selectionStart === snapshot.selectionEnd && prev.selectionStart === prev.selectionEnd) {
      const insertedPos = snapshot.selectionStart - 1;
      if (
        insertedPos >= 0 &&
        insertedPos === prev.selectionStart &&
        snapshot.value.slice(0, insertedPos) === prev.value.slice(0, insertedPos) &&
        snapshot.value.slice(insertedPos + 1) === prev.value.slice(insertedPos)
      ) {
        kind = 'insert';
        isNewlineEdit = snapshot.value[insertedPos] === '\n' || snapshot.value[insertedPos] === '\r';
        isContiguous =
          this.lastMeta !== null && this.lastMeta.kind === 'insert' && insertedPos === this.lastMeta.caret;
      }
    } else if (
      deltaLen === -1 &&
      snapshot.selectionStart === snapshot.selectionEnd &&
      prev.selectionStart === prev.selectionEnd
    ) {
      const deletedPos = snapshot.selectionStart;
      if (
        (deletedPos === prev.selectionStart - 1 || deletedPos === prev.selectionStart) &&
        snapshot.value.slice(0, deletedPos) === prev.value.slice(0, deletedPos) &&
        snapshot.value.slice(deletedPos) === prev.value.slice(deletedPos + 1)
      ) {
        kind = 'delete';
        const deletedChar = prev.value[deletedPos];
        isNewlineEdit = deletedChar === '\n' || deletedChar === '\r';
        isContiguous =
          this.lastMeta !== null &&
          this.lastMeta.kind === 'delete' &&
          (snapshot.selectionStart === this.lastMeta.caret - 1 || snapshot.selectionStart === this.lastMeta.caret);
      }
    }

    const canCoalesce =
      !this.forceBoundary &&
      this.index > 0 &&
      kind !== null &&
      this.lastMeta !== null &&
      this.lastMeta.kind === kind &&
      now - this.lastMeta.time <= this.coalesceWindowMs &&
      isContiguous &&
      !isNewlineEdit;

    if (canCoalesce && kind !== null) {
      this.entries[this.index] = { ...snapshot };
      this.lastMeta = { kind, time: now, caret: snapshot.selectionStart };
      return;
    }

    this.pushEntry(snapshot);
    this.forceBoundary = false;
    this.lastMeta =
      kind !== null && !isNewlineEdit ? { kind, time: now, caret: snapshot.selectionStart } : null;
  }

  /** Record an atomic programmatic edit after preserving the exact pre-edit selection. */
  recordProgrammatic(beforeSelection: { start: number; end: number }, next: HistorySnapshot): void {
    this.entries[this.index] = {
      ...this.entries[this.index],
      selectionStart: beforeSelection.start,
      selectionEnd: beforeSelection.end,
    };
    if (next.value === this.entries[this.index].value) {
      return;
    }
    if (this.index < this.entries.length - 1) {
      this.entries.splice(this.index + 1);
    }
    this.pushEntry(next);
    this.lastMeta = null;
    this.forceBoundary = false;
  }

  /** Step backward one history entry and return it, or null when at the baseline. */
  undo(): HistorySnapshot | null {
    if (!this.canUndo()) return null;
    this.index--;
    this.lastMeta = null;
    this.forceBoundary = false;
    return { ...this.entries[this.index] };
  }

  /** Step forward one history entry and return it, or null when at the latest entry. */
  redo(): HistorySnapshot | null {
    if (!this.canRedo()) return null;
    this.index++;
    this.lastMeta = null;
    this.forceBoundary = false;
    return { ...this.entries[this.index] };
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  current(): HistorySnapshot {
    return { ...this.entries[this.index] };
  }

  private pushEntry(snapshot: HistorySnapshot): void {
    this.entries.push({ ...snapshot });
    this.index = this.entries.length - 1;
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
      this.index--;
    }
  }
}

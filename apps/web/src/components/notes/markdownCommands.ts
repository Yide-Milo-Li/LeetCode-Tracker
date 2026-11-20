/**
 * Pure Markdown editing transforms and cursor/line utilities for the Notes Workspace editor.
 * Every operation takes the current text and selection and returns the next text and selection
 * without side effects or DOM coupling.
 */

export interface EditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export type InlineMarker = '**' | '*' | '~~' | '`' | '$';
export type LinePrefixKind = 'heading' | 'ul' | 'ol' | 'task' | 'quote';

const INDENT = '  ';
const URL_RE = /^https?:\/\/\S+$/i;

function getLineStart(value: string, pos: number): number {
  if (pos <= 0) return 0;
  const idx = value.lastIndexOf('\n', pos - 1);
  return idx === -1 ? 0 : idx + 1;
}

function getLineEnd(value: string, pos: number): number {
  const idx = value.indexOf('\n', pos);
  return idx === -1 ? value.length : idx;
}

function countCharLeft(value: string, index: number, ch: string): number {
  let count = 0;
  while (index - 1 - count >= 0 && value[index - 1 - count] === ch) {
    count++;
  }
  return count;
}

function countCharRight(value: string, index: number, ch: string): number {
  let count = 0;
  while (index + count < value.length && value[index + count] === ch) {
    count++;
  }
  return count;
}

/** True when `str` contains an isolated single occurrence of `ch` (e.g. `*a* and *b*`). */
function hasIsolatedMarkerChar(str: string, ch: string): boolean {
  let i = 0;
  while (i < str.length) {
    if (str[i] !== ch) {
      i++;
      continue;
    }
    let run = 0;
    while (i + run < str.length && str[i + run] === ch) {
      run++;
    }
    if (run % 2 === 1) return true;
    i += run;
  }
  return false;
}

/** Return true when `offset` sits inside an unclosed fenced code block opened on an earlier line. */
export function isInsideFencedCodeBlock(value: string, offset: number): boolean {
  const clamped = Math.max(0, Math.min(offset, value.length));
  const currentLineStart = getLineStart(value, clamped);
  const preceding = value.slice(0, currentLineStart);
  if (!preceding) return false;
  const lines = preceding.split(/\r?\n/);
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  for (const line of lines) {
    if (!fenceChar) {
      const open = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (open) {
        const marker = open[1];
        const info = line.slice(open[0].length);
        if (marker[0] === '`' && info.includes('`')) continue;
        fenceChar = marker[0] as '`' | '~';
        fenceLen = marker.length;
      }
    } else {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }
  return fenceChar !== null;
}

/** Insert a fenced code block around the current selection or placeholder. */
export function insertCodeBlock(
  value: string,
  start: number,
  end: number,
  language: string,
  placeholder: string,
): EditResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const before = value.slice(0, from);
  const after = value.slice(to);
  const body = value.slice(from, to) || placeholder;
  const leadSep = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  const trailSep = after.startsWith('\n') ? '' : '\n';
  const prefix = `${leadSep}\`\`\`${language}\n`;
  const suffix = `\n\`\`\`${trailSep}`;
  const nextValue = `${before}${prefix}${body}${suffix}${after}`;
  const selStart = from + prefix.length;
  return {
    value: nextValue,
    selectionStart: selStart,
    selectionEnd: selStart + body.length,
  };
}

function unwrapSurroundedFencedBlock(value: string, start: number, end: number): EditResult | null {
  const selected = value.slice(start, end);
  const innerFence = /^[ \t]*```[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/.exec(selected);
  if (innerFence && !innerFence[1].includes('\n```')) {
    const body = innerFence[1];
    return {
      value: value.slice(0, start) + body + value.slice(end),
      selectionStart: start,
      selectionEnd: start + body.length,
    };
  }
  const before = value.slice(0, start);
  const after = value.slice(end);
  const openMatch = /(?:^|\n)([ \t]*```[^\n]*\n)$/.exec(before);
  const closeMatch = /^(\n[ \t]*```[ \t]*)(?:\n|$)/.exec(after);
  if (openMatch && closeMatch) {
    const openLen = openMatch[1].length;
    const closeLen = closeMatch[1].length;
    const nextValue = value.slice(0, start - openLen) + selected + value.slice(end + closeLen);
    return {
      value: nextValue,
      selectionStart: start - openLen,
      selectionEnd: end - openLen,
    };
  }
  return null;
}

/** Toggle Markdown inline formatting markers around the current selection or caret. */
export function toggleInlineWrap(
  value: string,
  start: number,
  end: number,
  marker: InlineMarker,
  options?: { placeholder?: string },
): EditResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const selected = value.slice(from, to);

  if (marker === '`' && from < to && selected.includes('\n')) {
    const unwrapped = unwrapSurroundedFencedBlock(value, from, to);
    if (unwrapped) return unwrapped;
    return insertCodeBlock(value, from, to, '', '');
  }

  // Collapsed caret
  if (from === to) {
    const before = value.slice(0, from);
    const after = value.slice(to);
    const len = marker.length;
    let emptyPair = false;
    if (marker === '**') {
      emptyPair = countCharLeft(value, from, '*') >= 2 && countCharRight(value, to, '*') >= 2;
    } else if (marker === '*' || marker === '$') {
      emptyPair =
        countCharLeft(value, from, marker) % 2 === 1 &&
        countCharRight(value, to, marker) % 2 === 1;
    } else {
      emptyPair = before.endsWith(marker) && after.startsWith(marker);
    }
    if (emptyPair) {
      return {
        value: value.slice(0, from - len) + value.slice(to + len),
        selectionStart: from - len,
        selectionEnd: from - len,
      };
    }
    const placeholder = options?.placeholder ?? '';
    const nextValue = `${before}${marker}${placeholder}${marker}${after}`;
    const selStart = from + len;
    return {
      value: nextValue,
      selectionStart: selStart,
      selectionEnd: selStart + placeholder.length,
    };
  }

  // Non-empty selection: preserve surrounding whitespace outside markers
  const wsMatch = /^(\s*)([\s\S]*?)(\s*)$/.exec(selected)!;
  const [, lead, core, trail] = wsMatch;
  if (core.length === 0) {
    const placeholder = options?.placeholder ?? '';
    const replacement = `${lead}${marker}${placeholder}${marker}${trail}`;
    const selStart = from + lead.length + marker.length;
    return {
      value: value.slice(0, from) + replacement + value.slice(to),
      selectionStart: selStart,
      selectionEnd: selStart + placeholder.length,
    };
  }

  const innerStart = from + lead.length;
  const innerEnd = to - trail.length;
  const len = marker.length;

  let wrappedOutside = false;
  if (marker === '**') {
    wrappedOutside = countCharLeft(value, innerStart, '*') >= 2 && countCharRight(value, innerEnd, '*') >= 2;
  } else if (marker === '*' || marker === '$') {
    wrappedOutside =
      countCharLeft(value, innerStart, marker) % 2 === 1 &&
      countCharRight(value, innerEnd, marker) % 2 === 1;
  } else {
    wrappedOutside =
      value.slice(innerStart - len, innerStart) === marker &&
      value.slice(innerEnd, innerEnd + len) === marker;
  }

  if (wrappedOutside) {
    return {
      value:
        value.slice(0, innerStart - len) +
        value.slice(innerStart, innerEnd) +
        value.slice(innerEnd + len),
      selectionStart: innerStart - len,
      selectionEnd: innerEnd - len,
    };
  }

  let wrappedInside = false;
  if (marker === '**') {
    const leadStars = countCharRight(core, 0, '*');
    const trailStars = countCharLeft(core, core.length, '*');
    wrappedInside = leadStars >= 2 && trailStars >= 2 && core.length > 4 && !core.slice(2, -2).includes('**');
  } else if (marker === '*' || marker === '$') {
    const leadCount = countCharRight(core, 0, marker);
    const trailCount = countCharLeft(core, core.length, marker);
    wrappedInside =
      leadCount % 2 === 1 &&
      trailCount % 2 === 1 &&
      core.length > 2 &&
      !hasIsolatedMarkerChar(core.slice(1, -1), marker);
  } else {
    wrappedInside =
      core.length > len * 2 &&
      core.startsWith(marker) &&
      core.endsWith(marker) &&
      !core.slice(len, -len).includes(marker);
  }

  if (wrappedInside) {
    const unwrapped = core.slice(len, -len);
    return {
      value: value.slice(0, from) + lead + unwrapped + trail + value.slice(to),
      selectionStart: innerStart,
      selectionEnd: innerStart + unwrapped.length,
    };
  }

  return {
    value: value.slice(0, from) + lead + marker + core + marker + trail + value.slice(to),
    selectionStart: innerStart + len,
    selectionEnd: innerEnd + len,
  };
}

const TASK_RE = /^([ \t]*)[-*+] \[[ xX]\] (.*)$/;
const UL_RE = /^([ \t]*)[-*+] (.*)$/;
const OL_RE = /^([ \t]*)\d+\. (.*)$/;
const ANY_HEADING_RE = /^([ \t]*)#{1,6}[ \t]+(.*)$/;
const EXACT_HEADING_RE = /^([ \t]*)###[ \t]+(.*)$/;
const QUOTE_RE = /^([ \t]*)> ?(.*)$/;

function lineMatchesKind(line: string, kind: LinePrefixKind): boolean {
  switch (kind) {
    case 'heading':
      return EXACT_HEADING_RE.test(line);
    case 'task':
      return TASK_RE.test(line);
    case 'ul':
      return !TASK_RE.test(line) && UL_RE.test(line);
    case 'ol':
      return OL_RE.test(line);
    case 'quote':
      return QUOTE_RE.test(line);
  }
}

function stripLineKind(line: string, kind: LinePrefixKind): string {
  switch (kind) {
    case 'heading': {
      const m = EXACT_HEADING_RE.exec(line);
      return m ? `${m[1]}${m[2]}` : line;
    }
    case 'task': {
      const m = TASK_RE.exec(line);
      return m ? `${m[1]}${m[2]}` : line;
    }
    case 'ul': {
      const m = UL_RE.exec(line);
      return m ? `${m[1]}${m[2]}` : line;
    }
    case 'ol': {
      const m = OL_RE.exec(line);
      return m ? `${m[1]}${m[2]}` : line;
    }
    case 'quote': {
      const m = QUOTE_RE.exec(line);
      return m ? `${m[1]}${m[2]}` : line;
    }
  }
}

function stripExistingListMarker(line: string): { indent: string; body: string } | null {
  for (const re of [TASK_RE, UL_RE, OL_RE]) {
    const m = re.exec(line);
    if (m) return { indent: m[1], body: m[2] };
  }
  return null;
}

/** Toggle a block/line prefix (heading, list, task, or quote) across every touched line. */
export function toggleLinePrefix(
  value: string,
  start: number,
  end: number,
  kind: LinePrefixKind,
  options?: { placeholder?: string },
): EditResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const lineStart = getLineStart(value, from);
  const effectiveEnd = to > from && value[to - 1] === '\n' ? to - 1 : to;
  const lineEnd = getLineEnd(value, effectiveEnd);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');

  const basePrefix: Record<LinePrefixKind, string> = {
    heading: '### ',
    ul: '- ',
    ol: '1. ',
    task: '- [ ] ',
    quote: '> ',
  };

  if (lines.length === 1 && lines[0] === '') {
    const prefix = basePrefix[kind];
    const placeholder = options?.placeholder ?? '';
    const replacement = prefix + placeholder;
    return {
      value: value.slice(0, lineStart) + replacement + value.slice(lineEnd),
      selectionStart: lineStart + prefix.length,
      selectionEnd: lineStart + prefix.length + placeholder.length,
    };
  }

  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const targetLines = nonEmptyLines.length > 0 ? nonEmptyLines : lines;
  const allMatched = targetLines.every((line) => lineMatchesKind(line, kind));

  let olIndex = 1;
  const newLines = lines.map((line) => {
    if (nonEmptyLines.length > 0 && line.trim().length === 0) {
      return line;
    }
    if (allMatched) {
      return stripLineKind(line, kind);
    }
    const indent = /^([ \t]*)/.exec(line)?.[1] ?? '';
    if (kind === 'heading') {
      const existing = ANY_HEADING_RE.exec(line);
      if (existing) return `${existing[1]}### ${existing[2]}`;
      return `${indent}### ${line.slice(indent.length)}`;
    }
    if (kind === 'quote') {
      return `${indent}> ${line.slice(indent.length)}`;
    }
    const marker = kind === 'task' ? '- [ ] ' : kind === 'ul' ? '- ' : `${olIndex++}. `;
    const existingList = stripExistingListMarker(line);
    if (existingList) {
      return `${existingList.indent}${marker}${existingList.body}`;
    }
    return `${indent}${marker}${line.slice(indent.length)}`;
  });

  const newBlock = newLines.join('\n');
  const nextValue = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
  const deltas = newLines.map((nl, i) => nl.length - lines[i].length);

  if (lines.length === 1) {
    const delta = deltas[0];
    const clamp = (pos: number) => Math.max(lineStart, Math.min(lineStart + newBlock.length, pos));
    const nextStart = clamp(from + delta);
    const nextEnd = Math.max(nextStart, clamp(to + delta));
    return { value: nextValue, selectionStart: nextStart, selectionEnd: nextEnd };
  }

  const firstDelta = deltas[0];
  const totalDelta = deltas.reduce((sum, d) => sum + d, 0);
  const nextStart =
    from === lineStart ? lineStart : Math.max(lineStart, Math.min(lineStart + newBlock.length, from + firstDelta));
  const nextEnd = Math.max(nextStart, Math.min(lineStart + newBlock.length, to + totalDelta));
  return { value: nextValue, selectionStart: nextStart, selectionEnd: nextEnd };
}

/** Insert a Markdown link, adapting to whether the selection is a URL, label text, or empty. */
export function insertLink(
  value: string,
  start: number,
  end: number,
  options?: { textPlaceholder?: string; urlPlaceholder?: string },
): EditResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const urlPlaceholder = options?.urlPlaceholder ?? 'url';
  const textPlaceholder = options?.textPlaceholder ?? '';
  const selected = value.slice(from, to);

  if (from === to) {
    const replacement = `[${textPlaceholder}](${urlPlaceholder})`;
    const selStart = from + 1;
    return {
      value: value.slice(0, from) + replacement + value.slice(to),
      selectionStart: selStart,
      selectionEnd: selStart + textPlaceholder.length,
    };
  }

  const wsMatch = /^(\s*)([\s\S]*?)(\s*)$/.exec(selected)!;
  const [, lead, core, trail] = wsMatch;

  if (core.length === 0) {
    const replacement = `${lead}[${textPlaceholder}](${urlPlaceholder})${trail}`;
    const selStart = from + lead.length + 1;
    return {
      value: value.slice(0, from) + replacement + value.slice(to),
      selectionStart: selStart,
      selectionEnd: selStart + textPlaceholder.length,
    };
  }

  if (URL_RE.test(core)) {
    const replacement = `${lead}[${textPlaceholder}](${core})${trail}`;
    const selStart = from + lead.length + 1;
    return {
      value: value.slice(0, from) + replacement + value.slice(to),
      selectionStart: selStart,
      selectionEnd: selStart + textPlaceholder.length,
    };
  }

  const replacement = `${lead}[${core}](${urlPlaceholder})${trail}`;
  const urlStart = from + lead.length + 1 + core.length + 2;
  return {
    value: value.slice(0, from) + replacement + value.slice(to),
    selectionStart: urlStart,
    selectionEnd: urlStart + urlPlaceholder.length,
  };
}

/** Wrap non-URL single-line text selection into a Markdown link when pasting an HTTP(S) URL. */
export function pasteUrlOverSelection(
  value: string,
  start: number,
  end: number,
  pastedText: string,
): EditResult | null {
  const [from, to] = start <= end ? [start, end] : [end, start];
  if (from >= to) return null;
  const trimmedUrl = pastedText.trim();
  if (!URL_RE.test(trimmedUrl)) return null;
  const selected = value.slice(from, to);
  if (selected.includes('\n')) return null;

  const wsMatch = /^(\s*)([\s\S]*?)(\s*)$/.exec(selected)!;
  const [, lead, core, trail] = wsMatch;
  if (core.length === 0 || URL_RE.test(core)) return null;
  if (isInsideFencedCodeBlock(value, from)) return null;

  const lineStart = getLineStart(value, from);
  const beforeOnLine = value.slice(lineStart, from);
  if ((beforeOnLine.match(/`/g)?.length ?? 0) % 2 === 1) return null;

  const replacement = `${lead}[${core}](${trimmedUrl})${trail}`;
  const caretAfter = from + lead.length + 1 + core.length + 2 + trimmedUrl.length + 1;
  return {
    value: value.slice(0, from) + replacement + value.slice(to),
    selectionStart: caretAfter,
    selectionEnd: caretAfter,
  };
}

/** Continue Markdown lists, blockquotes, or fenced code indentation on Enter, or exit empty items. */
export function handleEnterKey(value: string, start: number, end: number): EditResult | null {
  if (start !== end) return null;
  const lineStart = getLineStart(value, start);
  const lineEnd = getLineEnd(value, start);
  const line = value.slice(lineStart, lineEnd);
  const beforeCaret = value.slice(lineStart, start);

  if (isInsideFencedCodeBlock(value, lineStart)) {
    const indent = /^[ \t]*/.exec(beforeCaret)?.[0] ?? '';
    if (!indent) return null;
    const insertion = `\n${indent}`;
    const caret = start + insertion.length;
    return {
      value: value.slice(0, start) + insertion + value.slice(start),
      selectionStart: caret,
      selectionEnd: caret,
    };
  }

  let prefixLen = 0;
  let nextPrefix = '';
  let rest = '';

  const taskMatch = /^([ \t]*)([-*+]) \[([ xX])\] (.*)$/.exec(line);
  if (taskMatch) {
    prefixLen = taskMatch[0].length - taskMatch[4].length;
    nextPrefix = `${taskMatch[1]}${taskMatch[2]} [ ] `;
    rest = taskMatch[4];
  } else {
    const ulMatch = /^([ \t]*)([-*+]) (.*)$/.exec(line);
    if (ulMatch) {
      prefixLen = ulMatch[0].length - ulMatch[3].length;
      nextPrefix = `${ulMatch[1]}${ulMatch[2]} `;
      rest = ulMatch[3];
    } else {
      const olMatch = /^([ \t]*)(\d+)([.)]) (.*)$/.exec(line);
      if (olMatch) {
        prefixLen = olMatch[0].length - olMatch[4].length;
        nextPrefix = `${olMatch[1]}${Number(olMatch[2]) + 1}${olMatch[3]} `;
        rest = olMatch[4];
      } else {
        const quoteMatch = /^([ \t]*)(> ?)(.*)$/.exec(line);
        if (!quoteMatch) return null;
        prefixLen = quoteMatch[0].length - quoteMatch[3].length;
        nextPrefix = `${quoteMatch[1]}${quoteMatch[2].endsWith(' ') ? quoteMatch[2] : `${quoteMatch[2]} `}`;
        rest = quoteMatch[3];
      }
    }
  }

  if (start < lineStart + prefixLen) return null;

  if (rest.trim() === '' && start === lineEnd) {
    return {
      value: value.slice(0, lineStart) + value.slice(lineEnd),
      selectionStart: lineStart,
      selectionEnd: lineStart,
    };
  }

  const insertion = `\n${nextPrefix}`;
  const caret = start + insertion.length;
  return {
    value: value.slice(0, start) + insertion + value.slice(start),
    selectionStart: caret,
    selectionEnd: caret,
  };
}

/** Indent or outdent lines in Markdown lists/quotes/multi-line selections, or insert 2 spaces inline. */
export function handleTabIndent(value: string, start: number, end: number, outdent: boolean): EditResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const selected = value.slice(from, to);
  const lineStart = getLineStart(value, from);
  const currentLine = value.slice(lineStart, getLineEnd(value, from));
  const isStructuredLine = /^[ \t]*(?:[-*+] |(?:\d+[.)]) |> )/.test(currentLine);

  if (!outdent && !selected.includes('\n') && !isStructuredLine) {
    return {
      value: value.slice(0, from) + INDENT + value.slice(to),
      selectionStart: from + INDENT.length,
      selectionEnd: from + INDENT.length,
    };
  }

  const effectiveEnd = to > from && value[to - 1] === '\n' ? to - 1 : to;
  const lineEnd = getLineEnd(value, effectiveEnd);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');

  const newLines = lines.map((line) => {
    if (outdent) {
      return line.replace(/^(?: {1,2}|\t)/, '');
    }
    if (lines.length > 1 && line.trim().length === 0) {
      return line;
    }
    return INDENT + line;
  });

  const newBlock = newLines.join('\n');
  const nextValue = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
  const deltas = newLines.map((nl, i) => nl.length - lines[i].length);

  if (lines.length === 1) {
    const delta = deltas[0];
    const clamp = (pos: number) => Math.max(lineStart, Math.min(lineStart + newBlock.length, pos));
    const nextStart = clamp(from + delta);
    const nextEnd = Math.max(nextStart, clamp(to + delta));
    return { value: nextValue, selectionStart: nextStart, selectionEnd: nextEnd };
  }

  const firstDelta = deltas[0];
  const totalDelta = deltas.reduce((sum, d) => sum + d, 0);
  const nextStart =
    from === lineStart ? lineStart : Math.max(lineStart, Math.min(lineStart + newBlock.length, from + firstDelta));
  const nextEnd = Math.max(nextStart, Math.min(lineStart + newBlock.length, to + totalDelta));
  return { value: nextValue, selectionStart: nextStart, selectionEnd: nextEnd };
}

/** Return the text of the line containing `caret` without trailing newline characters. */
export function getCurrentLineText(value: string, caret: number): string {
  const clamped = Math.max(0, Math.min(caret, value.length));
  const lineStart = getLineStart(value, clamped);
  const lineEnd = getLineEnd(value, clamped);
  return value.slice(lineStart, lineEnd);
}

/** Remove the line containing `caret` (and its adjacent line break) and return the removed line text. */
export function cutCurrentLine(value: string, caret: number): { lineText: string; edit: EditResult } | null {
  if (value.length === 0) return null;
  const clamped = Math.max(0, Math.min(caret, value.length));
  const lineStart = getLineStart(value, clamped);
  const lineEnd = getLineEnd(value, clamped);
  const lineText = value.slice(lineStart, lineEnd);
  const col = clamped - lineStart;

  if (lineEnd < value.length) {
    const nextValue = value.slice(0, lineStart) + value.slice(lineEnd + 1);
    const nextLineEnd = getLineEnd(nextValue, lineStart);
    const nextCaret = lineStart + Math.min(col, nextLineEnd - lineStart);
    return {
      lineText,
      edit: { value: nextValue, selectionStart: nextCaret, selectionEnd: nextCaret },
    };
  }

  if (lineStart > 0) {
    const nextValue = value.slice(0, lineStart - 1);
    const nextCaret = lineStart - 1;
    return {
      lineText,
      edit: { value: nextValue, selectionStart: nextCaret, selectionEnd: nextCaret },
    };
  }

  return {
    lineText,
    edit: { value: '', selectionStart: 0, selectionEnd: 0 },
  };
}

/** Offline Markdown formatting and source-preserving AI layout operations. */
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Heading, Paragraph, PhrasingContent, Root, RootContent } from 'mdast';

const processor = remark().use(remarkGfm).use(remarkMath).data('settings', {
  bullet: '-', rule: '-', strong: '*', emphasis: '*', fences: true,
  fence: '`', listItemIndent: 'one', setext: false,
}).freeze();

export const MAX_NOTE_LENGTH = 100_000;
export const MAX_AI_FORMAT_LENGTH = 20_000;
export const MAX_AI_FRAGMENTS = 200;

export type FormatResult = {
  content: string;
  status: 'formatted' | 'unchanged' | 'skipped';
  reason?: 'unsupported' | 'unsafe' | 'too_large';
};

type LocatedNode = {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: LocatedNode[];
};

/** Compare complete parsed meaning while ignoring source locations and derived rendering hints. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => key !== 'position' && key !== 'data' && item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
}

/** Compare parsed structures independently of object key order and source positions. */
function equivalent(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Resolve UTF-16 source offsets or reject an unlocatable node. */
function offsets(node: LocatedNode): { start: number; end: number } {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error('Missing Markdown source positions');
  return { start, end };
}

/** Refuse to reserialize incomplete fences and known unsupported portable extensions. */
function hasUnsupportedSyntax(source: string, tree: Root, checkFrontMatter = true): boolean {
  if (checkFrontMatter && /^\uFEFF?---[ \t]*(?:\r?\n)/.test(source)) return true;
  let unsupported = false;
  const visit = (node: LocatedNode): void => {
    if (unsupported) return;
    if (node.type === 'text' && /!?\[\[[^\]\r\n]+\]\]/.test(node.value ?? '')) {
      unsupported = true;
      return;
    }
    if (node.type === 'blockquote') {
      const { start, end } = offsets(node);
      if (/^\s*>\s*\[![^\]\r\n]+\]/.test(source.slice(start, end))) {
        unsupported = true;
        return;
      }
    }
    if (node.type === 'code' || node.type === 'math') {
      const { start, end } = offsets(node);
      const raw = source.slice(start, end);
      const opening = node.type === 'math' ? /^(\${2,})/.exec(raw) : /^(`{3,}|~{3,})/.exec(raw);
      if (opening) {
        const lines = raw.split(/\r?\n/);
        const last = (lines.at(-1) ?? '').replace(/^[ \t]*(?:>[ \t]*)*/, '').trim();
        const marker = opening[1];
        if (lines.length < 2 || !new RegExp(`^${marker[0] === '$' ? '\\$' : marker[0]}{${marker.length},}[ \\t]*$`).test(last)) {
          unsupported = true;
        }
      }
      return;
    }
    node.children?.forEach(visit);
  };
  visit(tree as unknown as LocatedNode);
  return unsupported;
}

/** Format a document only when its parsed meaning remains exactly unchanged. */
export function formatMarkdown(source: string): FormatResult {
  if (!source.trim()) return { content: source, status: 'unchanged' };
  try {
    const original = processor.parse(source);
    if (hasUnsupportedSyntax(source, original)) return { content: source, status: 'skipped', reason: 'unsupported' };
    const content = processor.stringify(original);
    if (content.length > MAX_NOTE_LENGTH) return { content: source, status: 'skipped', reason: 'too_large' };
    if (!equivalent(original, processor.parse(content)) || processor.stringify(processor.parse(content)) !== content) {
      return { content: source, status: 'skipped', reason: 'unsafe' };
    }
    return { content, status: content === source ? 'unchanged' : 'formatted' };
  } catch {
    return { content: source, status: 'skipped', reason: 'unsafe' };
  }
}

export type Selection = { start: number; end: number };
export type AiFragment = { id: string; kind: 'text' | 'protected'; text?: string };
export type LayoutStyle = 'keep' | 'paragraph' | 'heading' | 'bullet_list' | 'ordered_list' | 'quote' | 'code';
export type LayoutGroup = { style: LayoutStyle; ids: string[]; level?: number };

type InternalFragment = {
  public: AiFragment;
  node: RootContent;
  originalIndex: number;
  start: number;
  end: number;
  split: boolean;
  plain: boolean;
};

export type PreparedAiFormat = {
  source: string;
  range: Selection;
  fragments: AiFragment[];
  tree: Root;
  firstIndex: number;
  lastIndex: number;
  internal: InternalFragment[];
};

export class MarkdownFormatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const protectedInline = new Set(['inlineCode', 'inlineMath', 'link', 'linkReference', 'image', 'imageReference', 'html']);

/** Redact protected inline source before constructing provider input. */
function displayText(source: string, node: LocatedNode): string {
  const { start, end } = offsets(node);
  const ranges: Array<{ start: number; end: number }> = [];
  const visit = (child: LocatedNode): void => {
    if (protectedInline.has(child.type)) {
      ranges.push(offsets(child));
      return;
    }
    child.children?.forEach(visit);
  };
  node.children?.forEach(visit);
  let cursor = start;
  let text = '';
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    text += source.slice(cursor, range.start) + '[protected]';
    cursor = range.end;
  }
  return text + source.slice(cursor, end);
}

/** Resolve a UTF-16 selection to complete root blocks and produce immutable provider fragments. */
export function prepareAiFormat(source: string, selection?: Selection): PreparedAiFormat {
  if (!source.trim() || source.length > MAX_NOTE_LENGTH) throw new MarkdownFormatError('INVALID_NOTE', 'Invalid note content');
  if (selection && (!Number.isInteger(selection.start) || !Number.isInteger(selection.end)
      || selection.start < 0 || selection.end <= selection.start || selection.end > source.length)) {
    throw new MarkdownFormatError('INVALID_SELECTION', 'Invalid selection');
  }
  const tree = processor.parse(source);
  let firstIndex = 0;
  let lastIndex = tree.children.length - 1;
  if (selection) {
    firstIndex = tree.children.findIndex(node => offsets(node as LocatedNode).end > selection.start);
    lastIndex = -1;
    tree.children.forEach((node, index) => {
      if (offsets(node as LocatedNode).start < selection.end) lastIndex = index;
    });
    if (firstIndex < 0 || lastIndex < firstIndex) throw new MarkdownFormatError('INVALID_SELECTION', 'Select content to format');
  }
  const first = tree.children[firstIndex];
  const last = tree.children[lastIndex];
  if (!first || !last) throw new MarkdownFormatError('INVALID_NOTE', 'The note has no Markdown blocks');
  const range = selection
    ? { start: offsets(first as LocatedNode).start, end: offsets(last as LocatedNode).end }
    : { start: 0, end: source.length };
  const selectedTree: Root = { type: 'root', children: tree.children.slice(firstIndex, lastIndex + 1) };
  if (hasUnsupportedSyntax(source, selectedTree, range.start === 0)) {
    throw new MarkdownFormatError('UNSUPPORTED_MARKDOWN', 'This selection contains unsupported or incomplete Markdown');
  }
  if (range.end - range.start > MAX_AI_FORMAT_LENGTH) throw new MarkdownFormatError('FORMAT_TOO_LARGE', 'Select a smaller portion of the note');

  const internal: InternalFragment[] = [];
  const add = (node: RootContent, originalIndex: number, start: number, end: number, split: boolean, plain: boolean): void => {
    const editable = node.type === 'paragraph' || node.type === 'heading';
    const id = `f${internal.length + 1}`;
    const text = editable ? (split ? source.slice(start, end) : displayText(source, node as LocatedNode)) : undefined;
    internal.push({ public: { id, kind: editable ? 'text' : 'protected', ...(text === undefined ? {} : { text }) },
      node, originalIndex, start, end, split, plain });
  };

  for (let index = firstIndex; index <= lastIndex; index++) {
    const node = tree.children[index];
    const { start, end } = offsets(node as LocatedNode);
    const raw = source.slice(start, end);
    if (node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'text'
        && raw.includes('\n') && node.children[0].value === raw.replace(/\r?\n[ \t]{0,3}/g, '\n')) {
      let cursor = start;
      const lines = raw.split('\n');
      const parsedLines = node.children[0].value.split('\n');
      for (const [lineIndex, line] of lines.entries()) {
        const cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;
        const fragment: Paragraph = { type: 'paragraph', children: [{ type: 'text', value: parsedLines[lineIndex] }] };
        add(fragment, index, cursor, cursor + cleanLine.length, true, true);
        cursor += line.length + (lineIndex < lines.length - 1 ? 1 : 0);
      }
    } else {
      const plain = node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'text' && node.children[0].value === raw;
      add(node, index, start, end, false, plain);
    }
  }
  if (internal.length > MAX_AI_FRAGMENTS) throw new MarkdownFormatError('FORMAT_TOO_LARGE', 'Select fewer blocks');
  if (!internal.some(frame => frame.public.kind === 'text')) throw new MarkdownFormatError('NOTHING_TO_FORMAT', 'The selection contains only protected content');
  return { source, range, fragments: internal.map(frame => frame.public), tree, firstIndex, lastIndex, internal };
}

/** Clone an editable fragment's original inline content into a paragraph. */
function paragraphOf(frame: InternalFragment): Paragraph {
  if (frame.node.type !== 'paragraph' && frame.node.type !== 'heading') throw new MarkdownFormatError('INVALID_LAYOUT', 'Protected content cannot be changed');
  return { type: 'paragraph', children: structuredClone(frame.node.children) };
}

/** Construct candidate Markdown only from original fragments and validated layout instructions. */
export function applyAiLayout(prepared: PreparedAiFormat, groups: LayoutGroup[]): string {
  if (!Array.isArray(groups) || groups.length === 0) throw new MarkdownFormatError('INVALID_LAYOUT', 'Missing layout');
  const allIds = groups.flatMap(group => group.ids);
  if (allIds.length !== prepared.internal.length || allIds.some((id, index) => id !== prepared.internal[index].public.id)) {
    throw new MarkdownFormatError('INVALID_LAYOUT', 'Layout must preserve every fragment in order');
  }
  const nodes: RootContent[] = [];
  let cursor = 0;
  const merged = groups.reduce<LayoutGroup[]>((result, group) => {
    if (group.style === 'keep' && result.at(-1)?.style === 'keep') result.at(-1)!.ids.push(...group.ids);
    else result.push({ ...group, ids: [...group.ids] });
    return result;
  }, []);

  for (const group of merged) {
    if (!group.ids.length) throw new MarkdownFormatError('INVALID_LAYOUT', 'Empty layout group');
    const frames = prepared.internal.slice(cursor, cursor + group.ids.length);
    cursor += group.ids.length;
    if (group.style !== 'keep' && frames.some(frame => frame.public.kind !== 'text')) {
      throw new MarkdownFormatError('INVALID_LAYOUT', 'Protected blocks must remain unchanged');
    }
    if (group.style === 'keep') {
      for (let i = 0; i < frames.length;) {
        const frame = frames[i];
        if (!frame.split) { nodes.push(structuredClone(frame.node)); i++; continue; }
        const run = [frame];
        while (i + run.length < frames.length && frames[i + run.length].split
          && frames[i + run.length].originalIndex === frame.originalIndex) run.push(frames[i + run.length]);
        const original = prepared.tree.children[frame.originalIndex];
        const originalOffsets = offsets(original as LocatedNode);
        if (run[0].start === originalOffsets.start && run[run.length - 1].end === originalOffsets.end) {
          nodes.push(structuredClone(original));
        } else {
          nodes.push({ type: 'paragraph', children: [{ type: 'text', value: run.map(item => (item.node as Paragraph).children.map(child => child.type === 'text' ? child.value : '').join('')).join('\n') }] });
        }
        i += run.length;
      }
    } else if (group.style === 'heading') {
      if (frames.length !== 1 || !Number.isInteger(group.level) || group.level! < 1 || group.level! > 6) {
        throw new MarkdownFormatError('INVALID_LAYOUT', 'A heading needs one fragment and a level');
      }
      nodes.push({ type: 'heading', depth: group.level as Heading['depth'], children: paragraphOf(frames[0]).children });
    } else if (group.style === 'paragraph') {
      const children: PhrasingContent[] = [];
      const append = (node: PhrasingContent) => {
        const previous = children.at(-1);
        if (previous?.type === 'text' && node.type === 'text') previous.value += node.value;
        else children.push(node);
      };
      frames.forEach((frame, index) => {
        if (index) append({ type: 'text', value: '\n' });
        paragraphOf(frame).children.forEach(append);
      });
      nodes.push({ type: 'paragraph', children });
    } else if (group.style === 'bullet_list' || group.style === 'ordered_list') {
      nodes.push({ type: 'list', ordered: group.style === 'ordered_list', start: group.style === 'ordered_list' ? 1 : null,
        spread: false, children: frames.map(frame => ({ type: 'listItem', spread: false, checked: null, children: [paragraphOf(frame)] })) });
    } else if (group.style === 'quote') {
      nodes.push({ type: 'blockquote', children: frames.map(paragraphOf) });
    } else if (group.style === 'code') {
      if (frames.some(frame => !frame.plain)) throw new MarkdownFormatError('INVALID_LAYOUT', 'Code wrapping requires plain source lines');
      nodes.push({ type: 'code', lang: null, meta: null,
        value: prepared.source.slice(frames[0].start, frames[frames.length - 1].end) });
    } else {
      throw new MarkdownFormatError('INVALID_LAYOUT', 'Unknown layout style');
    }
  }
  const fragment: Root = { type: 'root', children: nodes };
  const expected: Root = { type: 'root', children: [
    ...prepared.tree.children.slice(0, prepared.firstIndex), ...nodes, ...prepared.tree.children.slice(prepared.lastIndex + 1),
  ] };
  let replacement = processor.stringify(fragment);
  if (prepared.range.end < prepared.source.length && replacement.endsWith('\n') && prepared.source.slice(prepared.range.end).startsWith('\n')) {
    replacement = replacement.slice(0, -1);
  }
  const content = prepared.source.slice(0, prepared.range.start) + replacement + prepared.source.slice(prepared.range.end);
  if (content.length > MAX_NOTE_LENGTH || !equivalent(expected, processor.parse(content))) {
    throw new MarkdownFormatError('CONTENT_PROTECTION_FAILED', 'The requested layout could not preserve the note');
  }
  return content;
}

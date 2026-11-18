/**
 * Section-level edits for Markdown notes, so a model can add to one part of a
 * note without resending (and possibly rewriting) the rest of it.
 *
 * A section is an ATX heading ("## Title") plus every line up to the next
 * heading of the same or a higher level. Headings inside fenced code blocks are
 * ignored. Trailing blank lines and a closing "---" divider stay with the
 * section boundary, so the template's layout survives edits.
 */

export interface NoteHeading {
  /** Zero-based line index of the heading. */
  line: number;
  level: number;
  text: string;
}

export type SectionPatchMode = 'append' | 'replace';

export interface SectionPatch {
  heading: string;
  mode: SectionPatchMode;
  content: string;
  /** Heading level used when the section has to be created (default 2). */
  level?: number;
}

export interface SectionPatchResult {
  content: string;
  /** The heading as it appears in the note. */
  heading: string;
  created: boolean;
  /** The patched section, heading included, so callers can show the result. */
  section: string;
}

export class SectionPatchError extends Error {
  readonly code: 'SECTION_AMBIGUOUS' | 'INVALID_INPUT';
  constructor(code: 'SECTION_AMBIGUOUS' | 'INVALID_INPUT', message: string) {
    super(message);
    this.name = 'SectionPatchError';
    this.code = code;
  }
}

const HEADING = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const DIVIDER = /^[ \t]*(?:[-*_][ \t]*){3,}$/;
/** Template placeholders such as a lone "-" bullet carry no content. */
const EMPTY_BULLET = /^[ \t]*[-*+][ \t]*$/;

function splitLines(content: string): string[] {
  return content.replace(/\r\n?/g, '\n').split('\n');
}

/** List the note's headings, skipping anything inside fenced code. */
export function listHeadings(content: string): NoteHeading[] {
  const headings: NoteHeading[] = [];
  let fence: string | null = null;
  splitLines(content).forEach((line, index) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    const match = HEADING.exec(line);
    if (match) headings.push({ line: index, level: match[1].length, text: match[2] });
  });
  return headings;
}

/** Compare headings without leading emoji, punctuation, case or extra spaces. */
function normalizeHeading(text: string): string {
  return text
    .replace(/^#+\s*/, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Find the one heading the caller means; null when there is none. */
export function findHeading(content: string, heading: string): NoteHeading | null {
  const wanted = normalizeHeading(heading);
  if (!wanted) throw new SectionPatchError('INVALID_INPUT', 'heading must contain letters or digits.');
  const matches = listHeadings(content).filter(candidate => normalizeHeading(candidate.text) === wanted);
  if (matches.length > 1) {
    throw new SectionPatchError(
      'SECTION_AMBIGUOUS',
      `The note has ${matches.length} sections titled "${matches[0].text}". Edit it with tracker_save_notes instead.`,
    );
  }
  return matches[0] ?? null;
}

/** Index one past the section's last line. */
function sectionEnd(lines: string[], headings: NoteHeading[], target: NoteHeading): number {
  const next = headings.find(candidate => candidate.line > target.line && candidate.level <= target.level);
  return next ? next.line : lines.length;
}

/**
 * Split a section body into content and its trailing layout (blank lines and
 * a closing divider), which edits keep in place.
 */
function splitTrailingLayout(body: string[]): { content: string[]; trailing: string[] } {
  let cut = body.length;
  while (cut > 0 && (body[cut - 1].trim() === '' || DIVIDER.test(body[cut - 1]))) cut--;
  return { content: body.slice(0, cut), trailing: body.slice(cut) };
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/** Apply one section edit; creates the section at the end of the note when it is missing. */
export function patchSection(note: string, patch: SectionPatch): SectionPatchResult {
  const addition = trimBlankEdges(splitLines(patch.content));
  if (addition.length === 0) throw new SectionPatchError('INVALID_INPUT', 'content must not be empty.');
  const level = patch.level ?? 2;
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new SectionPatchError('INVALID_INPUT', 'level must be between 1 and 6.');
  }

  const target = findHeading(note, patch.heading);
  if (!target) {
    const title = patch.heading.trim().replace(/^#+\s*/, '');
    const headingLine = `${'#'.repeat(level)} ${title}`;
    const base = trimBlankEdges(splitLines(note));
    const lines = base.length ? [...base, '', headingLine, ...addition] : [headingLine, ...addition];
    return {
      content: `${lines.join('\n')}\n`,
      heading: title,
      created: true,
      section: [headingLine, ...addition].join('\n'),
    };
  }

  const lines = splitLines(note);
  const end = sectionEnd(lines, listHeadings(note), target);
  const body = lines.slice(target.line + 1, end);
  const { content: existing, trailing } = splitTrailingLayout(body);

  // A blank line between heading and text is the author's style; keep it.
  const lead = existing.length > 0 && existing[0].trim() === '' ? [''] : [];
  let nextBody: string[];
  if (patch.mode === 'replace') {
    nextBody = [...lead, ...addition];
  } else {
    const kept = trimBlankEdges(existing.filter(line => !EMPTY_BULLET.test(line)));
    nextBody = kept.length ? [...lead, ...kept, '', ...addition] : [...lead, ...addition];
  }
  // Keep at least one blank line before whatever followed the section.
  const tail = end < lines.length && trailing.length === 0 ? [''] : trailing;
  const updatedSection = [lines[target.line], ...nextBody];
  const updated = [...lines.slice(0, target.line), ...updatedSection, ...tail, ...lines.slice(end)];
  return {
    content: updated.join('\n'),
    heading: target.text,
    created: false,
    section: updatedSection.join('\n'),
  };
}

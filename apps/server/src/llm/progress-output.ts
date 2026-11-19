import { z } from 'zod';
import { progressCandidateInputSchema } from '../../../../packages/contracts/src/practice.ts';

const lineNumber = z.number().int().positive();
const responseSchema = z.object({
  candidates: z.array(progressCandidateInputSchema.extend({
    sourceLine: lineNumber.optional(),
    endLine: lineNumber.optional(),
  })).max(200),
  // Older providers and injected adapters may still return excerpts directly.
  unparsedSnippets: z.array(z.string()).optional(),
});

function withoutFinalLineBreak(text: string): string {
  return text.replace(/(?:\r\n|[\r\n])$/, '');
}

export function decodeProgressOutput(text: string, lines: string[]) {
  const parsed = responseSchema.parse(JSON.parse(text));
  const covered = new Set<number>();
  const hasLineReferences = parsed.candidates.every(row => row.sourceLine !== undefined);
  if (!hasLineReferences && parsed.candidates.some(row => row.sourceLine !== undefined)) {
    throw new Error('Incomplete source line references');
  }
  const candidates = parsed.candidates.map(({ sourceLine, endLine, ...candidate }) => {
    if (sourceLine === undefined) {
      if (endLine !== undefined) throw new Error('Missing starting line');
      return candidate;
    }
    const last = endLine ?? sourceLine;
    if (last < sourceLine || last > lines.length) throw new Error('Invalid source line range');
    for (let n = sourceLine; n <= last; n++) covered.add(n);
    // The preview contract limits the excerpt to 500 characters. Keep full unmatched lines below.
    return { ...candidate, rawSnippet: withoutFinalLineBreak(lines.slice(sourceLine - 1, last).join('')).slice(0, 500) };
  });
  const unparsedSnippets = hasLineReferences
    ? lines.filter((line, i) => line.trim() && !covered.has(i + 1)).map(withoutFinalLineBreak)
    : parsed.unparsedSnippets ?? [];
  return { candidates, unparsedSnippets };
}

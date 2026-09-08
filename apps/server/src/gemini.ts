/**
 * Gemini format assistant module.
 * Formats unstructured pasted LeetCode progress text into validated candidate records
 * using official @google/genai structured outputs.
 * Local-only, server-side execution: API key is never exposed to the client.
 */
import { GoogleGenAI, Type } from '@google/genai';
import type { ProgressCandidateInput } from '../../../packages/contracts/src/practice.ts';

/** Result structure returned by Gemini formatting. */
export interface GeminiFormatResult {
  candidates: ProgressCandidateInput[];
  unparsedSnippets: string[];
  model: string;
}

/** Error classification for Gemini format operations. */
export class GeminiFormatError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = 'GeminiFormatError';
    this.code = code;
    this.status = status;
  }
}

/** Options for configuring Gemini format assistant. */
export interface GeminiAssistantOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/** Interface for pluggable format service to allow hermetic unit testing. */
export interface IGeminiAssistant {
  formatProgressText(rawText: string, batchYear?: number): Promise<GeminiFormatResult>;
  getStatus(): { configured: boolean; model: string };
}

/**
 * Gemini format assistant for parsing user-provided LeetCode progress text.
 */
export class GeminiAssistant implements IGeminiAssistant {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private formattingLock: Promise<void> = Promise.resolve();

  constructor(options: GeminiAssistantOptions = {}) {
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    this.model = options.model || process.env.GEMINI_MODEL || 'models/gemini-3.8-flash';
    this.timeoutMs = options.timeoutMs || 60000;
  }

  /**
   * Check configuration status without exposing credentials.
   */
  public getStatus(): { configured: boolean; model: string } {
    return {
      configured: Boolean(this.apiKey && this.apiKey.trim().length > 0),
      model: this.model,
    };
  }

  /**
   * Format raw pasted text into structured candidate records.
   * Serialized to allow at most one concurrent AI format execution.
   *
   * @param rawText User-provided pasted progress table text (max 64 KiB).
   * @param batchYear Optional default year for incomplete dates.
   */
  public async formatProgressText(rawText: string, batchYear?: number): Promise<GeminiFormatResult> {
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new GeminiFormatError(
        'GEMINI_NOT_CONFIGURED',
        'Gemini API key is not configured on the server. Please set GEMINI_API_KEY in your environment or .env file.',
        503
      );
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
      return { candidates: [], unparsedSnippets: [], model: this.model };
    }

    if (Buffer.byteLength(rawText, 'utf8') > 64 * 1024) {
      throw new GeminiFormatError(
        'PAYLOAD_TOO_LARGE',
        'Input exceeds maximum limit of 64 KiB. Please paste smaller batches.',
        413
      );
    }

    // Mutex serialization: single concurrency
    const run = this.formattingLock.then(() => this.executeFormat(trimmed, batchYear));
    this.formattingLock = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Perform LLM request with structured JSON schema output and timeout.
   */
  private async executeFormat(rawText: string, batchYear?: number): Promise<GeminiFormatResult> {
    const ai = new GoogleGenAI({ apiKey: this.apiKey! });

    const systemInstruction = `You are a structured data formatting assistant. Your ONLY job is to parse tabular LeetCode progress text into structured records.
The user pasted text copied from their personal LeetCode Progress page, which typically contains:
- Last Submitted (e.g. "Aug 26, 2026", "Sep 8", "2026-08-26")
- Problem (e.g. "1. Two Sum", "206. Reverse Linked List")
- Last Result (e.g. "Accepted", "Wrong Answer", "Time Limit Exceeded")
- Submissions count (integer number of submissions, e.g. 3)

For each identifiable problem row:
- frontendId: The numeric or frontend problem ID string (e.g. "1" from "1. Two Sum").
- title: Problem title if present (e.g. "Two Sum").
- lastSubmitted: The exact submission date or timestamp string from the text.
- lastResult: The submission result string.
- submissions: The total submissions count as an integer. If missing or invalid, use -1.
- rawSnippet: The excerpt or line corresponding to this entry.

Do not invent or hallucinate problems not in the input. If lines cannot be parsed, put them in unparsedSnippets. Limit to at most 200 candidates.`;

    const prompt = batchYear !== undefined
      ? `Batch year context: ${batchYear}\n\nParse the following progress text:\n${rawText}`
      : `Parse the following progress text:\n${rawText}`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        candidates: {
          type: Type.ARRAY,
          description: 'List of parsed progress candidate rows',
          items: {
            type: Type.OBJECT,
            properties: {
              frontendId: { type: Type.STRING },
              title: { type: Type.STRING },
              lastSubmitted: { type: Type.STRING },
              lastResult: { type: Type.STRING },
              submissions: { type: Type.INTEGER },
              rawSnippet: { type: Type.STRING },
            },
            required: ['frontendId', 'lastSubmitted', 'lastResult', 'submissions'],
          },
        },
        unparsedSnippets: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
      required: ['candidates'],
    };

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      const response = await ai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
          abortSignal: abortController.signal,
        },
      });

      clearTimeout(timeoutHandle);

      const text = response.text?.trim() || '{}';
      const parsed = JSON.parse(text) as {
        candidates?: Array<{
          frontendId: string;
          title?: string;
          lastSubmitted: string;
          lastResult: string;
          submissions: number;
          rawSnippet?: string;
        }>;
        unparsedSnippets?: string[];
      };

      const rawCandidates = (parsed.candidates ?? []).slice(0, 200);
      const candidates: ProgressCandidateInput[] = rawCandidates.map(c => ({
        frontendId: String(c.frontendId || '').trim(),
        title: c.title?.trim(),
        lastSubmitted: String(c.lastSubmitted || '').trim(),
        lastResult: String(c.lastResult || '').trim(),
        submissions: typeof c.submissions === 'number' ? c.submissions : parseInt(String(c.submissions), 10) || 0,
        rawSnippet: c.rawSnippet,
      }));

      return {
        candidates,
        unparsedSnippets: parsed.unparsedSnippets ?? [],
        model: this.model,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);

      if (abortController.signal.aborted) {
        throw new GeminiFormatError(
          'GEMINI_TIMEOUT',
          `Gemini formatting timed out after ${Math.round(this.timeoutMs / 1000)} seconds. Please try pasting a smaller batch.`,
          504
        );
      }

      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('503') || message.includes('UNAVAILABLE') || message.includes('high demand')) {
        throw new GeminiFormatError(
          'GEMINI_UNAVAILABLE',
          'Gemini service is temporarily experiencing high demand. Please try again in a few moments.',
          503
        );
      }

      if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('quota')) {
        throw new GeminiFormatError(
          'GEMINI_QUOTA_EXCEEDED',
          'Gemini API quota exceeded. Please check your API quota or retry later.',
          429
        );
      }

      throw new GeminiFormatError('GEMINI_ERROR', `Gemini format request failed: ${message}`, 502);
    }
  }
}

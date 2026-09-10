/**
 * Structured output JSON schemas for Gemini API calls via @google/genai.
 */
import { Type } from '@google/genai';

/** Schema for parsing unstructured progress table text into candidates. */
export const progressFormatResponseSchema = {
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

/** Schema for generating bilingual reasons and daily encouragement. */
export const planContentResponseSchema = {
  type: Type.OBJECT,
  properties: {
    reasons: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          questionId: { type: Type.STRING },
          en: { type: Type.STRING },
          zh: { type: Type.STRING },
        },
        required: ['questionId', 'en', 'zh'],
      },
    },
    encouragement: {
      type: Type.OBJECT,
      properties: {
        en: { type: Type.STRING },
        zh: { type: Type.STRING },
      },
      required: ['en', 'zh'],
    },
  },
  required: ['reasons', 'encouragement'],
};

/** Schema for parsing natural language override requests into a RulePatch. */
export const overrideResponseSchema = {
  type: Type.OBJECT,
  properties: {
    dailyCount: { type: Type.INTEGER },
    difficulty: {
      type: Type.OBJECT,
      properties: {
        Easy: { type: Type.NUMBER },
        Medium: { type: Type.NUMBER },
        Hard: { type: Type.NUMBER },
      },
      required: ['Easy', 'Medium', 'Hard'],
    },
    tags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    premium: { type: Type.BOOLEAN },
    reviewEnabled: { type: Type.BOOLEAN },
    reviewPercent: { type: Type.NUMBER },
    preference: { type: Type.STRING },
    unresolved: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
};

/** Schema for qualitative preference-based problem ranking and selection. */
export const problemSelectionResponseSchema = {
  type: Type.OBJECT,
  properties: {
    selectedQuestionIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ['selectedQuestionIds'],
};

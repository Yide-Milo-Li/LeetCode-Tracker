/**
 * Size limits of one chat request. Kept free of schema imports so the web client can apply the
 * same limits before sending without bundling the validators.
 */

/** Turns kept per request; the client drops the oldest ones beyond this. */
export const CHAT_MAX_MESSAGES = 40;
/** Characters allowed in one turn. */
export const CHAT_MAX_MESSAGE_CHARS = 24_000;
/** Characters allowed across all turns of one request. */
export const CHAT_MAX_TOTAL_CHARS = 120_000;

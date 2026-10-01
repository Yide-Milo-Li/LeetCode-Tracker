/** Shared contract imports carry no transport instance. */
export * from '../../contracts/src/index.ts';
export { ApiError } from './client.ts';
export type { GeminiStatus, GeminiFormatResponse, CatalogQuery, PracticeQuery } from './client-http-adapter.ts';

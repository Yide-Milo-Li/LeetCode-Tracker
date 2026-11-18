/** Transport-neutral failure, preserving compatibility details for entrypoint adapters. */
export class ApplicationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(status: number, details: Record<string, unknown>) {
    super(typeof details.message === 'string' ? details.message : String(details.error));
    this.name = 'ApplicationError';
    this.code = String(details.error);
    this.status = status;
    this.details = details;
  }
}
export function fail(status: number, details: Record<string, unknown>): never {
  throw new ApplicationError(status, details);
}
export interface ExportArtifact<T = unknown> {
  readonly kind: 'export'; readonly content: T; readonly mediaType: string; readonly filename: string;
}
/** Return content to the adapter without accepting filesystem destinations. */
export function artifact<T>(content: T, mediaType: string, filename: string): ExportArtifact<T> {
  return {kind:'export', content, mediaType, filename};
}

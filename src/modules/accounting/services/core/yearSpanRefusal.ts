/**
 * The refusal for a run that would post journals in more than MAX_RUN_YEARS distinct years (core/numberYearLocks.ts).
 * Dependency-free so withErrorHandler and the MCP registry can recognise it without importing the lock module.
 */
/** The most distinct years one run may lock. A run spanning more is refused, not split. */
export const MAX_RUN_YEARS = 20;

/** A run that would post in more than MAX_RUN_YEARS years. Raised before any lock or write: a 400, never a 503. */
export class YearSpanTooWideError extends Error {
  readonly code = 'YEAR_SPAN_TOO_WIDE';
  readonly statusCode = 400;
  constructor(readonly years: number) {
    super(`This run would post journals in ${years} different years (at most ${MAX_RUN_YEARS}). `
      + 'Split it into runs that each cover fewer years.');
    this.name = 'YearSpanTooWideError';
  }
}

export function isYearSpanTooWide(err: unknown): err is YearSpanTooWideError {
  return err instanceof Error && (err as { code?: unknown }).code === 'YEAR_SPAN_TOO_WIDE';
}

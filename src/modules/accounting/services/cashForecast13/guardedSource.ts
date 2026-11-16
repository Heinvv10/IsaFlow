/**
 * One source of the forecast in its own savepoint (the SARS calendar's pattern, sarsComplianceCalendarDb.ts).
 * A DATABASE error (a five-character SQLSTATE `code`) rolls the savepoint back, is logged and becomes a
 * `source_unavailable` warning, so one unreadable source leaves the rest of the forecast and the request
 * transaction usable. So does a DOMAIN refusal the caller names (review L1: an explicit allow-list per source —
 * no fiscal year for the horizon end, a loan not found or with terms the engine refuses). Anything else is a
 * code bug and propagates.
 */
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ForecastWarning } from './types';

export function isDatabaseError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/** A source's known domain refusals; false for everything else. */
export type DomainRefusal = (err: unknown) => boolean;

export async function guardedSource<T>(
  savepoint: string, source: string, warnings: ForecastWarning[], read: () => Promise<T>, domainRefusal?: DomainRefusal,
): Promise<T | null> {
  try {
    return await withSavepoint(savepoint, read);
  } catch (err) {
    const domain = !isDatabaseError(err) && domainRefusal !== undefined && domainRefusal(err);
    if (!isDatabaseError(err) && !domain) throw err;
    log.warn('Cash forecast source could not be read', { error: err, source }, 'cashForecast13');
    const why = domain ? `: ${(err as Error).message}` : '';
    warnings.push({ code: 'source_unavailable', source, message: `${source} could not be read${why}; the forecast leaves it out` });
    return null;
  }
}

/** A refusal recognised by its class or its exact message shape. */
export function refusalOf(classes: ReadonlyArray<abstract new (...a: never[]) => Error>, messages: readonly RegExp[]): DomainRefusal {
  return (err) => err instanceof Error && (classes.some((c) => err instanceof c) || messages.some((m) => m.test(err.message)));
}

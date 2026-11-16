/**
 * One source of the forecast in its own savepoint (the SARS calendar's pattern, sarsComplianceCalendarDb.ts).
 * A DATABASE error (a five-character SQLSTATE `code`) rolls the savepoint back, is logged and becomes a
 * `source_unavailable` warning, so one unreadable source leaves the rest of the forecast and the request
 * transaction usable. Anything else is a code bug and propagates.
 */
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ForecastWarning } from './types';

export function isDatabaseError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

export async function guardedSource<T>(
  savepoint: string, source: string, warnings: ForecastWarning[], read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await withSavepoint(savepoint, read);
  } catch (err) {
    if (!isDatabaseError(err)) throw err;
    log.warn('Cash forecast source could not be read', { error: err, source }, 'cashForecast13');
    warnings.push({ code: 'source_unavailable', source, message: `${source} could not be read; the forecast leaves it out` });
    return null;
  }
}

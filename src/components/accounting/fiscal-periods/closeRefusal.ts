/**
 * Reading a refused period close on the client. Every close path answers a
 * readiness refusal with 409 and `error.details.code = PERIOD_CLOSE_NOT_READY`
 * (pages/api/accounting/fiscal-periods-action.ts); a refused Bulk Close period
 * carries the same `periods` on its result row. apiFetch resolves on 4xx, so
 * the caller asks here BEFORE assertOk turns the response into a bare message.
 */

import { log } from '@/lib/logger';
import { PERIOD_CLOSE_NOT_READY, type BlockedPeriod } from '@/modules/accounting/services/gl/periodCloseRefusalShape';

export interface CloseRefusal {
  /** Set when a whole year was refused. */
  fiscalYear?: number;
  periods: BlockedPeriod[];
}

interface RefusalBody {
  error?: { details?: { code?: unknown; fiscalYear?: unknown; periods?: unknown } };
}

/** The refusal on a 409, or null for any other response (which assertOk then handles). Reads a clone. */
export async function readCloseRefusal(res: Response): Promise<CloseRefusal | null> {
  if (res.status === 409) {
    let body: RefusalBody;
    try {
      body = await res.clone().json() as RefusalBody;
    } catch (err) {
      log.warn('A 409 from a period close had no JSON body', { error: err }, 'accounting-ui');
      return null;
    }
    const details = body.error?.details;
    if (details?.code === PERIOD_CLOSE_NOT_READY && Array.isArray(details.periods)) {
      return {
        ...(typeof details.fiscalYear === 'number' ? { fiscalYear: details.fiscalYear } : {}),
        periods: details.periods as BlockedPeriod[],
      };
    }
  }
  return null;
}

/** The refused periods of a Bulk Close result, as one refusal; null when none was refused by the checks. */
export function bulkCloseRefusal(
  results: ReadonlyArray<{ code?: string; periods?: BlockedPeriod[] }>,
): CloseRefusal | null {
  const periods = results.filter((r) => r.code === PERIOD_CLOSE_NOT_READY).flatMap((r) => r.periods ?? []);
  return periods.length > 0 ? { periods } : null;
}

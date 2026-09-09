import { fmtDate } from '@/lib/fmtDate';
import { getPeriodStatusForDate } from './periodStatusService';

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export async function resolveReversalDate(
  companyId: string,
  originalDate: string,
  requested: string | undefined,
): Promise<string> {
  if (requested === undefined) {
    const originalPeriod = await getPeriodStatusForDate(companyId, originalDate);
    return originalPeriod === 'open' ? originalDate : fmtDate(new Date());
  }
  if (!isCalendarDate(requested)) {
    throw new Error(`reversal_date must be a real calendar date in YYYY-MM-DD format, got "${requested}"`);
  }
  if (requested < originalDate) {
    throw new Error(
      `reversal_date ${requested} is before the entry it reverses (${originalDate}). `
      + 'A correction cannot be dated earlier than the entry it corrects.',
    );
  }
  const targetPeriod = await getPeriodStatusForDate(companyId, requested);
  if (targetPeriod === 'no_period') {
    throw new Error(
      `No fiscal period covers reversal_date ${requested}. `
      + 'Create the fiscal year first — posting outside every period would leave the '
      + 'reversal invisible to the trial balance, the VAT201 and the AFS.',
    );
  }
  if (targetPeriod !== 'open') {
    throw new Error(`The fiscal period covering reversal_date ${requested} is closed.`);
  }
  return requested;
}


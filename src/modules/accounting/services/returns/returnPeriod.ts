/**
 * What period a return may be finalised for (wave 5 L1a, review rulings).
 *
 * EMP201 is exactly one calendar month that has ended: a nil return for an ended month is
 * allowed (SARS requires one), but '2026-10-02..10-31', a future month or a whole year would
 * finalise a nil return that no later run could ever make drift. VAT201 is one period of the
 * company's own VAT cycle (companies.vat_period / vat_period_alignment, the same reading as
 * bureau/vatPeriodHelper); that it has ended and spans at most 12 months is lockVatPeriod's.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import {
  normalizeVatAlignment, normalizeVatSetting,
} from '@/modules/bureau/services/vatPeriodHelper';
import { ReturnRefusal } from './returnVersionTypes';

type Ymd = { y: number; m: number; d: number };

function parse(date: string): Ymd {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

/** Last calendar day of month m (1..12), leap-aware. */
function lastDayOf(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const isMonthEnd = (t: Ymd): boolean => t.d === lastDayOf(t.y, t.m);

/** Months from the first day's month to the last day's, inclusive. */
const monthSpan = (a: Ymd, b: Ymd): number => (b.y - a.y) * 12 + (b.m - a.m) + 1;

export function assertEmpPeriod(periodStart: string, periodEnd: string): void {
  const a = parse(periodStart);
  const b = parse(periodEnd);
  if (a.d !== 1 || !isMonthEnd(b) || monthSpan(a, b) !== 1) {
    throw new ReturnRefusal(400,
      'An EMP201 is one calendar month: periodStart must be the 1st and periodEnd that month\'s last day.');
  }
  if (periodEnd >= fmtDate(new Date())) {
    throw new ReturnRefusal(400, 'An EMP201 can be finalised once its month has ended.');
  }
}

/** The company's VAT cycle: a period starts on the 1st, ends on a month end, and has the cycle's length and parity. */
export async function assertVatPeriodShape(companyId: string, periodStart: string, periodEnd: string): Promise<void> {
  const rows = (await sql`
    SELECT vat_period, vat_system_type, vat_period_alignment FROM companies WHERE id = ${companyId}::UUID
  `) as DbRow[];
  const row = rows[0];
  const setting = normalizeVatSetting(row?.vat_period as string | null, row?.vat_system_type as string | null);
  if (setting === 'none') throw new ReturnRefusal(400, 'This company is not set up as a VAT vendor.');
  const a = parse(periodStart);
  const b = parse(periodEnd);
  const want = setting === 'monthly' ? 1 : 2;
  const oddEnd = normalizeVatAlignment(row?.vat_period_alignment as string | null) === 'odd';
  const shapeOk = a.d === 1 && isMonthEnd(b) && monthSpan(a, b) === want
    && (setting === 'monthly' || (b.m % 2 === 1) === oddEnd);
  if (!shapeOk) {
    throw new ReturnRefusal(400,
      `This company files VAT ${setting}${setting === 'monthly' ? '' : ` (periods ending in ${oddEnd ? 'odd' : 'even'} months)`}: `
      + `${periodStart} to ${periodEnd} is not one of its periods.`);
  }
}

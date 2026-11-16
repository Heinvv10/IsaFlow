/**
 * SARS Tax Periods & Compliance Calendar Service
 * Pure computations — no DB calls. Returns SA VAT and PAYE periods,
 * and a static compliance event calendar.
 */
import { backToFriday, lastDayOf, vatQuickPeriods, type VatAlignment, type VatSetting } from '@/modules/bureau/services/vatPeriodHelper';

export interface TaxPeriod {
  type: 'VAT' | 'PAYE';
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  label: string;
}

export interface ComplianceEvent {
  id?: string;
  eventType: string;
  dueDate: string;
  /** The period the item covers: what a "marked filed" row keys on (a due date moves with the rules). */
  periodStart: string;
  periodEnd: string;
  description: string;
  status: 'pending' | 'completed' | 'overdue';
  submissionId?: string;
  /** Set when a user marked the item filed: who (display name), when (ISO), and the SARS reference they gave. */
  filedBy?: string | null;
  filedAt?: string;
  sarsReference?: string | null;
  /** Set when IsaFlow's own filed submissions cover the item ("Filed on eFiling"): the latest one's reference and time (ISO). */
  efiling?: { reference: string | null; submittedAt: string | null };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function getDeadlineStatus(dueDate: string): ComplianceEvent['status'] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  if (due < today) return 'overdue';
  return 'pending';
}

interface VatFilingPeriod { start: string; end: string; dueDate: string; label: string }

/**
 * VAT periods that END in `year`, derived from vatPeriodHelper (the single
 * source of truth for SARS categories): 'odd' = Category A (ends Jan/Mar/...),
 * 'even' = Category B (ends Feb/Apr/...), 'monthly' = Category C.
 * A non-vendor ('none') has none. Due on the 25th of the month after the end,
 * moved back to the Friday when that is a weekend. Public holidays are not
 * shifted (no holiday calendar); eFiling's later deadline is not shown.
 */
function vatFilingPeriods(year: number, alignment: VatAlignment, setting: VatSetting): VatFilingPeriod[] {
  if (setting === 'none') return [];
  return vatQuickPeriods(year, setting, alignment).map((q) => {
    const endYear = Number(q.to.slice(0, 4));
    const endMonth = Number(q.to.slice(5, 7));
    const dueYear = endMonth === 12 ? endYear + 1 : endYear;
    const dueMonth = endMonth === 12 ? 1 : endMonth + 1;
    return { start: q.from, end: q.to, dueDate: backToFriday(dueYear, dueMonth, 25), label: q.label };
  });
}

/**
 * Return SA tax periods for `year`.
 * VAT: the periods ending in `year` for the company's category (see vatFilingPeriods).
 * PAYE: Monthly periods
 */
export function getTaxPeriods(year?: number, alignment: VatAlignment = 'odd', setting: VatSetting = 'bi-monthly'): TaxPeriod[] {
  const y = year || new Date().getFullYear();
  const periods: TaxPeriod[] = [];
  const payeMonthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  for (const vp of vatFilingPeriods(y, alignment, setting)) {
    periods.push({ type: 'VAT', periodStart: vp.start, periodEnd: vp.end, dueDate: vp.dueDate, label: `VAT201 — ${vp.label}` });
  }

  for (let m = 1; m <= 12; m++) {
    const lastDay = new Date(y, m, 0).getDate();
    const dueMonth = m + 1;
    const dueYear = dueMonth > 12 ? y + 1 : y;
    const dueM = dueMonth > 12 ? 1 : dueMonth;

    periods.push({
      type: 'PAYE',
      periodStart: `${y}-${pad(m)}-01`,
      periodEnd: `${y}-${pad(m)}-${pad(lastDay)}`,
      dueDate: backToFriday(dueYear, dueM, 7),
      label: `EMP201 — ${payeMonthNames[m - 1]} ${y}`,
    });
  }

  return periods;
}

/**
 * Build a static compliance event calendar with upcoming SARS deadlines.
 * Includes VAT201, EMP201, EMP501, and Provisional Tax (IRP6).
 */
export function getComplianceCalendar(year?: number, alignment: VatAlignment = 'odd', setting: VatSetting = 'bi-monthly'): ComplianceEvent[] {
  const y = year || new Date().getFullYear();
  const events: ComplianceEvent[] = [];

  for (const vp of vatFilingPeriods(y, alignment, setting)) {
    events.push({
      eventType: 'VAT201_DUE',
      dueDate: vp.dueDate,
      periodStart: vp.start,
      periodEnd: vp.end,
      description: `VAT201 return for ${vp.label}`,
      status: getDeadlineStatus(vp.dueDate),
    });
  }

  const calMonthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  for (let m = 1; m <= 12; m++) {
    const dueMonth = m + 1;
    const dueYear = dueMonth > 12 ? y + 1 : y;
    const dueM = dueMonth > 12 ? 1 : dueMonth;
    const dueDate = backToFriday(dueYear, dueM, 7);
    events.push({
      eventType: 'EMP201_DUE',
      dueDate,
      periodStart: `${y}-${pad(m)}-01`,
      periodEnd: `${y}-${pad(m)}-${pad(lastDayOf(y, m))}`,
      description: `EMP201 (PAYE/UIF/SDL) for ${calMonthNames[m - 1]} ${y}`,
      status: getDeadlineStatus(dueDate),
    });
  }

  const emp501Annual = backToFriday(y, 5, 31);
  const emp501Interim = backToFriday(y, 10, 31);
  const febEnd = (fy: number) => `${fy}-02-${pad(lastDayOf(fy, 2))}`;
  events.push({ eventType: 'EMP501_DUE', dueDate: emp501Annual, periodStart: `${y - 1}-03-01`, periodEnd: febEnd(y), description: `EMP501 Annual Reconciliation — Tax Year ending Feb ${y}`, status: getDeadlineStatus(emp501Annual) });
  events.push({ eventType: 'EMP501_DUE', dueDate: emp501Interim, periodStart: `${y}-03-01`, periodEnd: `${y}-08-31`, description: `EMP501 Interim Reconciliation (Mar–Aug ${y}) — Tax Year ending Feb ${y + 1}`, status: getDeadlineStatus(emp501Interim) });
  const irp6First = backToFriday(y, 8, 31);
  const irp6Second = backToFriday(y + 1, 2, lastDayOf(y + 1, 2));
  events.push({ eventType: 'PROVISIONAL_TAX', dueDate: irp6First, periodStart: `${y}-03-01`, periodEnd: `${y}-08-31`, description: `IRP6 First Provisional Tax Payment — Tax Year ending Feb ${y + 1}`, status: getDeadlineStatus(irp6First) });
  events.push({ eventType: 'PROVISIONAL_TAX', dueDate: irp6Second, periodStart: `${y}-03-01`, periodEnd: febEnd(y + 1), description: `IRP6 Second Provisional Tax Payment — Tax Year ending Feb ${y + 1}`, status: getDeadlineStatus(irp6Second) });

  events.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return events;
}

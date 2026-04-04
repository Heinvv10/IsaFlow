/**
 * SARS Tax Periods & Compliance Calendar Service
 * Pure computations — no DB calls. Returns SA VAT and PAYE periods,
 * and a static compliance event calendar.
 */

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
  description: string;
  status: 'pending' | 'completed' | 'overdue';
  submissionId?: string;
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

/**
 * Return SA tax periods for the current tax year.
 * VAT: Bi-monthly periods — Category A (odd: Jan/Feb...) or Category B (even: Feb/Mar...)
 * PAYE: Monthly periods
 */
export function getTaxPeriods(year?: number, alignment: 'odd' | 'even' = 'odd'): TaxPeriod[] {
  const y = year || new Date().getFullYear();
  const periods: TaxPeriod[] = [];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const payeMonthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const startMonths = alignment === 'even' ? [2, 4, 6, 8, 10, 12] : [1, 3, 5, 7, 9, 11];

  for (const sm of startMonths) {
    const endMonth = sm + 1;
    const startYear = y;
    const endYear = endMonth > 12 ? y + 1 : y;
    const em = endMonth > 12 ? 1 : endMonth;
    const lastDay = new Date(endYear, em, 0).getDate();
    const vp = {
      start: `${startYear}-${pad(sm)}-01`,
      end: `${endYear}-${pad(em)}-${pad(lastDay)}`,
      label: `${monthNames[sm - 1]}–${monthNames[em - 1]} ${endYear !== startYear ? startYear + '/' + endYear : startYear}`,
    };
    const endDate = new Date(vp.end);
    const dueMonth = endDate.getMonth() + 2;
    const dueYear = dueMonth > 12 ? endDate.getFullYear() + 1 : endDate.getFullYear();
    const dueM = dueMonth > 12 ? dueMonth - 12 : dueMonth;

    periods.push({ type: 'VAT', periodStart: vp.start, periodEnd: vp.end, dueDate: `${dueYear}-${pad(dueM)}-25`, label: `VAT201 — ${vp.label}` });
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
      dueDate: `${dueYear}-${pad(dueM)}-07`,
      label: `EMP201 — ${payeMonthNames[m - 1]} ${y}`,
    });
  }

  return periods;
}

/**
 * Build a static compliance event calendar with upcoming SARS deadlines.
 * Includes VAT201, EMP201, EMP501, and Provisional Tax (IRP6).
 */
export function getComplianceCalendar(year?: number, alignment: 'odd' | 'even' = 'odd'): ComplianceEvent[] {
  const y = year || new Date().getFullYear();
  const events: ComplianceEvent[] = [];

  const vatEndMonths = alignment === 'even' ? [3, 5, 7, 9, 11, 1] : [2, 4, 6, 8, 10, 12];
  const vatLabels = alignment === 'even'
    ? ['Feb–Mar', 'Apr–May', 'Jun–Jul', 'Aug–Sep', 'Oct–Nov', 'Dec–Jan']
    : ['Jan–Feb', 'Mar–Apr', 'May–Jun', 'Jul–Aug', 'Sep–Oct', 'Nov–Dec'];

  for (let i = 0; i < vatEndMonths.length; i++) {
    const endMonth = vatEndMonths[i] as number;
    const dueMonth = endMonth + 1;
    const dueYear = dueMonth > 12 ? y + 1 : y;
    const dueM = dueMonth > 12 ? 1 : dueMonth;
    events.push({
      eventType: 'VAT201_DUE',
      dueDate: `${dueYear}-${pad(dueM)}-25`,
      description: `VAT201 return for ${vatLabels[i]} ${y}`,
      status: getDeadlineStatus(`${dueYear}-${pad(dueM)}-25`),
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
    events.push({
      eventType: 'EMP201_DUE',
      dueDate: `${dueYear}-${pad(dueM)}-07`,
      description: `EMP201 (PAYE/UIF/SDL) for ${calMonthNames[m - 1]} ${y}`,
      status: getDeadlineStatus(`${dueYear}-${pad(dueM)}-07`),
    });
  }

  events.push({ eventType: 'EMP501_DUE', dueDate: `${y}-05-31`, description: `EMP501 Interim Reconciliation — Tax Year ending Feb ${y}`, status: getDeadlineStatus(`${y}-05-31`) });
  events.push({ eventType: 'EMP501_DUE', dueDate: `${y}-10-31`, description: `EMP501 Annual Reconciliation — Tax Year ending Feb ${y}`, status: getDeadlineStatus(`${y}-10-31`) });
  events.push({ eventType: 'PROVISIONAL_TAX', dueDate: `${y}-08-31`, description: `IRP6 First Provisional Tax Payment — Tax Year ending Feb ${y + 1}`, status: getDeadlineStatus(`${y}-08-31`) });
  events.push({ eventType: 'PROVISIONAL_TAX', dueDate: `${y + 1}-02-28`, description: `IRP6 Second Provisional Tax Payment — Tax Year ending Feb ${y + 1}`, status: getDeadlineStatus(`${y + 1}-02-28`) });

  events.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return events;
}

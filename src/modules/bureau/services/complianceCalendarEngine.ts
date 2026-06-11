/**
 * Pure compliance-calendar engine: derives upcoming statutory due dates from
 * a per-company obligation config. No DB, no clock — callers supply `today`.
 *
 * Date conventions (deliberate, documented):
 * - Window is [today - graceDays, today + horizonDays] on UTC calendar dates:
 *   items due today stay visible, and a missed deadline lingers as overdue
 *   for the grace period (default 7 days) instead of silently vanishing.
 * - VAT due the 25th of the month after period end — same rule as
 *   vatPeriodHelper. 'odd' alignment = periods END in odd months (the
 *   cockpit's existing Category-A convention); 'even' = END in even months.
 *   Only periods ending AFTER today are emitted: the just-ended period is
 *   owned by vatDueSignal, which knows whether the return was filed.
 * - EMP201 due the 7th of every month, covering the prior payroll month.
 *   SARS moves this deadline EARLIER over weekends, so a Saturday/Sunday 7th
 *   is pulled back to the Friday. Public holidays are out of scope.
 * - EMP501 interim due 31 Oct (Mar–Aug), annual due 31 May (Mar–Feb).
 * - IRP6 1st payment: last day of the 6th month before financial year end;
 *   2nd payment: last day of the year-end month (leap-aware).
 * - CIPC annual return: last day of the anniversary month (always at or
 *   before the true 30-business-day rule, so the simplification is safe).
 * - No weekend adjustment for VAT/EMP501/IRP6/CIPC: the 25th eFiling rule
 *   extends later, and the last-day rules are already the earliest-safe pick.
 */

import { MONTHS, formatPeriod } from './bureauWorkTypes';

export type ObligationKind =
  | 'vat'
  | 'emp201'
  | 'emp501'
  | 'provisional_tax'
  | 'cipc_annual_return';

export interface ObligationDue {
  kind: ObligationKind;
  task: string;
  detail: string;
  /** YYYY-MM-DD */
  dueDate: string;
}

export interface EngineConfig {
  vat: { enabled: boolean; period: 'monthly' | 'bi-monthly'; alignment: 'odd' | 'even' };
  emp201Enabled: boolean;
  emp501Enabled: boolean;
  provisionalTax: { enabled: boolean; yearEndMonth: number };
  cipc: { enabled: boolean; anniversaryMonth: number | null };
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Last calendar day of month m (1..12) in year y — leap-aware. */
function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function prevMonth(y: number, m: number): { y: number; m: number } {
  return m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
}

/** Pull a weekend due day back to the preceding Friday. */
function backToFriday(y: number, m: number, d: number): string {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 6) return iso(y, m, d - 1); // Saturday → Friday
  if (dow === 0) return iso(y, m, d - 2); // Sunday → Friday
  return iso(y, m, d);
}

/**
 * Statutory obligations due within [today - graceDays, today + horizonDays],
 * sorted by due date.
 */
export function upcomingObligations(
  config: EngineConfig,
  today: Date,
  horizonDays = 90,
  graceDays = 7,
): ObligationDue[] {
  const todayIso = today.toISOString().slice(0, 10);
  const startIso = new Date(today.getTime() - graceDays * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const horizonIso = new Date(today.getTime() + horizonDays * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const inWindow = (d: string) => d >= startIso && d <= horizonIso;
  const items: ObligationDue[] = [];

  // Iterate candidate months from last month through horizon + 1 month.
  const startY = today.getUTCFullYear();
  const startM = today.getUTCMonth() + 1;
  const monthsToScan = Math.ceil(horizonDays / 28) + 2;

  for (let i = -1; i <= monthsToScan; i++) {
    const total = startY * 12 + (startM - 1) + i;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;

    // EMP201 — 7th of month m covers payroll month m-1 (weekends pull back)
    if (config.emp201Enabled) {
      const due = backToFriday(y, m, 7);
      if (inWindow(due)) {
        const p = prevMonth(y, m);
        items.push({ kind: 'emp201', task: 'EMP201 due', detail: formatPeriod(p.m, p.y), dueDate: due });
      }
    }

    // VAT — period ends last day of month m when parity matches (or monthly);
    // due the 25th of the following month. Periods that have already ended
    // belong to vatDueSignal (which checks vat_returns), so only future-ending
    // periods are emitted here.
    if (config.vat.enabled) {
      const endsHere =
        config.vat.period === 'monthly' ||
        (m % 2 === 1) === (config.vat.alignment === 'odd');
      const periodEndIso = iso(y, m, lastDay(y, m));
      if (endsHere && periodEndIso > todayIso) {
        const dueMonth = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
        const due = iso(dueMonth.y, dueMonth.m, 25);
        if (inWindow(due)) {
          const detail =
            config.vat.period === 'monthly'
              ? formatPeriod(m, y)
              : `${MONTHS[(m + 10) % 12]}–${MONTHS[m - 1]} ${y}`;
          items.push({ kind: 'vat', task: 'VAT return due', detail, dueDate: due });
        }
      }
    }

    // EMP501 — interim due 31 Oct, annual due 31 May
    if (config.emp501Enabled) {
      if (m === 10) {
        const due = iso(y, 10, 31);
        if (inWindow(due)) {
          items.push({ kind: 'emp501', task: 'EMP501 reconciliation due', detail: `Interim Mar–Aug ${y}`, dueDate: due });
        }
      }
      if (m === 5) {
        const due = iso(y, 5, 31);
        if (inWindow(due)) {
          items.push({ kind: 'emp501', task: 'EMP501 reconciliation due', detail: `Annual Mar ${y - 1}–Feb ${y}`, dueDate: due });
        }
      }
    }

    // IRP6 provisional tax — 2nd payment at year end; 1st payment 6 months earlier
    if (config.provisionalTax.enabled) {
      const ye = config.provisionalTax.yearEndMonth;
      if (m === ye) {
        const due = iso(y, m, lastDay(y, m));
        if (inWindow(due)) {
          items.push({ kind: 'provisional_tax', task: 'Provisional tax (IRP6) due', detail: `2nd payment FY${y}`, dueDate: due });
        }
      }
      const firstMonth = ((ye + 5) % 12) + 1; // 6 months before year end, wrapping
      if (m === firstMonth) {
        const due = iso(y, m, lastDay(y, m));
        if (inWindow(due)) {
          // FY label = calendar year of the year-end that follows this 1st payment
          const fyEndYear = firstMonth < ye ? y : y + 1;
          items.push({ kind: 'provisional_tax', task: 'Provisional tax (IRP6) due', detail: `1st payment FY${fyEndYear}`, dueDate: due });
        }
      }
    }

    // CIPC annual return — last day of the anniversary month
    if (config.cipc.enabled && config.cipc.anniversaryMonth) {
      if (m === config.cipc.anniversaryMonth) {
        const due = iso(y, m, lastDay(y, m));
        if (inWindow(due)) {
          items.push({ kind: 'cipc_annual_return', task: 'CIPC annual return due', detail: `Anniversary month ${MONTHS[m - 1]}`, dueDate: due });
        }
      }
    }
  }

  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return items;
}

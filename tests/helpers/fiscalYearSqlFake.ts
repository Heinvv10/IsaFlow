/**
 * A stand-in for the two registry functions in the database
 * (`fiscal_year_for_date`, `fiscal_year_for_label`, migration 940), for unit tests that
 * drive the REAL gl/fiscalYearRegistry.ts through a mocked `sql`.
 *
 * It answers from a fixed list of stored years only; a date or label no year holds is "no
 * row" (the registry throws / returns null), standing in for a date outside every year.
 */

export interface FakeYear {
  fiscalYear: number;
  startDate: string;
  endDate: string;
  status?: string;
  kind?: 'normal' | 'transition';
}

function row(y: FakeYear, id: string | null) {
  return {
    id,
    fiscal_year: y.fiscalYear,
    start_date: y.startDate,
    end_date: y.endDate,
    status: y.status ?? 'open',
    kind: y.kind ?? 'normal',
    stored: id !== null,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The twelve-month template year holding `date` for a company declaring `month` (1-12). */
function templateYear(date: string, month: number): FakeYear {
  const year = Number(date.slice(0, 4));
  const startYear = Number(date.slice(5, 7)) >= month ? year : year - 1;
  const endYear = month === 1 ? startYear : startYear + 1;
  const endMonth = month === 1 ? 12 : month - 1;
  const endDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return {
    fiscalYear: endYear,
    startDate: `${startYear}-${pad(month)}-01`,
    endDate: `${endYear}-${pad(endMonth)}-${pad(endDay)}`,
  };
}

/**
 * `sql` tagged-template mock answering the registry queries from `years`.
 * With `templateMonth`, a date no stored year holds gets that month's twelve-month
 * template year (`stored: false`, no id), as the database's template does.
 */
export function fiscalYearSqlFake(years: readonly FakeYear[], opts: { templateMonth?: number } = {}) {
  const calls: string[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push(text);
    if (text.includes('fiscal_year_for_date')) {
      const date = String(values[1]);
      const hit = years.find((y) => date >= y.startDate && date <= y.endDate);
      if (hit) return [row(hit, `fy-${hit.fiscalYear}`)];
      return opts.templateMonth ? [row(templateYear(date, opts.templateMonth), null)] : [];
    }
    if (text.includes('fiscal_year_for_label')) {
      const hit = years.find((y) => y.fiscalYear === Number(values[1]));
      return hit ? [row(hit, `fy-${hit.fiscalYear}`)] : [];
    }
    if (text.includes('FROM fiscal_years')) {
      return years.map((y) => row(y, `fy-${y.fiscalYear}`));
    }
    throw new Error(`fiscalYearSqlFake: unexpected query: ${text.slice(0, 80)}`);
  };
  return Object.assign(fn, { calls });
}

/** The company the fixture calendars belong to, and the two shapes the tests share. */
export const MARCH_YEARS: readonly FakeYear[] = [
  { fiscalYear: 2025, startDate: '2024-03-01', endDate: '2025-02-28' },
  { fiscalYear: 2026, startDate: '2025-03-01', endDate: '2026-02-28' },
  { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' },
];

/**
 * A January company that moved to a February year end: FY2027 is a 14-month transition year
 * (2026-01-01 to 2027-02-28) and the year before it is a calendar year, not March-based.
 */
export const TRANSITION_YEARS: readonly FakeYear[] = [
  { fiscalYear: 2026, startDate: '2025-01-01', endDate: '2025-12-31' },
  { fiscalYear: 2027, startDate: '2026-01-01', endDate: '2027-02-28', kind: 'transition' },
  { fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29' },
];

// ── The registry module itself, for unit tests that mock `sql` with an ordered queue ──────
//
// A test that queues `sql` results in call order cannot also let the registry query the
// database: its queries would take queue entries meant for the service. Such a test mocks the
// REGISTRY MODULE instead:
//
//   vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
//     async () => (await import('../../helpers/fiscalYearSqlFake')).registryMock());
//
// and sets `fakeRegistry.years` (default: the March calendar, with March templates beyond it).

import { vi } from 'vitest';

export interface FakeCalendar { years: readonly FakeYear[]; templateMonth: number | undefined }

export const fakeRegistry: FakeCalendar & { companies: Record<string, FakeCalendar> } = {
  years: MARCH_YEARS,
  templateMonth: 3,
  /** A calendar for one company id; any other company reads `years` / `templateMonth`. */
  companies: {},
};

export function resetFakeRegistry(): void {
  fakeRegistry.years = MARCH_YEARS;
  fakeRegistry.templateMonth = 3;
  fakeRegistry.companies = {};
}

export async function registryMock() {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/gl/fiscalYearRegistry')>(
    '@/modules/accounting/services/gl/fiscalYearRegistry',
  );
  const record = (y: FakeYear, stored: boolean) => ({
    id: stored ? `fy-${y.fiscalYear}` : null,
    fiscalYear: y.fiscalYear,
    startDate: y.startDate,
    endDate: y.endDate,
    status: (y.status ?? 'open') as 'open',
    kind: y.kind ?? ('normal' as const),
    stored,
    months: actual.monthsSpanned(y.startDate, y.endDate),
    assumed: false,
  });
  const calendarOf = (companyId: string): FakeCalendar => fakeRegistry.companies[companyId] ?? fakeRegistry;
  const forDate = async (companyId: string, date: string) => {
    const { years, templateMonth } = calendarOf(companyId);
    const hit = years.find((y) => date >= y.startDate && date <= y.endDate);
    if (hit) return record(hit, true);
    if (templateMonth) return record(templateYear(date, templateMonth), false);
    throw new Error(`fiscalYearForDate: no fiscal year on ${date}`);
  };
  const forLabel = async (companyId: string, label: number) => {
    const hit = calendarOf(companyId).years.find((y) => y.fiscalYear === label);
    return hit ? record(hit, true) : null;
  };
  return {
    ...actual,
    fiscalYearForDate: vi.fn(forDate),
    getFiscalYear: vi.fn(forLabel),
    requireFiscalYear: vi.fn(async (companyId: string, label: number) => {
      const y = await forLabel(companyId, label);
      if (!y) throw new actual.FiscalYearLabelUnknownError(companyId, label);
      return y;
    }),
    priorFiscalYear: vi.fn(async (companyId: string, year: { startDate: string }) =>
      forDate(companyId, actual.dayBefore(year.startDate))),
  };
}

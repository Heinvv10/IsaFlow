/**
 * GET /api/accounting/kpi-dashboard, end to end over a fake SQL layer.
 *
 *  - SAST day: at 22:30 UTC the SAST calendar day is already tomorrow. The
 *    handler's default `to` is todayInSast(now) and its default `from` is
 *    fmtDate(fyStart); a revert to toISOString() gives the UTC day for `to` and
 *    (on this UTC+2 host) the day BEFORE the 1st for `from`.
 *  - Revenue MTD is the SAST month's posted revenue, not the 13-month window
 *    the Revenue tile covers.
 *  - Each side's open book is fetched ONCE per request and feeds both the
 *    Receivables / Payables tiles and the ageing donuts.
 *  - The Overdue tile equals the overdue donut slices plus the overdue disputed
 *    share the tile now reports.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { OpenAgingInvoice } from '@/modules/accounting/utils/aging';
import { mockUnsafe } from '../helpers/sqlFragmentMock';

const h = vi.hoisted(() => ({
  queries: [] as { text: string; values: unknown[] }[],
  revenue: [] as { date: string; amount: number; subtype?: string }[],
  expenses: [] as { date: string; amount: number; subtype?: string }[],
  ar: [] as unknown[],
  ap: [] as unknown[],
  arCalls: 0,
  apCalls: 0,
  inFlight: 0,
  maxInFlight: 0,
  /** Holds a fetch open for a few ticks, counting how many are open at once. */
  slow: async <T,>(rows: T): Promise<T> => {
    h.inFlight += 1;
    h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    h.inFlight -= 1;
    return rows;
  },
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => data),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    internalError: vi.fn((_res: unknown, err: unknown) => { throw err; }),
  },
}));
vi.mock('@/modules/accounting/services/bank/hasBankAccountService', () => ({ hasBankAccount: async () => true }));
vi.mock('@/modules/accounting/services/ar/arAgingInvoices', () => ({
  UNKNOWN_CUSTOMER: 'Unknown customer',
  fetchARAgingInvoices: async () => { h.arCalls += 1; return h.slow(h.ar); },
}));
vi.mock('@/modules/accounting/services/ap/apAgingInvoices', () => ({
  fetchAPAgingInvoices: async () => { h.apCalls += 1; return h.slow(h.ap); },
}));
vi.mock('@/lib/neon', () => {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const fake = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    h.queries.push({ text, values });
    // The monthly chart: per month, per (type, subtype), up to the bound `today`, like its SQL.
    if (text.includes('generate_series') && text.includes("'revenue'")) {
      const today = values.find((v): v is string => typeof v === 'string' && ISO.test(v))!;
      const n = Number(values.find((v) => typeof v === 'number')) + 1;
      const out: unknown[] = [];
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() - i);
        const start = d.toISOString().slice(0, 10);
        const end = new Date(d); end.setUTCMonth(end.getUTCMonth() + 1);
        const inMonth = (x: { date: string }) => x.date >= start && x.date < end.toISOString().slice(0, 10) && x.date <= today;
        const groups = new Map<string, { account_type: string; account_subtype: string; total: number }>();
        for (const [type, rows, sign] of [['revenue', h.revenue, 1], ['expense', h.expenses, 1]] as const) {
          for (const r of rows.filter(inMonth)) {
            const sub = r.subtype ?? (type === 'revenue' ? 'sales' : 'operating_expense');
            const g = groups.get(`${type}/${sub}`) ?? { account_type: type, account_subtype: sub, total: 0 };
            g.total += sign * r.amount;
            groups.set(`${type}/${sub}`, g);
          }
        }
        if (groups.size === 0) out.push({ month_start: start, account_type: null, account_subtype: null, total: 0 });
        for (const g of groups.values()) out.push({ month_start: start, ...g });
      }
      return Promise.resolve(out);
    }
    // KPI expenses between the two bound dates.
    if (text.includes("account_type = 'expense'") && !text.includes('GROUP BY')) {
      const [from, to] = values.filter((v): v is string => typeof v === 'string' && ISO.test(v));
      return Promise.resolve([{ total: h.expenses.filter((x) => x.date >= from! && x.date <= to!).reduce((t, x) => t + x.amount, 0) }]);
    }
    // Posted revenue between the two dates the query is bound with, one row per subtype.
    if (text.includes("account_type = 'revenue'")) {
      const [from, to] = values.filter((v): v is string => typeof v === 'string' && ISO.test(v));
      const bySubtype = new Map<string | null, number>();
      for (const r of h.revenue.filter((x) => x.date >= from! && x.date <= to!)) {
        bySubtype.set(r.subtype ?? 'sales', (bySubtype.get(r.subtype ?? 'sales') ?? 0) + r.amount);
      }
      return Promise.resolve([...bySubtype].map(([account_subtype, total]) => ({ account_subtype, total })));
    }
    return Promise.resolve([]);
  };
  return { sql: Object.assign(fake, { unsafe: mockUnsafe }) };
});

import handler from '../../../pages/api/accounting/kpi-dashboard';

const ORIGINAL_TZ = process.env.TZ;
// 22:30 UTC on 27 Oct is 00:30 on 28 Oct in South Africa.
const NOW = new Date('2026-10-27T22:30:00Z');

beforeAll(() => {
  process.env.TZ = 'Africa/Johannesburg';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

const inv = (id: string, dueDate: string, balance: number, disputedAmount = 0): OpenAgingInvoice => ({
  id, invoiceNumber: id, entityId: 'c1', entityName: 'Cust', dueDate, dueDateMissing: false,
  totalAmount: balance, amountPaid: 0, balance, disputedAmount, invoiceDate: '2026-01-01', reference: null,
});

beforeEach(() => {
  h.queries.length = 0;
  h.arCalls = 0;
  h.apCalls = 0;
  h.maxInFlight = 0;
  h.expenses = [{ date: '2026-10-10', amount: 100 }, { date: '2025-11-01', amount: 30 }];
  h.revenue = [
    { date: '2025-12-15', amount: 1000 },
    { date: '2026-09-30', amount: 200 },
    { date: '2026-10-02', amount: 300 },
    { date: '2026-10-27', amount: 50 },
    // Other income: inside revenue-type accounts, outside the P&L's Revenue line.
    { date: '2026-10-05', amount: 40, subtype: 'other_income' },
    { date: '2026-02-01', amount: 7, subtype: 'Other Income' },
  ];
  // 57 days overdue with R250 disputed, and not yet due with R100 disputed.
  h.ar = [inv('a', '2026-09-01', 1000, 250), inv('b', '2026-11-30', 500, 100)];
  h.ap = [inv('p', '2026-10-20', 80)];
});

type Out = {
  kpis: {
    revenue: { total: number; changePercent: number }; revenueMtd: number;
    netProfit: { amount: number; margin: number };
    receivables: { total: number; overdue: number; overdueDisputed: number };
    payables: { total: number; overdue: number };
  };
  revenueChart: { month: string; revenue: number; expenses: number }[];
  arAging: { name: string; value: number }[];
  apAging: { name: string; value: number }[];
};
const call = async (): Promise<Out> =>
  (await handler({ method: 'GET', query: {}, companyId: 'co-1' } as unknown as NextApiRequest, {} as NextApiResponse)) as unknown as Out;

const revenueQueries = () => h.queries.filter((q) => q.text.includes("account_type = 'revenue'") && !q.text.includes('generate_series'));

describe('kpi-dashboard handler', () => {
  it('uses the SAST day for the window: to = 28 Oct, from = 1 Oct a year earlier', async () => {
    const out = await call();
    const dates = revenueQueries()[0]!.values.filter((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
    expect(dates).toEqual(['2025-10-01', '2026-10-28']);
    expect(out.kpis.revenue.total).toBe(1550);
  });

  it('Revenue MTD is October only, not the 13-month window', async () => {
    const out = await call();
    expect(out.kpis.revenueMtd).toBe(350);
    expect(out.kpis.revenue.total).toBe(1550);
  });

  it('Revenue MTD starts on the 1st of the SAST month, not the UTC month', async () => {
    // 22:30 UTC on 31 Oct is 00:30 on 1 Nov in South Africa: October revenue is no longer "this month".
    vi.setSystemTime(new Date('2026-10-31T22:30:00Z'));
    try {
      h.revenue = [{ date: '2026-10-31', amount: 70 }, { date: '2026-11-01', amount: 5 }];
      expect((await call()).kpis.revenueMtd).toBe(5);
    } finally {
      vi.setSystemTime(NOW);
    }
  });

  it('other income is in neither Revenue nor Revenue MTD, but stays in profit (aliases included)', async () => {
    const out = await call();
    expect(out.kpis.revenue.total).toBe(1550);
    expect(out.kpis.revenueMtd).toBe(350);
    // Net profit: every revenue-type account (1550 + 40 + 7) less every expense (100 + 30).
    expect(out.kpis.netProfit.amount).toBe(1467);
    expect(out.kpis).not.toHaveProperty('grossProfit');
  });

  it('net margin is net profit over turnover, as the P&L\'s', async () => {
    const out = await call();
    expect(out.kpis.netProfit.margin).toBeCloseTo((1467 / 1550) * 100, 6);
  });

  it('every ledger query joins gl_accounts within the company, like the P&L', async () => {
    await call();
    const ledger = h.queries.filter((q) => q.text.includes('gl_journal_lines') && q.text.includes('JOIN gl_accounts'));
    expect(ledger.length).toBeGreaterThanOrEqual(5);
    for (const q of ledger) expect(q.text, q.text.slice(0, 120)).toMatch(/ga\.company_id = jl\.company_id/);
  });

  it('the revenue chart\'s current-month bar is Revenue MTD, and an earlier bar is that month\'s turnover', async () => {
    const out = await call();
    const bars = out.revenueChart;
    expect(bars).toHaveLength(6);
    // Same rows, same banding, same SAST-today bound: October = 300 + 50 + 1000... = the MTD figure.
    expect(bars[5]!.revenue).toBe(out.kpis.revenueMtd);
    expect(bars[5]!.revenue).toBe(350);
    expect(bars[5]!.expenses).toBe(100);
    // September: 200 of sales; the 7 of other income sits in February, outside the six bars.
    expect(bars[4]!.revenue).toBe(200);
  });

  it('the chart\'s current month stops at the SAST today, not month end', async () => {
    h.revenue = [{ date: '2026-10-28', amount: 10 }, { date: '2026-10-29', amount: 99 }];
    h.expenses = [];
    const out = await call();
    expect(out.revenueChart[5]!.revenue).toBe(10);
  });

  it('a net-negative month draws negative (credit notes exceeding sales), not its absolute value', async () => {
    h.revenue = [{ date: '2026-09-10', amount: -80 }, { date: '2026-10-02', amount: 20 }];
    h.expenses = [{ date: '2026-09-11', amount: -15 }];
    const out = await call();
    expect(out.revenueChart[4]!.revenue).toBe(-80);
    expect(out.revenueChart[4]!.expenses).toBe(-15);
  });

  it('other income is not in a chart bar', async () => {
    h.revenue = [{ date: '2026-10-02', amount: 20 }, { date: '2026-10-03', amount: 500, subtype: 'other_income' }];
    h.expenses = [];
    expect((await call()).revenueChart[5]!.revenue).toBe(20);
  });

  it('reads the AR and AP books in parallel', async () => {
    await call();
    expect(h.maxInFlight).toBe(2);
  });

  it('fetches each side of the open book once per request', async () => {
    await call();
    expect(h.arCalls).toBe(1);
    expect(h.apCalls).toBe(1);
  });

  it('the Overdue tile is the overdue donut slices plus the overdue disputed share', async () => {
    const out = await call();
    const slice = (name: string) => out.arAging.find((b) => b.name === name)!.value;
    const overdueSlices = slice('1–30 Days') + slice('31–60 Days') + slice('61–90 Days') + slice('90+ Days');
    expect(out.kpis.receivables.total).toBe(1500);
    expect(out.kpis.receivables.overdue).toBe(1000);
    expect(out.kpis.receivables.overdueDisputed).toBe(250);
    expect(overdueSlices + out.kpis.receivables.overdueDisputed).toBe(out.kpis.receivables.overdue);
    expect(out.arAging.reduce((s, b) => s + b.value, 0)).toBe(out.kpis.receivables.total);
  });
});

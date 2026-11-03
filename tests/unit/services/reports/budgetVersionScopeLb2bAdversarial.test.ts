/**
 * LB-2(b) adversarial suite (PR #1124 round 1, adopted from the reviewer's repros): runs the REAL
 * facade/range/core over the in-memory ledger twice, once with the live budgetVersionScope and once
 * with master's (helpers/budgetVersionScopeMaster.ts, a test fixture).
 *
 * The registry mock answers from W.years; a date in GAP_ERRORS raises the exact error real
 * PostgreSQL's fiscal_year_template raised for that registry (proved on PG16 with 940's function,
 * see pg-proof.txt), with its P0001 code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SALES, RENT, W, fakeSql, resetLedger } from './helpers/budgetLedgerFake';

const impl = { old: false };
const GAP_ERRORS: Record<string, string> = {};

vi.mock('@/lib/neon', () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => fakeSql(s, ...v) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', async (orig) => ({
  ...(await orig<object>()),
  fiscalYearForDate: (_c: string, d: string) => {
    if (GAP_ERRORS[d]) return Promise.reject(Object.assign(new Error(GAP_ERRORS[d]), { code: 'P0001' }));
    const y = W.years.find((r) => d >= r.startDate && d <= r.endDate);
    if (!y) return Promise.reject(new Error(`fiscalYearForDate: no fiscal year for company x on ${d}`));
    return Promise.resolve({ ...y, id: `fy${y.fiscalYear}`, status: 'open', kind: 'normal', stored: y.stored !== false, assumed: false });
  },
  getFiscalYear: (_c: string, fiscalYear: number) => Promise.resolve(W.years.find((y) => y.fiscalYear === fiscalYear) ?? null),
}));
vi.mock('@/modules/accounting/services/budgets/budgetVersionScope', async (orig) => {
  const nu = await orig<typeof import('@/modules/accounting/services/budgets/budgetVersionScope')>();
  const old = await import('./helpers/budgetVersionScopeMaster');
  return {
    ...nu,
    primaryVersionScopeAndYears: (c: string, s: string, e: string) =>
      (impl.old ? old.primaryVersionScopeAndYears : nu.primaryVersionScopeAndYears)(c, s, e),
  };
});

import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
import { buildRangeTracking } from '@/modules/accounting/services/budgets/tracking/trackingRange';

const CO = 'cccccccc-0000-4000-8000-00000000000c';
const settle = async <T>(p: () => Promise<T>) => {
  try { return { ok: true as const, value: await p() }; } catch (e) { return { ok: false as const, error: String((e as Error).message), status: (e as { status?: number }).status }; }
};
const both = async <T>(p: () => Promise<T>) => {
  impl.old = true; const before = await settle(p);
  impl.old = false; const after = await settle(p);
  return { before, after };
};
const budget = (r: { lines: Array<{ account_id: string; budget_amount: number }> }, id: string) => r.lines.find((l) => l.account_id === id)?.budget_amount;

beforeEach(() => { resetLedger(); for (const k of Object.keys(GAP_ERRORS)) delete GAP_ERRORS[k]; impl.old = false; });

describe('REPRO 1: a registry gap holding the 1st of the window\'s first month', () => {
  it('a window starting after the gap (10 Mar) worked before and is a 400 now', async () => {
    // FY2026 ends 25 Feb 2026, FY2027 starts 5 Mar 2026: 26 Feb..4 Mar is a gap holding 1 March.
    W.years = [{ fiscalYear: 2026, startDate: '2025-02-26', endDate: '2026-02-25' }, { fiscalYear: 2027, startDate: '2026-03-05', endDate: '2027-03-04' }];
    GAP_ERRORS['2026-03-01'] = 'fiscal_year_template: no free label for the year holding 2026-03-01 (between FY2026 and FY2027)';
    W.versions = { 2027: 'v27' };
    W.cells = [{ version: 'v27', account: SALES, month: '2026-04', amount: 1000 }];
    const { before, after } = await both(() => buildRangeTracking(CO, '2026-03-10', '2026-04-30'));
    expect(before.ok).toBe(true);
    expect(after).toMatchObject({ ok: true }); // FAILS: 400 No financial year can be placed for that date
  });
});

describe('REPRO 2: first registry year starts mid-month', () => {
  // Real PG: fiscal_year_for_date(co, 2025-03-01) with FY2026 = 15 Mar 2025..14 Mar 2026 the only
  // stored year returns the TEMPLATE FY2025 (2024-03-15..2025-03-14, stored=false), no version.
  const setup = () => {
    W.years = [
      { fiscalYear: 2025, startDate: '2024-03-15', endDate: '2025-03-14', stored: false }, // template, as PG returns it
      { fiscalYear: 2026, startDate: '2025-03-15', endDate: '2026-03-14' },
    ];
    W.versions = { 2026: 'v26' };
    // The FY2026 grid's months are 2025-03..2026-03 (gridSave: budgetMonthKeysInWindow(start, end)).
    W.cells = [
      { version: 'v26', account: SALES, month: '2025-03', amount: 500 },
      { version: 'v26', account: SALES, month: '2025-04', amount: 1000 },
    ];
  };
  it('the company\'s own FY2026 window drops the first month its FY2026 grid holds', async () => {
    setup();
    const { before, after } = await both(() => getBudgetVariance(CO, '2025-03-15', '2026-03-14'));
    expect(before.ok && budget(before.value, SALES)).toBe(1500);
    expect(after.ok && budget(after.value, SALES)).toBe(1500); // FAILS: 1000
  });
  it('a window inside FY2026\'s first month reads no budget at all now', async () => {
    setup();
    const { before, after } = await both(() => getBudgetVariance(CO, '2025-03-20', '2025-03-31'));
    expect(before.ok && budget(before.value, SALES)).toBe(500);
    expect(after.ok && budget(after.value, SALES)).toBe(500); // FAILS: undefined (no line)
  });
});

describe('REPRO 3: consumers of visited vs parts disagree on the owning year', () => {
  const twoYears = () => {
    W.years = [{ fiscalYear: 2026, startDate: '2025-03-15', endDate: '2026-03-14' }, { fiscalYear: 2027, startDate: '2026-03-15', endDate: '2027-03-14' }];
    W.versions = { 2026: 'v26', 2027: 'v27' };
    W.cells = [
      { version: 'v26', account: SALES, month: '2026-03', amount: 500 },
      { version: 'v27', account: SALES, month: '2026-03', amount: 700 },
    ];
  };
  it('window 20-31 Mar 2026 (absent mode, the comparator/MCP): FY2027 reported as having NO budget version', async () => {
    twoYears();
    const { before, after } = await both(() => getBudgetVariance(CO, '2026-03-20', '2026-03-31', { partialWindow: 'absent' }));
    const pick = (r: typeof before) => (r.ok ? { fiscalYear: r.value.fiscalYear, years: r.value.years, budgetAbsentYears: r.value.budgetAbsentYears, version: r.value.version?.id ?? null } : r);
    expect(pick(before)).toEqual({ fiscalYear: 2027, years: [2027], budgetAbsentYears: [], version: 'v27' });
    // FY2027 HAS a primary (v27); the month was read from v26. Expected: no year reported absent.
    // At 8bb78345e: { fiscalYear: 2027, years: [2026], budgetAbsentYears: [2027], version: null }. Now the owning
    // year (FY2026, whose version the month is read from) is the window's year; P0's fiscalYear stays the first day's.
    expect(pick(after)).toEqual({ fiscalYear: 2027, years: [2026], budgetAbsentYears: [], version: 'v26' });
  });
  it('naming the version the default read uses (v26) for that window is refused', async () => {
    twoYears();
    const r = await settle(() => getBudgetVariance(CO, '2026-03-20', '2026-03-31', { partialWindow: 'absent', versionId: 'v26' }));
    expect(r.ok).toBe(true); // was 400: version v26 is FY2026; the window reaches FY2027
    // Naming FY2027's version now reaches FY2026, the month's owner: refused, as any version of another year.
    const v27 = await settle(() => getBudgetVariance(CO, '2026-03-20', '2026-03-31', { partialWindow: 'absent', versionId: 'v27' }));
    expect(v27).toMatchObject({ ok: false, error: 'version v27 is FY2027; the window reaches FY2026' });
  });
});

describe('owner rule, template side: a template year ending mid-month hands its last month to the stored year', () => {
  const setup = () => {
    W.years = [
      { fiscalYear: 2025, startDate: '2024-03-15', endDate: '2025-03-14', stored: false },
      { fiscalYear: 2026, startDate: '2025-03-15', endDate: '2026-03-14' },
    ];
    W.versions = { 2026: 'v26' };
    W.cells = [{ version: 'v26', account: SALES, month: '2025-03', amount: 500 }, { version: 'v26', account: SALES, month: '2025-04', amount: 1000 }];
  };
  it('a window from 1 March reads FY2026\'s March too (master gave it to the template year: 1000)', async () => {
    setup();
    const { before, after } = await both(() => getBudgetVariance(CO, '2025-03-01', '2025-04-30'));
    expect([before.ok && budget(before.value, SALES), after.ok && budget(after.value, SALES)]).toEqual([1000, 1500]);
    expect(after.ok && after.value.fiscalYear).toBe(2025);
  });
  it('a window inside the template year\'s part of March walks on to FY2026 for it (master: no budget)', async () => {
    setup();
    const { before, after } = await both(() => getBudgetVariance(CO, '2025-03-01', '2025-03-10'));
    expect([before.ok && budget(before.value, SALES), after.ok && budget(after.value, SALES)]).toEqual([undefined, 500]);
  });
});

describe('visited is never empty', () => {
  it('an inverted window still reports the year holding its first day', async () => {
    W.years = [{ fiscalYear: 2026, startDate: '2025-03-15', endDate: '2026-03-14' }, { fiscalYear: 2027, startDate: '2026-03-15', endDate: '2027-03-14' }];
    const r = await buildRangeTracking(CO, '2026-03-20', '2026-03-05');
    expect([r.startFiscalYear, r.years, r.months]).toEqual([2027, [], ['2026-03']]);
  });
});

describe('REPRO 4: MAX_YEARS_IN_WINDOW now counts years before the window', () => {
  it('a window touching exactly 200 years by date throws now; it did not before', async () => {
    // 201 one-month years, each 15th..14th; the window starts on the 20th of the first year's 2nd month.
    const years = [] as Array<{ fiscalYear: number; startDate: string; endDate: string }>;
    const ymd = (o: number, d: number) => `${String(2000 + Math.floor(o / 12))}-${String((o % 12) + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    for (let i = 0; i < 202; i++) years.push({ fiscalYear: 1800 + i, startDate: ymd(i, 15), endDate: ymd(i + 1, 14) });
    W.years = years;
    const start = ymd(1, 20); // in year i=1 (15 Feb..14 Mar); 1 Feb is in year i=0
    const end = ymd(200, 20); // in year i=200: years 1..200 = 200 by date
    const { before, after } = await both(() => buildRangeTracking(CO, start, end));
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true); // FAILS: spans too many years
  });
});

describe('Byte identity: companies whose years all start on the 1st (fuzz vs old)', () => {
  it('every window start day, spans, inverted windows, both modes: identical output', async () => {
    let seed = 1124;
    // mulberry32: an LCG's low bits cycle (rnd(2) alternates), which hid edge days from the fuzz.
    const rnd = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const pad = (n: number) => String(n).padStart(2, '0');
    const mEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
    let compared = 0; let succeeded = 0;
    for (let reg = 0; reg < 30; reg++) {
      resetLedger();
      const years = [] as Array<{ fiscalYear: number; startDate: string; endDate: string }>;
      let y = 2024; let m = 1 + rnd(12); let label = 2024;
      for (let i = 0; i < 8; i++) {
        const len = 2 + rnd(14); // 2..15 months
        const sy = y; const sm = m;
        let ey = y; let em = m + len - 1; while (em > 12) { em -= 12; ey += 1; }
        label = Math.max(label + 1, ey);
        years.push({ fiscalYear: label, startDate: `${sy}-${pad(sm)}-01`, endDate: `${ey}-${pad(em)}-${pad(mEnd(ey, em))}` });
        if (rnd(3) === 0) W.versions[label] = `v${label}`;
        y = ey; m = em + 1; if (m > 12) { m = 1; y += 1; }
      }
      W.years = years;
      for (const lbl of Object.keys(W.versions)) {
        for (let k = 0; k < 6; k++) W.cells.push({ version: W.versions[Number(lbl)]!, account: rnd(2) ? SALES : RENT, month: `${2024 + rnd(6)}-${pad(1 + rnd(12))}`, amount: rnd(1000) });
      }
      W.jl = Array.from({ length: 20 }, () => ({ account: rnd(2) ? SALES : RENT, date: `${2024 + rnd(6)}-${pad(1 + rnd(12))}-${pad(1 + rnd(28))}`, amount: rnd(500) }));
      for (let w = 0; w < 40; w++) {
        // Windows inside the registry (an outside one throws the same miss either way, proving nothing).
        const first = years[0]!.startDate; const lastEnd = years[years.length - 1]!.endDate;
        const pick = (lo: string): string => {
          for (;;) {
            const yy = Number(lo.slice(0, 4)) + rnd(4); const mm = 1 + rnd(12); const me = mEnd(yy, mm);
            const dd = rnd(2) ? [1, 2, 15, me - 1, me][rnd(5)]! : 1 + rnd(me);
            const d = `${yy}-${pad(mm)}-${pad(dd)}`;
            if (d >= lo && d <= lastEnd) return d;
          }
        };
        const a = pick(first); const b = pick(a);
        const [start, end] = rnd(10) === 0 ? [b, a] : [a, b];
        for (const run of [
          () => getBudgetVariance(CO, start, end),
          () => getBudgetVariance(CO, start, end, { partialWindow: 'absent' }),
          () => buildRangeTracking(CO, start, end),
        ]) {
          const { before, after } = await both(run);
          expect(JSON.stringify(after), `${start}..${end}`).toBe(JSON.stringify(before));
          compared += 1; if (before.ok) succeeded += 1;
        }
      }
    }
    expect(compared).toBe(3600);
    expect(succeeded).toBeGreaterThan(3000);
  });
});

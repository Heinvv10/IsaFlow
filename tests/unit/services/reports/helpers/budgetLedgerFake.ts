/**
 * An in-memory ledger that answers the budget readers' SQL by query shape, so a unit test runs
 * the REAL facade (`getBudgetVariance`), `trackingRange`, `trackingCore`, P1's `primaryVersionScope`
 * and the line builder with no database. Adopted from the PR-C round-1 ledger-breaker's repro.
 *
 * Use: `vi.mock('@/lib/neon', () => ({ sql: fakeSql }))` and the registry mock below, then fill `W`.
 */
type Year = { fiscalYear: number; startDate: string; endDate: string };
type JL = { account: string; date: string; amount: number }; // natural sign
type Cell = { version: string; account: string; month: string; amount: number }; // month 'YYYY-MM'

export const W: { years: Year[]; versions: Record<number, string>; jl: JL[]; cells: Cell[] } = { years: [], versions: {}, jl: [], cells: [] };

export const ACCOUNTS: Record<string, { code: string; name: string; type: 'revenue' | 'expense'; subtype: string | null }> = {
  'aaaaaaaa-0000-4000-8000-000000000001': { code: '4000', name: 'Sales', type: 'revenue', subtype: null },
  'aaaaaaaa-0000-4000-8000-000000000002': { code: '5000', name: 'Rent', type: 'expense', subtype: null },
  'aaaaaaaa-0000-4000-8000-000000000003': { code: '5100', name: 'Wages', type: 'expense', subtype: null },
  'aaaaaaaa-0000-4000-8000-000000000004': { code: '5500', name: 'Cost of sales', type: 'expense', subtype: 'cost_of_sales' },
};
export const [SALES, RENT, WAGES, COS] = Object.keys(ACCOUNTS) as [string, string, string, string];

export function resetLedger(): void {
  W.years = []; W.versions = {}; W.jl = []; W.cells = [];
}

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const meta = (id: string) => ({
  account_id: id, account_code: ACCOUNTS[id]!.code, account_name: ACCOUNTS[id]!.name, account_type: ACCOUNTS[id]!.type, account_subtype: ACCOUNTS[id]!.subtype,
});

export function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const q = strings.join('?');
  if (q.includes('FROM budget_month_amounts bm')) {
    const [ids, firsts, lasts] = values as [string[], string[], string[]];
    const out = new Map<string, number>();
    for (const c of W.cells) {
      const i = ids.indexOf(c.version);
      if (i < 0) continue;
      const d = `${c.month}-01`;
      if (d < firsts[i]! || d > lasts[i]!) continue;
      out.set(`${c.account}|${c.month}`, (out.get(`${c.account}|${c.month}`) ?? 0) + c.amount);
    }
    return Promise.resolve([...out].map(([k, v]) => {
      const [a, m] = k.split('|');
      return { ...meta(a!), month: m, cc1_id: null, cc2_id: null, bu_id: null, amount: v.toFixed(2) };
    }));
  }
  if (q.includes('FROM budget_versions') && q.includes('is_primary AND fiscal_year')) {
    const labels = values.find(Array.isArray) as number[];
    return Promise.resolve(labels.filter((l) => W.versions[l]).map((l) => ({ id: W.versions[l], fiscal_year: l })));
  }
  if (q.includes('FROM budget_versions')) {
    const ids = values.find(Array.isArray) as string[];
    return Promise.resolve(ids.map((id) => ({ id, name: 'Original', kind: 'original', status: 'draft', is_primary: true })));
  }
  if (q.includes('FROM gl_journal_lines jl')) {
    const [s, e] = values.filter(isDate);
    const out = new Map<string, { amount: number; last: string }>();
    for (const l of W.jl) {
      if (l.date < s! || l.date > e!) continue;
      const k = `${l.account}|${l.date.slice(0, 7)}`;
      const cur = out.get(k) ?? { amount: 0, last: '' };
      out.set(k, { amount: cur.amount + l.amount, last: l.date > cur.last ? l.date : cur.last });
    }
    return Promise.resolve([...out].map(([k, v]) => {
      const [a, m] = k.split('|');
      return { ...meta(a!), month: m, member_id: null, amount: v.amount.toFixed(2), last_posted: v.last };
    }));
  }
  if (q.includes('posted_through')) {
    const [s, e] = values.filter(isDate);
    const ds = W.jl.map((l) => l.date).filter((d) => d >= s! && d <= e!).sort();
    return Promise.resolve([{ posted_through: ds.length ? ds[ds.length - 1] : null }]);
  }
  if (q.includes('FROM gl_accounts')) {
    const ids = values.find(Array.isArray) as string[];
    return Promise.resolve(ids.slice().sort((x, y) => ACCOUNTS[x]!.code.localeCompare(ACCOUNTS[y]!.code)).map((id) => ({ id })));
  }
  throw new Error(`unexpected query: ${q.slice(0, 120)}`);
}

/** `fiscalYearForDate` over `W.years`. */
export async function fakeFiscalYearForDate(_c: string, date: string) {
  const y = W.years.find((r) => date >= r.startDate && date <= r.endDate);
  if (!y) throw new Error(`fiscalYearForDate: no fiscal year for company x on ${date}`);
  return { ...y, id: `fy${y.fiscalYear}`, status: 'open', kind: 'normal', stored: true, assumed: false };
}

/**
 * An in-memory ledger that answers the budget readers' SQL by query shape, so a unit test runs
 * the REAL facade (`getBudgetVariance`), `trackingRange`, `trackingCore`, P1's `primaryVersionScope`
 * and the line builder with no database. Adopted from the PR-C round-1 ledger-breaker's repro.
 *
 * Use: `vi.mock('@/lib/neon', () => ({ sql: fakeSql }))` and the registry mock below, then fill `W`.
 */
type Year = { fiscalYear: number; startDate: string; endDate: string };
type JL = { account: string; date: string; amount: number; cc1?: string; cc2?: string }; // natural sign
type Cell = { version: string; account: string; month: string; amount: number; cc1?: string; cc2?: string; bu?: string }; // month 'YYYY-MM'
/** A cost centre: `type` 'cc1' (an FNO) or 'cc2' (a project, whose `parent` is its FNO). */
type Centre = { code: string; type: 'cc1' | 'cc2'; parent: string | null };

export const W: { years: Year[]; versions: Record<number, string>; jl: JL[]; cells: Cell[]; centres: Record<string, Centre> } =
  { years: [], versions: {}, jl: [], cells: [], centres: {} };

export const ACCOUNTS: Record<string, { code: string; name: string; type: 'revenue' | 'expense'; subtype: string | null }> = {
  'aaaaaaaa-0000-4000-8000-000000000001': { code: '4000', name: 'Sales', type: 'revenue', subtype: null },
  'aaaaaaaa-0000-4000-8000-000000000002': { code: '5000', name: 'Rent', type: 'expense', subtype: null },
  'aaaaaaaa-0000-4000-8000-000000000003': { code: '5100', name: 'Wages', type: 'expense', subtype: null },
  'aaaaaaaa-0000-4000-8000-000000000004': { code: '5500', name: 'Cost of sales', type: 'expense', subtype: 'cost_of_sales' },
};
export const [SALES, RENT, WAGES, COS] = Object.keys(ACCOUNTS) as [string, string, string, string];

export function resetLedger(): void {
  W.years = []; W.versions = {}; W.jl = []; W.cells = []; W.centres = {}; registry.lookups = 0;
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
      const k = [c.account, c.month, c.cc1 ?? '', c.cc2 ?? '', c.bu ?? ''].join('|');
      out.set(k, (out.get(k) ?? 0) + c.amount);
    }
    return Promise.resolve([...out].map(([k, v]) => {
      const [a, m, cc1, cc2, bu] = k.split('|');
      return { ...meta(a!), month: m, cc1_id: cc1 || null, cc2_id: cc2 || null, bu_id: bu || null, amount: v.toFixed(2) };
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
    // An either-level cost-centre filter is the last bound value (null when none).
    const cc = values[values.length - 1] as string | null;
    const out = new Map<string, { amount: number; last: string }>();
    for (const l of W.jl) {
      if (l.date < s! || l.date > e!) continue;
      if (typeof cc === 'string' && l.cc1 !== cc && l.cc2 !== cc) continue;
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
  if (q.includes('WITH RECURSIVE chain')) {
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (let id of values.find(Array.isArray) as string[]) {
      while (id && W.centres[id] && !seen.has(id)) {
        seen.add(id);
        const c = W.centres[id]!;
        out.push({ id, code: c.code, parent_id: c.parent, cc_type: c.type });
        id = c.parent!;
      }
    }
    return Promise.resolve(out);
  }
  if (q.includes('FROM cost_centres')) {
    const id = values.find((v) => typeof v === 'string' && W.centres[v]) as string | undefined;
    return Promise.resolve(id ? [{ id, code: W.centres[id]!.code, name: W.centres[id]!.code, cc_type: W.centres[id]!.type }] : []);
  }
  if (q.includes('FROM gl_accounts')) {
    const ids = values.find(Array.isArray) as string[];
    return Promise.resolve(ids.slice().sort((x, y) => ACCOUNTS[x]!.code.localeCompare(ACCOUNTS[y]!.code)).map((id) => ({ id })));
  }
  throw new Error(`unexpected query: ${q.slice(0, 120)}`);
}

/** How many registry lookups (`fiscalYearForDate`) a read made: each is a savepointed query. */
export const registry = { lookups: 0 };

/** `fiscalYearForDate` over `W.years`. */
export async function fakeFiscalYearForDate(_c: string, date: string) {
  registry.lookups += 1;
  const y = W.years.find((r) => date >= r.startDate && date <= r.endDate);
  if (!y) throw new Error(`fiscalYearForDate: no fiscal year for company x on ${date}`);
  return { ...y, id: `fy${y.fiscalYear}`, status: 'open', kind: 'normal', stored: true, assumed: false };
}

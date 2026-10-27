/**
 * The series a wizard seed uplifts (Budgets P2 spec 8): one series per account and dimension
 * combination, each a list of months (positions in the budget year) with integer-cent amounts.
 * Reads only; seedVersion.ts runs `uplift` over them and writes.
 *
 * PY actuals (leaf accounts only, decision 18): dense series, every month of the year, so a month
 * with no activity is an explicit 0. At a dimension grain a PY row with NO member ("unassigned")
 * would mix grains for its account (decision 4); a row on a member the budget cannot take (an
 * inactive one, or a cost centre whose cc_type is not the grain's, NULL included) counts as
 * unassigned too, never written to that member. Per account: `unassigned: 'company'` (the
 * default; PY totals are kept) makes an account that has any unassigned activity company grain
 * ENTIRELY (all its rows summed); `'drop'` keeps only its tagged series and discards the rest.
 * Accounts with no activity at all (default off, `includeNoActivity`) become zero company rows.
 *
 * Copy version: the source's own rows (every revenue/expense account it holds, headers and
 * inactive ones included, as P1's copy does), mapped by month position (the same year maps
 * month for month; another year by position, months past the target's length dropped). A series
 * keeps only the months the source budgets, so the uplift's residue lands on the series' last
 * budgeted month, never on a month the source left blank.
 */
import { sql, type DbRow } from '@/lib/neon';
import { isHeaderSql } from './headerSql';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { requireFiscalYear } from '../gl/fiscalYearRegistry';
import { toBudgetYearInfo } from '../core/budgetYears';
import { BudgetVersionError } from './budgetVersionTypes';
import { toCents } from './grid/cents';
import { loadPriorActuals, type PriorGrain } from './priorActuals';

export interface SeedSeries {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  /** Indexes into the target year's months, ascending. */
  positions: number[];
  /** Integer cents, one per position. */
  cents: number[];
}

export interface SeedAccount { id: string; label: string; isActive: boolean; isHeader: boolean }

export type UnassignedRule = 'company' | 'drop';

/** Every revenue/expense account of the company with the facts the seed's leaf rule needs. */
export async function loadSeedAccounts(companyId: string): Promise<Map<string, SeedAccount>> {
  const rows = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.is_active, ${isHeaderSql()} AS is_header
      FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.account_type IN ('revenue', 'expense')
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), {
    id: String(r.id), label: `${String(r.account_code)} ${String(r.account_name)}`.trim(),
    isActive: r.is_active !== false, isHeader: Boolean(r.is_header),
  }]));
}

const sumArrays = (arrays: Iterable<number[]>, n: number): number[] => {
  const total = Array<number>(n).fill(0);
  for (const a of arrays) for (let i = 0; i < n; i++) total[i] = (total[i] ?? 0) + (a[i] ?? 0);
  return total;
};
const seriesKey = (s: Pick<SeedSeries, 'glAccountId' | 'cc1Id' | 'cc2Id' | 'buId'>): string =>
  `${s.glAccountId}|${s.cc1Id ?? ''}|${s.cc2Id ?? ''}|${s.buId ?? ''}`;
const active = (cents: readonly number[]): boolean => cents.some((c) => c !== 0);
const dense = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function dimColumns(grain: PriorGrain, dimensionId: string | null): Pick<SeedSeries, 'cc1Id' | 'cc2Id' | 'buId'> {
  return { cc1Id: grain === 'cc1' ? dimensionId : null, cc2Id: grain === 'cc2' ? dimensionId : null, buId: grain === 'bu' ? dimensionId : null };
}

export interface PySeriesOptions { grain: PriorGrain; unassigned: UnassignedRule; includeNoActivity: boolean }

/** The members a dimension grain may budget: active, and for CC1/CC2 a cost centre of exactly that cc_type. */
async function seedMembers(companyId: string, grain: Exclude<PriorGrain, 'company'>): Promise<Set<string>> {
  const rows = (grain === 'bu'
    ? await sql`SELECT id FROM business_units WHERE company_id = ${companyId}::UUID AND COALESCE(is_active, true)`
    : await sql`SELECT id FROM cost_centres WHERE company_id = ${companyId}::UUID AND cc_type = ${grain} AND is_active`) as DbRow[];
  return new Set(rows.map((r) => String(r.id)));
}

/** PY-actuals series for the registry year `fiscalYear`, and how many accounts with activity were left out (headers, inactive). */
export async function pySeries(
  companyId: string, fiscalYear: number, accounts: ReadonlyMap<string, SeedAccount>, opts: PySeriesOptions,
): Promise<{ series: SeedSeries[]; skipped: number }> {
  const prior = await loadPriorActuals(companyId, fiscalYear, opts.grain);
  const members = opts.grain === 'company' ? null : await seedMembers(companyId, opts.grain);
  const n = prior.months.length;
  const monthIndex = new Map(prior.months.map((m, i) => [m, i]));
  const byAccount = new Map<string, Map<string | null, number[]>>();
  for (const c of prior.cells) {
    const i = monthIndex.get(c.month);
    if (i === undefined) continue;
    const dim = c.dimensionId !== null && members?.has(c.dimensionId) ? c.dimensionId : null;
    const dims = byAccount.get(c.glAccountId) ?? new Map<string | null, number[]>();
    const cents = dims.get(dim) ?? Array<number>(n).fill(0);
    cents[i] = (cents[i] ?? 0) + toCents(c.amount);
    dims.set(dim, cents);
    byAccount.set(c.glAccountId, dims);
  }

  const series: SeedSeries[] = [];
  const touched = new Set<string>();
  let skipped = 0;
  for (const [glAccountId, dims] of byAccount) {
    const live = [...dims].filter(([, cents]) => active(cents));
    if (live.length === 0) continue;
    touched.add(glAccountId);
    const account = accounts.get(glAccountId);
    if (!account || !account.isActive || account.isHeader) {
      skipped += 1;
      continue;
    }
    const unassigned = live.some(([dim]) => dim === null);
    if (opts.grain === 'company' || (unassigned && opts.unassigned === 'company')) {
      series.push({ glAccountId, ...dimColumns('company', null), positions: dense(n), cents: sumArrays(dims.values(), n) });
    } else {
      for (const [dim, cents] of live) if (dim !== null) series.push({ glAccountId, ...dimColumns(opts.grain, dim), positions: dense(n), cents });
    }
  }
  if (opts.includeNoActivity) {
    for (const a of accounts.values()) {
      if (a.isActive && !a.isHeader && !touched.has(a.id)) {
        series.push({ glAccountId: a.id, ...dimColumns('company', null), positions: dense(n), cents: Array<number>(n).fill(0) });
      }
    }
  }
  series.sort((a, b) => (seriesKey(a) < seriesKey(b) ? -1 : 1));
  return { series, skipped };
}

/**
 * Every version row lock a seed takes, FOR UPDATE, in ONE statement ordered by (fiscal_year, id),
 * before anything of the source is read: the source's row, and with `year` every version of that
 * year (what P1's copyVersion and setPrimary lock later, so they wait for nothing more). Two seeds
 * then queue on the first row they share: a shared lock upgraded later deadlocked two make-primary
 * copies of one source. Bounded wait (503). Returns the source's year label; a source that is not
 * the company's, or was deleted before the lock, is BUDGET_VERSION_NOT_FOUND.
 */
export async function lockSeedVersions(companyId: string, sourceId: string | null, year: number | null): Promise<number | null> {
  if (sourceId === null && year === null) return null;
  const rows = (await withRowLockBudget(
    () => sql`
      SELECT id, fiscal_year FROM budget_versions
       WHERE company_id = ${companyId}::UUID AND (id = ${sourceId}::UUID OR fiscal_year = ${year}::INT)
       ORDER BY fiscal_year, id FOR UPDATE
    `,
    () => new RowLockTimeoutError('The budget versions this seed uses'),
  )) as DbRow[];
  if (sourceId === null) return null;
  const source = rows.find((r) => String(r.id) === sourceId.toLowerCase());
  if (!source) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  return Number(source.fiscal_year);
}

/** The source version's series, its months mapped by position onto a target year of `targetMonths` months. */
export async function versionSeries(
  companyId: string, versionId: string, sourceFiscalYear: number, targetMonths: number,
): Promise<SeedSeries[]> {
  const sourceMonths = toBudgetYearInfo(await requireFiscalYear(companyId, sourceFiscalYear)).monthKeys;
  const positionOf = new Map(sourceMonths.map((m, i) => [m, i]));
  const rows = (await sql`
    SELECT bm.gl_account_id, bm.cc1_id, bm.cc2_id, bm.bu_id, to_char(bm.month, 'YYYY-MM') AS month_key, bm.amount::text AS amount
      FROM budget_month_amounts bm
      JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
     WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
       AND ga.account_type IN ('revenue', 'expense')
  `) as DbRow[];
  const grouped = new Map<string, { head: Omit<SeedSeries, 'positions' | 'cents'>; byPosition: Map<number, number> }>();
  for (const r of rows) {
    const position = positionOf.get(String(r.month_key));
    if (position === undefined || position >= targetMonths) continue;
    const head = {
      glAccountId: String(r.gl_account_id),
      cc1Id: r.cc1_id ? String(r.cc1_id) : null, cc2Id: r.cc2_id ? String(r.cc2_id) : null, buId: r.bu_id ? String(r.bu_id) : null,
    };
    const key = seriesKey(head);
    const entry = grouped.get(key) ?? { head, byPosition: new Map<number, number>() };
    entry.byPosition.set(position, (entry.byPosition.get(position) ?? 0) + toCents(Number(r.amount)));
    grouped.set(key, entry);
  }
  return [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, { head, byPosition }]) => {
    const positions = [...byPosition.keys()].sort((a, b) => a - b);
    return { ...head, positions, cents: positions.map((p) => byPosition.get(p) ?? 0) };
  });
}

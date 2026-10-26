/**
 * The budget grid's batch save (Budgets P2, spec §7.2): the only batch writer of a version's
 * amounts. Inside the request transaction it holds the year registry (shared), then takes the
 * version row with a compare-and-set on `updated_at` (the client's token): P1's pre-lock plus
 * the CAS, so two saves of one version serialise and the second, holding a token the first moved,
 * is 409 STALE. Deletes run before upserts, so a grain change in one batch passes decision 4.
 *
 * Everything after the registry lock runs in one savepoint: a refusal raised after the token
 * moved or after a delete (a grain clash, a lock trigger BV001) rolls all of it back, so the 4xx
 * the route answers (which withAuth COMMITs) carries no write and no token bump.
 *
 * Decision 18: a cell is refused on a header (an account another account, active or not, names
 * as its parent) or an inactive account unless that account already holds amounts in the version.
 */
import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { isHeaderSql } from '../core/budgetAccount';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { getFiscalYear } from '../gl/fiscalYearRegistry';
import { budgetMonthKeysInWindow, monthKeyToDate } from '../reports/budgetPeriodWindow';
import { auditBudgetWrite, holdYearRegistry } from './budgetVersionScope';
import { BudgetVersionError, mapBudgetDbError, type BudgetVersionStatus } from './budgetVersionTypes';
import { toCents } from './grid/cents';
import { inputError, tokenSql } from './gridErrors';
import { accountWithTwoGrains, assertMonthsInYear, validateBatch, type SaveCell, type ValidatedBatch } from './gridSaveValidate';

export { MAX_SAVE_CELLS, type SaveCell } from './gridSaveValidate';

export interface SaveCellsInput {
  versionId: string;
  /** The version's updatedAt as the client read it (text, microseconds). */
  expectedUpdatedAt: string;
  cells: SaveCell[];
}

export interface SaveCellsResult {
  /** The version's new token. */
  updatedAt: string;
  saved: number;
  deleted: number;
}

/** 409 BUDGET_VERSION_STALE, with what the version is now (for the stale-version dialog). */
export class BudgetVersionStaleError extends BudgetVersionError {
  constructor(readonly currentUpdatedAt: string, readonly versionStatus: BudgetVersionStatus) {
    super('BUDGET_VERSION_STALE', 'This budget changed since you opened it; reload and re-apply your changes');
  }
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

export async function saveCells(companyId: string, userId: string, input: SaveCellsInput): Promise<SaveCellsResult> {
  const batch = validateBatch(input.cells);
  await holdYearRegistry(companyId);
  try {
    return await withSavepoint('budget_grid_save', () => write(companyId, userId, input, batch));
  } catch (err) {
    return mapBudgetDbError(err);
  }
}

async function write(companyId: string, userId: string, input: SaveCellsInput, batch: ValidatedBatch): Promise<SaveCellsResult> {
  const { versionId } = input;
  const version = await takeVersion(companyId, versionId, input.expectedUpdatedAt);
  const year = await getFiscalYear(companyId, version.fiscalYear);
  if (!year) throw new BudgetVersionError('BUDGET_VERSION_STATE', `No financial year is labelled ${version.fiscalYear}`);
  assertMonthsInYear(input.cells, budgetMonthKeysInWindow(year.startDate, year.endDate), version.fiscalYear);

  const labels = await checkAccounts(companyId, versionId, input.cells, batch);
  await checkDimensions(companyId, input.cells);
  const twoGrains = accountWithTwoGrains(batch.upserts);
  if (twoGrains) throw grainClash(labels.get(twoGrains)!);

  const sumBefore = await versionSum(companyId, versionId);
  const deleted = await deleteCells(companyId, versionId, batch.deletes);
  await assertOneGrain(companyId, versionId, batch.upserts, labels);
  await upsertCells(companyId, versionId, userId, batch.upserts);
  const sumAfter = await versionSum(companyId, versionId);

  await auditBudgetWrite(companyId, userId, 'update', versionId, version.fiscalYear, {
    upserts: String(batch.upserts.length), deletes: String(deleted), sumBefore, sumAfter, versionStatus: version.status,
  });
  return { updatedAt: version.updatedAt, saved: batch.upserts.length, deleted };
}

/**
 * The compare-and-set: bumps the version's updated_at only when it is the company's, still holds
 * the client's token and is not locked, taking the row lock (bounded wait). Otherwise says why.
 */
async function takeVersion(companyId: string, versionId: string, expected: string) {
  const rows = (await withRowLockBudget(
    () => sql`
      UPDATE budget_versions SET updated_at = clock_timestamp()
       WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
         AND updated_at = ${expected}::TIMESTAMPTZ AND status <> 'locked'
      RETURNING fiscal_year, status, ${tokenSql()} AS token
    `,
    () => new RowLockTimeoutError('This budget version'),
  )) as DbRow[];
  if (rows[0]) {
    return { fiscalYear: Number(rows[0].fiscal_year), status: String(rows[0].status) as BudgetVersionStatus, updatedAt: String(rows[0].token) };
  }
  const now = (await sql`
    SELECT status, ${tokenSql()} AS token
      FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!now[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  if (now[0].status === 'locked') throw new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked');
  throw new BudgetVersionStaleError(String(now[0].token), String(now[0].status) as BudgetVersionStatus);
}

/**
 * Every account must be a revenue or expense account of the company; an upserted one must also be
 * a leaf and active, unless it already holds amounts in this version (decision 18). Returns each
 * account's "code name" label for messages.
 */
async function checkAccounts(companyId: string, versionId: string, cells: SaveCell[], batch: ValidatedBatch): Promise<Map<string, string>> {
  const ids = unique(cells.map((c) => c.glAccountId));
  const rows = (await sql`
    SELECT t.id::text AS id, ga.account_code, ga.account_name, ga.account_type, ga.is_active, ${isHeaderSql()} AS is_header,
           EXISTS (SELECT 1 FROM budget_month_amounts bm
                    WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID AND bm.gl_account_id = ga.id) AS holds
      FROM unnest(${ids}::UUID[]) AS t(id)
      LEFT JOIN gl_accounts ga ON ga.id = t.id AND ga.company_id = ${companyId}::UUID
  `) as DbRow[];
  const labels = new Map<string, string>();
  const upserted = new Set(batch.upserts.map((u) => u.glAccountId));
  for (const r of rows) {
    const id = String(r.id);
    if (r.account_code === null || r.account_code === undefined) throw inputError(`Account ${id} is not an account of this company`);
    const label = `${String(r.account_code)} ${String(r.account_name ?? '')}`.trim();
    labels.set(id, label);
    if (r.account_type !== 'revenue' && r.account_type !== 'expense') {
      throw inputError(`Account ${label} is not a revenue or expense account; budgets are set on revenue and expense accounts only`);
    }
    if (!upserted.has(id) || r.holds) continue;
    if (r.is_header) throw inputError(`Account ${label} is a header account: budget its sub-accounts instead`);
    if (!r.is_active) throw inputError(`Account ${label} is inactive: a new budget cannot be set on it`);
  }
  return labels;
}

/** CC1 and CC2 ids must be cost centres of the company of that kind; BU ids its business units. */
async function checkDimensions(companyId: string, cells: SaveCell[]): Promise<void> {
  const centres = unique(cells.flatMap((c) => [c.cc1Id ? `cc1:${c.cc1Id}` : null, c.cc2Id ? `cc2:${c.cc2Id}` : null])
    .filter((x): x is string => x !== null));
  if (centres.length > 0) {
    const bad = (await sql`
      SELECT t.kind, t.id::text AS id
        FROM unnest(${centres.map((x) => x.slice(4))}::UUID[], ${centres.map((x) => x.slice(0, 3))}::TEXT[]) AS t(id, kind)
        LEFT JOIN cost_centres cc ON cc.id = t.id AND cc.company_id = ${companyId}::UUID
       WHERE cc.cc_type IS DISTINCT FROM t.kind
       LIMIT 1
    `) as DbRow[];
    if (bad[0]) throw inputError(`${String(bad[0].kind).toUpperCase()} ${String(bad[0].id)} is not a ${String(bad[0].kind).toUpperCase()} cost centre of this company`);
  }
  const units = unique(cells.map((c) => c.buId).filter((x): x is string => x !== null));
  if (units.length > 0) {
    const bad = (await sql`
      SELECT t.id::text AS id FROM unnest(${units}::UUID[]) AS t(id)
       WHERE NOT EXISTS (SELECT 1 FROM business_units b WHERE b.id = t.id AND b.company_id = ${companyId}::UUID)
       LIMIT 1
    `) as DbRow[];
    if (bad[0]) throw inputError(`Business unit ${String(bad[0].id)} is not a business unit of this company`);
  }
}

const grainClash = (label: string) => new BudgetVersionError('BUDGET_GRAIN_CONFLICT',
  `Account ${label} is budgeted at one level per version (company level or one dimension): clear its other cells in the same save to change its level`);

async function versionSum(companyId: string, versionId: string): Promise<string> {
  const rows = (await sql`
    SELECT COALESCE(SUM(amount), 0.00)::text AS s FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
  `) as DbRow[];
  return String(rows[0]?.s ?? '0.00');
}

async function deleteCells(companyId: string, versionId: string, cells: SaveCell[]): Promise<number> {
  if (cells.length === 0) return 0;
  const rows = (await sql`
    WITH gone AS (
      DELETE FROM budget_month_amounts bm
       USING unnest(${cells.map((c) => c.glAccountId)}::UUID[], ${cells.map((c) => c.cc1Id)}::UUID[],
                    ${cells.map((c) => c.cc2Id)}::UUID[], ${cells.map((c) => c.buId)}::UUID[],
                    ${cells.map((c) => monthKeyToDate(c.month))}::DATE[]) AS t(a, c1, c2, b, m)
       WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
         AND bm.gl_account_id = t.a AND bm.month = t.m
         AND bm.cc1_id IS NOT DISTINCT FROM t.c1 AND bm.cc2_id IS NOT DISTINCT FROM t.c2 AND bm.bu_id IS NOT DISTINCT FROM t.b
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM gone
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}

/**
 * After the deletes: an upserted account that still has cells at another grain in the version is
 * a typed 400 naming it (the exclusion constraint stays as the backstop, mapped the same way).
 */
async function assertOneGrain(
  companyId: string, versionId: string, upserts: ValidatedBatch['upserts'], labels: Map<string, string>,
): Promise<void> {
  if (upserts.length === 0) return;
  const grainOf = new Map(upserts.map((u) => [u.glAccountId, u.grain]));
  const clash = (await sql`
    SELECT bm.gl_account_id::text AS id FROM budget_month_amounts bm
      JOIN unnest(${[...grainOf.keys()]}::UUID[], ${[...grainOf.values()]}::SMALLINT[]) AS t(a, g) ON bm.gl_account_id = t.a
     WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID AND bm.dim_grain <> t.g
     LIMIT 1
  `) as DbRow[];
  if (clash[0]) throw grainClash(labels.get(String(clash[0].id)) ?? String(clash[0].id));
}

async function upsertCells(companyId: string, versionId: string, userId: string, cells: ValidatedBatch['upserts']): Promise<void> {
  if (cells.length === 0) return;
  // Whole cents travel as integers and are divided in NUMERIC, so no float reaches the column.
  await sql`
    INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, amount, created_by)
    SELECT ${companyId}::UUID, ${versionId}::UUID, t.a, t.c1, t.c2, t.b, t.m, t.cents::NUMERIC / 100, ${userId}
      FROM unnest(${cells.map((c) => c.glAccountId)}::UUID[], ${cells.map((c) => c.cc1Id)}::UUID[],
                  ${cells.map((c) => c.cc2Id)}::UUID[], ${cells.map((c) => c.buId)}::UUID[],
                  ${cells.map((c) => monthKeyToDate(c.month))}::DATE[], ${cells.map((c) => toCents(c.amount))}::BIGINT[])
           AS t(a, c1, c2, b, m, cents)
    ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell
    DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()
  `;
}

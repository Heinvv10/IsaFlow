/**
 * What a driver may name, checked before it is written (P4 spec §5); every refusal is a 400.
 *
 * - The driven account is the company's, revenue or expense, and a leaf and active unless it
 *   already holds amounts in the version (P2 decision 18, `isHeaderSql`, as `saveCells`).
 * - A pct_of_line reference is a revenue or expense account of the company (any leaf rule: a row
 *   it reads may be a legacy header's own amounts or hold none yet, which reads 0 with a warning).
 * - CC1 / CC2 ids are cost centres of the company of that kind, BU ids its business units; the
 *   headcount scope is a cost centre of the company.
 * - Decision 4 among drivers: another driver of the same account in the version at another grain
 *   is BUDGET_GRAIN_CONFLICT (the amounts' grain is the 949 trigger's, mapped the same way).
 */
import { sql, type DbRow } from '@/lib/neon';
import { BudgetVersionError } from '../budgetVersionTypes';
import { inputError } from '../gridErrors';
import { isHeaderSql } from '../headerSql';
import { grainOf } from '../grid/cellKey';
import type { DriverGrain, DriverLine, StoredDriverLine } from './driverLine';

async function checkAccounts(companyId: string, versionId: string, line: DriverLine): Promise<Map<string, string>> {
  const ids = [...new Set([line.glAccountId, ...(line.ref ? [line.ref.glAccountId] : [])])];
  const rows = (await sql`
    SELECT t.id::text AS id, ga.account_code, ga.account_name, ga.account_type, ga.is_active, ${isHeaderSql()} AS is_header,
           EXISTS (SELECT 1 FROM budget_month_amounts bm
                    WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID AND bm.gl_account_id = ga.id) AS holds
      FROM unnest(${ids}::UUID[]) AS t(id)
      LEFT JOIN gl_accounts ga ON ga.id = t.id AND ga.company_id = ${companyId}::UUID
  `) as DbRow[];
  const labels = new Map<string, string>();
  for (const r of rows) {
    const id = String(r.id);
    if (r.account_code === null || r.account_code === undefined) throw inputError(`Account ${id} is not an account of this company`);
    const label = `${String(r.account_code)} ${String(r.account_name ?? '')}`.trim();
    labels.set(id, label);
    if (r.account_type !== 'revenue' && r.account_type !== 'expense') {
      throw inputError(`Account ${label} is not a revenue or expense account; drivers are set on revenue and expense accounts only`);
    }
    if (id !== line.glAccountId || r.holds) continue;
    if (r.is_header) throw inputError(`Account ${label} is a header account: put the driver on its sub-accounts instead`);
    if (!r.is_active) throw inputError(`Account ${label} is inactive: a new driver cannot be set on it`);
  }
  return labels;
}

async function checkDimensions(companyId: string, line: DriverLine): Promise<void> {
  const grains: DriverGrain[] = [line, ...(line.ref ? [line.ref] : [])];
  const centres: Array<{ id: string; kind: string }> = [];
  for (const g of grains) {
    if (grainOf(g) === 'multi') throw inputError('A driver row carries at most one dimension');
    if (g.cc1Id) centres.push({ id: g.cc1Id, kind: 'cc1' });
    if (g.cc2Id) centres.push({ id: g.cc2Id, kind: 'cc2' });
  }
  if (line.headcountCostCentreId) centres.push({ id: line.headcountCostCentreId, kind: 'any' });
  if (centres.length > 0) {
    const bad = (await sql`
      SELECT t.kind, t.id::text AS id
        FROM unnest(${centres.map((c) => c.id)}::UUID[], ${centres.map((c) => c.kind)}::TEXT[]) AS t(id, kind)
        LEFT JOIN cost_centres cc ON cc.id = t.id AND cc.company_id = ${companyId}::UUID
       WHERE cc.id IS NULL OR (t.kind <> 'any' AND cc.cc_type IS DISTINCT FROM t.kind)
       LIMIT 1
    `) as DbRow[];
    if (bad[0]) {
      const kind = String(bad[0].kind);
      throw inputError(kind === 'any'
        ? `Cost centre ${String(bad[0].id)} is not a cost centre of this company`
        : `${kind.toUpperCase()} ${String(bad[0].id)} is not a ${kind.toUpperCase()} cost centre of this company`);
    }
  }
  const units = grains.map((g) => g.buId).filter((x): x is string => x !== null);
  if (units.length > 0) {
    const bad = (await sql`
      SELECT t.id::text AS id FROM unnest(${units}::UUID[]) AS t(id)
       WHERE NOT EXISTS (SELECT 1 FROM business_units b WHERE b.id = t.id AND b.company_id = ${companyId}::UUID)
       LIMIT 1
    `) as DbRow[];
    if (bad[0]) throw inputError(`Business unit ${String(bad[0].id)} is not a business unit of this company`);
  }
}

/** Refuses the line (400) or returns account labels for messages. `others` = the version's other drivers. */
export async function checkDriverLine(
  companyId: string, versionId: string, line: DriverLine, others: readonly StoredDriverLine[],
): Promise<Map<string, string>> {
  const labels = await checkAccounts(companyId, versionId, line);
  await checkDimensions(companyId, line);
  const clash = others.find((d) => d.glAccountId === line.glAccountId && grainOf(d) !== grainOf(line));
  if (clash) {
    throw new BudgetVersionError('BUDGET_GRAIN_CONFLICT',
      `Account ${labels.get(line.glAccountId) ?? line.glAccountId} already has a driver at another level in this version (company level or one dimension)`);
  }
  return labels;
}

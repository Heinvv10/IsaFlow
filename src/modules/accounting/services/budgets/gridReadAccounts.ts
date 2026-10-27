/**
 * Which accounts the budget grid lists, and how headers roll up (P2 spec 4.2, 6.5; decision 18).
 *
 * Listed: an active postable revenue/expense account, plus any account holding amounts in the
 * version (inactive ones flagged). A HEADER is any account another account (active or not) names
 * as `parent_account_id` (the `leafAccountOptions` rule in `src/lib/chartAccountOptions.ts`): it is
 * listed when it holds amounts of its own or has a listed account below it, and it is a read-only
 * roll-up row, never an editable line. Amounts are held in integer cents here.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isHeaderSql } from './headerSql';
import { fromCents } from './grid/cents';
import { bandOf } from './grid/subtotals';
import type { AccountGrain } from './grid/pivot';
import type { GridAccount, GridDimensions, GridMember } from './gridReadTypes';

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: 'revenue' | 'expense';
  subtype: string | null;
  isActive: boolean;
  parentId: string | null;
  isHeader: boolean;
}

const byCode = (a: AccountRow, b: AccountRow): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : 1);

async function readAccountRows(companyId: string): Promise<AccountRow[]> {
  const rows = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype, ga.is_active, ga.parent_account_id,
           ${isHeaderSql()} AS is_header
      FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.account_type IN ('revenue', 'expense')
     ORDER BY ga.account_code, ga.id
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id), code: String(r.account_code), name: String(r.account_name),
    type: String(r.account_type) as 'revenue' | 'expense',
    subtype: r.account_subtype === null || r.account_subtype === undefined ? null : String(r.account_subtype),
    isActive: r.is_active !== false,
    parentId: r.parent_account_id ? String(r.parent_account_id) : null,
    isHeader: Boolean(r.is_header),
  }));
}

/** The ids to list: lines that are active or hold amounts, headers that hold amounts or sit above a listed account. */
function listedIds(rows: readonly AccountRow[], holds: ReadonlySet<string>): Set<string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const listed = new Set<string>();
  for (const r of rows) {
    if (holds.has(r.id) || (!r.isHeader && r.isActive)) listed.add(r.id);
  }
  for (const id of [...listed]) {
    const seen = new Set<string>([id]);
    for (let p = byId.get(id)?.parentId; p && byId.has(p) && !seen.has(p); p = byId.get(p)?.parentId) {
      seen.add(p);
      listed.add(p);
    }
  }
  return listed;
}

/**
 * The grid's accounts in tree order (a header, then what is below it, each level by code).
 * `own` is each account's own amounts per year month in cents, summed over its dimension rows.
 */
export async function loadGridAccounts(
  companyId: string, own: ReadonlyMap<string, readonly number[]>, grains: ReadonlyMap<string, AccountGrain>, monthCount: number,
): Promise<GridAccount[]> {
  const rows = await readAccountRows(companyId);
  const listed = listedIds(rows, new Set(own.keys()));
  const shown = rows.filter((r) => listed.has(r.id));
  const shownIds = new Set(shown.map((r) => r.id));
  const parentOf = (r: AccountRow): string | null => (r.parentId && shownIds.has(r.parentId) && r.parentId !== r.id ? r.parentId : null);
  const children = new Map<string | null, AccountRow[]>();
  for (const r of shown) children.set(parentOf(r), [...(children.get(parentOf(r)) ?? []), r]);
  for (const list of children.values()) list.sort(byCode);

  // Σ of everything listed below an account, per month in cents (its own amounts excluded).
  const below = new Map<string, number[]>();
  const sumBelow = (id: string, guard: ReadonlySet<string>): number[] => {
    const memo = below.get(id);
    if (memo) return memo;
    const total = Array<number>(monthCount).fill(0);
    for (const child of children.get(id) ?? []) {
      if (guard.has(child.id)) continue;
      const nested = sumBelow(child.id, new Set([...guard, child.id]));
      const mine = own.get(child.id);
      for (let m = 0; m < monthCount; m++) total[m] = (total[m] ?? 0) + (nested[m] ?? 0) + (mine?.[m] ?? 0);
    }
    below.set(id, total);
    return total;
  };

  const out: GridAccount[] = [];
  const placed = new Set<string>();
  const place = (r: AccountRow, depth: number, seen: ReadonlySet<string>): void => {
    placed.add(r.id);
    const kids = (children.get(r.id) ?? []).filter((k) => !seen.has(k.id));
    const holdsAmounts = own.has(r.id);
    out.push({
      id: r.id, code: r.code, name: r.name, type: r.type, subtype: r.subtype, band: bandOf(r.type, r.subtype), isActive: r.isActive,
      parentId: parentOf(r), depth, isHeader: r.isHeader, childIds: kids.map((k) => k.id),
      ownAmounts: r.isHeader && holdsAmounts, grain: grains.get(r.id) ?? null,
      rollup: r.isHeader ? sumBelow(r.id, new Set([...seen, r.id])).map(fromCents) : null,
    });
    for (const k of kids) place(k, depth + 1, new Set([...seen, k.id]));
  };
  for (const r of children.get(null) ?? []) place(r, 0, new Set([r.id]));
  // Accounts whose parents name each other form no tree from the top: list them rather than lose their amounts.
  for (const r of shown) if (!placed.has(r.id)) place(r, 0, new Set([r.id]));
  return out;
}

async function members(companyId: string, kind: 'cc1' | 'cc2' | 'bu', used: readonly string[]): Promise<GridMember[]> {
  const rows = (kind === 'bu'
    ? await sql`
        SELECT id, code, name, COALESCE(is_active, true) AS is_active FROM business_units
         WHERE company_id = ${companyId}::UUID AND (COALESCE(is_active, true) OR id IN (SELECT unnest(${used}::UUID[])))
         ORDER BY code, id`
    : await sql`
        SELECT id, code, name, is_active FROM cost_centres
         WHERE company_id = ${companyId}::UUID AND cc_type = ${kind}
           AND (is_active OR id IN (SELECT unnest(${used}::UUID[])))
         ORDER BY code, id`) as DbRow[];
  return rows.map((r) => ({ id: String(r.id), code: String(r.code), name: String(r.name), isActive: r.is_active !== false }));
}

/**
 * The members to pick from: every active one, plus an inactive one the version still budgets. A
 * cost centre with no cc_type is neither CC1 nor CC2 (the save and the amounts trigger refuse it).
 */
export async function loadGridDimensions(
  companyId: string, used: { cc1: readonly string[]; cc2: readonly string[]; bu: readonly string[] },
): Promise<GridDimensions> {
  return {
    cc1: await members(companyId, 'cc1', used.cc1),
    cc2: await members(companyId, 'cc2', used.cc2),
    bu: await members(companyId, 'bu', used.bu),
  };
}

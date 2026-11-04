/**
 * The budget grid as a budget holder sees it (budgets P5-6, spec §3f). A WORK-SCOPE VIEW, NOT ACCESS
 * CONTROL: managers can read every budget elsewhere (reports, other versions, the driver list), so this
 * only focuses a holder on their slices; write integrity is migration 955's. Only the cells of their own
 * slices; every other slice's cells are left out, so the band totals and the company roll-ups the
 * grid computes cover their slices only. When every one of their holder rows names its accounts,
 * only those accounts (and the headers above them) are listed. Owners, admins and members who hold
 * no slice of the version see the version whole (`holderFilter` answers null). The same scope
 * holds for the grid's side doors (r2): the Excel template and the import preview read the filtered
 * model, and prior-year actuals keep only the holder's slice members (`priorForHolder`).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { GridAccount, GridCell } from './gridReadTypes';
import { loadHolderScope, isHolder } from './holderScope';
import { sliceOf, type HolderSlice, type HolderView } from './holderSlices';
import type { PriorActuals } from './priorActuals';

export interface HolderFilter {
  view: HolderView;
  /** The cells the holder may see. */
  cells: (cells: GridCell[]) => GridCell[];
  /** The listed accounts the holder may see (headers above a kept account stay). */
  accounts: (accounts: GridAccount[]) => GridAccount[];
  /** The slice members, so a slice with no amounts yet can still be picked in the grid's views. */
  members: { cc1: string[]; cc2: string[]; bu: string[] };
}

export async function holderFilter(companyId: string, versionId: string, userId: string | undefined): Promise<HolderFilter | null> {
  if (!userId) return null;
  const scope = await loadHolderScope(companyId, versionId, userId);
  if (!isHolder(scope)) return null;
  const slices = scope.slices;
  const limited = slices.every((s) => s.glAccountIds !== null);
  const allowed = new Set(slices.flatMap((s) => (s.glAccountIds ?? []).map((a) => a.toLowerCase())));
  return {
    view: { slices },
    cells: (cells) => cells.filter((c) => sliceOf(slices, c) !== null),
    accounts: (accounts) => (limited ? keepWithHeaders(accounts, allowed) : accounts),
    members: {
      cc1: slices.flatMap((s) => (s.cc1Id ? [s.cc1Id] : [])),
      cc2: slices.flatMap((s) => (s.cc2Id ? [s.cc2Id] : [])),
      bu: slices.flatMap((s) => (s.buId ? [s.buId] : [])),
    },
  };
}

/** The allowed accounts and every listed header above one of them; child lists keep only those. */
export function keepWithHeaders(accounts: GridAccount[], allowed: ReadonlySet<string>): GridAccount[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const keep = new Set<string>();
  for (const a of accounts) {
    if (!allowed.has(a.id.toLowerCase())) continue;
    for (let at: GridAccount | undefined = a; at && !keep.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) keep.add(at.id);
  }
  return accounts.filter((a) => keep.has(a.id)).map((a) => ({ ...a, childIds: a.childIds.filter((c) => keep.has(c)) }));
}

const low = (v: string | null | undefined) => (v == null ? null : v.toLowerCase());

/**
 * Prior-year actuals as a holder of `slices` may see them: at a dimension grain only the members of
 * their slices of that dimension, at company grain only when they hold a company-level slice; only
 * their accounts where a slice names accounts.
 */
export function priorForHolder(prior: PriorActuals, slices: readonly HolderSlice[]): PriorActuals {
  const dimOf = (s: HolderSlice) => (prior.grain === 'cc1' ? s.cc1Id : prior.grain === 'cc2' ? s.cc2Id : prior.grain === 'bu' ? s.buId : null);
  const atGrain = slices.filter((s) => (prior.grain === 'company' ? !s.cc1Id && !s.cc2Id && !s.buId : dimOf(s) !== null));
  const cells = prior.cells.filter((c) => atGrain.some((s) => (prior.grain === 'company' || low(dimOf(s)) === low(c.dimensionId))
    && (s.glAccountIds === null || s.glAccountIds.some((a) => low(a) === low(c.glAccountId)))));
  return { ...prior, cells };
}

/**
 * The prior-actuals route has a year, not a version: a member who is not an owner or admin and holds
 * slices in any version of the year is limited to those slices (their union); null for everyone else.
 */
export async function holderSlicesOfYear(companyId: string, fiscalYear: number, userId: string): Promise<HolderSlice[] | null> {
  const rows = (await sql`
    SELECT h.cc1_id::TEXT AS cc1_id, h.cc2_id::TEXT AS cc2_id, h.bu_id::TEXT AS bu_id, h.gl_account_ids::TEXT[] AS accounts
      FROM budget_holders h
      JOIN budget_versions v ON v.id = h.version_id AND v.company_id = h.company_id AND v.fiscal_year = ${fiscalYear}
     WHERE h.company_id = ${companyId}::UUID AND h.user_id = ${userId}
       AND NOT EXISTS (SELECT 1 FROM company_users cu WHERE cu.company_id = h.company_id AND cu.user_id = ${userId}
                         AND cu.role IN ('owner', 'admin'))
  `) as DbRow[];
  if (rows.length === 0) return null;
  const id = (x: unknown) => (x == null ? null : String(x));
  return rows.map((r) => ({
    cc1Id: id(r.cc1_id), cc2Id: id(r.cc2_id), buId: id(r.bu_id), status: null,
    glAccountIds: Array.isArray(r.accounts) ? (r.accounts as unknown[]).map(String) : null,
  }));
}

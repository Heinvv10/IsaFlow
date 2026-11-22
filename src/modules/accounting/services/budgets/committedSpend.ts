/**
 * Committed spend as a report (design docs/design/mcp-po-reports.md, `committed_spend`): the open value of the purchase orders that
 * commit spend (approved, partially received, received, and closed by billing while not fully billed), per PO line
 * `openPoLineCents(lineTotal, billed)`, read by the ONE committed reading (`remainingCommitted.readCommitmentLines`, the rows
 * `readCommitments` hands to budget_remaining), so nothing about netting is recomputed here: bills, #1703's header links, the
 * largest-remainder share of negative lines, the floor at 0. Summed per the caller's group keys.
 *
 * The invariant (tested to the cent): for any (account, month, slice) the groups of `account + month + cc1 + cc2 + bu`, mapped onto the
 * account's budget level, add up to budget_remaining's `committed` for that key.
 *   - A PO line that names no account cannot meet a budget (budget_remaining never sees it): it is reported apart, in `noAccount`,
 *     never inside a group and never in `total`.
 *   - A line whose dimensions miss the account's budget level is reported under its own dimensions (off-slice at the level).
 * Every query is company-scoped (the readers' own predicates, and the names below). Money is integer cents.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { monthEnd, monthKeyToDate } from '../reports/budgetPeriodWindow';
import { openPoLineCents } from './remainingBudgetCore';
import { readCommitmentLines } from './remainingCommitted';

export const GROUP_KEYS = ['supplier', 'cc2', 'account', 'cc1', 'bu', 'month'] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];
export const DEFAULT_GROUP_BY: readonly GroupKey[] = ['supplier', 'cc2', 'account'];

/** Longest name or code carried in a row: a reply of a full page must stay under MAX_READ_RESULT_BYTES. */
export const NAME_CAP = 60;

export interface CommittedSpendQuery {
  /** 'YYYY-MM'. */
  fromMonth: string;
  toMonth: string;
  groupBy: readonly GroupKey[];
  supplierId?: string | null;
  accountId?: string | null;
  cc2Id?: string | null;
}

export interface Money { cents: number; poLines: number; pos: number }
/** A group key's member: null = the line has none of it (the unassigned slice). */
export interface Member { id: string; code: string | null; name: string | null }
export type GroupMembers = Partial<Record<Exclude<GroupKey, 'month'>, Member | null>> & { month?: string };
export interface CommittedGroup extends Money { members: GroupMembers }

export interface CommittedSpendReport {
  /** The groups of the requested page, largest first. */
  groups: CommittedGroup[];
  groupsTotal: number;
  nextOffset: number | null;
  /** Over every group, whatever the page. */
  total: Money;
  /** Lines naming no account (never in `total`). */
  noAccount: Money;
}

export const DEFAULT_PAGE = { offset: 0, limit: 50 };

interface Acc { ids: Partial<Record<GroupKey, string | null>>; cents: number; lines: number; pos: Set<string> }

const clip = (v: unknown): string | null => (v == null ? null : String(v).slice(0, NAME_CAP));

/** Names of the members on this page, one company-scoped read per dimension. */
async function memberNames(companyId: string, groups: readonly Acc[]): Promise<Record<Exclude<GroupKey, 'month'>, Map<string, Member>>> {
  const ids = (k: GroupKey) => [...new Set(groups.map((g) => g.ids[k]).filter((v): v is string => typeof v === 'string'))];
  const out = { supplier: new Map<string, Member>(), account: new Map<string, Member>(), cc1: new Map<string, Member>(), cc2: new Map<string, Member>(), bu: new Map<string, Member>() };
  const put = (map: Map<string, Member>, rows: DbRow[]) => rows.forEach((r) => map.set(String(r.id), { id: String(r.id), code: clip(r.code), name: clip(r.name) }));
  if (ids('supplier').length > 0) {
    put(out.supplier, (await sql`SELECT id::TEXT AS id, NULL::TEXT AS code, name FROM suppliers WHERE company_id = ${companyId}::UUID AND id = ANY(${ids('supplier')}::UUID[])`) as DbRow[]);
  }
  if (ids('account').length > 0) {
    put(out.account, (await sql`SELECT id::TEXT AS id, account_code AS code, account_name AS name FROM gl_accounts WHERE company_id = ${companyId}::UUID AND id = ANY(${ids('account')}::UUID[])`) as DbRow[]);
  }
  for (const k of ['cc1', 'cc2'] as const) {
    if (ids(k).length > 0) {
      put(out[k], (await sql`SELECT id::TEXT AS id, code, name FROM cost_centres WHERE company_id = ${companyId}::UUID AND cc_type = ${k} AND id = ANY(${ids(k)}::UUID[])`) as DbRow[]);
    }
  }
  if (ids('bu').length > 0) {
    put(out.bu, (await sql`SELECT id::TEXT AS id, code, name FROM business_units WHERE company_id = ${companyId}::UUID AND id = ANY(${ids('bu')}::UUID[])`) as DbRow[]);
  }
  return out;
}

export async function committedSpendReport(
  companyId: string, q: CommittedSpendQuery, page: { offset: number; limit: number } = DEFAULT_PAGE,
): Promise<CommittedSpendReport> {
  const lines = await readCommitmentLines(companyId, {
    accounts: q.accountId ? [q.accountId] : null,
    range: { start: monthKeyToDate(q.fromMonth), end: monthEnd(monthKeyToDate(q.toMonth)) },
    supplierId: q.supplierId ?? null, cc2Id: q.cc2Id ?? null,
  }, {});
  const groups = new Map<string, Acc>();
  const total = { cents: 0, lines: 0, pos: new Set<string>() };
  const noAccount = { cents: 0, lines: 0, pos: new Set<string>() };
  for (const l of lines) {
    const cents = openPoLineCents(l.lineTotal, l.billed);
    if (cents === 0) continue;
    const into = l.glAccountId === null ? noAccount : total;
    into.cents += cents; into.lines += 1; into.pos.add(l.poId);
    if (l.glAccountId === null) continue;
    const ids: Acc['ids'] = {};
    for (const k of q.groupBy) {
      ids[k] = k === 'supplier' ? l.supplierId : k === 'account' ? l.glAccountId : k === 'month' ? l.month : k === 'cc1' ? l.cc1Id : k === 'cc2' ? l.cc2Id : l.buId;
    }
    const key = JSON.stringify(q.groupBy.map((k) => ids[k] ?? null));
    const g = groups.get(key) ?? { ids, cents: 0, lines: 0, pos: new Set<string>() };
    g.cents += cents; g.lines += 1; g.pos.add(l.poId);
    groups.set(key, g);
  }
  const sorted = [...groups.entries()].sort(([ak, a], [bk, b]) => b.cents - a.cents || (ak < bk ? -1 : ak > bk ? 1 : 0)).map(([, g]) => g);
  const shown = sorted.slice(page.offset, page.offset + page.limit);
  const names = await memberNames(companyId, shown);
  const money = (m: { cents: number; lines: number; pos: Set<string> }): Money => ({ cents: m.cents, poLines: m.lines, pos: m.pos.size });
  return {
    groups: shown.map((g) => {
      const members: GroupMembers = {};
      for (const k of q.groupBy) {
        if (k === 'month') { members.month = String(g.ids.month); continue; }
        const id = g.ids[k];
        members[k] = id == null ? null : names[k].get(id) ?? { id, code: null, name: null };
      }
      return { ...money(g), members };
    }),
    groupsTotal: sorted.length,
    nextOffset: page.offset + shown.length < sorted.length ? page.offset + shown.length : null,
    total: money(total),
    noAccount: money(noAccount),
  };
}

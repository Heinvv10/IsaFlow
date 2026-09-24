/**
 * Would changing accounts' attributes — or the account lines sit on — change
 * what a FILED VAT201 was built from?
 *
 * The lock records the VAT201 snapshot. The snapshot (reports/vatBoxBasisQuery
 * + vatBoxBasis) does two things with account attributes:
 *
 *   1. it decides WHICH journals it folds in — the membership rule
 *      (reports/vatEntryMembership): a journal is VAT-bearing when any of its
 *      lines is a member line;
 *   2. it classifies every line of a folded-in journal (`classifyVatJournalLine`:
 *      tax leg / base / settlement / unmapped, and a direction).
 *
 * Operations that change attributes without posting — reclassifyAccount, an
 * account merge (source lines take the target's attributes), default-accounts,
 * the COA (re-)imports — can move a filed figure through EITHER. So for every
 * POSTED journal inside an ACTIVE lock that touches a changing account, with
 * ALL of the operation's changes applied together:
 *
 *   - membership before vs after — computed in SQL with the snapshot's own
 *     fragment, over every line of the journal, each changing account read
 *     with its `from` (before) or `to` (after) attributes. If it flips, the
 *     journal's OTHER lines enter or leave the filed boxes (a zero-rated sale
 *     whose debtors account is re-typed to an expense leaves box 2) — refused;
 *   - if it is folded in both before and after, each changing account's line
 *     class before vs after (the snapshot's classifier, imported) — refused if
 *     any differs.
 *
 * A journal folded in neither before nor after (the untagged salary journal on a
 * paycard going NULL → bank) is in no box, and never refuses.
 *
 * BOUNDED: the query returns DISTINCT (lock, the journal's two membership
 * facts, changing account, vat_type, debit/credit sign) — not every line.
 *
 * Takes the SHARED VAT-lock key first (journalVatLockGuard), so no lock can be
 * taken between this read and the caller's write.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { classifyVatJournalLine } from '../reports/vatBoxBasis';
import { vatEntryMemberLineSql } from '../reports/vatEntryMembership';
import { VatPeriodLockedError, takeVatLockShared, type ActiveVatLock } from './journalVatLockGuard';

export interface AccountVatAttrs {
  accountType: string;
  accountSubtype: string | null;
}

interface LineShape {
  vatType: string | null;
  debit: number;
  credit: number;
}

type Row = Record<string, unknown>;

function classKey(line: LineShape, account: AccountVatAttrs): string {
  const c = classifyVatJournalLine({
    journalEntryId: '', entryNumber: '', entryDate: '', lineId: '', accountId: '',
    accountCode: '', accountName: '',
    accountType: account.accountType,
    accountSubtype: account.accountSubtype,
    vatType: line.vatType,
    debit: line.debit,
    credit: line.credit,
    // ALWAYS false, deliberately. The snapshot passes true for a journal raised
    // by a since-cancelled document, and then a tax leg is 'cancelled' (out of
    // the box) where it would otherwise be a live tax leg. Treating every
    // journal as live can only make this check refuse MORE — a cancelled
    // document's tax leg moving is reported as a move — never less, and it
    // spares this query the snapshot's cancelled-document joins. Safe side.
    cancelledSource: false,
  });
  return `${c.role}|${c.direction ?? ''}`;
}

/** Pure: does this line land in a different part of the return under `to`? */
export function lineReclassifies(line: LineShape, from: AccountVatAttrs, to: AccountVatAttrs): boolean {
  return classKey(line, from) !== classKey(line, to);
}

/** One account whose type and/or subtype an operation changes (for a merge: the source, taking the target's attributes). */
export interface AccountAttributeChange {
  accountId: string;
  accountCode: string;
  from: AccountVatAttrs;
  to: AccountVatAttrs;
}

/** One DISTINCT row of the bounded query: what the decision needs, nothing more. */
export interface LockedJournalShape {
  lockId: string;
  periodStart: string;
  periodEnd: string;
  /** The journal is folded into the return before / after the changes. */
  memberBefore: boolean;
  memberAfter: boolean;
  /** A line of the journal on a CHANGING account. */
  accountId: string;
  vatType: string | null;
  /** Sign of debit - credit: 1, -1 or 0. */
  sign: number;
}

export interface LockedReclassification extends ActiveVatLock {
  accountCode: string;
  /** Distinct line shapes that move in that lock. */
  lines: number;
  /** True when the journal enters or leaves the return, not only a line's box. */
  membershipFlips: boolean;
}

/**
 * Pure decision over the query's rows (ordered by lock period start): the first
 * lock where a journal's membership flips, or a changing account's line in a
 * folded-in journal changes class — or null.
 */
export function decideLockedReclass(
  rows: readonly LockedJournalShape[], changes: readonly AccountAttributeChange[],
): LockedReclassification | null {
  const byId = new Map(changes.map((c) => [c.accountId, c]));
  let found: LockedReclassification | null = null;
  for (const r of rows) {
    const change = byId.get(r.accountId);
    if (!change) continue;
    const flips = r.memberBefore !== r.memberAfter;
    let moves = flips;
    if (!moves && r.memberBefore) {
      const line = { vatType: r.vatType, debit: r.sign > 0 ? 1 : 0, credit: r.sign < 0 ? 1 : 0 };
      moves = lineReclassifies(line, change.from, change.to);
    }
    if (!moves) continue;
    if (!found) {
      found = {
        id: r.lockId, periodStart: r.periodStart, periodEnd: r.periodEnd,
        accountCode: change.accountCode, lines: 0, membershipFlips: false,
      };
    }
    if (found.id === r.lockId) {
      found.lines += 1;
      found.membershipFlips ||= flips;
    }
  }
  return found;
}

const changed = (c: AccountAttributeChange) =>
  c.from.accountType !== c.to.accountType || (c.from.accountSubtype ?? null) !== (c.to.accountSubtype ?? null);

/**
 * The changed accounts as a relation `ch(id, from_type, from_sub, to_type,
 * to_sub)` — splice as `WITH ch AS (${changedAccountsSql(changes)})`.
 * Exported for the test that pins it against the snapshot's own membership
 * (tests/integration/vat-entry-membership-agreement.int.test.ts).
 */
export function changedAccountsSql(changes: readonly AccountAttributeChange[]) {
  return sql`SELECT * FROM unnest(
    ${changes.map((c) => c.accountId)}::UUID[],
    ${changes.map((c) => c.from.accountType)}::TEXT[], ${changes.map((c) => c.from.accountSubtype)}::TEXT[],
    ${changes.map((c) => c.to.accountType)}::TEXT[], ${changes.map((c) => c.to.accountSubtype)}::TEXT[]
  ) AS ch(id, from_type, from_sub, to_type, to_sub)`;
}

/**
 * The snapshot's member-line predicate (reports/vatEntryMembership) with each
 * CHANGED account read under its `from` or `to` attributes, over aliases `jl`,
 * `ga` and a LEFT-JOINed `ch` (changedAccountsSql). Every other account is read
 * from its own row.
 */
export function memberLineUnderSql(side: 'from' | 'to') {
  const override = side === 'from'
    ? { type: sql`ch.from_type`, sub: sql`ch.from_sub` }
    : { type: sql`ch.to_type`, sub: sql`ch.to_sub` };
  return vatEntryMemberLineSql({
    accountType: sql`(CASE WHEN ch.id IS NULL THEN ga.account_type ELSE ${override.type} END)`,
    accountSubtype: sql`(CASE WHEN ch.id IS NULL THEN ga.account_subtype ELSE ${override.sub} END)`,
    vatType: sql`jl.vat_type`,
  });
}

/**
 * With ALL `changes` applied together: the first ACTIVE lock holding a posted
 * journal whose filed figures would move — or null. Several entries for one
 * account collapse to the LAST (the account's final attributes); unchanged
 * entries are ignored.
 */
export async function findLockedReclassification(
  companyId: string, changes: readonly AccountAttributeChange[],
): Promise<LockedReclassification | null> {
  const last = new Map<string, AccountAttributeChange>();
  for (const c of changes) last.set(c.accountId, c);
  const real = [...last.values()].filter(changed);
  if (real.length === 0) return null;
  await takeVatLockShared(companyId);
  const ids = real.map((c) => c.accountId);
  const rows = (await sql`
    WITH ch AS (${changedAccountsSql(real)}),
    jr AS (
      SELECT DISTINCT e.id, vpl.id AS lock_id, vpl.period_start, vpl.period_end
      FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.company_id = l.company_id
      JOIN vat_period_locks vpl
        ON vpl.company_id = e.company_id AND vpl.unlocked_at IS NULL
       AND e.entry_date BETWEEN vpl.period_start AND vpl.period_end
      WHERE l.company_id = ${companyId}::UUID AND l.gl_account_id = ANY(${ids}::UUID[])
        AND e.status = 'posted'
    ),
    mem AS (
      SELECT jr.id,
             bool_or(${memberLineUnderSql('from')}) AS member_before,
             bool_or(${memberLineUnderSql('to')}) AS member_after
      FROM jr
      JOIN gl_journal_lines jl ON jl.journal_entry_id = jr.id AND jl.company_id = ${companyId}::UUID
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
      LEFT JOIN ch ON ch.id = jl.gl_account_id
      GROUP BY jr.id
    )
    SELECT DISTINCT jr.lock_id, jr.period_start, jr.period_end, mem.member_before, mem.member_after,
           l.gl_account_id AS account_id, l.vat_type, SIGN(l.debit - l.credit)::INT AS sign
    FROM jr
    JOIN mem ON mem.id = jr.id
    JOIN gl_journal_lines l ON l.journal_entry_id = jr.id AND l.company_id = ${companyId}::UUID
     AND l.gl_account_id = ANY(${ids}::UUID[])
    ORDER BY jr.period_start`) as Row[];

  return decideLockedReclass(rows.map((r) => ({
    lockId: String(r.lock_id),
    periodStart: fmtDate(r.period_start as string),
    periodEnd: fmtDate(r.period_end as string),
    memberBefore: r.member_before === true,
    memberAfter: r.member_after === true,
    accountId: String(r.account_id),
    vatType: r.vat_type == null ? null : String(r.vat_type),
    sign: Number(r.sign),
  })), real);
}

/** The refusal wording every caller uses. */
export function lockedReclassMessage(found: LockedReclassification, what: string): string {
  const how = found.membershipFlips
    ? 'would move a journal into or out of that period\'s filed VAT201'
    : 'would land in a different part of that period\'s filed VAT201';
  return `Posted lines on ${found.accountCode} dated inside the locked VAT period ${found.periodStart} to `
    + `${found.periodEnd} ${how} after ${what}, so nothing has been changed. An owner or admin can unlock the `
    + 'period (with a reason) if the return is being amended.';
}

/**
 * Refuse (VatPeriodLockedError, naming account and period) when `changes`,
 * applied TOGETHER, would move a filed VAT figure. For default-accounts and the
 * same-source re-import (checked before their first write, from the intended
 * attributes) and the COA import (checked after its writes inside a savepoint,
 * from the attributes actually written).
 */
export async function assertAccountChangesKeepVatLocks(
  companyId: string, changes: readonly AccountAttributeChange[],
): Promise<void> {
  const found = await findLockedReclassification(companyId, changes);
  if (found) {
    throw new VatPeriodLockedError(found.periodStart, found, undefined,
      lockedReclassMessage(found, 'this change of account type / subtype'));
  }
}

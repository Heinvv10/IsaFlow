/**
 * The queries behind the merge preview, kept apart from the assembly so that
 * each figure is visibly its OWN query.
 *
 * That separation is the point, not tidiness. The one thing a merge preview
 * must never do is compute the target's balance from the source's — then the
 * "after" figure agrees with the "before" figure by construction and proves
 * nothing. Every function here is filtered on exactly one account, or on the
 * company with both accounts excluded, and the assembly adds them up.
 */
import { sql } from '@/lib/neon';

export interface LedgerTotals {
  lines: number;
  debit: number;
  credit: number;
}

export interface MovableLine {
  journalLineId: string;
  journalEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  status: string;
  debit: number;
  credit: number;
}

export type MergeSkipCode = 'fiscal_period_closed' | 'posted_without_fiscal_period';

export interface MergeSkip extends MovableLine {
  reason: MergeSkipCode;
}

function totals(rows: Record<string, unknown>[]): LedgerTotals {
  const r = rows[0];
  return {
    lines: Number(r?.lines ?? 0),
    debit: Number(r?.debit ?? 0),
    credit: Number(r?.credit ?? 0),
  };
}

/** POSTED totals for ONE account. Nothing about the other account enters here. */
export async function postedTotalsForAccount(
  companyId: string, accountId: string,
): Promise<LedgerTotals> {
  return totals((await sql`
    SELECT COUNT(*)::INT AS lines,
           COALESCE(SUM(l.debit), 0)  AS debit,
           COALESCE(SUM(l.credit), 0) AS credit
      FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     WHERE l.company_id = ${companyId}::UUID
       AND l.gl_account_id = ${accountId}::UUID
       AND e.status = 'posted'
  `) as Record<string, unknown>[]);
}

/** POSTED totals for the whole company — no account filter at all. */
export async function postedTotalsForCompany(companyId: string): Promise<LedgerTotals> {
  return totals((await sql`
    SELECT COUNT(*)::INT AS lines,
           COALESCE(SUM(l.debit), 0)  AS debit,
           COALESCE(SUM(l.credit), 0) AS credit
      FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     WHERE l.company_id = ${companyId}::UUID AND e.status = 'posted'
  `) as Record<string, unknown>[]);
}

/**
 * POSTED totals for every account EXCEPT the two. Independent of both per-account
 * queries and of the company total — which is what lets the identity
 * `other + source + target === company` actually fail when something is wrong.
 */
export async function postedTotalsExcluding(
  companyId: string, sourceId: string, targetId: string,
): Promise<LedgerTotals> {
  return totals((await sql`
    SELECT COUNT(*)::INT AS lines,
           COALESCE(SUM(l.debit), 0)  AS debit,
           COALESCE(SUM(l.credit), 0) AS credit
      FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     WHERE l.company_id = ${companyId}::UUID
       AND e.status = 'posted'
       AND l.gl_account_id <> ${sourceId}::UUID
       AND l.gl_account_id <> ${targetId}::UUID
  `) as Record<string, unknown>[]);
}

/** Number of accounts carrying at least one posted line. Reported so the reader
 *  can see the merge removes exactly one account from the trial balance. */
export async function accountsWithPostedLines(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(DISTINCT l.gl_account_id)::INT AS n
      FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     WHERE l.company_id = ${companyId}::UUID AND e.status = 'posted'
  `) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

function toLine(r: Record<string, unknown>): MovableLine {
  const d = r.entry_date;
  return {
    journalLineId: String(r.line_id),
    journalEntryId: String(r.entry_id),
    entryNumber: r.entry_number == null ? null : String(r.entry_number),
    entryDate: d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? ''),
    status: String(r.status),
    debit: Number(r.debit ?? 0),
    credit: Number(r.credit ?? 0),
  };
}

/**
 * Every line on the source, split into the ones that can move and the ones that
 * cannot — in ONE query, so a row cannot fall into neither list.
 *
 * A posted line in a CLOSED period would change a trial balance someone has
 * already signed. A posted line with NO fiscal period is in the ledger but in
 * no period at all: the balance-cache trigger returns early on it, so no period
 * report would ever show the move. Both are facts about the DATA, so they are
 * skips rather than refusals — but a control-account merge that leaves half its
 * balance behind is worse than one that does not run, so any skip blocks the
 * write and the caller is told exactly which rows to fix.
 *
 * Drafts move freely: they post nothing, so no period is affected.
 */
export async function classifySourceLines(
  companyId: string, sourceId: string,
): Promise<{ movable: MovableLine[]; skips: MergeSkip[] }> {
  const rows = (await sql`
    SELECT l.id AS line_id, e.id AS entry_id, e.entry_number, e.entry_date, e.status,
           l.debit, l.credit,
           CASE
             WHEN e.status <> 'posted'          THEN NULL
             WHEN e.fiscal_period_id IS NULL    THEN 'posted_without_fiscal_period'
             WHEN fp.status IS DISTINCT FROM 'open' THEN 'fiscal_period_closed'
             ELSE NULL
           END AS skip_reason
      FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      LEFT JOIN fiscal_periods fp
        ON fp.id = e.fiscal_period_id AND fp.company_id = ${companyId}::UUID
     WHERE l.company_id = ${companyId}::UUID
       AND l.gl_account_id = ${sourceId}::UUID
     ORDER BY e.entry_date, e.entry_number, l.id
  `) as Record<string, unknown>[];

  const movable: MovableLine[] = [];
  const skips: MergeSkip[] = [];
  for (const r of rows) {
    const reason = r.skip_reason == null ? null : (String(r.skip_reason) as MergeSkipCode);
    if (reason) skips.push({ ...toLine(r), reason });
    else movable.push(toLine(r));
  }
  return { movable, skips };
}

/** Descendants of the source, with the level each would carry after the move. */
export async function descendantsOf(
  companyId: string, accountId: string, maxDepth: number,
): Promise<{ accountId: string; accountCode: string; accountName: string; level: number; isDirectChild: boolean }[]> {
  const rows = (await sql`
    WITH RECURSIVE subtree AS (
      SELECT id, account_code, account_name, level, 1 AS depth
        FROM gl_accounts
       WHERE parent_account_id = ${accountId}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT ch.id, ch.account_code, ch.account_name, ch.level, s.depth + 1
        FROM gl_accounts ch
        JOIN subtree s ON ch.parent_account_id = s.id
       WHERE ch.company_id = ${companyId}::UUID AND s.depth < ${maxDepth}
    )
    SELECT id, account_code, account_name, level, depth FROM subtree ORDER BY depth, account_code
  `) as Record<string, unknown>[];
  return rows.map((r) => ({
    accountId: String(r.id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    level: Number(r.level ?? 1),
    isDirectChild: Number(r.depth) === 1,
  }));
}

/** MAX(created_at) of the journal lines this preview consumed. Never now(). */
export async function postedThroughForAccounts(
  companyId: string, sourceId: string, targetId: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT MAX(l.created_at) AS ts
      FROM gl_journal_lines l
     WHERE l.company_id = ${companyId}::UUID
       AND l.gl_account_id IN (${sourceId}::UUID, ${targetId}::UUID)
  `) as { ts: Date | string | null }[];
  const ts = rows[0]?.ts;
  if (!ts) return null;
  return ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
}

/** Active system accounts claiming a subtype — the resolver's contested set. */
export async function systemClaimantsForSubtype(
  companyId: string, subtype: string | null,
): Promise<{ accountId: string; accountCode: string; accountName: string; accountType: string }[]> {
  if (!subtype) return [];
  const rows = (await sql`
    SELECT id, account_code, account_name, account_type
      FROM gl_accounts
     WHERE company_id = ${companyId}::UUID
       AND is_system_account = true AND is_active = true
       AND account_subtype = ${subtype}
     ORDER BY account_code
  `) as Record<string, unknown>[];
  return rows.map((r) => ({
    accountId: String(r.id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
  }));
}

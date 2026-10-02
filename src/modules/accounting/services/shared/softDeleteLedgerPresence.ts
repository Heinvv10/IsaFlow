/**
 * K-053 round 4: whether a document belongs on the SUB-LEDGER side of an as-at
 * comparison, given that soft-delete now reverses its approval journal.
 *
 * The delete reverses through reverseJournalEntry, which dates the reversal to
 * the ORIGINAL entry date only while that period is open and otherwise to
 * TODAY (resolveReversalDate, gl/journalEntryPostingService). So for a document
 * raised in a closed prior month — the ordinary case — the GL keeps carrying it
 * right up to the delete date and only then nets to zero.
 *
 * Round 3 answered "is this document out of the ledger?" with an UNDATED test
 * (deleted_at IS NULL, or an EXISTS on the linked entry's reversed_at). Both
 * sides of an as-at comparison are then measured on different clocks: the GL
 * half is bounded by entry_date <= as-at, the document half is not. An invoice
 * dated 2026-03-15, deleted on 2026-09-09, read as at 2026-06-30 left R1,150 on
 * the control account with nothing on the sub-ledger side — a false difference
 * at EVERY as-at date between the two, and a hard fail on the close checklist.
 *
 * The dated answer is the reversal chain's PARITY as at the date. The link
 * column always points at the original entry and reversing is additive
 * (reversing O posts R with reversal_of_id = O, reversing R posts R2), so the
 * chain is linear and the document's journal is standing exactly when an ODD
 * number of its posted entries are dated on or before the as-at date. That one
 * predicate covers every population without a historical repair:
 *
 *   - deleted before this change, journal never reversed  -> 1, standing, kept
 *   - deleted after it, as-at before the reversal          -> 1, standing, kept
 *   - deleted after it, as-at on or after the reversal     -> 2, out, dropped
 *   - the delete's reversal itself reversed by hand        -> 3, standing, kept
 *   - never posted, or the link is NULL                    -> 0, out, dropped
 *
 * PRECONDITION: no reversal is ever dated BEFORE the entry it reverses. Parity
 * of the entries dated on or before the as-at date only equals the chain's net
 * position when those entries form a PREFIX of the chain, and that is what
 * makes them one. resolveReversalDate (gl/journalEntryReversalDate) refuses
 * an EXPLICIT reversal_date earlier than the entry it corrects, and since
 * R-012 (2026-09-24) its default path does too: where today would precede a
 * future-dated original whose period is not open, the contra is dated with the
 * original when posting would create that year, and refused otherwise
 * (ReversalBeforeOriginalError) — EXCEPT for an original whose fiscal year is
 * outside the auto-create window (a typo'd year posted with a NULL period),
 * which keeps today. That one shape still breaks this precondition, by
 * design; so can rows written before R-012.
 * k053-out-of-order-reversal-chain.int.test.ts hand-builds such a chain in SQL
 * and pins what this predicate does with it.
 *
 * CASE rather than OR so the recursive walk is only ever evaluated for a
 * deleted row: CASE guarantees the arms are not evaluated when the condition
 * decides it, an OR arm is merely likely to be ordered that way by the planner.
 *
 * Built with ONE `sql.unsafe` rather than a nested tagged template. A nested
 * `sql` call is a call on the mocked client in every unit suite that stubs
 * `@/lib/neon`, so it silently consumes a `mockResolvedValueOnce` and shifts
 * every queued row after it; `unsafe` builds the same spliceable fragment
 * without one. The tenant is carried as a PARAMETER, not as the correlated
 * `<alias>.company_id`, so the fragment scopes itself the way every other query
 * in the codebase does and a caller cannot forget it. The one exception is the
 * group consolidation, which reads several tenants in one statement and so
 * cannot name one: it uses documentInLedgerAsAtFragmentForRowTenant below.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/**
 * The as-at date for a figure that takes no as-at parameter. A "current"
 * balance is a balance as at TODAY, and today is the date it has to ask this
 * question at: an undated `deleted_at IS NULL` would drop a document deleted
 * before this change, whose journal was never reversed and which the control
 * account therefore still carries. fmtDate, never toISOString — the host runs
 * UTC+2 and a Date round-trip reports the previous day after 22:00.
 */
export function asAtTodayStr(): string {
  return fmtDate(new Date());
}

/** Table alias the surrounding query gives the invoice: `ci` (AR) or `si` (AP). */
export type InvoiceAlias = 'ci' | 'si';

/**
 * A boolean fragment: TRUE when the document belongs on the sub-ledger side of
 * a comparison drawn as at `asAtStr`. Replaces a bare `<alias>.deleted_at IS
 * NULL` and must be paired with a GL half bounded by `entry_date <= asAtStr`.
 *
 * The row must expose `deleted_at` and `gl_journal_entry_id`.
 *
 * INTERPOLATION ONLY — hence the name. The return is a LazyQuery, i.e. a
 * thenable, so `await`ing it instead of splicing it into a template sends the
 * bare `(CASE WHEN ...)` fragment to Postgres as a whole statement and fails at
 * runtime rather than at compile time. Same hazard as `effectivePaidExpr`.
 */
export function documentInLedgerAsAtFragment(alias: InvoiceAlias, asAtStr: string, companyId: string) {
  return chainParityFragment(alias, '$1::UUID', '$2::date', [companyId, asAtStr]);
}

/**
 * The same predicate for a query that spans SEVERAL tenants — the group
 * consolidation is the only one — where a single `companyId` parameter cannot
 * express the scope. The chain is scoped to the invoice row's OWN
 * `company_id`, which is the tenant that owns the document by definition, so
 * the walk still cannot cross a tenant boundary; the outer query remains
 * responsible for restricting WHICH companies are read, exactly as it already
 * is for the invoice rows themselves.
 *
 * The row must additionally expose `company_id`.
 */
export function documentInLedgerAsAtFragmentForRowTenant(alias: InvoiceAlias, asAtStr: string) {
  return chainParityFragment(alias, `${alias}.company_id`, '$1::date', [asAtStr]);
}

/**
 * D7: TRUE when the entry `<entryAlias>` is a LINK of a soft-deleted invoice's
 * or bill's reversal chain: R, R2, R3 ... past the document's own journal O,
 * never O itself. It walks UP from the entry, so it reads that entry's own
 * chain and no other. The one definition of "a deleted document's chain" for
 * each reader that must leave it out:
 *
 *   - the AR/AP orphan scan (reconciliation/orphanControlPostings). The
 *     sub-ledger side already accounts for the chain through its parity.
 *   - the VAT reconciliation's REVENUE arm (reports/vatReconciliationService),
 *     which is compared with an invoice leg that keeps a deleted invoice in
 *     the month it was raised. NOT its VAT arms: those are compared with
 *     returns filed from the ledger as it stands.
 *
 * Excluding only the entry `soft_delete_journal_reversals` records broke both
 * of them as soon as that entry was itself reversed by hand. That row does not
 * move; the chain does. The row must expose `id` and `reversal_of_id`; an entry
 * that reverses nothing is decided without a walk (CASE, as above).
 * INTERPOLATION ONLY.
 */
export function deletedDocumentChainLinkFragment(
  entryAlias: 'je' | 'gje',
  companyId: string,
  /**
   * 'otherMonth' narrows it to links whose document's own journal is dated in
   * a DIFFERENT calendar month from the link (the row must expose
   * `entry_date`): the VAT reconciliation's rate keeps a delete and its
   * reversal that fall in one month, where they net to nothing, and drops a
   * reversal that rolled into a later month.
   */
  only: 'any' | 'otherMonth' = 'any',
) {
  const deletedJournal = (table: string) => `EXISTS (SELECT 1 FROM ${table} d
          WHERE d.company_id = $1::UUID AND d.deleted_at IS NOT NULL
            AND d.gl_journal_entry_id = up_chain.id)`;
  const month = only === 'otherMonth'
    ? `AND date_trunc('month', up_chain.entry_date) <> date_trunc('month', ${entryAlias}.entry_date)`
    : '';
  return sql.unsafe(
    `(CASE WHEN ${entryAlias}.reversal_of_id IS NULL THEN FALSE ELSE EXISTS (
        WITH RECURSIVE ${chainWalk('up_chain', `${entryAlias}.id`, '$1::UUID', 'up')}
        SELECT 1 FROM up_chain
        WHERE up_chain.depth > 0 AND NOT up_chain.is_cycle ${month}
          AND (${deletedJournal('customer_invoices')} OR ${deletedJournal('supplier_invoices')})
      ) END)`,
    [companyId],
  );
}

/**
 * D7: TRUE when the document's journal is REVERSED OUT of the ledger as at
 * `asAtStr`, meaning an ODD number of the posted reversals hanging off it are
 * dated on or before that date. Reading one link instead ("O has a posted
 * reversal") says a document deleted and restored inside its period, O <- R <-
 * R2, is reversed when its chain stands. Same prefix precondition as the
 * parity predicate above. The row must expose `gl_journal_entry_id`, and the
 * journal must be known to be posted: an unposted one has no reversals and
 * reads FALSE. INTERPOLATION ONLY.
 */
export function journalReversedAsAtFragment(alias: InvoiceAlias, asAtStr: string, companyId: string) {
  return sql.unsafe(
    `(WITH RECURSIVE ${chainWalk('down_chain', `${alias}.gl_journal_entry_id`, '$1::UUID', 'down')}
      SELECT COUNT(*) FILTER (WHERE down_chain.depth > 0 AND NOT down_chain.is_cycle
                                AND down_chain.entry_date <= $2::date) % 2 = 1
      FROM down_chain)`,
    [companyId, asAtStr],
  );
}

/**
 * The ONE recursive walk every chain predicate here uses: POSTED entries of one
 * tenant, linked by `reversal_of_id`, starting from the posted entry
 * `seedExpr` (depth 0). 'down' follows the entries that reverse the previous
 * one; 'up' follows the entry the previous one reverses. The UNIQUE on
 * (company_id, reversal_of_id) keeps a real chain linear.
 *
 * CYCLE GUARD (D7 round 3). Nothing stops a forged `reversal_of_id` loop, and
 * an unguarded `UNION ALL` walk never ends on one: a single loop O <-> R hung
 * the VAT reconciliation, the VAT201 unposted check and the AR reconciliation
 * (this parity walk) for the whole company, and the statements ran on
 * server-side after the client gave up. `CYCLE ... SET is_cycle` stops at the
 * first entry already on the path and flags that row; every reader skips
 * flagged rows, so a loop reads as the chain up to the point where it closes.
 */
function chainWalk(name: string, seedExpr: string, tenantExpr: string, direction: 'down' | 'up'): string {
  const step = direction === 'down' ? `j.reversal_of_id = ${name}.id` : `j.id = ${name}.reversal_of_id`;
  return `${name} AS (
      SELECT s.id, s.reversal_of_id, s.entry_date, 0 AS depth
      FROM gl_journal_entries s
      WHERE s.id = ${seedExpr} AND s.company_id = ${tenantExpr} AND s.status = 'posted'
      UNION ALL
      SELECT j.id, j.reversal_of_id, j.entry_date, ${name}.depth + 1
      FROM gl_journal_entries j
      JOIN ${name} ON ${step}
      WHERE j.company_id = ${tenantExpr} AND j.status = 'posted'
    ) CYCLE id SET is_cycle USING path`;
}

function chainParityFragment(
  alias: InvoiceAlias,
  tenantExpr: string,
  asAtExpr: string,
  params: unknown[],
) {
  return sql.unsafe(
    `(CASE WHEN ${alias}.deleted_at IS NULL THEN TRUE ELSE (
        WITH RECURSIVE ${chainWalk('chain', `${alias}.gl_journal_entry_id`, tenantExpr, 'down')}
        SELECT COUNT(*) FILTER (WHERE NOT chain.is_cycle AND chain.entry_date <= ${asAtExpr}) % 2 = 1
        FROM chain
      ) END)`,
    params,
  );
}

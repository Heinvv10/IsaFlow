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
 * makes them one. resolveReversalDate (gl/journalEntryPostingService) enforces
 * it — it returns the target's own date or TODAY when the target's period is
 * closed, and refuses an explicit reversal_date earlier than the entry it
 * corrects. A change there that let a reversal be back-dated past its original
 * would make this predicate answer the wrong way round for the dates between
 * the two, silently. k053-out-of-order-reversal-chain.int.test.ts hand-builds
 * such a chain in SQL and pins that failure mode so the coupling is visible.
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

function chainParityFragment(
  alias: InvoiceAlias,
  tenantExpr: string,
  asAtExpr: string,
  params: unknown[],
) {
  return sql.unsafe(
    `(CASE WHEN ${alias}.deleted_at IS NULL THEN TRUE ELSE (
        WITH RECURSIVE chain AS (
          SELECT je.id, je.entry_date
          FROM gl_journal_entries je
          WHERE je.id = ${alias}.gl_journal_entry_id
            AND je.company_id = ${tenantExpr}
            AND je.status = 'posted'
          UNION ALL
          SELECT j.id, j.entry_date
          FROM gl_journal_entries j
          JOIN chain ON j.reversal_of_id = chain.id
          WHERE j.company_id = ${tenantExpr}
            AND j.status = 'posted'
        )
        SELECT COUNT(*) FILTER (WHERE chain.entry_date <= ${asAtExpr}) % 2 = 1
        FROM chain
      ) END)`,
    params,
  );
}

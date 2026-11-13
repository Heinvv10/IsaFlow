/**
 * Whether a CANCELLED payment or receipt was still standing on a PAST as-at date.
 *
 * A statement drawn as at a past date filtered payments on their CURRENT status,
 * so a payment cancelled after that date vanished from the statement for every
 * earlier date: the balance owed jumped by the payment although the control
 * account (whose reversal is dated later) still carried it.
 *
 * Neither payment table carries a cancellation date (only `updated_at`, which any
 * edit touches). Cancelling does reverse the payment's journal, though, and that
 * reversal is dated. THE RULE IS NARROW ON PURPOSE: a cancelled payment counts as
 * live at `as_at` only when its journal HAS a posted reversal dated AFTER `as_at`
 * -- it stood then and was undone later. Anything else stays off, exactly as
 * before: no journal, a cancelled payment whose journal was NEVER reversed (a data
 * defect, which `party_ledger_check` flags as `cancelled_payment_journal_stands`),
 * or a reversal dated on or before `as_at`. Customer statements are emailed, so a
 * defect row must not change what a customer is told.
 *
 * For `as_at` today or later the column is FALSE outright: today's statement is
 * byte-identical to what it was, whatever a post-dated reversal says.
 *
 * Splice the join after `FROM <table> <alias>` and the column into the SELECT.
 * The alias is a closed pair of literals, never input. ONE `sql.unsafe` each, not
 * a nested template: a nested `sql` call is a call on the mocked client in every
 * unit suite that stubs @/lib/neon and would consume a queued response.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

export type PaymentAlias = 'sp' | 'cp';

export function paymentJournalJoin(alias: PaymentAlias, companyId: string, asAtStr: string) {
  return sql.unsafe(
    `LEFT JOIN gl_journal_entries pje ON pje.id = ${alias}.gl_journal_entry_id
       AND pje.company_id = $1::UUID AND pje.status = 'posted' AND pje.entry_date <= $2::DATE`,
    [companyId, asAtStr],
  );
}

export function paymentStoodAsAtColumn(alias: PaymentAlias, companyId: string, asAtStr: string) {
  if (asAtStr >= fmtDate(new Date())) return sql.unsafe('FALSE');
  return sql.unsafe(
    `(${alias}.status = 'cancelled' AND pje.id IS NOT NULL AND EXISTS (
        SELECT 1 FROM gl_journal_entries rev
        WHERE rev.reversal_of_id = pje.id AND rev.company_id = $1::UUID
          AND rev.status = 'posted' AND rev.entry_date > $2::DATE))`,
    [companyId, asAtStr],
  );
}

/**
 * Whether a CANCELLED payment or receipt was still standing on an as-at date.
 *
 * A statement drawn as at a past date filtered payments on their CURRENT status,
 * so a payment cancelled after that date vanished from the statement for every
 * earlier date: the balance owed jumped by the payment although the control
 * account (whose reversal is dated later) still carried it.
 *
 * Neither payment table carries a cancellation date (only `updated_at`, which any
 * edit touches). Cancelling does reverse the payment's journal, though, and that
 * reversal is dated: the payment stood on a date exactly when its journal's
 * reversal chain was in force then (`journalInForceAsAt`, the rule the soft-delete
 * presence test uses). A cancelled payment with NO journal never moved the ledger
 * and stays off.
 *
 * Splice the join after `FROM <table> <alias>` and the column into the SELECT.
 * The alias is a closed pair of literals, never input.
 */
import { sql } from '@/lib/neon';
import { chainParitySql } from './journalInForceAsAt';

export type PaymentAlias = 'sp' | 'cp';

export function paymentJournalJoin(alias: PaymentAlias, companyId: string, asAtStr: string) {
  return sql.unsafe(
    `LEFT JOIN gl_journal_entries pje ON pje.id = ${alias}.gl_journal_entry_id
       AND pje.company_id = $1::UUID AND pje.status = 'posted' AND pje.entry_date <= $2::DATE`,
    [companyId, asAtStr],
  );
}

export function paymentStoodAsAtColumn(alias: PaymentAlias, companyId: string, asAtStr: string) {
  // ONE sql.unsafe, not a nested template: a nested `sql` call is a call on the mocked client in every
  // unit suite that stubs @/lib/neon and would consume a queued response (see journalInForceAsAt).
  return sql.unsafe(
    `(${alias}.status = 'cancelled' AND pje.id IS NOT NULL AND ${chainParitySql('pje.id')})`,
    [companyId, asAtStr],
  );
}

/**
 * What KIND of settlement a supplier payment is — the one rule `find_double_settlements` reports by and
 * `void_payment(undo_share)` refuses by (step 6, 2026-11-13).
 *
 * Nothing in the schema says "contra" or "card line" outright for every payment: `payment_method = 'contra'` exists
 * only since migration 540 and only `settle_by_contra` writes it, and a statement-line payment is written as `'eft'`
 * (`supplierBankPaymentService`). So the kind is DERIVED from data every payment carries, in this order:
 *
 *   1. `contra`    — `payment_method = 'contra'`.
 *   2. `card_line` — the payment came from an imported STATEMENT LINE: a bank line is matched to a line of its own
 *                    journal (`bank_transactions.matched_journal_line_id`, live statuses), or it settles a bank-first
 *                    provisional (`settles_provisional_je_id`, R-127 — a statement line too). At Velocity these are
 *                    the paycard lines; a line on the main bank account classifies the same way, and the reported
 *                    account names which card or bank it was.
 *   3. `contra`    — the account the payment's journal CREDITS (its largest credit line; `bank_account_id` when it has
 *                    no journal) is not a MONEY account. Money account = a bank/cash subtype (`CASH_SUBTYPES`) OR an
 *                    account that holds imported statement lines (a paycard whose subtype was never set still holds
 *                    its lines). A clearing account such as 1560731 "Bank Transfer acc - ABSA Paycards" is neither.
 *   4. `payment`   — everything else: a bank / cash payment captured as a document (payments screen, batch, MCP apply).
 *
 * Credit notes are a fifth kind (`credit_note`) and are classified by their table, not here.
 */
import { sql } from '@/lib/neon';
import { CASH_SUBTYPES } from '../gl/accountSubtypes';

export type PaymentSettlementKind = 'contra' | 'card_line' | 'payment';
export type SettlementKind = PaymentSettlementKind | 'credit_note';

/** A fixed column reference of the caller's own SQL — aliases are literals in this module, never input. */
const col = (alias: string, column: string) => sql.unsafe(`${alias}.${column}`);

/**
 * SQL: the account the supplier payment aliased `sp` CREDITS — its journal's largest credit line (ties by line id),
 * else its `bank_account_id` (a batch member or an unposted payment has no journal of its own).
 */
export function creditedAccountIdSql(sp: string) {
  return sql`COALESCE((
    SELECT kjl.gl_account_id FROM gl_journal_lines kjl
    WHERE kjl.journal_entry_id = ${col(sp, 'gl_journal_entry_id')}
      AND kjl.company_id = ${col(sp, 'company_id')}
      AND kjl.credit > 0
    ORDER BY kjl.credit DESC, kjl.id
    LIMIT 1
  ), ${col(sp, 'bank_account_id')})`;
}

/** SQL: a live statement line matched to a line of the journal of the payment aliased `sp` (rule 2). */
function statementLineSql(sp: string) {
  return sql`EXISTS (
    SELECT 1 FROM bank_transactions kbt
    JOIN gl_journal_lines kml ON kml.id = kbt.matched_journal_line_id
    WHERE kbt.company_id = ${col(sp, 'company_id')}
      AND kml.company_id = ${col(sp, 'company_id')}
      AND kml.journal_entry_id = ${col(sp, 'gl_journal_entry_id')}
      AND kbt.status IN ('allocated', 'matched', 'reconciled')
  )`;
}

/** SQL: is the gl_accounts row aliased `alias` a money account (rule 3)? */
function moneyAccountSql(alias: string) {
  return sql`(
    ${col(alias, 'account_subtype')} = ANY(${[...CASH_SUBTYPES]}::TEXT[])
    OR EXISTS (
      SELECT 1 FROM bank_transactions mbt
      WHERE mbt.bank_account_id = ${col(alias, 'id')} AND mbt.company_id = ${col(alias, 'company_id')}
    )
  )`;
}

/**
 * SQL: the rule above for the supplier_payments row aliased `sp`, as TEXT. The ONE implementation — the read tool
 * selects it per settlement and the undo-share plan selects it for the payment it refuses or accepts.
 */
export function paymentSettlementKindSql(sp: string) {
  return sql`(CASE
    WHEN ${col(sp, 'payment_method')} = 'contra' THEN 'contra'
    WHEN ${col(sp, 'settles_provisional_je_id')} IS NOT NULL OR ${statementLineSql(sp)} THEN 'card_line'
    WHEN EXISTS (
      SELECT 1 FROM gl_accounts kacc
      WHERE kacc.id = ${creditedAccountIdSql(sp)}
        AND kacc.company_id = ${col(sp, 'company_id')}
        AND NOT ${moneyAccountSql('kacc')}
    ) THEN 'contra'
    ELSE 'payment'
  END)`;
}

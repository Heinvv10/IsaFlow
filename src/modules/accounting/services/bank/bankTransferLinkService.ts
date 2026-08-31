/**
 * bankTransferLinkService — retroactively link bank transactions that are
 * the opposite leg of an already-allocated JE on another bank account.
 *
 * Covers two cases:
 *   1. allocation_type = 'transfer'  (native transfer allocation)
 *   2. allocation_type = 'account'   (user picked a bank GL as the contra account)
 *
 * Called after each import and exposed as a standalone API so the UI can
 * trigger a re-link pass without re-importing.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

/**
 * For each 'imported' transaction in `bankAccountId`, find any JE that:
 *   - Has a line for this bank's GL account (i.e. the JE involves this bank)
 *   - Is already linked to another bank account's transaction via
 *     `matched_journal_line_id`
 *   - Has a matching amount (opposite sign) and date (±2 days)
 *
 * Updates matching transactions to `status = 'allocated'` with the JE link.
 * Returns the count of rows updated.
 */
export async function relinkTransferCounterparts(
  companyId: string,
  bankAccountId: string,
): Promise<number> {
  try {
    const result = (await sql`
      WITH source_allocs AS (
        -- Allocated transactions on OTHER bank accounts whose JE has a line
        -- for the current bank's GL account (bankAccountId).
        SELECT DISTINCT ON (bt_src.id)
          bt_src.id                         AS src_tx_id,
          bt_src.bank_account_id            AS src_bank_id,
          bt_src.transaction_date           AS src_date,
          bt_src.amount                     AS src_amount,
          bt_src.allocated_entity_name,
          jl_mine.id                        AS target_je_line_id
        FROM bank_transactions bt_src
        JOIN gl_journal_lines jl_src
          ON  jl_src.id = bt_src.matched_journal_line_id
        JOIN gl_journal_entries je
          ON  je.id = jl_src.journal_entry_id
          AND je.company_id = ${companyId}::UUID
        JOIN gl_journal_lines jl_mine
          ON  jl_mine.journal_entry_id = je.id
          AND jl_mine.gl_account_id    = ${bankAccountId}::UUID
        WHERE bt_src.company_id    = ${companyId}::UUID
          AND bt_src.bank_account_id != ${bankAccountId}::UUID
          AND bt_src.status          = 'allocated'
          AND bt_src.matched_journal_line_id IS NOT NULL
      ),
      best_matches AS (
        -- For each unlinked imported transaction, pick the closest source alloc
        SELECT DISTINCT ON (bt_new.id)
          bt_new.id               AS new_tx_id,
          sa.target_je_line_id,
          sa.src_bank_id          AS counterparty_bank_id,
          sa.allocated_entity_name
        FROM bank_transactions bt_new
        JOIN source_allocs sa ON (
          ABS(bt_new.amount + sa.src_amount) < 0.01
          AND bt_new.transaction_date BETWEEN
              (sa.src_date::DATE - INTERVAL '2 days')
          AND (sa.src_date::DATE + INTERVAL '2 days')
        )
        WHERE bt_new.bank_account_id = ${bankAccountId}::UUID
          AND bt_new.company_id      = ${companyId}::UUID
          AND bt_new.status          = 'imported'
        ORDER BY bt_new.id,
                 ABS(bt_new.transaction_date::DATE - sa.src_date::DATE) ASC
      )
      UPDATE bank_transactions bt
      SET status                  = 'allocated',
          allocation_type         = 'transfer',
          matched_journal_line_id = m.target_je_line_id,
          counterparty_account_id = m.counterparty_bank_id,
          allocated_entity_name   = m.allocated_entity_name,
          -- Clearing these is redundant today (the WHERE is status='imported',
          -- which a rule-posted row can never be) but keeps every writer of
          -- allocated_entity_name symmetrical: the next reuse of this UPDATE on
          -- an already-allocated row would otherwise leave a stale rule label
          -- beside a freshly rewritten account.
          allocation_rule_id = NULL, allocation_rule_name = NULL,
          updated_at              = NOW()
      FROM best_matches m
      WHERE bt.id         = m.new_tx_id
        AND bt.company_id = ${companyId}::UUID
        AND bt.status     = 'imported'
      RETURNING bt.id
    `) as Row[];

    const count = result.length;
    if (count > 0) {
      log.info('Re-linked transfer counterpart transactions', { bankAccountId, count }, 'accounting');
    }
    return count;
  } catch (err) {
    log.warn('relinkTransferCounterparts failed — non-fatal', { bankAccountId, error: err }, 'accounting');
    return 0;
  }
}

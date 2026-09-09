/**
 * bankTransferLinkService — link bank transactions that are the opposite leg
 * of an already-allocated JE on another bank account.
 *
 * Two passes live here, both invoked by `importParsedTransactions`:
 *   - `autoLinkImportedBatchTransfers` — the rows of one import batch against
 *     existing `allocation_type = 'transfer'` allocations.
 *   - `relinkTransferCounterparts` — every `imported` row on one bank account,
 *     against both 'transfer' and 'account' allocations. Also exposed as a
 *     standalone API so the UI can re-link without re-importing.
 *
 * Both obey the same invariant: **a GL movement is the counterpart of exactly
 * one bank line.** A journal line already referenced by a
 * `bank_transactions.matched_journal_line_id` is excluded outright, and at most
 * one bank line may win any single free line per pass. A runner-up is not lost
 * — the pass repeats until it links nothing, and each repeat re-evaluates the
 * runner-up against the lines still free.
 *
 * Neither pass may mark a row `allocated` without a journal line behind it:
 * that is the state this whole file exists to produce correctly.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

/**
 * Outcome of a link pass. `failed` distinguishes "nothing to link" from "the
 * pass errored": both used to return 0, so a caller (and the UI behind
 * `bank-relink-transfers`) could not tell them apart.
 */
export interface TransferLinkResult {
  linked: number;
  failed: boolean;
}

/**
 * Each repeat claims at least one journal line, so the loop converges long
 * before this. The cap only bounds a pathological plan.
 */
const MAX_LINK_PASSES = 100;

/**
 * Repeat `pass` until it links nothing, inside ONE savepoint.
 *
 * The savepoint is what makes the swallowing catch safe: both callers run
 * inside the request transaction, where an error rolled back only by the catch
 * leaves the connection aborted (25P02) and every later statement in the
 * request fails.
 */
async function runLinkPasses(
  label: string,
  savepointName: string,
  context: Record<string, unknown>,
  pass: () => Promise<Row[]>,
): Promise<TransferLinkResult> {
  try {
    return await withSavepoint(savepointName, async () => {
      let linked = 0;
      let passes = 0;
      for (;;) {
        const rows = await pass();
        if (rows.length === 0) break;
        linked += rows.length;
        passes += 1;
        if (passes >= MAX_LINK_PASSES) {
          log.warn(`${label} hit the pass cap; some counterparts may be unlinked`,
            { ...context, linked }, 'accounting');
          break;
        }
      }
      if (linked > 0) log.info(label, { ...context, linked }, 'accounting');
      return { linked, failed: false };
    });
  } catch (err) {
    log.warn(`${label} failed — non-fatal`, { ...context, error: err }, 'accounting');
    return { linked: 0, failed: true };
  }
}

/**
 * Link the `imported` rows of one import batch to the JE of an existing
 * `transfer` allocation on another bank account, matching on opposite amount
 * and date (±2 days).
 */
export async function autoLinkImportedBatchTransfers(
  companyId: string,
  batchId: string,
): Promise<TransferLinkResult> {
  return runLinkPasses(
    'Auto-linked transfer counterparts for import batch',
    'bank_import_autolink',
    { batchId },
    () => sql`
      WITH new_txs AS (
        SELECT id, amount, transaction_date, bank_account_id
        FROM bank_transactions
        WHERE company_id      = ${companyId}::UUID
          AND import_batch_id = ${batchId}::UUID
          AND status          = 'imported'
      ),
      matching AS (
        SELECT DISTINCT ON (n.id)
          n.id                         AS new_tx_id,
          et.transfer_journal_entry_id AS je_id,
          et.bank_account_id           AS counterparty_bank_id,
          jl.id                        AS je_line_id,
          et.allocated_entity_name     AS entity_name,
          ABS(et.transaction_date::DATE - n.transaction_date::DATE) AS date_distance
        FROM new_txs n
        JOIN bank_transactions et
          ON  et.company_id = ${companyId}::UUID
          AND et.bank_account_id != n.bank_account_id
          AND et.status = 'allocated'
          AND et.allocation_type = 'transfer'
          AND et.transfer_journal_entry_id IS NOT NULL
          AND ABS(et.amount + n.amount) < 0.01
          AND et.transaction_date BETWEEN (n.transaction_date::DATE - INTERVAL '2 days')
                                      AND (n.transaction_date::DATE + INTERVAL '2 days')
        -- INNER, not LEFT: a JE with no leg on this bank account is not the
        -- counterpart, and a NULL line would mark the row allocated with no GL
        -- movement behind it.
        JOIN gl_journal_lines jl
          ON  jl.journal_entry_id = et.transfer_journal_entry_id
          AND jl.gl_account_id    = n.bank_account_id
          AND jl.company_id       = ${companyId}::UUID
        WHERE NOT EXISTS (
          SELECT 1
          FROM bank_transactions bt_used
          WHERE bt_used.company_id              = ${companyId}::UUID
            AND bt_used.matched_journal_line_id = jl.id
        )
        ORDER BY n.id,
                 ABS(et.transaction_date::DATE - n.transaction_date::DATE) ASC,
                 jl.id
      ),
      winners AS (
        SELECT DISTINCT ON (je_line_id)
          new_tx_id, je_id, counterparty_bank_id, je_line_id, entity_name
        FROM matching
        ORDER BY je_line_id, date_distance ASC, new_tx_id
      )
      UPDATE bank_transactions bt
      SET status                    = 'allocated',
          allocation_type           = 'transfer',
          transfer_journal_entry_id = m.je_id,
          matched_journal_line_id   = m.je_line_id,
          counterparty_account_id   = m.counterparty_bank_id,
          allocated_entity_name     = m.entity_name,
          -- Clearing these is redundant today (the WHERE is status='imported',
          -- which a rule-posted row can never be) but keeps every writer of
          -- allocated_entity_name symmetrical.
          allocation_rule_id = NULL, allocation_rule_name = NULL,
          updated_at                = NOW()
      FROM winners m
      WHERE bt.id         = m.new_tx_id
        AND bt.company_id = ${companyId}::UUID
        AND bt.status     = 'imported'
      RETURNING bt.id
    ` as Promise<Row[]>,
  );
}

/**
 * For each 'imported' transaction in `bankAccountId`, find any JE that:
 *   - Has a line for this bank's GL account (i.e. the JE involves this bank)
 *   - Is already linked to another bank account's transaction via
 *     `matched_journal_line_id`
 *   - Has a matching amount (opposite sign) and date (±2 days)
 *
 * Covers both `allocation_type = 'transfer'` and `'account'` (the user picked a
 * bank GL as the contra account).
 */
export async function relinkTransferCounterparts(
  companyId: string,
  bankAccountId: string,
): Promise<TransferLinkResult> {
  return runLinkPasses(
    'Re-linked transfer counterpart transactions',
    'relink_transfer_counterparts',
    { bankAccountId },
    () => sql`
      WITH source_allocs AS (
        -- Allocated transactions on OTHER bank accounts whose JE has a line
        -- for the current bank's GL account (bankAccountId).
        SELECT DISTINCT ON (bt_src.id)
          bt_src.id                         AS src_tx_id,
          bt_src.bank_account_id            AS src_bank_id,
          bt_src.transaction_date           AS src_date,
          bt_src.amount                     AS src_amount,
          bt_src.allocated_entity_name,
          je.id                             AS target_je_id,
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
          -- The counterpart leg is only free if no bank line already claims it.
          AND NOT EXISTS (
            SELECT 1
            FROM bank_transactions bt_used
            WHERE bt_used.company_id              = ${companyId}::UUID
              AND bt_used.matched_journal_line_id = jl_mine.id
          )
        -- DISTINCT ON without an ORDER BY takes an arbitrary row: heap order,
        -- which moves under VACUUM or a plan change. A journal with two legs on
        -- this bank offers its lowest free line first; the repeat pass, which
        -- sees the first claimed, then offers the next.
        ORDER BY bt_src.id, jl_mine.id
      ),
      best_matches AS (
        -- For each unlinked imported transaction, pick the closest source alloc
        SELECT DISTINCT ON (bt_new.id)
          bt_new.id               AS new_tx_id,
          sa.target_je_id,
          sa.target_je_line_id,
          sa.src_bank_id          AS counterparty_bank_id,
          sa.allocated_entity_name,
          ABS(bt_new.transaction_date::DATE - sa.src_date::DATE) AS date_distance
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
                 ABS(bt_new.transaction_date::DATE - sa.src_date::DATE) ASC,
                 sa.target_je_line_id
      ),
      winners AS (
        -- One bank line per GL movement. Closest date wins; new_tx_id breaks
        -- the tie so a re-run of the same pass picks the same winner.
        SELECT DISTINCT ON (target_je_line_id)
          new_tx_id,
          target_je_id,
          target_je_line_id,
          counterparty_bank_id,
          allocated_entity_name
        FROM best_matches
        ORDER BY target_je_line_id, date_distance ASC, new_tx_id
      )
      UPDATE bank_transactions bt
      SET status                  = 'allocated',
          allocation_type         = 'transfer',
          -- Set alongside the line: the duplicate-transfer guard in
          -- bankAllocationService selects on transfer_journal_entry_id IS NOT
          -- NULL, so a relinked row left without it is invisible to the guard
          -- and a second transfer journal can be posted for the same movement.
          transfer_journal_entry_id = m.target_je_id,
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
      FROM winners m
      WHERE bt.id         = m.new_tx_id
        AND bt.company_id = ${companyId}::UUID
        AND bt.status     = 'imported'
      RETURNING bt.id
    ` as Promise<Row[]>,
  );
}

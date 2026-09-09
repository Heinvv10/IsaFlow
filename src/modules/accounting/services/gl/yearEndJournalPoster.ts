/**
 * Writing the year-end closing journal, and locking the year behind it.
 *
 * Split out of `yearEndCloseService` to stay inside the 300-line cap, for the
 * same reason `yearEndJournalBuilder` was: this is the half with the write in
 * it, and it carries the guards that stand in for the canonical posting path.
 */

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateJournalEntry } from '../../utils/doubleEntry';
import type { YearEndJournalPreview } from './yearEndCloseService';

export interface ClosingJournalResult {
  /** NULL only for a dormant year that has never been closed. */
  entry: Record<string, unknown> | null;
  /** True when this year already had a closing journal and nothing was written. */
  alreadyClosed: boolean;
}

/**
 * Post the closing journal and lock every period in the year.
 */
export async function postClosingJournal(
  companyId: string,
  userId: string,
  yearLabel: string,
  preview: YearEndJournalPreview,
  fiscalPeriodId: string | null,
): Promise<ClosingJournalResult> {
  // Balance and per-line validity are checked HERE, before the transaction
  // opens, because this path INSERTs straight at status='posted' and therefore
  // never meets the two guards every other poster does: `createJournalEntry`
  // runs `validateJournalEntry`, and `trg_gl_je_balanced` fires BEFORE UPDATE
  // only, so a row born posted never trips it.
  //
  // Until migration 627 the `source` CHECK was standing in for that guard by
  // rejecting 'year_end' outright, which is why the close could not run at all
  // (see tests/unit/services/glEntrySourceConstraint.test.ts). Admitting the
  // source without this check would un-gate an unvalidated posting path.
  // Converting to createJournalEntry/postJournalEntry is not available: the
  // close requires every period CLOSED, and postJournalEntry refuses any
  // period that is not OPEN.
  //
  // NOT included, deliberately: the inactive-account refusal that
  // `postJournalEntry` applies via `assertNoInactiveAccountLines`. Closing a
  // withdrawn account is precisely how its balance gets zeroed; refusing would
  // strand the tenant, because the account cannot be cleared without the close
  // and cannot be closed without being reactivated first — every year, forever.
  // The equity side is not exempt and does not need to be: the system-account
  // resolver only caches accounts with `is_active = true`, so an inactive
  // retained-earnings account surfaces as `no_retained_earnings` before this
  // point.
  //
  // A DORMANT YEAR has no lines at all — nothing was posted to any P&L account
  // — and there is no such thing as a legal empty journal. Closing it is still
  // a real and necessary act: the periods lock, and without that a company
  // that traded not at all could never close the year and would carry it open
  // forever. So lock and write nothing, rather than manufacture a journal or
  // refuse.
  if (preview.lines.length === 0) {
    // Two different situations reach here and they must not be reported the
    // same way. A year that was ALREADY closed also nets to zero — its own
    // closing journal is what flattened the P&L — so without this lookup a
    // re-run would answer "closed, nothing to do" and quietly hide that the
    // real close happened earlier. Return the existing journal instead.
    // (This is not a fix for K-113, which is the missing already-closed guard
    // on the whole close; it only stops the dormant path from masking it.)
    const existing = (await sql`
      SELECT * FROM gl_journal_entries
      WHERE company_id = ${companyId} AND source = 'year_end'
        AND entry_number = ${preview.entryNumber}
      LIMIT 1
    `) as Record<string, unknown>[];
    if (existing.length > 0) {
      log.info('Year-end close re-run: the year already has its closing journal',
        { companyId, year: yearLabel, entryId: existing[0]!.id }, 'yearEnd');
      return { entry: existing[0]!, alreadyClosed: true };
    }

    await withTransaction(async (tx) => {
      await tx`
        UPDATE fiscal_periods SET status = 'locked'
        WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
      `;
    });
    log.info('Year-end closed with no journal: no posted profit or loss in the year',
      { companyId, year: yearLabel }, 'yearEnd');
    return { entry: null, alreadyClosed: false };
  }

  const validation = validateJournalEntry(preview.lines.map((l) => ({
    glAccountId: l.accountId, debit: l.debit, credit: l.credit,
  })));
  if (!validation.valid) {
    throw new Error(`Year-end closing journal is invalid: ${validation.errors.join('; ')}`);
  }

  // Atomic: a partial year-end close is unrecoverable — half the P&L zeroed and
  // the periods left open.
  return withTransaction(async (tx) => {
    // NO total_debit / total_credit. Those columns do not exist on
    // gl_journal_entries — not in isaflow_dev, not in production — so this
    // INSERT raised 42703 and EVERY live year-end close failed before writing a
    // line, over MCP and through the UI route alike. Brightsphere's four
    // unclosed years are that, not an oversight by whoever runs the close. The
    // totals live on the lines and every reader derives them (see
    // transactionLedgerService, sageMigrationCompareService); the preview still
    // reports them to the caller, which is where they were actually wanted.
    const closingRows = await tx`
      INSERT INTO gl_journal_entries (
        id, company_id, entry_number, entry_date, fiscal_period_id, description,
        source, status, created_by, created_at, posted_by, posted_at, posting_agent
      ) VALUES (
        gen_random_uuid(), ${companyId}, ${preview.entryNumber}, ${preview.entryDate},
        ${fiscalPeriodId}, ${preview.description}, 'year_end', 'posted',
        ${userId}, NOW(), ${userId}, NOW(), 'system:year-end-close'
      ) RETURNING *
    `;
    const entry = (closingRows as Record<string, unknown>[])[0];
    if (!entry) throw new Error('Failed to create closing journal entry');

    for (const line of preview.lines) {
      await tx`
        INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at, company_id)
        VALUES (gen_random_uuid(), ${entry.id}, ${line.accountId}, ${line.debit}, ${line.credit},
                'Year-end close', NOW(), ${companyId}::UUID)
      `;
    }

    await tx`
      UPDATE fiscal_periods SET status = 'locked'
      WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
    `;

    return { entry, alreadyClosed: false };
  });
}

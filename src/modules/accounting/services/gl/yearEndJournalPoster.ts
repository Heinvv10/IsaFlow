/**
 * Writing the year-end closing journal, and locking the year behind it.
 *
 * Split out of `yearEndCloseService` to stay inside the 300-line cap, for the
 * same reason `yearEndJournalBuilder` was: this is the half with the write in
 * it, and it carries the guards that stand in for the canonical posting path.
 */

import { sql, withTransaction, type TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { roundToCents, validateJournalEntry } from '../../utils/doubleEntry';
import { reloadNetIncome, type FiscalYearRange } from './yearEndJournalBuilder';
import type { CloseYearError, CloseYearResult, YearEndJournalPreview } from './yearEndCloseTypes';

/** The two refusals a row holding the closing entry number can earn. */
export type ClosingNumberRefusal =
  Extract<CloseYearError, { error: 'closing_entry_number_taken' | 'closing_journal_not_posted' }>;

export interface ClosingJournalResult {
  /** NULL only for a dormant year: nothing to transfer, so nothing to write. */
  entry: Record<string, unknown> | null;
  /** Periods this call actually locked, COUNTED from the UPDATE, not asserted. */
  periodsLocked: number;
}

/**
 * WHATEVER row holds the year's closing entry number — any status, any source.
 *
 * Neither column is filtered on, because this lookup exists to stand in for
 * `uq_gl_je_company_entry_number`, and that index is unique on
 * (company_id, entry_number) with NO predicate on status and none on source
 * (confirmed against the schema). Anything narrower is blind to a row the
 * index will still reject, and blindness here is not a missing warning — it is
 * the raw 23505 → HTTP 500 this refusal was written to remove.
 *
 * The three states the caller has to tell apart:
 *
 * A POSTED `year_end` header means the year is closed: report it, write nothing.
 *
 * A REVERSED or DRAFT `year_end` header does NOT mean the year is closed — the
 * lines have been undone, the P&L is back where it was — but it does mean the
 * year cannot be closed again as things stand, because that row holds the fixed
 * `YE-<year>` number. Reporting it as `alreadyClosed` would be a lie AND would
 * leave the year locked out for good, since that path writes nothing.
 *
 * A header of ANY OTHER source carrying `YE-<year>` — a manual journal a user
 * numbered that way, an import — is a squatter. It says nothing about whether
 * the year is closed, and it blocks the INSERT just as hard.
 *
 * Read by the close BEFORE the dry-run return, so the preview a person reads
 * says the year is closed rather than showing the empty journal a dormant year
 * shows (K-113).
 */
export async function findClosingJournal(
  companyId: string,
  entryNumber: string,
): Promise<Record<string, unknown> | null> {
  const rows = (await sql`
    SELECT * FROM gl_journal_entries
    WHERE company_id = ${companyId} AND entry_number = ${entryNumber}
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows[0] ?? null;
}

/**
 * What a row holding `YE-<year>` means — a refusal, or NULL when it is the
 * year's own posted closing journal and the year is simply closed.
 *
 * Shared by the pre-INSERT lookup and by the 23505 catch below. A squatter that
 * takes the number BETWEEN those two differs from one that was already sitting
 * there only in timing, and answering the second with a rethrown 23505 → HTTP
 * 500 is exactly the opacity the typed refusal was written to remove.
 */
export function classifyClosingJournal(
  entryNumber: string,
  row: Record<string, unknown>,
): ClosingNumberRefusal | null {
  if (String(row.source) !== 'year_end') {
    return {
      error: 'closing_entry_number_taken',
      entryNumber,
      entryId: String(row.id),
      source: String(row.source),
      status: String(row.status),
    };
  }
  if (row.status !== 'posted') {
    return {
      error: 'closing_journal_not_posted',
      entryNumber,
      entryId: String(row.id),
      status: String(row.status),
    };
  }
  return null;
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
  //
  // A year that was already closed reaches the caller's already-closed branch
  // before this function is called at all, so an empty preview here means
  // dormant and nothing else.
  if (preview.lines.length === 0) {
    const locked = await withTransaction(async (tx) => lockYear(tx, companyId, yearLabel));
    log.info('Year-end closed with no journal: no posted profit or loss in the year',
      { companyId, year: yearLabel, periodsLocked: locked }, 'yearEnd');
    return { entry: null, periodsLocked: locked };
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

    return { entry, periodsLocked: await lockYear(tx, companyId, yearLabel) };
  });
}

/**
 * Lock every period in the year and report HOW MANY were locked.
 *
 * The count is read back from the UPDATE rather than assumed, because
 * `periodsLocked: true` was an assertion about a statement nobody had looked
 * at: a year whose periods had already been locked, or moved out from under the
 * label, produced the same `true` as a year that locked twelve.
 */
async function lockYear(tx: TxSql, companyId: string, yearLabel: string): Promise<number> {
  const locked = await tx`
    UPDATE fiscal_periods SET status = 'locked'
    WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
    RETURNING id
  `;
  return locked.length;
}

/** True for a duplicate-key violation on the closing entry number, and nothing else. */
export function isClosingNumberConflict(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e?.constraint === 'uq_gl_je_company_entry_number';
}

/**
 * The answer for a year that already carries its posted closing journal.
 *
 * The residual is the point. A closed year's aggregates read flat because its
 * own closing journal flattened them, so a NON-zero `netIncome` here is P&L
 * that landed in the year AFTER the close — outside the closing journal and
 * outside retained earnings, and unreachable by this service for good, because
 * the entry number is taken. Saying only "already closed" is how that stays
 * invisible.
 *
 * The residual is RE-READ here rather than taken from the `netIncome` the close
 * computed on the way in, because that read may predate the closing journal —
 * a caller that lost the race, or a re-run that raced one, read the P&L before
 * the winner wrote, and its non-zero netIncome is the very movement the winner
 * has just swept into equity. `netIncome` still reports what THIS call read.
 */
export async function alreadyClosedResult(
  companyId: string,
  yearLabel: string,
  existingEntry: Record<string, unknown>,
  yearRange: FiscalYearRange,
): Promise<CloseYearResult> {
  const lockedRows = (await sql`
    SELECT count(*)::int AS n FROM fiscal_periods
    WHERE company_id = ${companyId} AND fiscal_year = ${yearLabel} AND status = 'locked'
  `) as Array<{ n: number }>;
  const unclosedNetIncome = roundToCents(
    await reloadNetIncome(companyId, yearRange.start_date, yearRange.end_date));
  log.info('Year-end close re-run: the year already has its closing journal',
    { companyId, year: yearLabel, entryId: existingEntry.id, unclosedNetIncome, module: 'accounting' });
  const entryNumber = String(existingEntry.entry_number ?? '');
  return {
    closingEntry: existingEntry,
    periodsLockedInYear: lockedRows[0]?.n ?? 0,
    alreadyClosed: true,
    // Read HERE, after the closing journal is known to exist — the same re-read
    // `unclosedNetIncome` uses, and for the same reason. The caller's figure was
    // taken before the lookup, so a close that committed in between left it
    // holding the winner's own movement: `net_income: 620` beside
    // `already_closed: true` on a year with nothing stranded, which reads as a
    // hole in the books. A closed year's aggregates are flat, so on the ordinary
    // path this is 0, and where it is not, it is the residual.
    netIncome: unclosedNetIncome,
    unclosedNetIncome,
    message: `Year ${yearLabel} was already closed. Its closing journal ${entryNumber} is `
      + 'unchanged and nothing was posted.'
      + (unclosedNetIncome !== 0
        ? ` WARNING: R${unclosedNetIncome.toFixed(2)} of profit or loss has been posted into `
          + `this year SINCE it was closed, and it is NOT in ${entryNumber} and NOT in retained `
          + 'earnings. This close cannot sweep it up — the entry number is taken. Reverse those '
          + 'journals into an open year, or post the residual to equity by hand.'
        : ''),
  };
}

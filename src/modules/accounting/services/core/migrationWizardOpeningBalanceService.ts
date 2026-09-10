/**
 * Migration Wizard — Opening Balances
 *
 * Split out of migrationImportService.ts, which was pushed over the 300-line
 * cap by the take-on work. The seam is a real one: this posts a single trial
 * balance, the AR/AP steps post one entry per document, and the only thing they
 * share is the R-020 interlock in migrationPostingSupport.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { updateSession, type MigrationError } from './migrationService';
import { lockMigrationImport } from './migrationPostingSupport';
import type { DbRow } from '@/types/db';

export interface OpeningBalanceRow {
  accountCode: string;
  debit: number;
  credit: number;
}

/** The description every opening-balance entry carries; also how a re-run finds its own. */
const OPENING_BALANCE_DESCRIPTION = 'Opening balances — migration import';

/**
 * Reverse the entry a previous run of this step posted for this session.
 *
 * Without this the step was a one-way door. `assertNoOpeningControlTotal`
 * refuses the document steps once a control total is in the trial balance and
 * tells the operator to remove it and re-run — but the flags were only ever
 * written `true` and never cleared, and a second run posted a SECOND full trial
 * balance on top of the first. The instruction the product prints has to be one
 * the product can carry out.
 *
 * Scoped to the session by `created_at >= started_at`, the same way
 * recordClearingResidual scopes its residual, so a company running the wizard a
 * second time never reverses the first run's take-on.
 */
async function reversePriorOpeningBalances(
  companyId: string,
  sessionId: string,
  userId: string,
): Promise<void> {
  const rows = (await sql`
    SELECT e.id
    FROM gl_journal_entries e
    JOIN migration_sessions s
      ON s.id = ${sessionId}::UUID AND s.company_id = ${companyId}::UUID
    WHERE e.company_id = ${companyId}::UUID
      AND e.source = 'auto_migration'
      AND e.description = ${OPENING_BALANCE_DESCRIPTION}
      AND e.status = 'posted'
      AND e.reversed_at IS NULL
      AND e.created_at >= s.started_at
    ORDER BY e.created_at
  `) as DbRow[];
  for (const row of rows) {
    const id = String(row.id);
    log.info('Reversing a previous opening-balance entry before re-importing', {
      companyId, sessionId, journalEntryId: id,
    }, 'migration');
    await reverseJournalEntry(companyId, id, userId);
  }
}

export async function importOpeningBalances(
  companyId: string,
  sessionId: string,
  effectiveDate: string,
  balances: OpeningBalanceRow[],
  userId: string,
): Promise<{ journalEntryId: string; errors: MigrationError[] }> {
  const errors: MigrationError[] = [];

  // R-020 is a rule about DOUBLE counting, not about control accounts. A trial
  // balance may bring the AR or AP control total in INSTEAD of the documents —
  // a summary-only take-on. It may not do both. So: refuse the control line once
  // the matching side has actually taken documents on, otherwise accept it and
  // record it on the session, where the document step reads it and refuses.
  //
  // The interlock is a read-then-write on the same session row the document
  // steps read and write, so it needs the same lock they take — otherwise an
  // opening-balances request carrying a control line and a document request
  // overlap, each reads a session without the other's mark, both pass, and both
  // post. Transaction-scoped and re-entrant; `withAuth` gives the request one
  // transaction, so the window without it is the whole request.
  await lockMigrationImport(companyId);

  const sessRows = (await sql`
    SELECT ar_invoices_imported, ap_invoices_imported
    FROM migration_sessions
    WHERE id = ${sessionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  // Gate on documents actually TAKEN ON, not on "the step ran". The step flag is
  // written even by a run that imported nothing (every supplier unmatched, say),
  // and gating on it permanently barred an operator whose first file failed from
  // ever bringing the control total in — with nothing imported there is nothing
  // to double count.
  const documentsTakenOn: Record<string, boolean> = {
    ar_invoices: Number(sessRows[0]?.ar_invoices_imported ?? 0) > 0,
    ap_invoices: Number(sessRows[0]?.ap_invoices_imported ?? 0) > 0,
  };
  // Recomputed from THIS run's trial balance, both sides, every time — including
  // `false`. Writing only the `true` side left a flag no run could ever clear,
  // and `assertNoOpeningControlTotal` reads it as a permanent refusal.
  const controlTotals: Record<string, boolean> = {
    opening_balances_ar_control: false,
    opening_balances_ap_control: false,
  };

  const totalDebit  = balances.reduce((s, b) => s + (b.debit ?? 0), 0);
  const totalCredit = balances.reduce((s, b) => s + (b.credit ?? 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(
      `Trial balance is not balanced: debits ${totalDebit.toFixed(2)} ≠ credits ${totalCredit.toFixed(2)}`
    );
  }

  const lines = [];
  for (let i = 0; i < balances.length; i++) {
    const bal = balances[i]!;
    if (bal.debit === 0 && bal.credit === 0) continue;

    const acctRows = (await sql`
      SELECT id, account_subtype FROM gl_accounts
      WHERE account_code = ${bal.accountCode} AND company_id = ${companyId}::UUID
    `) as DbRow[];

    if (acctRows.length === 0) {
      errors.push({ step: 'opening_balances', row: i, field: 'accountCode', message: `Account ${bal.accountCode} not found` });
      continue;
    }

    const subtype = String(acctRows[0]!.account_subtype ?? '');
    if (subtype === 'receivable' || subtype === 'payable') {
      const documentStep = subtype === 'receivable' ? 'ar_invoices' : 'ap_invoices';
      if (documentsTakenOn[documentStep]) {
        throw new Error(
          `Opening trial balance carries ${bal.accountCode}, a ${subtype} control account, and the ${subtype === 'receivable' ? 'customer' : 'supplier'} invoice step has already taken those documents on, one line per outstanding document. Importing the control total as well posts the same money a second time. Remove the control account rows from the trial balance.`,
        );
      }
      controlTotals[documentStep === 'ar_invoices' ? 'opening_balances_ar_control' : 'opening_balances_ap_control'] = true;
    }

    lines.push({
      glAccountId: String(acctRows[0]!.id),
      debit: bal.debit ?? 0,
      credit: bal.credit ?? 0,
      description: `Opening balance — ${bal.accountCode}`,
    });
  }

  if (lines.length === 0) {
    throw new Error('No valid balance rows to import');
  }

  // After the trial balance is known good, before anything new is posted: a
  // re-run REPLACES the previous opening balances rather than adding to them.
  await reversePriorOpeningBalances(companyId, sessionId, userId);

  const entry = await createJournalEntry(companyId, {
    entryDate: effectiveDate,
    description: OPENING_BALANCE_DESCRIPTION,
    source: 'auto_migration',
    lines,
  }, userId);

  await postJournalEntry(companyId, entry.id, userId);

  await updateSession(sessionId, companyId, {
    openingBalancesSet: true,
    stepsCompleted: { opening_balances: true, ...controlTotals },
    errors,
  });

  log.info('Opening balances imported', { companyId, journalEntryId: entry.id, lines: lines.length }, 'migration');
  return { journalEntryId: entry.id, errors };
}

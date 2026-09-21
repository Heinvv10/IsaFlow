/**
 * PRD-060 Phase 6: Sage Data Importers
 * Ledger transaction → GL journal entries
 *
 * Supplier invoices are in sageSupplierInvoiceImportService.ts and re-exported
 * from here: every caller — sageMigrationService, core/index.ts and the tests —
 * has imported both from this module.
 *
 * BL-40: Every SELECT/JOIN/INSERT/UPDATE is now scoped by company_id to
 * prevent cross-tenant data leaks and silent INSERT failures caused by
 * missing NOT NULL company_id columns.
 */

import { sql, transaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { roundToCents } from '@/modules/accounting/utils/doubleEntry';
import { decideLedgerRelink } from './sageLedgerRelinkGuard';
import type { MigrationRun } from './sageMigrationService';
import { startRun, completeRun, failRun } from './sageMigrationService';
import type { DbRow } from '@/types/db';

export { importSupplierInvoices } from './sageSupplierInvoiceImportService';


// ── Ledger Transaction Import ───────────────────────────────────────────────

/**
 * Import sage_ledger_transactions as GL journal entries.
 * Groups by document_number + transaction_date into balanced entries.
 *
 * ⚠️ THIS FUNCTION CANNOT CURRENTLY RUN. The query below selects
 * `slt.document_number`, `slt.sage_account_id` and `slt.ff_project_id`, and
 * joins `sage_accounts` on `sa.sage_account_id` — none of those columns exist.
 * The live table is (id, sage_id, account_code, transaction_date, description,
 * debit, credit, reference, gl_journal_entry_id, migration_status, imported_at,
 * company_id), so the first statement throws 42703 and the run fails. Verified
 * against production: 0 rows in sage_ledger_transactions, 0 journals with
 * posting_agent='import:sage', and nothing in the repo INSERTs into that table.
 * The whole Sage ledger import is orphaned code pending a schema reconciliation.
 *
 * The validation below (exact balance, >= 2 non-zero lines, idempotent relink,
 * posting through createJournalEntry) is therefore correct-but-unreached. It is
 * kept rather than deleted because the schema repair is a separate decision, and
 * shipping the repair onto the old unvalidated INSERT would reintroduce a path
 * that can post unbalanced straight to status='posted'.
 *
 * KNOWN GAP if this is ever revived: the idempotency guard is a bare SELECT with
 * no lock and no unique index behind it, so two concurrent runs can both miss
 * and both post. Fix that with a partial unique index on
 * (company_id, reference, entry_date) WHERE posting_agent = 'import:sage'
 * AND reversed_at IS NULL, or take pg_advisory_xact_lock on the company at the
 * top of the run. Not added now: an index guarding unreachable code is cost
 * without benefit, and the correct shape depends on the reconciled schema.
 */
export async function importLedgerTransactions(companyId: string, userId: string): Promise<MigrationRun> {
  const runId = await startRun('ledger_import', userId, companyId);

  try {
    // BL-40: Added AND slt.company_id + AND sa.company_id to prevent cross-tenant SELECT
    const allLines = (await sql`
      SELECT slt.id, slt.document_number, slt.transaction_date, slt.description,
        slt.debit, slt.credit, slt.reference, slt.ff_project_id,
        sa.gl_account_id
      FROM sage_ledger_transactions slt
      JOIN sage_accounts sa
        ON sa.sage_account_id = slt.sage_account_id
        AND sa.company_id = ${companyId}::UUID
      WHERE slt.migration_status = 'pending'
        AND slt.company_id = ${companyId}::UUID
        AND sa.gl_account_id IS NOT NULL
      ORDER BY slt.transaction_date, slt.document_number
    `) as DbRow[];

    // Group lines in JavaScript rather than with a separate query per group
    const groupMap = new Map<string, { document_number: string; transaction_date: unknown; description: string; lines: DbRow[] }>();
    for (const line of allLines) {
      const key = `${line.document_number}::${String(line.transaction_date)}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          document_number: String(line.document_number),
          transaction_date: line.transaction_date,
          description: String(line.description ?? ''),
          lines: [],
        });
      }
      groupMap.get(key)!.lines.push(line);
    }

    const groups = Array.from(groupMap.values());
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    /** Mark every line of a group failed, scoped by company_id (BL-40). */
    const markGroupFailed = async (groupLines: DbRow[]) => {
      await transaction((txSql) =>
        groupLines.map(line => txSql`
          UPDATE sage_ledger_transactions
          SET migration_status = 'failed'
          WHERE id = ${line.id}
            AND company_id = ${companyId}::UUID
        `)
      );
    };

    for (const group of groups) {
      // Tracks whether this group's journal actually reached the ledger, so the
      // catch below knows whether marking the rows 'failed' is safe.
      let posted = false;
      try {
        const lines = group.lines;
        if (lines.length === 0) { skipped++; continue; }

        // Zero-value rows cannot be journal lines (validateJournalLine rejects a
        // line with neither debit nor credit) and contribute nothing to the
        // balance, so drop them here rather than after the header exists.
        const activeLines = lines.filter(
          l => Number(l.debit || 0) !== 0 || Number(l.credit || 0) !== 0,
        );

        // A group whose rows are ALL zero used to pass the balance gate (0 - 0),
        // get its header INSERTed at status='posted', and then write no lines at
        // all. (An earlier version of this comment attributed 34 zero-line
        // 'manual' headers in production to this path — that was wrong; those
        // are legacy loanPaymentService entries. This path has never run.)
        if (activeLines.length < 2) {
          log.warn('Sage ledger group has fewer than two non-zero lines — cannot form a journal', {
            docNum: group.document_number, companyId, lineCount: activeLines.length,
          }, 'accounting');
          await markGroupFailed(lines);
          failed++;
          continue;
        }

        const totalDebit = roundToCents(activeLines.reduce((t, l) => t + Number(l.debit || 0), 0));
        const totalCredit = roundToCents(activeLines.reduce((t, l) => t + Number(l.credit || 0), 0));

        // EXACT, not the old `> 0.02` tolerance. That tolerance let a group of
        // Dr 100.00 / Cr 100.02 through into a header INSERTed directly at
        // status='posted' — and trg_gl_je_balanced is BEFORE UPDATE, so nothing
        // downstream ever checked it. Two cents per document is not a rounding
        // artefact to absorb; it is a source-data problem to report.
        if (totalDebit !== totalCredit) {
          log.warn('Sage ledger group does not balance', {
            docNum: group.document_number, companyId, totalDebit, totalCredit,
          }, 'accounting');
          await markGroupFailed(lines);
          failed++;
          continue;
        }

        // SAGE-<doc> lives in `reference`, not entry_number. entry_number is
        // UNIQUE per company and entryRef keyed on document_number ALONE, so two
        // legitimate groups sharing a document number across different dates
        // collided on 23505 and were recorded as failures.
        //
        // Losing that unique index means idempotency is NOT free — an earlier
        // revision claimed migration_status='pending' was sufficient, which is
        // false, because resetMigration puts every row back to 'pending' without
        // reversing the journals. The explicit guard below replaces it.
        const entryRef = group.document_number
          ? `SAGE-${group.document_number}`
          : `SAGE-${String(group.transaction_date)}`;
        const entryDate = fmtDate(group.transaction_date);

        // Explicit idempotency guard, keyed on the group's real identity
        // (reference + date). This used to be implicit: entry_number was
        // `SAGE-<doc>` under uq_gl_je_company_entry_number, so a re-import hit
        // 23505 and was counted failed. Moving the tag to `reference` removed
        // that, and `migration_status = 'pending'` alone does NOT replace it —
        // resetMigration (sageMigrationCompareService.ts:80) sets every row back
        // to 'pending' and NULLs gl_journal_entry_id WITHOUT reversing the
        // journals it created. So import → reset → import posted the entire
        // ledger twice, both sets balanced, nothing to catch it. Two concurrent
        // imports had the same effect under READ COMMITTED. The decision itself
        // lives in sageLedgerRelinkGuard.ts.
        const decision = await decideLedgerRelink(companyId, entryRef, entryDate, activeLines);

        if (decision.kind === 'mismatch') {
          log.error('Sage group matches an existing journal by reference+date but not by content — refusing to relink', {
            docNum: group.document_number, companyId, entryId: decision.entryId,
            groupLines: activeLines.length, groupDebit: totalDebit,
            journalLines: decision.journalLines,
          }, 'accounting');
          await markGroupFailed(lines);
          failed++;
          continue;
        }

        if (decision.kind === 'relink') {
          log.info('Sage ledger group already imported — relinking instead of re-posting', {
            docNum: group.document_number, companyId, entryId: decision.entryId,
          }, 'accounting');
          const existingId = decision.entryId;
          await transaction((txSql) =>
            lines.map(line => txSql`
              UPDATE sage_ledger_transactions
              SET migration_status = 'imported', gl_journal_entry_id = ${existingId}::UUID
              WHERE id = ${line.id}
                AND company_id = ${companyId}::UUID
            `)
          );
          skipped++;
          continue;
        }

        const entry = await createJournalEntry(companyId, {
          entryDate,
          description: group.description || `Sage import: ${entryRef}`,
          source: 'manual',
          reference: entryRef,
          lines: activeLines.map(line => ({
            glAccountId: String(line.gl_account_id),
            debit: Number(line.debit || 0),
            credit: Number(line.credit || 0),
            description: String(line.description || group.description || ''),
            ...(line.ff_project_id ? { projectId: String(line.ff_project_id) } : {}),
          })),
        }, userId, { postingAgent: 'import:sage' });

        await postJournalEntry(companyId, entry.id, userId);
        posted = true;

        // Every row of the group is moved off 'pending' — including the
        // zero-value ones excluded from the journal, which would otherwise be
        // re-selected by every subsequent run.
        await transaction((txSql) =>
          lines.map(line => txSql`
            UPDATE sage_ledger_transactions
            SET migration_status = 'imported', gl_journal_entry_id = ${entry.id}::UUID
            WHERE id = ${line.id}
              AND company_id = ${companyId}::UUID
          `)
        );

        succeeded++;
      } catch (err) {
        log.error('Failed to import ledger group', { docNum: group.document_number, error: err }, 'accounting');
        // Only mark the rows failed when NOTHING was posted.
        //
        // Left pending, a group that can never succeed (e.g. Sage stores the
        // contra as debit AND credit on one row, which validateJournalLine
        // rejects) is silently re-attempted by every future run while the report
        // says "failed" — hence marking failed in the normal case.
        //
        // But if postJournalEntry already succeeded and the status batch threw
        // (that batch is savepointed via sql.transaction, so the journal
        // survives), marking failed is WORSE than leaving them: the driving
        // query selects only migration_status = 'pending', so 'failed' rows are
        // never re-selected and the idempotency guard above can never reach them
        // — stranding a posted journal behind rows that will never be relinked,
        // recoverable only by resetting the whole company. Leave them pending so
        // the next run finds the existing journal and relinks.
        if (posted) {
          log.error('Sage group posted but could not be linked — rows left pending for relink', {
            docNum: group.document_number, companyId,
          }, 'accounting');
        } else {
          try {
            await markGroupFailed(group.lines);
          } catch (markErr) {
            log.error('Could not mark Sage ledger group failed', {
              docNum: group.document_number, error: markErr,
            }, 'accounting');
          }
        }
        failed++;
      }
    }

    return await completeRun(runId, groups.length, succeeded, failed, skipped);
  } catch (err) {
    await failRun(runId, err);
    throw err;
  }
}

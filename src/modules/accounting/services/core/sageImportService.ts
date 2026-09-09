/**
 * PRD-060 Phase 6: Sage Data Importers
 * Ledger transaction → GL journal entries
 * Supplier invoices → AP supplier_invoices
 *
 * BL-40: Every SELECT/JOIN/INSERT/UPDATE is now scoped by company_id to
 * prevent cross-tenant data leaks and silent INSERT failures caused by
 * missing NOT NULL company_id columns.
 */

import { sql, transaction, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { roundToCents } from '@/modules/accounting/utils/doubleEntry';
import type { MigrationRun } from './sageMigrationService';
import { startRun, completeRun, failRun } from './sageMigrationService';
import type { DbRow } from '@/types/db';
import { computeFingerprint, insertNamingDuplicate, isDuplicateFingerprintViolation } from '../capture/captureDeduplicationService';


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
        // imports had the same effect under READ COMMITTED.
        //
        // Keyed on (reference, entry_date) rather than reference alone, which is
        // what the old entry_number scheme got wrong: it collided for the same
        // document number on two different dates and failed a legitimate group.
        const existing = (await sql`
          SELECT id FROM gl_journal_entries
          WHERE company_id = ${companyId}::UUID
            AND reference = ${entryRef}
            AND entry_date = ${entryDate}::DATE
            AND posting_agent = 'import:sage'
            AND status = 'posted'
            AND reversed_at IS NULL
          LIMIT 1
        `) as DbRow[];

        if (existing[0]) {
          const existingId = String(existing[0].id);

          // Relink only if the existing journal actually represents THIS group.
          // The key is (reference, entry_date), which does not prove the
          // contents match: if Sage re-syncs a correcting line onto the same
          // document and date and the operator resets, the group now has more
          // lines than the journal. Relinking blind would mark the new line
          // 'imported' against a journal that does not contain its amount —
          // the row claims to be in the GL and is not, with nothing to show it.
          // Compare the journal's LINES, not its totals. (An earlier revision
          // compared count + SUM(debit) + SUM(credit) and claimed the credit
          // conjunct caught a side flip. It was arithmetically incapable of it —
          // see below — and its test asserted `skipped + failed === 1`, which
          // holds whether the guard refuses or relinks.)
          //
          // Totals cannot detect a side flip. The balance check above guarantees
          // totalDebit === totalCredit for the group, and `status = 'posted'`
          // guarantees the same for the journal (enforce_balanced_entry is a
          // BEFORE UPDATE trigger on the draft→posted flip), so
          // `existing.total_debit === totalDebit` implies
          // `existing.total_credit === totalCredit` — a second totals conjunct
          // is arithmetically incapable of adding information. An earlier
          // revision added exactly that redundant check and credited it with
          // catching the flip; it could not.
          //
          // A per-line multiset of (account, debit, credit) does catch it:
          // Cr A 100 / Dr B 100 and Dr A 100 / Cr B 100 have identical counts
          // and identical totals but different lines.
          const existingLines = (await sql`
            SELECT gl_account_id, debit, credit
            FROM gl_journal_lines
            WHERE journal_entry_id = ${existingId}::UUID
              AND company_id = ${companyId}::UUID
          `) as DbRow[];

          const fingerprint = (rows: Array<{ acct: string; dr: number; cr: number }>) =>
            rows
              .map(r => `${r.acct}|${roundToCents(r.dr).toFixed(2)}|${roundToCents(r.cr).toFixed(2)}`)
              .sort()
              .join(';');

          const sameShape = fingerprint(
            existingLines.map(l => ({
              acct: String(l.gl_account_id),
              dr: Number(l.debit || 0),
              cr: Number(l.credit || 0),
            })),
          ) === fingerprint(
            activeLines.map(l => ({
              acct: String(l.gl_account_id),
              dr: Number(l.debit || 0),
              cr: Number(l.credit || 0),
            })),
          );

          if (!sameShape) {
            log.error('Sage group matches an existing journal by reference+date but not by content — refusing to relink', {
              docNum: group.document_number, companyId, entryId: existingId,
              groupLines: activeLines.length, groupDebit: totalDebit,
              journalLines: existingLines.length,
            }, 'accounting');
            await markGroupFailed(lines);
            failed++;
            continue;
          }

          log.info('Sage ledger group already imported — relinking instead of re-posting', {
            docNum: group.document_number, companyId, entryId: existingId,
          }, 'accounting');
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

// ── Supplier Invoice Import ─────────────────────────────────────────────────

/**
 * Import sage_supplier_invoices into the supplier_invoices table.
 * Matches Sage's approach: invoices are standalone AP documents,
 * no separate GL journal entries are created per invoice.
 */
export async function importSupplierInvoices(companyId: string, userId: string): Promise<MigrationRun> {
  const runId = await startRun('invoice_import', userId, companyId);

  try {
    // BL-40: Added AND company_id to prevent cross-tenant SELECT
    const sageInvoices = (await sql`
      SELECT id, sage_invoice_id, sage_supplier_id, invoice_number,
        invoice_date, due_date, subtotal, tax_amount, total_amount,
        outstanding_amount, status, ff_purchase_order_id, supplier_id,
        raw_data, line_items
      FROM sage_supplier_invoices
      WHERE migration_status = 'pending'
        AND company_id = ${companyId}::UUID
      ORDER BY invoice_date
    `) as DbRow[];

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const inv of sageInvoices) {
      // Set inside the savepoint and read in the catch, which has to find the
      // invoice a duplicate collided with; recomputing the fingerprint there
      // would mean re-reading the supplier's VAT number.
      let recordFingerprint: string | null = null;
      try {
        const totalAmount = Number(inv.total_amount || 0);
        if (totalAmount === 0) { skipped++; continue; }

        // Every statement for this record runs inside its own savepoint. The
        // unique index migration 625 adds makes a 23505 reachable here for the
        // first time, and without a savepoint that aborts the request
        // transaction — so the `migration_status = 'failed'` marker in the catch
        // below would raise 25P02, escape to failRun(), and roll back every
        // invoice the run had already imported.
        const outcome = await withSavepoint('sage_supplier_invoice_record', async (): Promise<'imported' | 'no_supplier'> => {

          // NOTE: purchase_orders table is not available in standalone accounting app.
          // Supplier ID must come from the Sage import data directly; PO lookup is stubbed.
          const supplierId = inv.supplier_id;

          if (!supplierId) return 'no_supplier';

          const subtotal = Number(inv.subtotal || 0) || totalAmount / 1.15;
          const taxAmount = Number(inv.tax_amount || 0) || totalAmount - subtotal;
          const taxRate = subtotal > 0
            ? Math.round((taxAmount / subtotal) * 100 * 100) / 100
            : 15;

          // project_id cannot be resolved from purchase_orders in standalone mode
          const projectId: string | null = null;

          const isPaid = inv.status === 'paid' || Number(inv.outstanding_amount || 0) === 0;

          // Extract reference from raw_data if available
          const rawObj = parseJson(inv.raw_data);
          const reference = rawObj?.Reference || null;

          // Fingerprint for duplicate detection (PRD-05)
          const [supVatRow] = (await sql`
            SELECT vat_number FROM suppliers
            WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
          `) as DbRow[];
          const invNumber = inv.invoice_number || `SAGE-${inv.sage_invoice_id}`;
          const dupFingerprint = computeFingerprint(
            supVatRow?.vat_number ?? null,
            invNumber,
            totalAmount,
          );
          recordFingerprint = dupFingerprint;

          // BL-40: Added company_id to INSERT — was missing, causing NOT NULL violation
          const newInv = (await insertNamingDuplicate(invNumber, async () => (await sql`
            INSERT INTO supplier_invoices (
              company_id, invoice_number, supplier_id, purchase_order_id, project_id,
              invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
              amount_paid, status, sage_invoice_id, reference, created_by,
              duplicate_fingerprint
            ) VALUES (
              ${companyId}::UUID,
              ${invNumber},
              ${supplierId}, ${inv.ff_purchase_order_id || null}, ${projectId},
              ${inv.invoice_date}, ${inv.due_date || inv.invoice_date},
              ${subtotal.toFixed(2)}, ${taxRate}, ${taxAmount.toFixed(2)}, ${totalAmount},
              ${isPaid ? totalAmount : 0}, ${isPaid ? 'paid' : 'approved'},
              ${inv.sage_invoice_id}, ${reference}, ${userId},
              ${dupFingerprint}
            ) RETURNING id
          `) as DbRow[]));

          const newInvoiceId = String(newInv[0]!.id);

          // Insert line items from raw_data
          // supplier_invoice_items has no company_id column; tenant-scoped via supplier_invoice_id FK
          const lines = parseRawData(inv.raw_data, inv.line_items);
          if (lines && Array.isArray(lines) && lines.length > 0) {
            for (const line of lines) {
              const qty = Number(line.Quantity || 1);
              const price = Number(line.UnitPriceExclusive || 0);
              const lineTax = Number(line.Tax || 0);
              const lineTotal = Number(line.Exclusive || line.Total || price * qty);
              const lineTaxPct = Number(line.TaxPercentage || 0) * 100;

              if (projectId) {
                await sql`
                  INSERT INTO supplier_invoice_items (
                    supplier_invoice_id, description, quantity, unit_price,
                    tax_rate, tax_amount, line_total, project_id
                  ) VALUES (
                    ${newInvoiceId}::UUID, ${line.Description || 'Line item'},
                    ${qty}, ${price}, ${lineTaxPct}, ${lineTax}, ${lineTotal},
                    ${projectId}::UUID
                  )
                `;
              } else {
                await sql`
                  INSERT INTO supplier_invoice_items (
                    supplier_invoice_id, description, quantity, unit_price,
                    tax_rate, tax_amount, line_total
                  ) VALUES (
                    ${newInvoiceId}::UUID, ${line.Description || 'Line item'},
                    ${qty}, ${price}, ${lineTaxPct}, ${lineTax}, ${lineTotal}
                  )
                `;
              }
            }
          }

          // BL-40: UPDATE scoped by company_id
          await sql`
            UPDATE sage_supplier_invoices
            SET migration_status = 'imported', gl_supplier_invoice_id = ${newInvoiceId}::UUID
            WHERE id = ${inv.id}
              AND company_id = ${companyId}::UUID
          `;

          return 'imported';
        });

        if (outcome === 'imported') {
          succeeded++;
        } else {
          // Outside the savepoint, so the marker survives.
          await sql`
            UPDATE sage_supplier_invoices
            SET migration_status = 'failed'
            WHERE id = ${inv.id}
              AND company_id = ${companyId}::UUID
          `;
          failed++;
        }
      } catch (err) {
        // The savepoint has rolled back, so the transaction is usable and these
        // statements will land.
        if (isDuplicateFingerprintViolation(err)) {
          // Not a failure: this supplier already has this invoice for this
          // amount, so the document IS in IsaFlow. Point the staging row at it
          // and count the record as skipped rather than imported — nothing new
          // was created — so that a re-run of the same export converges instead
          // of reporting a growing failure count.
          const existing = (await sql`
            SELECT id FROM supplier_invoices
            WHERE company_id = ${companyId}::UUID
              AND supplier_id = ${inv.supplier_id}::UUID
              AND duplicate_fingerprint = ${recordFingerprint}
              AND deleted_at IS NULL
            LIMIT 1
          `) as DbRow[];
          log.warn('Sage invoice already imported; linking the staging row to it', {
            invoiceId: inv.id, existingId: existing[0]?.id ?? null,
          }, 'accounting');
          await sql`
            UPDATE sage_supplier_invoices
            SET migration_status = 'imported',
                gl_supplier_invoice_id = COALESCE(${existing[0]?.id ?? null}::UUID, gl_supplier_invoice_id)
            WHERE id = ${inv.id}
              AND company_id = ${companyId}::UUID
          `;
          skipped++;
          continue;
        }
        log.error('Failed to import sage invoice', { invoiceId: inv.id, error: err }, 'accounting');
        // BL-40: UPDATE scoped by company_id
        await sql`
          UPDATE sage_supplier_invoices
          SET migration_status = 'failed'
          WHERE id = ${inv.id}
            AND company_id = ${companyId}::UUID
        `;
        failed++;
      }
    }

    return await completeRun(runId, sageInvoices.length, succeeded, failed, skipped);
  } catch (err) {
    await failRun(runId, err);
    throw err;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseRawData(rawData: unknown, lineItems: unknown): any[] | null {
  // Try raw_data.Lines first (full Sage response with includeDetail)
  const raw = parseJson(rawData);
  if (raw?.Lines && Array.isArray(raw.Lines) && raw.Lines.length > 0) {
    return raw.Lines;
  }
  // Fall back to line_items JSONB column
  const items = parseJson(lineItems);
  if (Array.isArray(items) && items.length > 0) return items;
  return null;
}

function parseJson(val: unknown): Record<string, unknown> | null {
  if (!val) return null;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return null; }
  }
  return val as Record<string, unknown>;
}

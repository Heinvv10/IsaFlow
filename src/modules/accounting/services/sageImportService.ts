/**
 * PRD-060 Phase 6: Sage Data Importers
 * Ledger transaction → GL journal entries
 * Supplier invoices → AP supplier_invoices
 */

import { sql, transaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { MigrationRun } from './sageMigrationService';
import { startRun, completeRun, failRun } from './sageMigrationService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Ledger Transaction Import ───────────────────────────────────────────────

/**
 * Import sage_ledger_transactions as GL journal entries
 * Groups by document_number + transaction_date into balanced entries
 */
export async function importLedgerTransactions(companyId: string, userId: string): Promise<MigrationRun> {
  const runId = await startRun('ledger_import', userId);

  try {
    // Fetch all pending lines in a single SELECT — eliminates N+1 per-group queries
    const allLines = (await sql`
      SELECT slt.id, slt.document_number, slt.transaction_date, slt.description,
        slt.debit, slt.credit, slt.reference, slt.ff_project_id,
        sa.gl_account_id
      FROM sage_ledger_transactions slt
      JOIN sage_accounts sa ON sa.sage_account_id = slt.sage_account_id
      WHERE slt.migration_status = 'pending'
        AND sa.gl_account_id IS NOT NULL
      ORDER BY slt.transaction_date, slt.document_number
    `) as Row[];

    // Group lines in JavaScript rather than with a separate query per group
    const groupMap = new Map<string, { document_number: string; transaction_date: unknown; description: string; lines: Row[] }>();
    for (const line of allLines) {
      const key = `${line.document_number}::${String(line.transaction_date)}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          document_number: line.document_number,
          transaction_date: line.transaction_date,
          description: line.description,
          lines: [],
        });
      }
      groupMap.get(key)!.lines.push(line);
    }

    const groups = Array.from(groupMap.values());
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const group of groups) {
      try {
        const lines = group.lines;
        if (lines.length === 0) { skipped++; continue; }

        const totalDebit = lines.reduce((s: number, l: Row) => s + Number(l.debit || 0), 0);
        const totalCredit = lines.reduce((s: number, l: Row) => s + Number(l.credit || 0), 0);

        if (Math.abs(totalDebit - totalCredit) > 0.02) {
          await transaction((txSql) =>
            lines.map(line => txSql`
              UPDATE sage_ledger_transactions SET migration_status = 'failed' WHERE id = ${line.id}
            `)
          );
          failed++;
          continue;
        }

        const entryRef = group.document_number
          ? `SAGE-${group.document_number}`
          : `SAGE-${group.transaction_date}`;

        const entry = (await sql`
          INSERT INTO gl_journal_entries (
            entry_number, entry_date, description, source, status, created_by
          ) VALUES (
            ${entryRef}, ${group.transaction_date},
            ${group.description || `Sage import: ${entryRef}`},
            'manual', 'posted', ${userId}
          ) RETURNING id
        `) as Row[];

        const entryId = String(entry[0].id);

        // Batch all line inserts + status updates into one HTTP round-trip
        const activeLines = lines.filter(l => Number(l.debit || 0) !== 0 || Number(l.credit || 0) !== 0);
        if (activeLines.length > 0) {
          await transaction((txSql) =>
            activeLines.flatMap(line => {
              const debit = Number(line.debit || 0);
              const credit = Number(line.credit || 0);
              const projectId = line.ff_project_id || null;
              const lineInsert = projectId
                ? txSql`
                    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, project_id)
                    VALUES (${entryId}::UUID, ${line.gl_account_id}::UUID, ${debit}, ${credit},
                      ${line.description || group.description || ''}, ${projectId}::UUID)
                  `
                : txSql`
                    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
                    VALUES (${entryId}::UUID, ${line.gl_account_id}::UUID, ${debit}, ${credit},
                      ${line.description || group.description || ''})
                  `;
              const statusUpdate = txSql`
                UPDATE sage_ledger_transactions
                SET migration_status = 'imported', gl_journal_entry_id = ${entryId}::UUID
                WHERE id = ${line.id}
              `;
              return [lineInsert, statusUpdate];
            })
          );
        }

        succeeded++;
      } catch (err) {
        log.error('Failed to import ledger group', { docNum: group.document_number, error: err }, 'accounting');
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
  const runId = await startRun('invoice_import', userId);

  try {
    const sageInvoices = (await sql`
      SELECT id, sage_invoice_id, sage_supplier_id, invoice_number,
        invoice_date, due_date, subtotal, tax_amount, total_amount,
        outstanding_amount, status, ff_purchase_order_id, supplier_id,
        raw_data, line_items
      FROM sage_supplier_invoices
      WHERE migration_status = 'pending'
      ORDER BY invoice_date
    `) as Row[];

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const inv of sageInvoices) {
      try {
        const totalAmount = Number(inv.total_amount || 0);
        if (totalAmount === 0) { skipped++; continue; }

        // NOTE: purchase_orders table is not available in standalone accounting app.
        // Supplier ID must come from the Sage import data directly; PO lookup is stubbed.
        const supplierId = inv.supplier_id;

        if (!supplierId) {
          await sql`UPDATE sage_supplier_invoices SET migration_status = 'failed' WHERE id = ${inv.id}`;
          failed++;
          continue;
        }

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

        const newInv = (await sql`
          INSERT INTO supplier_invoices (
            invoice_number, supplier_id, purchase_order_id, project_id,
            invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
            amount_paid, status, sage_invoice_id, reference, created_by
          ) VALUES (
            ${inv.invoice_number || `SAGE-${inv.sage_invoice_id}`},
            ${supplierId}, ${inv.ff_purchase_order_id || null}, ${projectId},
            ${inv.invoice_date}, ${inv.due_date || inv.invoice_date},
            ${subtotal.toFixed(2)}, ${taxRate}, ${taxAmount.toFixed(2)}, ${totalAmount},
            ${isPaid ? totalAmount : 0}, ${isPaid ? 'paid' : 'approved'},
            ${inv.sage_invoice_id}, ${reference}, ${userId}
          ) RETURNING id
        `) as Row[];

        const newInvoiceId = String(newInv[0].id);

        // Insert line items from raw_data
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

        await sql`
          UPDATE sage_supplier_invoices
          SET migration_status = 'imported', gl_supplier_invoice_id = ${newInvoiceId}::UUID
          WHERE id = ${inv.id}
        `;

        succeeded++;
      } catch (err) {
        log.error('Failed to import sage invoice', { invoiceId: inv.id, error: err }, 'accounting');
        await sql`UPDATE sage_supplier_invoices SET migration_status = 'failed' WHERE id = ${inv.id}`;
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

/**
 * PRD-060 Phase 6: Sage Data Importers — supplier invoices
 * Sage supplier invoices → AP supplier_invoices
 *
 * Split out of sageImportService.ts, which was over the 300-line cap and grew
 * further with the savepoint fix. The two importers share no code: this one
 * touches sage_supplier_invoices and supplier_invoices, the ledger one touches
 * sage_ledger_transactions and the GL.
 *
 * BL-40: Every SELECT/JOIN/INSERT/UPDATE is scoped by company_id to prevent
 * cross-tenant data leaks and silent INSERT failures caused by missing NOT NULL
 * company_id columns.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { MigrationRun } from './sageMigrationService';
import { startRun, completeRun, failRun } from './sageMigrationService';
import type { DbRow } from '@/types/db';
import { computeFingerprint } from '../capture/captureDeduplicationService';

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
      try {
        const totalAmount = Number(inv.total_amount || 0);
        if (totalAmount === 0) { skipped++; continue; }

        // Every statement for this record runs inside its own savepoint. Any
        // SQL failure on a record used to abort the whole request transaction,
        // so the `migration_status = 'failed'` marker in the catch below then
        // raised 25P02, escaped to failRun() — more SQL on the same dead
        // transaction — and rolled back every invoice the run had imported.
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

          // BL-40: Added company_id to INSERT — was missing, causing NOT NULL violation
          const newInv = (await sql`
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
          `) as DbRow[];

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

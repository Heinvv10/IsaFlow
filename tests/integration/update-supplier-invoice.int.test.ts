/**
 * update_supplier_invoice against a real database, through the tool handler.
 *
 * Pins: a line replacement computes exactly what create computes (the totals
 * helper is shared, and the approval journal is built from these figures);
 * the edited draft then approves into a balanced journal at the NEW total;
 * every refusal leaves the row untouched; and nothing crosses a tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { updateSupplierInvoiceTool } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import {
  SupplierInvoiceDraftUpdateRefusal, lockAndPlanSupplierInvoiceDraftUpdate,
} from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdate';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { applyDRCVat } from '@/modules/accounting/services/reports/drcVatService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { withSavepoint } from '@/lib/neon';
import { savepointNameFor } from '@/lib/mcp/registry';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, runOn, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
let expenseAccount: string;
let seq = 0;

type Row = Record<string, unknown>;
const ctxOf = (f: Fixture) => ({ companyId: f.companyId, userId: f.userId, tokenJti: 'jti-u' }) as unknown as McpToolContext;
const key = () => ({ idempotency_key: `k-${++seq}` });
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

const LINES = [
  { description: 'Fibre splice', quantity: 3, unit_price: 33.33 },
  { description: 'Cable 1km', quantity: 1.5, unit_price: 1234.57, tax_rate: 0 },
];

async function draft(f: Fixture = fx, number = `D${++seq}`): Promise<string> {
  const bill = await inTx(f, () => createSupplierInvoice(f.companyId, {
    supplierId: f.supplierId, invoiceNumber: `${number}-${f.tag}`.slice(0, 50), invoiceDate: '2026-05-01',
    dueDate: '2026-05-31', reference: 'orig-ref',
    items: [{ description: 'Original', quantity: 1, unitPrice: 100 }],
  }, f.userId));
  return bill.id;
}

const update = (id: string, args: Record<string, unknown>, f: Fixture = fx) =>
  inTx(f, () => updateSupplierInvoiceTool.handler({ invoice_id: id, ...args, ...key() }, ctxOf(f)));

async function snapshot(id: string): Promise<Row> {
  const [head] = (await sql`
    SELECT invoice_number, invoice_date::TEXT AS invoice_date, due_date::TEXT AS due_date, reference,
           supplier_id, subtotal::FLOAT8 AS subtotal, tax_amount::FLOAT8 AS tax_amount,
           total_amount::FLOAT8 AS total_amount, duplicate_fingerprint, status
    FROM supplier_invoices WHERE id = ${id}::UUID`) as Row[];
  const lines = (await sql`
    SELECT description, quantity::FLOAT8 AS quantity, unit_price::FLOAT8 AS unit_price,
           tax_rate::FLOAT8 AS tax_rate, tax_amount::FLOAT8 AS tax_amount,
           line_total::FLOAT8 AS line_total, vat_classification
    FROM supplier_invoice_items WHERE supplier_invoice_id = ${id}::UUID ORDER BY description`) as Row[];
  return { ...head, lines };
}

/**
 * A draft carrying a posted DRC journal. applyDRCVat now refuses drafts and
 * taxed bills, but rows written before those fixes exist, so the edit guard
 * must still hold.
 */
async function drcOnDraft(id: string) {
  // The old path also ignored supplier VAT; apply as a clean approved bill,
  // then restore the draft exactly as that path left it.
  const [{ tax_amount: tax }] = (await sql`
    SELECT tax_amount FROM supplier_invoices WHERE id = ${id}::UUID`) as { tax_amount: string }[];
  await sql`UPDATE supplier_invoices SET status = 'approved', tax_amount = 0 WHERE id = ${id}::UUID`;
  const drc = await inTx(fx, () => applyDRCVat(fx.companyId, id, fx.userId));
  await sql`UPDATE supplier_invoices SET status = 'draft', tax_amount = ${tax} WHERE id = ${id}::UUID`;
  return drc;
}

describeIfDb('update_supplier_invoice — drafts over a real ledger', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates, edits and approves supplier bills.');
    fx = await seedFixture('USI', DATABASE_URL!);
    other = await seedFixture('USX', DATABASE_URL!);
    expenseAccount = String(((await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'default_expense'
      LIMIT 1`) as Row[])[0]!.id);
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      await sql`DELETE FROM credit_notes WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM approval_requests WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM supplier_coding_history WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM supplier_statement_reconciliations WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM captured_documents WHERE company_id = ${f.companyId}::UUID`;
      await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${f.companyId}::UUID`;
      await dropFixture(f);
    }
  }, 120000);

  it('changes only the header fields sent, and leaves lines and totals alone', async () => {
    const id = await draft();
    const before = await snapshot(id);
    const r = await update(id, { reference: 'new-ref', invoice_date: '2026-05-03' });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).changed).toEqual(['invoiceDate', 'reference']);
    expect(await snapshot(id)).toEqual({ ...before, reference: 'new-ref', invoice_date: '2026-05-03' });
  });

  it('replaces lines with exactly the figures create computes, and approves at the new total', async () => {
    const id = await draft();
    const r = await update(id, { lines: [...LINES, { description: 'Labour', quantity: 2, unit_price: 50, gl_account_id: expenseAccount }] });
    expect(r.isError).toBeFalsy();

    const twin = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
      supplierId: fx.supplierId, invoiceNumber: `TWIN-${fx.tag}`.slice(0, 50), invoiceDate: '2026-05-01',
      items: [
        { description: 'Fibre splice', quantity: 3, unitPrice: 33.33 },
        { description: 'Cable 1km', quantity: 1.5, unitPrice: 1234.57, taxRate: 0 },
        { description: 'Labour', quantity: 2, unitPrice: 50, glAccountId: expenseAccount },
      ],
    }, fx.userId));
    const [edited, created] = [await snapshot(id), await snapshot(twin.id)];
    for (const k of ['subtotal', 'tax_amount', 'total_amount', 'lines'] as const) {
      expect(edited[k]).toEqual(created[k]);
    }
    expect(edited.total_amount).toBe(2081.85); // net 99.99 + 1851.86 + 100; VAT 15.00 + 0 + 15.00

    const approved = await inTx(fx, () => approveSupplierInvoice(fx.companyId, id, fx.userId));
    const [je] = (await sql`
      SELECT SUM(debit)::FLOAT8 AS dr, SUM(credit)::FLOAT8 AS cr FROM gl_journal_lines
      WHERE journal_entry_id = ${approved.glJournalEntryId!}::UUID`) as Row[];
    expect(je).toEqual({ dr: 2081.85, cr: 2081.85 });
  });

  it('recomputes the duplicate fingerprint when the number or total changes', async () => {
    const id = await draft();
    const before = (await snapshot(id)).duplicate_fingerprint;
    await update(id, { invoice_number: `RENUM-${fx.tag}`.slice(0, 50) });
    expect((await snapshot(id)).duplicate_fingerprint).not.toBe(before);
  });

  it('refuses a bill that is not a draft, naming the remedy, and writes nothing', async () => {
    const id = await draft();
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, id, fx.userId));
    const before = await snapshot(id);
    const r = await update(id, { reference: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('cancel_supplier_invoice');
    expect(await snapshot(id)).toEqual(before);
  });

  it('answers Not found for another tenant\'s bill, supplier or account', async () => {
    const foreign = await draft(other);
    expect(text(await update(foreign, { reference: 'x' }))).toBe('Not found');
    expect((await snapshot(foreign)).reference).toBe('orig-ref');

    const id = await draft();
    expect(text(await update(id, { supplier_id: other.supplierId }))).toBe('Not found');
    const foreignAcct = String(((await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${other.companyId}::UUID LIMIT 1`) as Row[])[0]!.id);
    expect(text(await update(id, { lines: [{ ...LINES[0], gl_account_id: foreignAcct }] })))
      .toContain('not GL accounts in your company');
    expect((await snapshot(id)).supplier_id).toBe(fx.supplierId);
  });

  it('refuses a total or supplier change while a payment names the bill, but allows a reference edit', async () => {
    const id = await draft();
    const pay = String(((await sql`
      INSERT INTO supplier_payments (company_id, supplier_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${`PU-${seq}-${Date.now()}`.slice(0, 30)}, '2026-05-05', 115, 'draft', ${fx.userId}::UUID)
      RETURNING id`) as Row[])[0]!.id);
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${pay}::UUID, ${id}::UUID, 115)`;

    const before = await snapshot(id);
    expect(text(await update(id, { lines: LINES }))).toContain('draft payment');
    expect(text(await update(id, { supplier_id: await seedSupplier(fx, `S2-${seq}`) }))).toContain('draft payment');
    expect(await snapshot(id)).toEqual(before);
    expect((await update(id, { reference: 'still-fine' })).isError).toBeFalsy();
  });

  it('refuses to replace lines that carry a project or an exempt classification', async () => {
    const withProject = await draft();
    await sql`UPDATE supplier_invoice_items SET project_id = ${randomUUID()}::UUID WHERE supplier_invoice_id = ${withProject}::UUID`;
    expect(text(await update(withProject, { lines: LINES }))).toContain('would drop');

    const exempt = await draft();
    await sql`UPDATE supplier_invoice_items SET tax_rate = 0, vat_classification = 'exempt' WHERE supplier_invoice_id = ${exempt}::UUID`;
    expect(text(await update(exempt, { lines: LINES }))).toContain('would drop');
    expect((await snapshot(exempt)).lines).toHaveLength(1);
  });

  it('refuses tax_rate without lines, a due date before the invoice date, and an empty patch', async () => {
    const id = await draft();
    expect(text(await update(id, { tax_rate: 0 }))).toContain('pass lines');
    expect(text(await update(id, { due_date: '2026-04-01' }))).toContain('before invoice_date');
    expect(text(await update(id, {}))).toContain('Nothing to update');
  });

  it('the service itself refuses a negative line, for callers that skip the tool parser', async () => {
    const id = await draft();
    const err = await inTx(fx, () => lockAndPlanSupplierInvoiceDraftUpdate(fx.companyId, id, {
      items: [{ description: 'Neg', quantity: 1, unitPrice: -5 }],
    })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierInvoiceDraftUpdateRefusal);
    expect((err as Error).message).toContain('unit price cannot be negative');
  });

  it('refuses a number the supplier already uses on another live bill', async () => {
    const taken = await draft();
    const takenNumber = String((await snapshot(taken)).invoice_number);
    const id = await draft();
    const before = await snapshot(id);
    expect(text(await update(id, { invoice_number: takenNumber }))).toContain(`already has a draft bill numbered ${takenNumber}`);
    expect(await snapshot(id)).toEqual(before);
    // Another supplier may use the same number.
    const s2 = await seedSupplier(fx, `S3-${seq}`);
    expect((await update(id, { supplier_id: s2, invoice_number: takenNumber })).isError).toBeFalsy();
  });

  it('keeps the fingerprint on a header-only edit, and treats identical lines as unchanged', async () => {
    const id = await draft();
    await sql`UPDATE supplier_invoices SET duplicate_fingerprint = 'sentinel' WHERE id = ${id}::UUID`;
    await update(id, { reference: 'header-only' });
    expect((await snapshot(id)).duplicate_fingerprint).toBe('sentinel');

    // The stored line carries a project, so a REAL replacement would be refused.
    await sql`UPDATE supplier_invoice_items SET project_id = ${randomUUID()}::UUID WHERE supplier_invoice_id = ${id}::UUID`;
    const same = await update(id, { lines: [{ description: 'Original', quantity: 1, unit_price: 100 }] });
    expect(same.isError).toBeFalsy();
    expect(JSON.parse(text(same)).changed).toEqual([]);
    expect((await snapshot(id)).duplicate_fingerprint).toBe('sentinel');
  });

  /** Ledger review MEDIUM: applyDRCVat posted on DRAFTS (legacy rows remain) and leaves gl_journal_entry_id NULL. */
  it('refuses any edit of a draft that already carries a posted DRC VAT journal', async () => {
    const id = await draft();
    await drcOnDraft(id);
    const before = await snapshot(id);
    const r = await update(id, { lines: [{ description: 'Bigger', quantity: 1, unit_price: 5000 }] });
    expect(text(r)).toContain('is sourced from it');
    expect(text(await update(id, { reference: 'x' }))).toContain('reverse_journal_entry');
    expect(await snapshot(id)).toEqual(before);
  });

  it('refuses a total, supplier or number change while an approval request or statement line records the bill', async () => {
    const approved = await draft();
    await sql`
      INSERT INTO approval_requests (company_id, document_type, document_id, amount, status, requested_by)
      VALUES (${fx.companyId}::UUID, 'supplier_invoice', ${approved}::UUID, 115, 'approved', ${fx.userId}::UUID)`;
    expect(text(await update(approved, { lines: LINES }))).toContain('approval request (approved)');
    expect((await update(approved, { reference: 'header-ok' })).isError).toBeFalsy();

    const matched = await draft();
    const doc = String(((await sql`
      INSERT INTO captured_documents (company_id, file_name, file_type)
      VALUES (${fx.companyId}::UUID, 'stmt.pdf', 'application/pdf') RETURNING id`) as Row[])[0]!.id);
    const rec = String(((await sql`
      INSERT INTO supplier_statement_reconciliations
        (company_id, supplier_id, source_document_id, statement_date, supplier_balance, isaflow_balance, variance)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${doc}::UUID, '2026-05-31', 115, 115, 0)
      RETURNING id`) as Row[])[0]!.id);
    await sql`
      INSERT INTO supplier_statement_lines (reconciliation_id, reference, debit, matched_supplier_invoice_id)
      VALUES (${rec}::UUID, 'STMT-1', 115, ${matched}::UUID)`;
    expect(text(await update(matched, { invoice_number: `NEW-${fx.tag}`.slice(0, 50) })))
      .toContain('supplier-statement line (STMT-1)');

    // Coding history pins the SUPPLIER only: a number change stays allowed.
    const coded = await draft();
    await sql`
      INSERT INTO supplier_coding_history (company_id, supplier_id, supplier_invoice_id, gl_account_id, posted_by)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${coded}::UUID, ${expenseAccount}::UUID, ${fx.userId}::UUID)`;
    expect(text(await update(coded, { supplier_id: await seedSupplier(fx, `S4-${seq}`) })))
      .toContain('supplier coding history');
    expect((await update(coded, { invoice_number: `CODED-${fx.tag}`.slice(0, 50) })).isError).toBeFalsy();
  });

  /** Ledger re-review LOW: reversing a DRC journal leaves is_drc set, so the only remedy is a new bill. */
  it('names cancel-and-re-enter once the DRC journal is already reversed', async () => {
    const id = await draft();
    const drc = await drcOnDraft(id);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, drc.journalEntryId, fx.userId));
    const msg = text(await update(id, { reference: 'x' }));
    expect(msg).toContain('already reversed');
    expect(msg).toContain('cancel_supplier_invoice');
  });

  /** Ledger re-review LOW: a joined-string signature let one sent line equal two stored ones. */
  it('does not treat one line whose description embeds another line as unchanged', async () => {
    const id = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
      supplierId: fx.supplierId, invoiceNumber: `NL-${fx.tag}`.slice(0, 50), invoiceDate: '2026-05-01',
      items: [{ description: 'A', quantity: 1, unitPrice: 100 }, { description: 'B', quantity: 1, unitPrice: 200 }],
    }, fx.userId)).then((b) => b.id);
    const r = await update(id, { lines: [{ description: 'A|1.0000|100.00|15.00|15.00|100.00|\nB', quantity: 1, unit_price: 200 }] });
    expect(JSON.parse(text(r)).changed).toEqual(['lines']);
    expect((await snapshot(id)).lines).toHaveLength(1);
  });

  /** Ledger re-review: K-052 — a caught lock timeout must leave the transaction usable. */
  it('hands back the retry wording, not 25P02, when another request holds the bill', async () => {
    const id = await draft();
    const holder = await fx.pool.connect();
    const runner = await fx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [id]);
      await runner.query('BEGIN');
      const { out, afterwards } = await runOn(fx, runner, async () => {
        // EXACTLY registry.call's shape for a write tool, then a statement on
        // the surviving transaction where the registry writes its audit row.
        const result = await withSavepoint(savepointNameFor('update_supplier_invoice'),
          () => updateSupplierInvoiceTool.handler({ invoice_id: id, reference: 'x', ...key() }, ctxOf(fx)));
        const probe = (await sql`SELECT 1 AS ok`) as Row[];
        return { out: result, afterwards: probe.length };
      });
      await runner.query('COMMIT');
      expect(out.isError).toBe(true);
      expect(text(out)).toContain('retry');
      expect(afterwards).toBe(1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await runner.query('ROLLBACK').catch(() => undefined);
      runner.release();
    }
    expect((await snapshot(id)).reference).toBe('orig-ref');
  }, 30_000);
});

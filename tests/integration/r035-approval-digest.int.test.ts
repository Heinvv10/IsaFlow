/**
 * R-035 PR1: an approval must bind to WHAT was approved.
 *
 * `resolveApprovalDocument` now returns the document's digest, computed by the
 * one SQL definition (`approval_document_digest`, migration 708). Every column
 * the posting, the AP subledger or the VAT201 reads must move it; line-id churn
 * (the draft edit deletes and re-inserts every line) and the 3-way-match state
 * must not. Each hashed column is mutated on its own and must go red on its own.
 *
 * Also here: rules are matched on the functional (ZAR) total, not the
 * document-currency total — a USD 5 000 bill is ~R92 500 and must not slip under
 * a R50 000 rule.
 *
 * Runs inside a rolled-back transaction per case, as the pool's role.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { resolveApprovalDocument } from '../../src/modules/accounting/services/gl/approvalDocuments';
import { checkApproval } from '../../src/modules/accounting/services/gl/approvalMatching';
import { getSupplierInvoiceById } from '../../src/modules/accounting/services/ap/supplierInvoiceService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { enableFxDocuments, newCompany, plantBill, plantRule, type Bill } from './r035-approval.helpers';

assertDisposable();
const USER = '00000000-0000-0000-0000-00000000a035';
type Ctx = Parameters<typeof als.run>[0];

afterAll(async () => { await getPoolForTests().end(); });

async function inTx(fn: (c: PoolClient, company: string, bill: Bill) => Promise<void>): Promise<void> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const company = await newCompany(client, []);
    await enableFxDocuments(client, company); // the digest covers both currency columns
    const bill = await plantBill(client, company, USER);
    const ctx = { client, userId: USER, companyId: company, claims: {} } as unknown as Ctx;
    await als.run(ctx, () => fn(client, company, bill));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const digestOf = async (company: string, id: string) =>
  (await resolveApprovalDocument(company, 'supplier_invoice', id)).digest;

/** Each entry changes ONE hashed column and nothing else. */
const HASHED: [string, string][] = [
  ['supplier_id', `UPDATE supplier_invoices SET supplier_id = (SELECT id FROM s2) WHERE id = $1`],
  ['invoice_number', `UPDATE supplier_invoices SET invoice_number = invoice_number || '-X' WHERE id = $1`],
  ['invoice_date', `UPDATE supplier_invoices SET invoice_date = invoice_date + 1 WHERE id = $1`],
  ['currency', `UPDATE supplier_invoices SET currency = 'USD' WHERE id = $1`],
  ['currency_code', `UPDATE supplier_invoices SET currency_code = 'USD' WHERE id = $1`],
  ['exchange_rate', `UPDATE supplier_invoices SET exchange_rate = 18.5 WHERE id = $1`],
  ['subtotal', `UPDATE supplier_invoices SET subtotal = subtotal + 1 WHERE id = $1`],
  ['tax_rate', `UPDATE supplier_invoices SET tax_rate = 0 WHERE id = $1`],
  ['tax_amount', `UPDATE supplier_invoices SET tax_amount = tax_amount + 1 WHERE id = $1`],
  ['total_amount', `UPDATE supplier_invoices SET total_amount = total_amount + 1 WHERE id = $1`],
  ['functional_total', `UPDATE supplier_invoices SET functional_total = 99999 WHERE id = $1`],
  ['project_id', `UPDATE supplier_invoices SET project_id = gen_random_uuid() WHERE id = $1`],
  ['cost_center_id', `UPDATE supplier_invoices SET cost_center_id = gen_random_uuid() WHERE id = $1`],
  ['is_drc', `UPDATE supplier_invoices SET is_drc = NOT COALESCE(is_drc, false) WHERE id = $1`],
  ['line gl_account_id', `UPDATE supplier_invoice_items SET gl_account_id = (SELECT gl_account_id FROM supplier_invoice_items WHERE supplier_invoice_id = $1 AND description = 'Line B') WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['line description', `UPDATE supplier_invoice_items SET description = 'Line A edited' WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['line quantity', `UPDATE supplier_invoice_items SET quantity = 3 WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['line unit_price', `UPDATE supplier_invoice_items SET unit_price = 301 WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['line tax_rate', `UPDATE supplier_invoice_items SET tax_rate = 0 WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['line tax_amount', `UPDATE supplier_invoice_items SET tax_amount = 91 WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['line line_total', `UPDATE supplier_invoice_items SET line_total = 601 WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['line project_id', `UPDATE supplier_invoice_items SET project_id = gen_random_uuid() WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['line cost_center_id', `UPDATE supplier_invoice_items SET cost_center_id = gen_random_uuid() WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['line vat_classification', `UPDATE supplier_invoice_items SET vat_classification = 'capital' WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
  ['a line added', `INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total) VALUES($1,'Line C',1,0,0)`],
  ['a line removed', `DELETE FROM supplier_invoice_items WHERE supplier_invoice_id = $1 AND description = 'Line B'`],
];

/** Each entry changes something the approval deliberately does NOT cover. */
const NOT_HASHED: [string, string][] = [
  ['line_match_status', `UPDATE supplier_invoice_items SET line_match_status = 'fully_matched' WHERE supplier_invoice_id = $1`],
  ['qty/price variance', `UPDATE supplier_invoice_items SET qty_variance_pct = 1.5, price_variance_pct = 2.5, match_computed_at = NOW() WHERE supplier_invoice_id = $1`],
  ['match_status', `UPDATE supplier_invoices SET match_status = 'po_matched' WHERE id = $1`],
  ['status', `UPDATE supplier_invoices SET status = 'pending_approval' WHERE id = $1`],
  ['notes/reference/due_date', `UPDATE supplier_invoices SET notes = 'n', reference = 'r', due_date = due_date + 7 WHERE id = $1`],
  ['amount_paid', `UPDATE supplier_invoices SET amount_paid = 10 WHERE id = $1`],
  ['100 vs 100.00', `UPDATE supplier_invoice_items SET quantity = 2.0000 WHERE supplier_invoice_id = $1 AND description = 'Line A'`],
];

describe('the digest covers every column an approval vouches for', () => {
  it('is a stable sha256 for a supplier invoice', async () => {
    await inTx(async (_c, company, bill) => {
      const first = await digestOf(company, bill.id);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(await digestOf(company, bill.id)).toBe(first);
    });
  });

  it.each(HASHED)('changes when %s changes', async (_name, mutation) => {
    await inTx(async (c, company, bill) => {
      const before = await digestOf(company, bill.id);
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      await c.query(`CREATE TEMP TABLE s2 ON COMMIT DROP AS SELECT gen_random_uuid() AS id`);
      await c.query('INSERT INTO suppliers(id,company_id,name) SELECT id, $1, $2 FROM s2', [company, 'r035 other']);
      await c.query(mutation, [bill.id]);
      expect(await digestOf(company, bill.id)).not.toBe(before);
    });
  });

  it.each(NOT_HASHED)('does NOT change when %s changes', async (_name, mutation) => {
    await inTx(async (c, company, bill) => {
      const before = await digestOf(company, bill.id);
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      await c.query(mutation, [bill.id]);
      expect(await digestOf(company, bill.id)).toBe(before);
    });
  });

  it('survives line-id churn: delete and re-insert every line, in the other order', async () => {
    await inTx(async (c, company, bill) => {
      const before = await digestOf(company, bill.id);
      await c.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [bill.id]);
      await c.query(
        `INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,tax_rate,tax_amount,line_total,gl_account_id)
         VALUES($1,'Line B',1,400,15,60,400,$3),($1,'Line A',2,300,15,90,600,$2)`, [bill.id, bill.accountA, bill.accountB]);
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(await digestOf(company, bill.id)).toBe(before);
    });
  });

  it('hashes lines in POSTING order: moving a line earlier changes the digest', async () => {
    // buildExpenseLines puts the rounding residual on the LAST line, so which
    // line is last is part of what gets posted (review MED-3).
    await inTx(async (c, company, bill) => {
      const before = await digestOf(company, bill.id);
      await c.query(`UPDATE supplier_invoice_items SET created_at = created_at - interval '1 minute'
                     WHERE supplier_invoice_id = $1 AND description = 'Line B'`, [bill.id]);
      expect(await digestOf(company, bill.id)).not.toBe(before);
    });
  });

  it('reads tied lines for posting in a deterministic content order, not heap or sort-tie order', async () => {
    // Eight lines inserted together (so their created_at ties) in a SHUFFLED
    // description order, all on one account so the gl_accounts join cannot
    // order them by accident. A tie-only ORDER BY returns them in whatever
    // order the scan and sort produce; the posting order must be the content's.
    await inTx(async (c, company, bill) => {
      await c.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [bill.id]);
      const names = ['C', 'H', 'A', 'F', 'B', 'E', 'D', 'G'].map((x) => `Line ${x}`);
      for (const name of names) {
        await c.query(
          `INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,gl_account_id)
           VALUES($1,$2,1,100,100,$3)`, [bill.id, name, bill.accountA]);
      }
      const invoice = await getSupplierInvoiceById(company, bill.id);
      expect(invoice?.items.map((i) => i.description)).toEqual([...names].sort());
    });
  });

  it('hashes a NULL line account as NULL — the default expense account is not resolved (documented limit)', async () => {
    await inTx(async (c, company, bill) => {
      await c.query("UPDATE supplier_invoice_items SET gl_account_id = NULL WHERE supplier_invoice_id = $1 AND description = 'Line A'", [bill.id]);
      const withNull = await digestOf(company, bill.id);
      await c.query(
        `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,account_subtype)
         VALUES($1,'DEFX','default expense','expense','debit','default_expense')`, [company]);
      expect(await digestOf(company, bill.id)).toBe(withNull);
    });
  });

  it('comes back when an edit is reverted to identical content (Q9)', async () => {
    await inTx(async (c, company, bill) => {
      const before = await digestOf(company, bill.id);
      await c.query('UPDATE supplier_invoices SET total_amount = 9999 WHERE id = $1', [bill.id]);
      expect(await digestOf(company, bill.id)).not.toBe(before);
      await c.query('UPDATE supplier_invoices SET total_amount = 1150 WHERE id = $1', [bill.id]);
      expect(await digestOf(company, bill.id)).toBe(before);
    });
  });

  it("is NULL for another company's bill — the SQL function is tenant-scoped", async () => {
    await inTx(async (c, _company, bill) => {
      const other = await newCompany(c, []);
      const { rows } = await c.query('SELECT approval_document_digest($1, $2, $3) AS d', [other, 'supplier_invoice', bill.id]);
      expect(rows[0].d).toBeNull();
      await expect(resolveApprovalDocument(other, 'supplier_invoice', bill.id)).rejects.toThrow(/No supplier_invoice/);
    });
  });
});

describe('rules match the functional (ZAR) total', () => {
  it('a USD 5 000 bill (R92 500) is governed by a R50 000 rule', async () => {
    await inTx(async (c, company) => {
      const rule = await plantRule(c, company, 'owner', { operator: 'greater_than', value: 50000 });
      const usd = await plantBill(c, company, USER, { total: 5000, functionalTotal: 92500, currencyCode: 'USD', exchangeRate: 18.5 });
      const document = await resolveApprovalDocument(company, 'supplier_invoice', usd.id);
      expect(document.amount).toBe(92500);
      const check = await checkApproval(company, 'supplier_invoice', usd.id, document.amount);
      expect(check.matchedRule?.id).toBe(rule);
    });
  });

  it('falls back to total_amount when functional_total is NULL', async () => {
    await inTx(async (_c, company, bill) => {
      expect((await resolveApprovalDocument(company, 'supplier_invoice', bill.id)).amount).toBe(1150);
    });
  });

  it('treats a soft-deleted customer invoice as no document', async () => {
    await inTx(async (c, company) => {
      const customer = crypto.randomUUID();
      const id = crypto.randomUUID();
      await c.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'r035 deleted']);
      await c.query(
        `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,total_amount,created_by,deleted_at)
         VALUES($1,$2,$3,$4,100,$5,NOW())`, [id, company, `CI-${id.slice(0, 6)}`, customer, USER]);
      await expect(resolveApprovalDocument(company, 'customer_invoice', id)).rejects.toThrow(/No customer_invoice/);
    });
  });

  it('applies to customer invoices too — they carry the same functional_total column', async () => {
    await inTx(async (c, company) => {
      const customer = crypto.randomUUID();
      const id = crypto.randomUUID();
      await c.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'r035 customer']);
      await c.query(
        `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,total_amount,functional_total,created_by)
         VALUES($1,$2,$3,$4,5000,92500,$5)`, [id, company, `CI-${id.slice(0, 6)}`, customer, USER]);
      expect((await resolveApprovalDocument(company, 'customer_invoice', id)).amount).toBe(92500);
    });
  });
});

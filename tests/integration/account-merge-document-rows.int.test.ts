/**
 * A GL account merge repoints the DOCUMENT lines coded to the source — bill
 * lines, customer invoice lines (migration 870), expense-claim lines, PO lines
 * and capture events — in the same
 * transaction as the journal lines, and records exactly which rows moved.
 *
 * Before this, those four FK columns were caught by the configuration sweep,
 * so an account ever coded on a bill could never be merged and nothing could
 * recode its posted bill lines: a dead end.
 *
 * Runs on isaflow_dev inside a transaction that is ROLLED BACK, on a company
 * the fixture creates for itself — nothing commits, nothing to clean up.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { assertMergeTestDb, createMergeFixture, type MergeFixture } from '../unit/helpers/accountMergeFixture';

vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { mergeAccounts, AccountMergeError } from '../../src/modules/accounting/services/gl/accountMergeService';
import { previewAccountMerge } from '../../src/modules/accounting/services/gl/accountMergePreview';

const USER = '00000000-0000-0000-0000-0000000000aa';
const hasDb = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('dummy');

type Ctx = Parameters<typeof als.run>[0];

async function withFixture(fn: (c: PoolClient, f: MergeFixture) => Promise<void>): Promise<void> {
  assertMergeTestDb();
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const f = await createMergeFixture(client);
    const ctx = { client, userId: USER, companyId: f.companyId, claims: {} } as unknown as Ctx;
    await als.run(ctx, () => fn(client, f));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

interface DocIds {
  supplierInvoiceItem: string;
  customerInvoiceItem: string;
  customerInvoice: string;
  expenseClaimLine: string;
  poItem: string;
  captureEvent: string;
}

async function one(c: PoolClient, text: string, params: unknown[]): Promise<string> {
  const { rows } = await c.query<{ id: string }>(text, params);
  return rows[0]!.id;
}

/** One row in each of the four document tables, owned by `companyId`, coded to `accountId`. */
async function seedDocuments(
  c: PoolClient, companyId: string, accountId: string, billStatus: 'posted' | 'draft' = 'posted',
): Promise<DocIds> {
  const tag = Math.random().toString(36).slice(2, 8);
  const supplier = await one(c,
    `INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, `ZZ doc ${tag}`]);
  const invoice = await one(c,
    `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date,
       subtotal, total_amount, created_by, status)
     VALUES ($1, $2, $3, CURRENT_DATE, 100, 115, $4, $5) RETURNING id`,
    [companyId, `ZZ-INV-${tag}`, supplier, USER, billStatus === 'posted' ? 'approved' : 'draft']);
  if (billStatus === 'posted') {
    // Stands in for its approval journal: an approved bill whose journal is posted.
    await c.query(
      `UPDATE supplier_invoices SET gl_journal_entry_id = (
         SELECT id FROM gl_journal_entries WHERE company_id = $2 AND status = 'posted' ORDER BY id LIMIT 1)
       WHERE id = $1`, [invoice, companyId]);
  }
  const supplierInvoiceItem = await one(c,
    `INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, line_total, gl_account_id)
     VALUES ($1, 'doc fixture', 1, 100, 100, $2) RETURNING id`, [invoice, accountId]);
  const customer = await one(c,
    `INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, `ZZ cust ${tag}`]);
  // Follows the bill: a posted invoice (its journal posted) or a draft. A draft's
  // line may not move onto a header target (account-merge-invoice-lines.int.test.ts).
  const customerInvoice = await one(c,
    `INSERT INTO customer_invoices (company_id, invoice_number, customer_id, client_id, subtotal, total_amount, created_by, status,
       gl_journal_entry_id)
     VALUES ($1, $2, $3, $3, 100, 115, $4, $5::text, CASE WHEN $5::text = 'approved' THEN (
       SELECT id FROM gl_journal_entries WHERE company_id = $1 AND status = 'posted' ORDER BY id LIMIT 1) END)
     RETURNING id`, [companyId, `ZZ-CI-${tag}`, customer, USER, billStatus === 'posted' ? 'approved' : 'draft']);
  const customerInvoiceItem = await one(c,
    `INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount, gl_account_id)
     VALUES ($1, 'doc fixture', 1, 100, 100, $2) RETURNING id`, [customerInvoice, accountId]);
  const employee = await one(c,
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
     VALUES ($1, $2, 'Doc', 'Fixture', CURRENT_DATE) RETURNING id`, [companyId, `ZZ-${tag}`]);
  const claim = await one(c,
    `INSERT INTO expense_claims (company_id, employee_id, claim_number, claim_date, status)
     VALUES ($1, $2, $3, CURRENT_DATE, 'posted') RETURNING id`, [companyId, employee, `ZZ-EC-${tag}`]);
  const expenseClaimLine = await one(c,
    `INSERT INTO expense_claim_lines (claim_id, company_id, line_date, amount, vat_amount, gl_account_id)
     VALUES ($1, $2, CURRENT_DATE, 50, 0, $3) RETURNING id`, [claim, companyId, accountId]);
  const po = await one(c,
    `INSERT INTO purchase_orders (company_id, po_number, supplier_id, order_date, status)
     VALUES ($1, $2, $3, CURRENT_DATE, 'approved') RETURNING id`, [companyId, `ZZ-PO-${tag}`, supplier]);
  const poItem = await one(c,
    `INSERT INTO po_items (purchase_order_id, description, quantity, unit_price, line_total, gl_account_id)
     VALUES ($1, 'doc fixture', 1, 80, 80, $2) RETURNING id`, [po, accountId]);
  const captureEvent = await one(c,
    `INSERT INTO capture_events (company_id, channel, status, resolved_gl_account_id)
     VALUES ($1, 'api', 'posted', $2) RETURNING id`, [companyId, accountId]);
  return { supplierInvoiceItem, customerInvoiceItem, customerInvoice, expenseClaimLine, poItem, captureEvent };
}

/** The account each seeded row points at now, read directly — no service code involved. */
async function accountsOf(c: PoolClient, d: DocIds): Promise<string[]> {
  const { rows } = await c.query<{ a: string }>(
    `SELECT (SELECT gl_account_id FROM supplier_invoice_items WHERE id = $1)::text AS a
     UNION ALL SELECT (SELECT gl_account_id FROM expense_claim_lines WHERE id = $2)::text
     UNION ALL SELECT (SELECT gl_account_id FROM po_items WHERE id = $3)::text
     UNION ALL SELECT (SELECT resolved_gl_account_id FROM capture_events WHERE id = $4)::text
     UNION ALL SELECT (SELECT gl_account_id FROM customer_invoice_items WHERE id = $5)::text`,
    [d.supplierInvoiceItem, d.expenseClaimLine, d.poItem, d.captureEvent, d.customerInvoiceItem]);
  return rows.map((r) => r.a);
}

async function otherTenant(c: PoolClient): Promise<{ companyId: string; accountId: string }> {
  const companyId = await one(c, "INSERT INTO companies (name) VALUES ('ZZ doc other tenant') RETURNING id", []);
  const accountId = await one(c,
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1, 'ZZ-OTH', 'Other tenant expense', 'asset', 'debit', 3) RETURNING id`, [companyId]);
  return { companyId, accountId };
}

describe.skipIf(!hasDb)('mergeAccounts repoints document lines', () => {
  it('(a) moves bill, expense-claim, PO and capture rows onto the target and records their ids', async () => {
    await withFixture(async (c, f) => {
      const docs = await seedDocuments(c, f.companyId, f.cleanSourceId);

      const result = await mergeAccounts(f.companyId, f.cleanSourceId, f.targetId, USER);

      expect(await accountsOf(c, docs)).toEqual([f.targetId, f.targetId, f.targetId, f.targetId, f.targetId]);
      expect(result.documentRowsRepointed).toEqual({
        supplier_invoice_items: 1, customer_invoice_items: 1, expense_claim_lines: 1, po_items: 1, capture_events: 1,
      });
      const { rows } = await c.query<{ moved: Record<string, string[]> }>(
        'SELECT moved_document_rows AS moved FROM gl_account_merges WHERE id = $1 AND company_id = $2',
        [result.mergeRecordId, f.companyId]);
      expect(rows[0]!.moved).toEqual({
        supplier_invoice_items: [docs.supplierInvoiceItem],
        customer_invoice_items: [docs.customerInvoiceItem],
        expense_claim_lines: [docs.expenseClaimLine],
        po_items: [docs.poItem],
        capture_events: [docs.captureEvent],
      });
      // The line's account is in the invoice's approval digest: the merger is now an author of it.
      const authored = await c.query<{ a: string[] }>(
        'SELECT content_authors AS a FROM customer_invoices WHERE id = $1 AND company_id = $2',
        [docs.customerInvoice, f.companyId]);
      expect(authored.rows[0]!.a).toContain(USER);
    });
  }, 120_000);

  it('(b) writes nothing in another company — its own rows, and even rows forged onto our source id', async () => {
    await withFixture(async (c, f) => {
      const other = await otherTenant(c);
      // Another company's documents, coded to ITS OWN account.
      const theirs = await seedDocuments(c, other.companyId, other.accountId);
      // The FK checks only that the account id exists, not whose it is, so a
      // corrupt row of another company CAN name our source. It must not move.
      const forged = await seedDocuments(c, other.companyId, f.cleanSourceId);
      const ours = await seedDocuments(c, f.companyId, f.cleanSourceId);

      const preview = await previewAccountMerge(f.companyId, f.cleanSourceId, f.targetId);
      expect(preview.documentRowsToRepoint).toEqual({
        supplier_invoice_items: 1, customer_invoice_items: 1, expense_claim_lines: 1, po_items: 1, capture_events: 1,
      });

      await mergeAccounts(f.companyId, f.cleanSourceId, f.targetId, USER);

      expect(await accountsOf(c, ours)).toEqual([f.targetId, f.targetId, f.targetId, f.targetId, f.targetId]);
      expect(await accountsOf(c, theirs)).toEqual([
        other.accountId, other.accountId, other.accountId, other.accountId, other.accountId]);
      expect(await accountsOf(c, forged)).toEqual([
        f.cleanSourceId, f.cleanSourceId, f.cleanSourceId, f.cleanSourceId, f.cleanSourceId]);
    });
  }, 120_000);

  it('(c) a non-document configuration row still refuses the merge, and nothing moves', async () => {
    await withFixture(async (c, f) => {
      const docs = await seedDocuments(c, f.companyId, f.cleanSourceId);
      await c.query(
        `INSERT INTO bank_rules (company_id, name, match_type, match_field, match_value, gl_account_id)
         VALUES ($1, 'doc fixture rule', 'contains', 'description', 'zzz', $2)`,
        [f.companyId, f.cleanSourceId]);

      let code: string | undefined;
      let references: { table: string }[] = [];
      try {
        await mergeAccounts(f.companyId, f.cleanSourceId, f.targetId, USER);
      } catch (err) {
        expect(err).toBeInstanceOf(AccountMergeError);
        code = (err as AccountMergeError).code;
        references = (err as AccountMergeError).references;
      }
      expect(code).toBe('source_referenced_by_configuration');
      // Only the bank rule is named: the four document tables are not configuration.
      expect(references.map((r) => r.table)).toEqual(['bank_rules']);
      expect(await accountsOf(c, docs)).toEqual([
        f.cleanSourceId, f.cleanSourceId, f.cleanSourceId, f.cleanSourceId, f.cleanSourceId]);
    });
  }, 120_000);

  it('(d) the dry run reports the same per-table counts the live merge moves', async () => {
    await withFixture(async (c, f) => {
      await seedDocuments(c, f.companyId, f.cleanSourceId);
      await seedDocuments(c, f.companyId, f.cleanSourceId);
      // A third set with its capture event uncoded, so the counts differ per table.
      const extra = await seedDocuments(c, f.companyId, f.cleanSourceId);
      await c.query('UPDATE capture_events SET resolved_gl_account_id = NULL WHERE id = $1 AND company_id = $2',
        [extra.captureEvent, f.companyId]);

      const preview = await previewAccountMerge(f.companyId, f.cleanSourceId, f.targetId);
      const expected = {
        supplier_invoice_items: 3, customer_invoice_items: 3, expense_claim_lines: 3, po_items: 3, capture_events: 2,
      };
      expect(preview.documentRowsToRepoint).toEqual(expected);

      const result = await mergeAccounts(f.companyId, f.cleanSourceId, f.targetId, USER);
      expect(result.documentRowsRepointed).toEqual(preview.documentRowsToRepoint);
    });
  }, 120_000);

  // The bill-line guard refuses bill lines on control, bank, VAT, system and
  // header accounts. A bill still to be approved or posted whose line moves
  // onto such a target could never be approved again, so the merge refuses.
  it('(e) refuses when a bill still to be posted would land on an account bill lines may not use', async () => {
    await withFixture(async (c, f) => {
      // The fixture's target has a child, so it is a header: refused for bill lines.
      const docs = await seedDocuments(c, f.companyId, f.cleanSourceId, 'draft');

      for (const attempt of [
        () => previewAccountMerge(f.companyId, f.cleanSourceId, f.targetId),
        () => mergeAccounts(f.companyId, f.cleanSourceId, f.targetId, USER),
      ]) {
        const err = await attempt().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(AccountMergeError);
        expect((err as AccountMergeError).code).toBe('target_refused_for_open_bill_lines');
        expect((err as Error).message).toMatch(/ZZ-INV-/);
      }
      expect(await accountsOf(c, docs)).toEqual([
        f.cleanSourceId, f.cleanSourceId, f.cleanSourceId, f.cleanSourceId, f.cleanSourceId]);
    });
  }, 120_000);

  it('(f) a draft bill still moves onto a target bill lines may use', async () => {
    await withFixture(async (c, f) => {
      const docs = await seedDocuments(c, f.companyId, f.cleanSourceId, 'draft');
      await mergeAccounts(f.companyId, f.cleanSourceId, f.targetChildId, USER);
      expect(await accountsOf(c, docs)).toEqual([
        f.targetChildId, f.targetChildId, f.targetChildId, f.targetChildId, f.targetChildId]);
    });
  }, 120_000);
});

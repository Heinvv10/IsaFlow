/**
 * R-032 L5 (Hein, 2026-09-26): no document is approved, posted or decided from a
 * "Login as" session. The session authenticates as the target, so each act would
 * be recorded under the name of someone who did not take it.
 *
 * One real, draft document per type the helper can plant, driven through its
 * real route: the Login-as session gets 403 IMPERSONATION_FORBIDDEN and the
 * document, its journals and the audit trail are exactly as they were. The
 * target's own session is not refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { NextApiHandler } from 'next';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import supplierInvoicesBulk from '../../pages/api/accounting/supplier-invoices-bulk-action';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import creditNotesAction from '../../pages/api/accounting/credit-notes-action';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { plantDocument, type PlantableType } from './approval-document.helpers';
import { loginAsFixture, reasonOf, type Jar } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'R032 L5 docs');

beforeAll(() => fx.setUp());
afterAll(async () => {
  try { await fx.tearDown(); } finally { await pool.end(); }
});

const TABLE: Record<PlantableType, string> = {
  supplier_invoice: 'supplier_invoices', customer_invoice: 'customer_invoices', credit_note: 'credit_notes',
  payment: 'supplier_payments', journal_entry: 'gl_journal_entries',
};

/** Everything an approval could have written for this company, plus the document's own row. */
async function snapshot(type: PlantableType, id: string) {
  const row = await pool.query(`SELECT * FROM ${TABLE[type]} WHERE id=$1`, [id]);
  const counts = await pool.query(`SELECT
      (SELECT count(*) FROM gl_journal_entries WHERE company_id=$1) AS journals,
      (SELECT count(*) FROM gl_journal_lines WHERE company_id=$1) AS lines,
      (SELECT count(*) FROM audit_log WHERE company_id=$1) AS audits`, [fx.company]);
  return { row: row.rows[0], counts: counts.rows[0] };
}

type Case = { name: string; type: PlantableType; handler: NextApiHandler; body: (id: string) => Record<string, unknown> };
const CASES: Case[] = [
  { name: 'supplier invoice approve', type: 'supplier_invoice', handler: supplierInvoicesAction,
    body: (id) => ({ action: 'approve', invoiceId: id }) },
  { name: 'supplier invoice bulk approve', type: 'supplier_invoice', handler: supplierInvoicesBulk,
    body: (id) => ({ action: 'approve', invoiceIds: [id] }) },
  { name: 'supplier invoice bulk post to GL', type: 'supplier_invoice', handler: supplierInvoicesBulk,
    body: (id) => ({ action: 'post_gl', invoiceIds: [id] }) },
  { name: 'customer invoice approve', type: 'customer_invoice', handler: customerInvoicesDetail,
    body: (id) => ({ id, action: 'approve' }) },
  { name: 'customer credit note approve', type: 'credit_note', handler: creditNotesAction,
    body: (id) => ({ action: 'approve', creditNoteId: id }) },
  { name: 'supplier payment approve', type: 'payment', handler: supplierPaymentsAction,
    body: (id) => ({ action: 'approve', paymentId: id }) },
  { name: 'supplier payment process', type: 'payment', handler: supplierPaymentsAction,
    body: (id) => ({ action: 'process', paymentId: id }) },
  { name: 'journal post', type: 'journal_entry', handler: journalEntriesAction,
    body: (id) => ({ id, action: 'post' }) },
];

describe('R-032 L5 — a Login-as session approves, posts and decides nothing', () => {
  let loginAs: Jar;
  beforeAll(async () => { loginAs = await fx.loginAsTarget(); });

  it.each(CASES)('refuses $name with 403 and writes nothing', async ({ type, handler, body }) => {
    const id = await plantDocument(pool, fx.company, type, 1150, fx.target);
    const before = await snapshot(type, id);
    const result = await fx.call(handler, loginAs, { body: body(id) });
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(403);
    expect(reasonOf(result)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await snapshot(type, id)).toEqual(before);
  });
});

describe('R-032 L5 — the target\'s own session is not refused', () => {
  it.each(CASES)('does not refuse $name as an impersonation', async ({ type, handler, body }) => {
    const id = await plantDocument(pool, fx.company, type, 1150, fx.target);
    const result = await fx.call(handler, await fx.ownSession(), { body: body(id) });
    expect(reasonOf(result), JSON.stringify(result.state.body)).not.toBe('IMPERSONATION_FORBIDDEN');
  });

  it('approves a supplier payment end to end', async () => {
    const id = await plantDocument(pool, fx.company, 'payment', 1150, fx.target);
    const result = await fx.call(supplierPaymentsAction, await fx.ownSession(), { body: { action: 'approve', paymentId: id } });
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(200);
    const row = (await pool.query('SELECT status, approved_by FROM supplier_payments WHERE id=$1', [id])).rows[0];
    expect(row).toEqual({ status: 'approved', approved_by: fx.target });
  });
});

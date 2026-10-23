/**
 * R-035 PR A, folded in from the round-2 adversarial review (prA-adv-r2): every no-active-rule sentence ApprovalEnforcementPanel.noRuleNote
 * can print, checked against the REAL posting routes (not evaluateApprovalGate),
 * with enforcement on and the rule rows that must NOT count planted beside it:
 * an INACTIVE rule of the type, a NULL-company template row of the type, and an
 * active rule of the type in ANOTHER company — each matching the document.
 * A red test means a sentence is false.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, newCompany, plantBill, plantRule } from './r035-approval.helpers';
import { billState, postableCompany, routes } from './r035-pr2.helpers';
import { enforceType, noteCompany, noteRoutes, noteState, plantNote } from './r035-pr3.helpers';
import { enforceInvoices, invoiceCompany, invoiceRoutes, invoiceState, plantInvoice } from './r035-pr4.helpers';
import { enforcePay, payCompany, payRoutes, plantBatch, plantPayment } from './r035-pr5.helpers';
import { cleanupPr6, enforceJournals, journalCompany, journalRoutes, journalState, plantJournal } from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const nullRules: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', admin: '', clerk: '' };
const MEMBERS = (): [string, string][] => [[u.owner, 'owner'], [u.admin, 'admin'], [u.clerk, 'manager']];

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'ADV-SPY', mock: true });
});
afterAll(async () => {
  await pool.query('DELETE FROM approval_rules WHERE id = ANY($1::UUID[])', [nullRules]);
  await cleanupPr6(pool, companies, Object.values(u));
});

/** The rows that must not make a type "have an active rule": inactive, NULL-company, another company's. */
async function decoys(c: string, documentType: string) {
  const inactive = await plantRule(pool, c, 'owner', { documentType, operator: 'any', name: 'inactive decoy' });
  await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1', [inactive]);
  const { rows } = await pool.query(
    `INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
     VALUES (NULL,'template decoy',$1,'total','any',0,'owner',true) RETURNING id`, [documentType]);
  nullRules.push(rows[0].id);
  const other = await newCompany(pool, [[u.owner, 'owner']], companies);
  await plantRule(pool, other, 'owner', { documentType, operator: 'any', name: 'other-company decoy' });
}

describe('"gates nothing" (supplier invoice, both credit notes, customer invoice)', () => {
  it('supplier_invoice: a R57 500 bill approves and posts', async () => {
    const c = await postableCompany(pool, MEMBERS(), companies);
    await decoys(c, 'supplier_invoice');
    await pool.query(`INSERT INTO approval_enforcement(company_id,document_type,enabled_by) VALUES($1,'supplier_invoice',$2)`, [c, u.owner]);
    const bill = await plantBill(pool, c, u.clerk, { total: 57500 });
    // Make the planted bill foot at R57 500 (the helper's lines total R1 150).
    await pool.query('UPDATE supplier_invoices SET subtotal = 50000, tax_amount = 7500 WHERE id = $1', [bill.id]);
    await pool.query(`UPDATE supplier_invoice_items SET unit_price = line_total * 50 / quantity, line_total = line_total * 50,
      tax_amount = tax_amount * 50 WHERE supplier_invoice_id = $1`, [bill.id]);
    const res = await routes(tokens).approveBill(u.clerk, c, bill.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await billState(pool, bill.id)).status).toBe('approved');
  });

  it.each(['customer', 'supplier'] as const)('%s_credit_note: a R115 000 note approves and posts', async (type) => {
    const c = await noteCompany(pool, MEMBERS(), companies);
    await decoys(c, `${type}_credit_note`);
    await enforceType(pool, c, type, u.owner);
    const note = await plantNote(pool, c, u.clerk, type, { subtotal: 100000, tax: 15000, total: 115000 });
    const res = await noteRoutes(tokens).approve(u.clerk, c, note.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await noteState(pool, note.id)).gl_journal_entry_id).not.toBeNull();
  });

  it('customer_invoice: a R115 000 invoice approves and posts', async () => {
    const c = await invoiceCompany(pool, MEMBERS(), companies);
    await decoys(c, 'customer_invoice');
    await enforceInvoices(pool, c, u.owner);
    const inv = await plantInvoice(pool, c, u.clerk, { subtotal: 100000, tax: 15000, total: 115000 });
    const res = await invoiceRoutes(tokens).approve(u.clerk, c, inv.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await invoiceState(pool, inv.id)).gl_journal_entry_id).not.toBeNull();
  });
});

it('manual_journal "holds no journal for approval": a R150 000 draft journal posts', async () => {
  const f = await journalCompany(pool, MEMBERS(), companies);
  await decoys(f.c, 'manual_journal');
  await enforceJournals(pool, f.c, u.owner);
  const id = await plantJournal(pool, f, u.clerk, { amount: 150000 });
  const res = await journalRoutes(tokens).post(u.clerk, f.c, id);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  expect((await journalState(pool, id)).status).toBe('posted');
});

describe('coupled payments', () => {
  const RAW = { payments: [{ accountHolder: 'Anyone', bankCode: '250655', accountNumber: '62000000009', amount: 100000, reference: 'x' }] };
  const netcash = (c: string, body: Record<string, unknown>) =>
    callRoute(netcashSubmit, tokens[u.admin]!, c, 'POST', body, '/api/accounting/netcash/submit');
  async function payFixture(ruleOn: 'none' | 'supplier_payment' | 'payment_batch') {
    const { company: c, bank } = await payCompany(pool, MEMBERS(), companies);
    await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
    await decoys(c, 'supplier_payment');
    await decoys(c, 'payment_batch');
    if (ruleOn !== 'none') {
      await plantRule(pool, c, 'owner', { documentType: ruleOn, operator: 'greater_than', value: 100000, name: 'Large payments' });
    }
    await enforcePay(pool, c, 'supplier_payment', u.owner);
    return { c, bank };
  }

  it('neither: "holds no payment for an approver" — a R150 000 payment and batch both approve', async () => {
    const { c, bank } = await payFixture('none');
    const pay = await plantPayment(pool, c, u.clerk, bank, { amount: 150000 });
    const batch = await plantBatch(pool, c, u.clerk, bank, [150000]);
    const r = payRoutes(tokens);
    expect((await r.payment(u.admin, c, 'approve', pay.id)).state.statusCode).toBe(200);
    expect((await r.batch(u.admin, c, 'approve', batch.id)).state.statusCode).toBe(200);
  });

  it('neither: "bank file only after the batch is approved" — a draft batch is refused, the approved one is sent', async () => {
    const { c, bank } = await payFixture('none');
    const batch = await plantBatch(pool, c, u.clerk, bank, [150000]);
    expect((await netcash(c, { batchPaymentId: batch.id })).state.statusCode).toBe(409);
    expect((await payRoutes(tokens).batch(u.admin, c, 'approve', batch.id)).state.statusCode).toBe(200);
    const sent = await netcash(c, { batchPaymentId: batch.id });
    expect(sent.state.statusCode, JSON.stringify(sent.state.body)).toBe(200);
  });

  it.each(['none', 'payment_batch'] as const)('%s: "a raw Netcash payment list is refused" (400 since AP-01: every raw list)', async (ruleOn) => {
    const { c } = await payFixture(ruleOn);
    expect((await netcash(c, RAW)).state.statusCode).toBe(400);
    expect(submitEftBatch).not.toHaveBeenCalled();
  });

  it('only a batch rule: "gates only payment batches" — a R150 000 payment approves, a R150 000 batch is refused', async () => {
    const { c, bank } = await payFixture('payment_batch');
    const pay = await plantPayment(pool, c, u.clerk, bank, { amount: 150000 });
    const batch = await plantBatch(pool, c, u.clerk, bank, [150000]);
    const r = payRoutes(tokens);
    expect((await r.payment(u.admin, c, 'approve', pay.id)).state.statusCode).toBe(200);
    expect((await r.batch(u.admin, c, 'approve', batch.id)).state.statusCode).toBe(409);
  });

  it('only a payment rule: the batch row says nothing because a R150 000 batch IS refused', async () => {
    const { c, bank } = await payFixture('supplier_payment');
    const batch = await plantBatch(pool, c, u.clerk, bank, [150000]);
    expect((await payRoutes(tokens).batch(u.admin, c, 'approve', batch.id)).state.statusCode).toBe(409);
  });
});

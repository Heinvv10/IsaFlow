/**
 * R-035 PR5: approval enforcement on a SINGLE supplier payment through the
 * real route (supplier-payments-action). Approve (draft -> approved) and
 * process (approved -> processed: DR AP / CR bank, every bill's amount_paid)
 * are each an instruction to pay, so each is refused 409 — before any write —
 * until an APPROVED request exists for the payment's CURRENT content, at the
 * rank the strictest rule today demands, decided since enforcement was
 * switched on. Process re-checks: an approval taken before enforcement, or
 * content that moved after approval, is not paid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr5, enforcePay, payCompany, paymentState, payRoutes, plantPayment } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', m: '' };
const r = payRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

/** A (admin) creates and requests; B (owner) approves; M is a manager. */
const company = () => payCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);

async function gated(opts: { rule?: string; enforced?: boolean; status?: string } = {}) {
  const { company: c, bank } = await company();
  await plantRule(pool, c, opts.rule ?? 'owner', { documentType: 'supplier_payment', name: 'Owner pays' });
  if (opts.enforced !== false) await enforcePay(pool, c, 'supplier_payment', u.b);
  return { c, p: await plantPayment(pool, c, u.a, bank, { status: opts.status }) };
}

/** Everything approve or process could have written. */
async function footprint(c: string, id: string) {
  const { rows: [row] } = await pool.query(
    'SELECT status, approved_by, approved_at, processed_at, updated_at, gl_journal_entry_id FROM supplier_payments WHERE id = $1', [id]);
  return { ...row, ...(await paymentState(pool, id)), c };
}

describe('approve', () => {
  it('the enforcement API switches supplier_payment on (200) — and payment_batch with it (coupled, D1)', async () => {
    const { company: c } = await company();
    const res = await callRoute(approvalEnforcement, tokens[u.b]!, c, 'POST',
      { documentType: 'supplier_payment', enabled: true }, '/api/accounting/approval-enforcement');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { rows } = await pool.query('SELECT document_type FROM approval_enforcement WHERE company_id = $1 ORDER BY 1', [c]);
    expect(rows.map((x) => x.document_type)).toEqual(['payment_batch', 'supplier_payment']);
  });

  it('refuses 409 APPROVAL_REQUIRED before any write, naming the payment', async () => {
    const { c, p } = await gated();
    const before = await footprint(c, p.id);
    const res = await r.payment(u.a, c, 'approve', p.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).toBe(`Supplier payment ${p.number} needs owner approval before it can be paid (rule: Owner pays).`);
    expect(await footprint(c, p.id)).toEqual(before);
    expect(before).toMatchObject({ status: 'draft', approved_by: null, journals: 0, paid: 0 });
  });

  it('refuses 409 APPROVAL_PENDING while the request awaits a decision', async () => {
    const { c, p } = await gated();
    expect((await r.raise(u.a, c, 'supplier_payment', p.id)).state.statusCode).toBe(200);
    const res = await r.payment(u.a, c, 'approve', p.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_PENDING');
  });

  it('A requests, B approves the request, A approves then processes: 200, the journal and the bill paid', async () => {
    const { c, p } = await gated();
    await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', p.id);
    const approved = await r.payment(u.a, c, 'approve', p.id);
    expect(approved.state.statusCode, JSON.stringify(approved.state.body)).toBe(200);
    const processed = await r.payment(u.a, c, 'process', p.id);
    expect(processed.state.statusCode, JSON.stringify(processed.state.body)).toBe(200);
    expect(await paymentState(pool, p.id)).toMatchObject({ status: 'processed', journals: 1, paid: 1150 });
  });

  it('the rank ratchet: a manager-rule approval does not clear once an owner rule governs', async () => {
    const { c, p } = await gated({ rule: 'manager' });
    await r.approvedBy(pool, u.a, u.m, c, 'supplier_payment', p.id);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', name: 'Owner pays' });
    const res = await r.payment(u.a, c, 'approve', p.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect((await paymentState(pool, p.id)).status).toBe('draft');
  });

  it('an approval for content that moved is STALE; reverting the content clears it again (Q9)', async () => {
    const { c, p } = await gated();
    await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', p.id);
    await pool.query("UPDATE supplier_payments SET reference = 'moved' WHERE id = $1", [p.id]);
    const stale = await r.payment(u.a, c, 'approve', p.id);
    expect(stale.state.statusCode).toBe(409);
    expect(reasonOf(stale)).toBe('APPROVAL_STALE');
    await pool.query("UPDATE supplier_payments SET reference = 'R035 ref' WHERE id = $1", [p.id]);
    expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
  });
});

describe('process', () => {
  it('an approved payment from before enforcement is refused 409 at process: no journal, no bill paid, still approved', async () => {
    const { c, p } = await gated({ enforced: false });
    expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
    await enforcePay(pool, c, 'supplier_payment', u.b);
    const before = await footprint(c, p.id);
    const res = await r.payment(u.a, c, 'process', p.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(await footprint(c, p.id)).toEqual(before);
    expect(before).toMatchObject({ status: 'approved', journals: 0, paid: 0, processed_at: null });
  });

  it('an approval decided BEFORE enforcement was switched on clears nothing', async () => {
    const { c, p } = await gated({ enforced: false });
    await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', p.id);
    await enforcePay(pool, c, 'supplier_payment', u.b, new Date(Date.now() + 1000).toISOString());
    const res = await r.payment(u.a, c, 'approve', p.id);
    expect(res.state.statusCode).toBe(409);
  });

  it('content that moved between approve and process is refused STALE at process', async () => {
    const { c, p } = await gated();
    await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', p.id);
    expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
    await pool.query("UPDATE suppliers SET bank_account_number = '999' WHERE id = $1", [p.supplierId]);
    const res = await r.payment(u.a, c, 'process', p.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_STALE');
    expect(await paymentState(pool, p.id)).toMatchObject({ status: 'approved', journals: 0, paid: 0 });
  });
});

describe('scope', () => {
  it('enforcement off: approve and process run as before, with no approval state', async () => {
    const { c, p } = await gated({ enforced: false });
    expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
    expect((await r.payment(u.a, c, 'process', p.id)).state.statusCode).toBe(200);
    expect((await paymentState(pool, p.id)).status).toBe('processed');
  });

  it('no rule matches the amount: not gated', async () => {
    const { company: c, bank } = await company();
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', operator: 'greater_than', value: 5000 });
    await enforcePay(pool, c, 'supplier_payment', u.b);
    const p = await plantPayment(pool, c, u.a, bank);
    expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
  });

  it("tenant isolation: another company's enforcement, rules and approved rows bind nothing here", async () => {
    const { c, p } = await gated();
    const { company: other } = await company();
    await enforcePay(pool, other, 'supplier_payment', u.b);
    const digest = (await pool.query("SELECT approval_document_digest($1,'supplier_payment',$2) AS d", [c, p.id])).rows[0].d;
    await pool.query(
      `INSERT INTO approval_requests(company_id,document_type,document_id,amount,requested_by,status,required_role,document_digest,decided_by,decided_at)
       VALUES($1,'supplier_payment',$2,1150,$3,'approved','owner',$4,$5,now())`, [other, p.id, u.a, digest, u.b]);
    expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(409);
  });

  it('a NULL-digest approved row clears nothing', async () => {
    const { c, p } = await gated();
    await pool.query(
      `INSERT INTO approval_requests(company_id,document_type,document_id,amount,requested_by,status,required_role,decided_by,decided_at)
       VALUES($1,'supplier_payment',$2,1150,$3,'approved','owner',$4,now())`, [c, p.id, u.a, u.b]);
    expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(409);
  });

  it('the detail GET shows the derived state: required, pending, approved', async () => {
    const { c, p } = await gated();
    const state = async () => dataOf<{ approval: { state: string } | null }>(await r.getPayment(u.a, c, p.id)).approval?.state;
    expect(await state()).toBe('required');
    const raised = dataOf<{ id: string }>(await r.raise(u.a, c, 'supplier_payment', p.id));
    expect(await state()).toBe('pending');
    expect((await r.decide(pool, u.b, c, raised.id)).state.statusCode).toBe(200);
    expect(await state()).toBe('approved');
    // Where the money goes, read live (round 1 LOW c).
    expect(dataOf<{ payeeBank: unknown }>(await r.getPayment(u.a, c, p.id)).payeeBank).toEqual({
      bankName: 'R035 Bank', accountNumber: '62000000001', branchCode: '250655', accountHolder: 'R035 Holder' });
  });
});

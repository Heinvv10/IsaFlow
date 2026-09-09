import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
import { requestOperationApproval, decideOperationApproval, getApprovalRequirements } from '@/modules/accounting/services/controls/approvalRequestService';
import { executeControlledOperation } from '@/modules/accounting/services/controls/approvalExecutionService';

const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY = randomBytes(32).toString('hex');
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 4 });
let fixture: ForensicFixture;
const supplier = randomUUID(), invoice = randomUUID(), payment = randomUUID(), rule = randomUUID();
const ref: OperationRef = { operation: 'supplier_payment.process', entityType: 'supplier_payment', entityId: payment };
async function request<T>(person: 'u1' | 'u2' | 'u3', fn: (ctx: ControlTx) => Promise<T>, bearer = false): Promise<T> {
  const user = fixture[person], client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
      [JSON.stringify({ sub: user.id, company_id: user.companyId, role: 'authenticated' }), user.companyId]);
    const token = user.tokens[bearer && person === 'u1' ? 1 : 0]!;
    const result = await withControlRequest({ client, userId: user.id, companyId: user.companyId, claims: {} },
      { personId: user.id, companyId: user.companyId, authMethod: bearer ? 'pat' : 'cookie',
        ...(bearer ? { connectionId: token.id, grantId: token.id, grantedScopes: ['write:approvals', 'write:invoices', 'write:post'] } : {}) },
      () => fn(requireControlTx()));
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
beforeAll(async () => {
  fixture = await provisionForensicFixture(config);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, fixture.companyA, 'Forensic supplier']);
  await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency,created_by)
    VALUES($1,$2,$3,'FORENSIC-KERNEL','2026-09-09',100,15,115,'ZAR',$4)`, [invoice, fixture.companyA, supplier, fixture.u1.id]);
  await pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_amount)
    VALUES($1,'Synthetic goods',1,100,100,15)`, [invoice]);
  await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,created_by)
    VALUES($1,$2,$3,'FORENSIC-PAY','2026-09-09',115,'approved',$4)`, [payment, fixture.companyA, supplier, fixture.u1.id]);
  await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)', [payment, invoice]);
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Kernel test policy','payment','amount','any',0,'admin')`, [rule, fixture.companyA]);
});
afterAll(async () => { await pool.end(); });
it('inspects without historical writes and rejects same-person second-token decisions', async () => {
  const before = await pool.query('SELECT id FROM control_change_events WHERE company_id=$1', [fixture.companyA]);
  const requirement = await request('u1', ctx => getApprovalRequirements(ctx, ref));
  expect(requirement.requiresApproval).toBe(true);
  expect((await pool.query('SELECT id FROM control_change_events WHERE company_id=$1', [fixture.companyA])).rows).toEqual(before.rows);
  const approval = await request('u1', ctx => requestOperationApproval(ctx, ref));
  await expect(request('u1', ctx => decideOperationApproval(ctx, approval.id, 'approved'), true)).rejects.toThrow();
  await expect(request('u1', ctx => decideOperationApproval(ctx, approval.id, 'approved'))).rejects.toThrow('Self');
  await expect(request('u3', ctx => decideOperationApproval(ctx, approval.id, 'approved'))).rejects.toThrow();
});
it('independent approval executes once; failed effect rolls back consumption for a valid retry', async () => {
  const approval = await request('u1', ctx => requestOperationApproval(ctx, ref));
  expect((await request('u2', ctx => decideOperationApproval(ctx, approval.id, 'approved'))).status).toBe('approved');
  await expect(request('u1', ctx => executeControlledOperation(ctx, ref, approval.id, async () => {
    await ctx.sql`UPDATE supplier_payments SET description='rolled back' WHERE company_id=${fixture.companyA}::uuid AND id=${payment}::uuid`;
    throw new Error('Synthetic effect failure');
  }))).rejects.toThrow('Synthetic effect failure');
  expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2', [fixture.companyA, approval.id])).rows[0].status).toBe('approved');
  const run = () => request('u1', ctx => executeControlledOperation(ctx, ref, approval.id, async () => {
    await ctx.sql`UPDATE supplier_payments SET description='one effect' WHERE company_id=${fixture.companyA}::uuid AND id=${payment}::uuid`;
    return { paymentId: payment };
  }));
  const results = await Promise.allSettled([run(), run()]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2', [fixture.companyA, payment])).rows).toHaveLength(1);
});

async function freshPayment(amount = '115'): Promise<OperationRef> {
  const id = randomUUID(), bill = randomUUID();
  await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,currency,created_by)
    VALUES($1,$2,$3,$4,'2026-09-09',$5,'ZAR',$6)`, [bill, fixture.companyA, supplier, bill, amount, fixture.u1.id]);
  await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,created_by)
    VALUES($1,$2,$3,'2026-09-09',$4,'approved',$5)`, [id, fixture.companyA, supplier, amount, fixture.u1.id]);
  await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)', [id, bill, amount]);
  return { ...ref, entityId: id };
}
const noEffect = async () => ({ accepted: true });
it('refuses expired, canceled and rejected approvals without an effect', async () => {
  for (const state of ['expired', 'cancelled', 'rejected'] as const) {
    const targetRef = await freshPayment();
    const approval = await request('u1', ctx => requestOperationApproval(ctx, targetRef));
    if (state === 'expired') {
      await request('u2', ctx => decideOperationApproval(ctx, approval.id, 'approved'));
      await pool.query("UPDATE control_operation_approvals SET requested_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 minute' WHERE company_id=$1 AND id=$2", [fixture.companyA, approval.id]);
    } else {
      await request(state === 'cancelled' ? 'u1' : 'u2', ctx => decideOperationApproval(ctx, approval.id, state));
    }
    await expect(request('u1', ctx => executeControlledOperation(ctx, targetRef, approval.id, noEffect))).rejects.toThrow();
    expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2', [fixture.companyA, targetRef.entityId])).rows).toHaveLength(0);
  }
});
it('refuses changed material and changed policy after independent approval', async () => {
  for (const change of ['amount', 'policy']) {
    const targetRef = await freshPayment();
    const approval = await request('u1', ctx => requestOperationApproval(ctx, targetRef));
    await request('u2', ctx => decideOperationApproval(ctx, approval.id, 'approved'));
    if (change === 'amount') {
      await pool.query('UPDATE supplier_payments SET total_amount=116 WHERE company_id=$1 AND id=$2', [fixture.companyA, targetRef.entityId]);
      await pool.query('UPDATE payment_allocations SET amount_allocated=116 WHERE payment_id=$1', [targetRef.entityId]);
    } else { await pool.query('UPDATE approval_rules SET condition_value=1 WHERE company_id=$1 AND id=$2', [fixture.companyA, rule]); }
    await expect(request('u1', ctx => executeControlledOperation(ctx, targetRef, approval.id, noEffect))).rejects.toThrow('material');
  }
});
it('rechecks current approver membership and explicit permission at execution', async () => {
  for (const change of ['role', 'inactive', 'deny']) {
    const targetRef = await freshPayment();
    const approval = await request('u1', ctx => requestOperationApproval(ctx, targetRef));
    await request('u2', ctx => decideOperationApproval(ctx, approval.id, 'approved'));
    try {
      if (change === 'role') await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2", [fixture.companyA, fixture.u2.id]);
      if (change === 'inactive') await pool.query('UPDATE users SET is_active=false WHERE id=$1', [fixture.u2.id]);
      if (change === 'deny') await pool.query(`INSERT INTO company_user_permissions(company_id,user_id,module_key,can_approve)
        VALUES($1,$2,'approvals',false)`, [fixture.companyA, fixture.u2.id]);
      await expect(request('u1', ctx => executeControlledOperation(ctx, targetRef, approval.id, noEffect))).rejects.toThrow();
    } finally {
      await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2", [fixture.companyA, fixture.u2.id]);
      await pool.query('UPDATE users SET is_active=true WHERE id=$1', [fixture.u2.id]);
      await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='approvals'", [fixture.companyA, fixture.u2.id]);
    }
  }
});
it('requires every current matching policy and rejects unsupported active rule semantics', async () => {
  const second = randomUUID();
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Second policy','payment','amount','any',0,'admin')`, [second, fixture.companyA]);
  try {
    const targetRef = await freshPayment();
    const approval = await request('u1', ctx => requestOperationApproval(ctx, targetRef));
    await request('u2', ctx => decideOperationApproval(ctx, approval.id, 'approved'));
    expect((await pool.query('SELECT policy_id FROM control_operation_decisions WHERE company_id=$1 AND approval_id=$2', [fixture.companyA, approval.id])).rows).toHaveLength(2);
    await pool.query('DELETE FROM control_operation_decisions WHERE company_id=$1 AND approval_id=$2 AND policy_id=$3', [fixture.companyA, approval.id, second]);
    await expect(request('u1', ctx => executeControlledOperation(ctx, targetRef, approval.id, noEffect))).rejects.toThrow('Independent');
    await pool.query("UPDATE approval_rules SET condition_operator='unsupported' WHERE company_id=$1 AND id=$2", [fixture.companyA, second]);
    await expect(request('u1', ctx => getApprovalRequirements(ctx, targetRef))).rejects.toThrow('Unsupported');
  } finally { await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2', [fixture.companyA, second]); }
});
it('rejects beneficiary changes and newly matching policy after approval', async () => {
  for (const change of ['beneficiary', 'insert-policy']) {
    const targetRef = await freshPayment();
    const approval = await request('u1', ctx => requestOperationApproval(ctx, targetRef));
    await request('u2', ctx => decideOperationApproval(ctx, approval.id, 'approved'));
    const added = randomUUID();
    try {
      if (change === 'beneficiary') await pool.query('UPDATE suppliers SET bank_account_number=$1 WHERE company_id=$2 AND id=$3', [randomUUID(), fixture.companyA, supplier]);
      else await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
        VALUES($1,$2,'New matching policy','payment','amount','any',0,'admin')`, [added, fixture.companyA]);
      await expect(request('u1', ctx => executeControlledOperation(ctx, targetRef, approval.id, noEffect))).rejects.toThrow('material');
    } finally { await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2', [fixture.companyA, added]); }
  }
});
it('refuses a human without the configured role and rechecks requester revocation', async () => {
  const targetRef = await freshPayment();
  const approval = await request('u1', ctx => requestOperationApproval(ctx, targetRef));
  try {
    await pool.query("UPDATE company_users SET role='owner' WHERE company_id=$1 AND user_id=$2", [fixture.companyA, fixture.u2.id]);
    await expect(request('u2', ctx => decideOperationApproval(ctx, approval.id, 'approved'))).rejects.toThrow('role');
  } finally { await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2", [fixture.companyA, fixture.u2.id]); }
  await request('u2', ctx => decideOperationApproval(ctx, approval.id, 'approved'));
  try {
    await pool.query('UPDATE users SET is_active=false WHERE id=$1', [fixture.u1.id]);
    await expect(request('u2', ctx => executeControlledOperation(ctx, targetRef, approval.id, noEffect))).rejects.toThrow('authority');
  } finally { await pool.query('UPDATE users SET is_active=true WHERE id=$1', [fixture.u1.id]); }
});
it('binds invoice line totals and treats approve/post as the same controlled operation', async () => {
  const invoiceRule = randomUUID();
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Invoice policy','supplier_invoice','amount','any',0,'admin')`, [invoiceRule, fixture.companyA]);
  const invoiceRef: OperationRef = { operation: 'supplier_invoice.approve', entityType: 'supplier_invoice', entityId: invoice };
  try {
    const approval = await request('u1', ctx => requestOperationApproval(ctx, invoiceRef));
    await request('u2', ctx => decideOperationApproval(ctx, approval.id, 'approved'));
    await expect(request('u1', ctx => executeControlledOperation(ctx, { ...invoiceRef, operation: 'supplier_invoice.post' }, approval.id, noEffect))).resolves.toEqual({ accepted: true });
    await expect(request('u1', ctx => executeControlledOperation(ctx, invoiceRef, approval.id, noEffect))).rejects.toThrow();
  } finally { await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2', [fixture.companyA, invoiceRule]); }
});
it('serializes same-day supplier exposure so concurrent split operations cannot both avoid approval', async () => {
  await pool.query(`UPDATE approval_rules SET condition_operator='greater_than',condition_value=10000,
    aggregate_window_days=1,aggregate_by='supplier' WHERE company_id=$1 AND id=$2`, [fixture.companyA, rule]);
  const first = await freshPayment('6000'), second = await freshPayment('6000');
  const results = await Promise.allSettled([first, second].map(targetRef => request('u1', ctx => executeControlledOperation(ctx, targetRef, null, noEffect))));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const total = (await pool.query("SELECT sum(amount)::text amount FROM control_policy_exposure WHERE company_id=$1 AND state='committed'", [fixture.companyA])).rows[0];
  expect(Number(total.amount)).toBe(6000);
});

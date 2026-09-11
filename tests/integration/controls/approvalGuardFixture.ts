import { afterAll, beforeAll, expect } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { seedApAccounts } from './apSyntheticAccounts';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
import { requestOperationApproval, decideOperationApproval } from '@/modules/accounting/services/controls/approvalRequestService';
import { executeControlledOperation } from '@/modules/accounting/services/controls/approvalExecutionService';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'consumed';
export type Person = 'u1' | 'u2' | 'u3';
/** app_user and platform_admin are the roles holding UPDATE(status); superuser stands for every other role. */
export type Role = 'app_user' | 'platform_admin' | 'superuser';
export type Statement = readonly [string, unknown[]];
/** A 688/689 refusal: one SQLSTATE, and a message naming the guard. */
export const refused = (guard: 'birth' | 'transition' | 'decision') =>
  ({ code: '23514', message: expect.stringMatching(new RegExp(`^Approval ${guard} refused`)) });
export const noEffect = async () => ({ accepted: true });

/** One company with one payment policy (admin approver); u1 requests, u2 is the independent admin, u3 is in company B. */
export function approvalGuardSuite(policy: { operator: 'any' | 'greater_than'; value: number; aggregate: boolean } =
  { operator: 'any', value: 0, aggregate: false }) {
  const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.CONTROL_FINGERPRINT_KEY = randomBytes(32).toString('hex');
  const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 4 });
  const supplier = randomUUID(), rule = randomUUID();
  let fixture: ForensicFixture;
  beforeAll(async () => {
    fixture = await provisionForensicFixture(config);
    await seedApAccounts(pool, fixture.companyA);
    await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, fixture.companyA, 'Approval guard supplier']);
    await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,
      approver_role,aggregate_window_days,aggregate_by) VALUES($1,$2,'Approval guard policy','payment','amount',$3,$4,'admin',$5,$6)`,
    [rule, fixture.companyA, policy.operator, policy.value, policy.aggregate ? 1 : null, policy.aggregate ? 'supplier' : null]);
  });
  afterAll(async () => { await pool.end(); });

  async function request<T>(person: 'u1' | 'u2', fn: (ctx: ControlTx) => Promise<T>): Promise<T> {
    const user = fixture[person], client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
        [JSON.stringify({ sub: user.id, company_id: user.companyId, role: 'authenticated' }), user.companyId]);
      const result = await withControlRequest({ client, userId: user.id, companyId: user.companyId, claims: {} },
        { personId: user.id, companyId: user.companyId, authMethod: 'cookie' }, () => fn(requireControlTx()));
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  /** Statements in one transaction as `role`, with `person` the acting request principal (null: none). Last row count. */
  async function as(role: Role, person: Person | null, statements: readonly Statement[]): Promise<number | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (role !== 'superuser') await client.query(role === 'app_user' ? 'SET LOCAL ROLE app_user' : 'SET LOCAL ROLE platform_admin');
      if (person) await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
        [JSON.stringify({ sub: fixture[person].id, company_id: fixture[person].companyId, role: 'authenticated' }), fixture[person].companyId]);
      let count: number | null = null;
      for (const [text, params] of statements) count = (await client.query(text, params)).rowCount;
      await client.query('COMMIT'); return count;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  /** Runs one statement as a superuser and always rolls it back, so a mutation run cannot damage the shared fixture. */
  async function attempt(statement: Statement): Promise<void> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(statement[0], statement[1]); }
    finally { await client.query('ROLLBACK'); client.release(); }
  }
  const setApproval = (id: string, set: string): Statement =>
    [`UPDATE control_operation_approvals SET ${set} WHERE company_id=$1 AND id=$2`, [fixture.companyA, id]];
  const decide = (id: string, policyId: string, person: Person, decision = 'approved'): Statement =>
    [`INSERT INTO control_operation_decisions(company_id,approval_id,policy_id,person_id,decision,evidence_refs)
      VALUES($1,$2,$3,$4,$5,'[]'::jsonb)`, [fixture.companyA, id, policyId, fixture[person].id, decision]];
  const snapshot = async (id: string) => (await pool.query(
    "SELECT to_jsonb(a)-'entity_id_canonical' AS row FROM control_operation_approvals a WHERE company_id=$1 AND id=$2",
    [fixture.companyA, id])).rows[0]?.row;
  const effects = async (ref: OperationRef) => (await pool.query(
    'SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2', [fixture.companyA, ref.entityId])).rows.length;
  const decisions = async (id: string) => (await pool.query(
    'SELECT policy_id,person_id,decision FROM control_operation_decisions WHERE company_id=$1 AND approval_id=$2', [fixture.companyA, id])).rows;
  async function policyIds(id: string): Promise<string[]> {
    return ((await snapshot(id)).binding.policies as Array<{ policyId: string }>).map(bound => bound.policyId);
  }
  async function freshPayment(amount = 115): Promise<OperationRef> {
    const id = randomUUID(), bill = randomUUID();
    await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,currency,created_by)
      VALUES($1,$2,$3,$4,'2026-09-09',$5,'ZAR',$6)`, [bill, fixture.companyA, supplier, bill, amount, fixture.u1.id]);
    await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,created_by)
      VALUES($1,$2,$3,'2026-09-09',$4,'approved',$5)`, [id, fixture.companyA, supplier, amount, fixture.u1.id]);
    await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)', [id, bill, amount]);
    return { operation: 'supplier_payment.process', entityType: 'supplier_payment', entityId: id };
  }
  /** Reaches `state` through the services alone: the edges 688 must keep. */
  async function approval(state: ApprovalState, amount = 115): Promise<{ id: string; ref: OperationRef }> {
    const ref = await freshPayment(amount);
    const { id } = await request('u1', ctx => requestOperationApproval(ctx, ref));
    if (state === 'rejected') await request('u2', ctx => decideOperationApproval(ctx, id, 'rejected'));
    if (state === 'approved' || state === 'cancelled' || state === 'consumed') await request('u2', ctx => decideOperationApproval(ctx, id, 'approved'));
    if (state === 'cancelled') await request('u1', ctx => decideOperationApproval(ctx, id, 'cancelled'));
    if (state === 'consumed') await request('u1', ctx => executeControlledOperation(ctx, ref, id, noEffect));
    expect((await snapshot(id)).status).toBe(state);
    return { id, ref };
  }
  return { pool, fixture: () => fixture, request, as, attempt, setApproval, decide, snapshot, effects, decisions, policyIds,
    freshPayment, approval };
}

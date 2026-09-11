import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { seedApAccounts } from './apSyntheticAccounts';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
import { requestOperationApproval, decideOperationApproval } from '@/modules/accounting/services/controls/approvalRequestService';
import { executeControlledOperation } from '@/modules/accounting/services/controls/approvalExecutionService';

// Migration 688: an approval moves only along the transitions the code makes, whatever role writes it.
const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY = randomBytes(32).toString('hex');
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 4 });
let fixture: ForensicFixture;
const supplier = randomUUID(), rule = randomUUID();
const REFUSED = { code: '23514', message: expect.stringMatching(/^Approval transition refused/) };
type State = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'consumed';

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
/** A direct UPDATE as the requester's app_user session, or as platform_admin, the two roles holding UPDATE(status). */
async function asRole(role: 'app_user' | 'platform_admin', id: string, set: string): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query(role === 'app_user' ? 'SET LOCAL ROLE app_user' : 'SET LOCAL ROLE platform_admin');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
      [JSON.stringify({ sub: fixture.u1.id, company_id: fixture.companyA, role: 'authenticated' }), fixture.companyA]);
    const result = await client.query(`UPDATE control_operation_approvals SET ${set} WHERE company_id=$1 AND id=$2`, [fixture.companyA, id]);
    await client.query('COMMIT'); return result.rowCount;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
const snapshot = async (id: string) => (await pool.query(
  "SELECT to_jsonb(a)-'entity_id_canonical' AS row FROM control_operation_approvals a WHERE company_id=$1 AND id=$2", [fixture.companyA, id])).rows[0]?.row;
const effects = async (ref: OperationRef) => (await pool.query(
  'SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2', [fixture.companyA, ref.entityId])).rows.length;
const noEffect = async () => ({ accepted: true });

async function freshPayment(): Promise<OperationRef> {
  const id = randomUUID(), bill = randomUUID();
  await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,currency,created_by)
    VALUES($1,$2,$3,$4,'2026-09-09',115,'ZAR',$5)`, [bill, fixture.companyA, supplier, bill, fixture.u1.id]);
  await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,created_by)
    VALUES($1,$2,$3,'2026-09-09',115,'approved',$4)`, [id, fixture.companyA, supplier, fixture.u1.id]);
  await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)', [id, bill]);
  return { operation: 'supplier_payment.process', entityType: 'supplier_payment', entityId: id };
}
/** Reaches `state` through the services alone: the transitions 688 must keep. */
async function approval(state: State): Promise<{ id: string; ref: OperationRef }> {
  const ref = await freshPayment();
  const { id } = await request('u1', ctx => requestOperationApproval(ctx, ref));
  if (state === 'rejected') await request('u2', ctx => decideOperationApproval(ctx, id, 'rejected'));
  if (state === 'approved' || state === 'cancelled' || state === 'consumed') await request('u2', ctx => decideOperationApproval(ctx, id, 'approved'));
  if (state === 'cancelled') await request('u1', ctx => decideOperationApproval(ctx, id, 'cancelled'));
  if (state === 'consumed') await request('u1', ctx => executeControlledOperation(ctx, ref, id, noEffect));
  expect((await snapshot(id)).status).toBe(state);
  return { id, ref };
}
async function policyIds(id: string): Promise<string[]> {
  const [row] = (await pool.query('SELECT binding FROM control_operation_approvals WHERE company_id=$1 AND id=$2', [fixture.companyA, id])).rows;
  return (row.binding.policies as Array<{ policyId: string }>).map(policy => policy.policyId);
}
async function recordDecision(id: string, person: string): Promise<void> {
  for (const policy of await policyIds(id)) await pool.query(`INSERT INTO control_operation_decisions(company_id,approval_id,policy_id,person_id,decision,evidence_refs)
    VALUES($1,$2,$3,$4,'approved','[]'::jsonb)`, [fixture.companyA, id, policy, person]);
}

beforeAll(async () => {
  fixture = await provisionForensicFixture(config);
  await seedApAccounts(pool, fixture.companyA);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, fixture.companyA, 'Transition supplier']);
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Transition policy','payment','amount','any',0,'admin')`, [rule, fixture.companyA]);
});
afterAll(async () => { await pool.end(); });

it('(a) refuses reviving a cancelled or rejected approval, and it stays unexecutable', async () => {
  for (const state of ['cancelled', 'rejected'] as const) {
    const { id, ref } = await approval(state), before = await snapshot(id);
    for (const role of ['app_user', 'platform_admin'] as const) {
      // status alone: platform_admin holds no UPDATE(decided_at), and a grant refusal is not the guard's.
      await expect(asRole(role, id, "status='approved'"), `${role} revives ${state}`).rejects.toMatchObject(REFUSED);
      await expect(asRole(role, id, "status='pending'"), `${role} re-opens ${state}`).rejects.toMatchObject(REFUSED);
    }
    expect(await snapshot(id)).toEqual(before);
    await expect(request('u1', ctx => executeControlledOperation(ctx, ref, id, noEffect))).rejects.toThrow();
    expect(await effects(ref)).toBe(0);
  }
});

it('(b) refuses re-opening, re-pointing or erasing a consumed approval', async () => {
  const { id } = await approval('consumed'), before = await snapshot(id);
  for (const role of ['app_user', 'platform_admin'] as const) {
    for (const set of ["status='approved'", "status='cancelled'", 'consumed_effect_id=NULL',
      `consumed_effect_id='${randomUUID()}'`, 'consumed_at=clock_timestamp()']) {
      await expect(asRole(role, id, set), `${role}: ${set}`).rejects.toMatchObject(REFUSED);
    }
  }
  expect(await snapshot(id)).toEqual(before);
});

it('(c) approves only with an independent approved decision for every policy, and consumes only its own effect', async () => {
  const bare = await approval('pending');
  await expect(asRole('app_user', bare.id, "status='approved',decided_at=clock_timestamp()"), 'no decision').rejects.toMatchObject(REFUSED);
  await expect(asRole('app_user', bare.id, `status='consumed',consumed_at=clock_timestamp(),consumed_effect_id='${randomUUID()}'`)).rejects.toMatchObject(REFUSED);
  await recordDecision(bare.id, fixture.u1.id);
  await expect(asRole('app_user', bare.id, "status='approved',decided_at=clock_timestamp()"), 'requester decision').rejects.toMatchObject(REFUSED);
  expect((await snapshot(bare.id)).status).toBe('pending');

  const decided = await approval('pending');
  await recordDecision(decided.id, fixture.u2.id);
  expect(await asRole('app_user', decided.id, "status='approved',decided_at=clock_timestamp()"), 'independent decision').toBe(1);

  const approved = await approval('approved'), consumed = await approval('consumed');
  const foreignEffect = (await snapshot(consumed.id)).consumed_effect_id as string;
  for (const effectId of [randomUUID(), foreignEffect]) {
    await expect(asRole('app_user', approved.id, `status='consumed',consumed_at=clock_timestamp(),consumed_effect_id='${effectId}'`)).rejects.toMatchObject(REFUSED);
  }
  await expect(asRole('app_user', approved.id, "status='pending'")).rejects.toMatchObject(REFUSED);
  await expect(asRole('app_user', approved.id, 'decided_at=clock_timestamp()')).rejects.toMatchObject(REFUSED);
  expect((await snapshot(approved.id)).status).toBe('approved');
});

it('(d) refuses rewriting identity, binding, requester or expiry, even as a superuser', async () => {
  for (const state of ['pending', 'consumed'] as const) {
    const { id } = await approval(state), before = await snapshot(id);
    for (const set of [`binding=binding||'{"policies":[]}'::jsonb`, "binding_hash=repeat('0',64)", `requester_person_id='${fixture.u2.id}'`,
      "requester_auth_method='pat'", `company_id='${fixture.companyB}'`, 'operation_id=gen_random_uuid()', 'entity_id=upper(entity_id)',
      "requested_at=requested_at-interval '1 hour'", "expires_at=expires_at+interval '1 day'"]) {
      await expect(pool.query(`UPDATE control_operation_approvals SET ${set} WHERE company_id=$1 AND id=$2`, [fixture.companyA, id]), `${state}: ${set}`)
        .rejects.toMatchObject(REFUSED);
    }
    await expect(asRole('app_user', id, `requester_person_id='${fixture.u2.id}'`)).rejects.toMatchObject({ code: '42501' });
    expect(await snapshot(id)).toEqual(before);
  }
});

it('(e) keeps every transition the code makes', async () => {
  for (const state of ['rejected', 'cancelled', 'consumed'] as const) await approval(state);
  const withdrawn = await approval('pending');
  await request('u1', ctx => decideOperationApproval(ctx, withdrawn.id, 'cancelled'));
  expect((await snapshot(withdrawn.id)).status).toBe('cancelled');
  const open = await approval('pending');
  expect(await asRole('app_user', open.id, "status='pending',decided_at=clock_timestamp()"), 'a decision that leaves a policy open').toBe(1);
  expect((await pool.query("UPDATE control_operation_approvals SET expires_at=expires_at-interval '1 hour' WHERE company_id=$1 AND id=$2",
    [fixture.companyA, open.id])).rowCount, 'expiry brought forward').toBe(1);
  const done = await approval('consumed');
  expect(await asRole('app_user', done.id, 'status=status'), 'a no-op on a terminal row').toBe(1);
});

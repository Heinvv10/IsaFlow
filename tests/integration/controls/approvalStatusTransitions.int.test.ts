import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { approvalGuardSuite, noEffect, refused, type Person, type Role } from './approvalGuardFixture';
import { decideOperationApproval } from '@/modules/accounting/services/controls/approvalRequestService';
import { executeControlledOperation } from '@/modules/accounting/services/controls/approvalExecutionService';

// Migration 688: an approval is born pending and moves only along the edges the services take, each by the actor
// allowed to take it, whatever role writes it.
const g = approvalGuardSuite();
const TRANSITION = refused('transition'), BIRTH = refused('birth');

it('(a) a cancelled or rejected approval cannot be revived by any role, and stays unexecutable', async () => {
  for (const state of ['cancelled', 'rejected'] as const) {
    const { id, ref } = await g.approval(state), before = await g.snapshot(id);
    const writers: Array<[Role, Person | null]> = [['app_user', 'u1'], ['app_user', 'u2'], ['platform_admin', 'u2'], ['platform_admin', null], ['superuser', 'u2']];
    for (const [role, person] of writers) for (const set of ["status='approved'", "status='pending'"]) {
      await expect(g.as(role, person, [g.setApproval(id, set)]), `${role}/${person}: ${set} on ${state}`).rejects.toMatchObject(TRANSITION);
    }
    expect(await g.snapshot(id)).toEqual(before);
    await expect(g.request('u1', ctx => executeControlledOperation(ctx, ref, id, noEffect))).rejects.toThrow();
    expect(await g.effects(ref)).toBe(0);
  }
});

it('(b) a consumed approval is never re-opened, re-pointed or erased', async () => {
  const { id } = await g.approval('consumed'), before = await g.snapshot(id);
  const writers: Array<[Role, Person | null]> = [['app_user', 'u1'], ['platform_admin', 'u1'], ['superuser', null]];
  for (const [role, person] of writers) for (const set of ["status='approved'", "status='cancelled'", 'consumed_effect_id=NULL',
    `consumed_effect_id='${randomUUID()}'`, 'consumed_at=clock_timestamp()']) {
    await expect(g.as(role, person, [g.setApproval(id, set)]), `${role}: ${set}`).rejects.toMatchObject(TRANSITION);
  }
  expect(await g.snapshot(id)).toEqual(before);
});

it('(c) approval and rejection follow the acting person\'s own decision, recorded in the same transaction', async () => {
  const bare = await g.approval('pending'), [policy] = await g.policyIds(bare.id);
  for (const [person, set] of [['u1', "status='approved'"], ['u2', "status='approved'"], ['u2', "status='rejected'"],
    ['u2', 'decided_at=clock_timestamp()']] as const) {
    await expect(g.as('app_user', person, [g.setApproval(bare.id, set)]), `${person}: ${set} with no decision`).rejects.toMatchObject(TRANSITION);
  }
  await g.as('app_user', 'u2', [g.decide(bare.id, policy!, 'u2')]);
  for (const person of ['u1', 'u2'] as const) {
    await expect(g.as('app_user', person, [g.setApproval(bare.id, "status='approved'")]), `${person}, a later transaction`).rejects.toMatchObject(TRANSITION);
  }
  expect((await g.snapshot(bare.id)).status).toBe('pending');

  const rejecting = await g.approval('pending'), [rejectPolicy] = await g.policyIds(rejecting.id);
  await expect(g.as('app_user', 'u2', [g.decide(rejecting.id, rejectPolicy!, 'u2', 'approved'), g.setApproval(rejecting.id, "status='rejected'")]),
    'rejected on an approving decision').rejects.toMatchObject(TRANSITION);
  const same = await g.approval('pending'), [samePolicy] = await g.policyIds(same.id);
  expect(await g.as('app_user', 'u2', [g.decide(same.id, samePolicy!, 'u2'), g.setApproval(same.id, "status='approved'")]),
    'the decision and its status in one transaction, as decideOperationApproval does').toBe(1);
});

it('(d) consumption names only the effect its own execution committed', async () => {
  const approved = await g.approval('approved'), consumed = await g.approval('consumed'), row = await g.snapshot(approved.id);
  const earlier = randomUUID();
  await g.pool.query(`INSERT INTO control_operation_effects(company_id,id,operation_id,operation,entity_type,entity_id,binding_hash,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb)`, [row.company_id, earlier, row.operation_id, row.operation, row.entity_type, row.entity_id, row.binding_hash]);
  for (const [effect, why] of [[randomUUID(), 'no such effect'], [(await g.snapshot(consumed.id)).consumed_effect_id, 'another approval\'s effect'],
    [earlier, 'an effect committed by an earlier transaction']] as const) {
    await expect(g.as('app_user', 'u1', [g.setApproval(approved.id, `status='consumed',consumed_at=clock_timestamp(),consumed_effect_id='${effect}'`)]), why)
      .rejects.toMatchObject(TRANSITION);
  }
  await expect(g.as('app_user', 'u1', [g.setApproval(approved.id, "status='pending'")])).rejects.toMatchObject(TRANSITION);
  await expect(g.as('app_user', 'u2', [g.setApproval(approved.id, 'decided_at=clock_timestamp()')])).rejects.toMatchObject(TRANSITION);
  expect((await g.snapshot(approved.id)).status).toBe('approved');
});

it('(e) identity, binding, requester and expiry never change, even for a superuser', async () => {
  for (const state of ['pending', 'consumed'] as const) {
    const { id } = await g.approval(state), before = await g.snapshot(id), f = g.fixture();
    for (const set of [`binding=binding||'{"policies":[]}'::jsonb`, "binding_hash=repeat('0',64)", `requester_person_id='${f.u2.id}'`,
      "requester_auth_method='pat'", `company_id='${f.companyB}'`, 'operation_id=gen_random_uuid()', 'entity_id=upper(entity_id)',
      "requested_at=requested_at-interval '1 hour'", "expires_at=expires_at+interval '1 day'", "expires_at=expires_at-interval '1 hour'"]) {
      await expect(g.as('superuser', 'u1', [g.setApproval(id, set)]), `${state}: ${set}`).rejects.toMatchObject(TRANSITION);
    }
    await expect(g.as('app_user', 'u1', [g.setApproval(id, `requester_person_id='${f.u2.id}'`)])).rejects.toMatchObject({ code: '42501' });
    expect(await g.snapshot(id)).toEqual(before);
  }
});

it('(f) only the requester cancels, whatever role writes it', async () => {
  for (const state of ['pending', 'approved'] as const) {
    const { id } = await g.approval(state);
    const writers: Array<[Role, Person | null]> = [['app_user', 'u2'], ['platform_admin', 'u2'], ['platform_admin', null], ['superuser', null]];
    for (const [role, person] of writers) {
      await expect(g.as(role, person, [g.setApproval(id, "status='cancelled'")]), `${role}/${person} cancels ${state}`).rejects.toMatchObject(TRANSITION);
    }
    expect((await g.snapshot(id)).status).toBe(state);
    if (state === 'pending') expect(await g.as('app_user', 'u1', [g.setApproval(id, "status='cancelled'")]), 'the requester').toBe(1);
    else await g.request('u1', ctx => decideOperationApproval(ctx, id, 'cancelled'));
    expect((await g.snapshot(id)).status).toBe('cancelled');
  }
});

it('(g) an approval is born pending, requested by the acting person', async () => {
  const f = g.fixture(), ref = await g.freshPayment();
  const born = (requester: Person, status: string, policies: unknown[], decided: boolean, effect: string | null) =>
    [`INSERT INTO control_operation_approvals(company_id,operation_id,operation,entity_type,entity_id,requester_person_id,requester_auth_method,
      binding,binding_hash,status,expires_at,decided_at,consumed_at,consumed_effect_id) VALUES($1,gen_random_uuid(),'supplier_payment.process',
      'supplier_payment',$2,$3,'cookie',$4::jsonb,repeat('a',64),$5,clock_timestamp()+interval '1 day',
      CASE WHEN $6 THEN clock_timestamp() END,CASE WHEN $7::uuid IS NOT NULL THEN clock_timestamp() END,$7::uuid)`,
    [f.companyA, ref.entityId, f[requester].id, JSON.stringify({ policies }), status, decided, effect]] as const;
  const bound = [{ policyId: randomUUID(), approverRole: 'admin' }];
  const forged: Array<[Role, Person | null, ReturnType<typeof born>, string]> = [
    ['app_user', 'u1', born('u1', 'approved', bound, false, null), 'approved while a policy binds it'],
    ['app_user', 'u1', born('u1', 'consumed', [], false, randomUUID()), 'born consumed'],
    ['app_user', 'u1', born('u1', 'pending', bound, true, null), 'born decided'],
    ['app_user', 'u1', born('u2', 'pending', bound, false, null), 'requested in another person\'s name'],
    // A superuser stands for every role past RLS; platform_admin holds no INSERT on approvals (687).
    ['superuser', null, born('u1', 'pending', bound, false, null), 'no acting person']];
  for (const [role, person, statement, why] of forged) await expect(g.as(role, person, [statement]), why).rejects.toMatchObject(BIRTH);
  expect(await g.as('app_user', 'u1', [born('u1', 'pending', bound, false, null)]), 'pending').toBe(1);
  expect(await g.as('app_user', 'u1', [born('u1', 'approved', [], false, null)]), 'approved when no policy binds it').toBe(1);
});

it('(h) keeps every edge the services take', async () => {
  for (const state of ['rejected', 'cancelled', 'consumed'] as const) await g.approval(state);
  const withdrawn = await g.approval('pending');
  await g.request('u1', ctx => decideOperationApproval(ctx, withdrawn.id, 'cancelled'));
  expect((await g.snapshot(withdrawn.id)).status).toBe('cancelled');
  const second = randomUUID(), f = g.fixture();
  await g.pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Owner policy','payment','amount','any',0,'owner')`, [second, f.companyA]);
  try {
    const open = await g.approval('pending');
    await g.request('u2', ctx => decideOperationApproval(ctx, open.id, 'approved'));
    const row = await g.snapshot(open.id);
    expect([row.status, row.decided_at !== null, (await g.decisions(open.id)).length], 'a decision that leaves a policy open').toEqual(['pending', true, 1]);
  } finally { await g.pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2', [f.companyA, second]); }
  const done = await g.approval('consumed');
  expect(await g.as('app_user', 'u1', [g.setApproval(done.id, 'status=status')]), 'a no-op on a terminal row').toBe(1);
});

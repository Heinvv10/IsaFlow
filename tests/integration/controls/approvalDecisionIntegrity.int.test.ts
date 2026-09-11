import { expect, it } from 'vitest';
import { approvalGuardSuite, noEffect, refused } from './approvalGuardFixture';
import { rewriteApprovalUnguarded } from './approvalGuardBypass';
import { executeControlledOperation } from '@/modules/accounting/services/controls/approvalExecutionService';

// Migration 689: a decision is the proof of an independent approval, made by the person acting, once, on a pending
// approval, and never changed afterwards.
const g = approvalGuardSuite();
const DECISION = refused('decision');

it('refuses the forgery: a requester records an approval in an admin\'s name, approves and executes', async () => {
  const { id, ref } = await g.approval('pending'), [policy] = await g.policyIds(id);
  await expect(g.as('app_user', 'u1', [g.decide(id, policy!, 'u2')]), 'as app_user').rejects.toMatchObject(DECISION);
  await expect(g.as('superuser', 'u1', [g.decide(id, policy!, 'u2')]), 'as a role past RLS').rejects.toMatchObject(DECISION);
  await expect(g.as('app_user', 'u1', [g.setApproval(id, "status='approved'")])).rejects.toMatchObject(refused('transition'));
  await expect(g.request('u1', ctx => executeControlledOperation(ctx, ref, id, noEffect))).rejects.toThrow();
  expect([await g.decisions(id), await g.effects(ref)]).toEqual([[], 0]);
});

it('a decision is the acting person\'s own: no principal, a non-member or the requester is refused', async () => {
  const { id } = await g.approval('pending'), [policy] = await g.policyIds(id);
  await expect(g.as('superuser', null, [g.decide(id, policy!, 'u2')]), 'no acting person').rejects.toMatchObject(DECISION);
  await expect(g.as('superuser', 'u3', [g.decide(id, policy!, 'u3')]), 'a member of another company').rejects.toMatchObject(DECISION);
  await expect(g.as('app_user', 'u1', [g.decide(id, policy!, 'u1')]), 'the requester').rejects.toMatchObject(DECISION);
  expect(await g.decisions(id)).toEqual([]);
  expect(await g.as('app_user', 'u2', [g.decide(id, policy!, 'u2')]), 'the independent admin, acting').toBe(1);
});

it('a decision lands only on a pending, unexpired approval, for a policy it binds, once per policy', async () => {
  for (const state of ['approved', 'rejected', 'cancelled', 'consumed'] as const) {
    const { id } = await g.approval(state), [policy] = await g.policyIds(id), before = await g.decisions(id);
    await expect(g.as('app_user', 'u2', [g.decide(id, policy!, 'u2')]), state).rejects.toMatchObject(DECISION);
    expect(await g.decisions(id)).toEqual(before);
  }
  const expired = await g.approval('pending'), [expiredPolicy] = await g.policyIds(expired.id);
  await rewriteApprovalUnguarded(g.pool, `UPDATE control_operation_approvals SET requested_at=clock_timestamp()-interval '2 days',
    expires_at=clock_timestamp()-interval '1 minute' WHERE company_id=$1 AND id=$2`, [g.fixture().companyA, expired.id]);
  await expect(g.as('app_user', 'u2', [g.decide(expired.id, expiredPolicy!, 'u2')]), 'expired').rejects.toMatchObject(DECISION);
  const { id } = await g.approval('pending'), [policy] = await g.policyIds(id);
  await expect(g.as('app_user', 'u2', [g.decide(id, 'a-policy-it-does-not-bind', 'u2')]), 'unbound policy').rejects.toMatchObject(DECISION);
  expect(await g.as('app_user', 'u2', [g.decide(id, policy!, 'u2')])).toBe(1);
  await expect(g.as('app_user', 'u2', [g.decide(id, policy!, 'u2', 'rejected')]), 'a second decision on the policy').rejects.toMatchObject({ code: '23505' });
});

it('decisions are append-only for every role', async () => {
  const { id } = await g.approval('approved'), before = await g.decisions(id), companyId = g.fixture().companyA;
  for (const [text, why] of [["UPDATE control_operation_decisions SET decision='rejected' WHERE company_id=$1 AND approval_id=$2", 'update'],
    ['UPDATE control_operation_decisions SET decided_at=decided_at-interval \'1 day\' WHERE company_id=$1 AND approval_id=$2', 'backdate'],
    ['DELETE FROM control_operation_decisions WHERE company_id=$1 AND approval_id=$2', 'delete']] as const) {
    await expect(g.attempt([text, [companyId, id]]), why).rejects.toMatchObject(DECISION);
  }
  await expect(g.attempt(['TRUNCATE control_operation_decisions', []]), 'truncate').rejects.toMatchObject(DECISION);
  expect(await g.decisions(id)).toEqual(before);
});

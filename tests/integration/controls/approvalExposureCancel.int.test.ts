import { expect, it } from 'vitest';
import { approvalGuardSuite, refused, type Person, type Role } from './approvalGuardFixture';
import { decideOperationApproval, getApprovalRequirements } from '@/modules/accounting/services/controls/approvalRequestService';

// A pending approval's reserved exposure counts in the supplier's daily window only while it is pending or approved
// and unexpired (aggregateOperationPolicy.ts). Cancelling it, rejecting it without a decision or shortening its
// expiry would let a sibling payment to the same supplier materialise with no policy. Only its requester may release it.
const g = approvalGuardSuite({ operator: 'greater_than', value: 10000, aggregate: true });

it('a pending approval\'s reserved exposure is released only by its requester', async () => {
  const held = await g.approval('pending', 11000), sibling = await g.freshPayment(500);
  const requiresApproval = async () => (await g.request('u1', ctx => getApprovalRequirements(ctx, sibling))).requiresApproval;
  expect(await requiresApproval(), 'the held exposure puts the sibling over the window').toBe(true);
  const writers: Array<[Role, Person | null, string]> = [['app_user', 'u2', "status='cancelled'"], ['platform_admin', 'u2', "status='cancelled'"],
    ['platform_admin', null, "status='cancelled'"], ['superuser', null, "status='cancelled'"], ['app_user', 'u2', "status='rejected'"],
    ['superuser', 'u1', "expires_at=clock_timestamp()+interval '1 millisecond'"]];
  for (const [role, person, set] of writers) {
    await expect(g.as(role, person, [g.setApproval(held.id, set)]), `${role}/${person}: ${set}`).rejects.toMatchObject(refused('transition'));
  }
  expect(await requiresApproval(), 'still held').toBe(true);
  await g.request('u1', ctx => decideOperationApproval(ctx, held.id, 'cancelled'));
  expect(await requiresApproval(), 'the requester withdrew it').toBe(false);
});

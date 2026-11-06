/**
 * Two admins demoting the TWO other eligible approvers of a pending pay-run approval at the same time: each check
 * sees the other approver still eligible, so without the per-company approver lock both pass and both writes land,
 * leaving the requester alone. With it, the second check waits for the first's COMMIT and is refused: exactly one
 * demotion succeeds.
 *
 * Deterministic: a wrapper holds each caller AFTER its check and BEFORE its write until the other has also finished
 * its check (or 1.5 s pass). With the lock the second caller cannot reach its check before the first commits, so the
 * first is released by the timeout; without the lock both checks pass and both wait for each other, then both write.
 * Covers the company member writes (migration_admin transaction) and the platform-admin write (request transaction).
 * Disposable schema fixture only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({
  arrived: 0, release: null as null | (() => void), wait: null as null | Promise<void>,
  // The lock-order test: a member write is held before it asks for the approver lock until the reset has its locks.
  resetMode: false, resetDone: null as null | Promise<void>, resetOpen: null as null | (() => void),
  memberArrived: null as null | Promise<void>, memberArrive: null as null | (() => void),
}));
vi.mock('@/modules/accounting/services/core/payRunApproverGuard', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/core/payRunApproverGuard')>();
  /** After a passed check: wait until the peer has also passed its check, or 1.5 s. */
  const afterCheck = async (): Promise<void> => {
    gate.arrived += 1;
    if (gate.arrived >= 2) { gate.release?.(); return; }
    await Promise.race([gate.wait, new Promise<void>((res) => setTimeout(res, 1500))]);
  };
  return {
    ...actual,
    refuseLastPayRunApprover: async (...a: Parameters<typeof actual.refuseLastPayRunApprover>) => {
      if (gate.resetMode) {
        gate.memberArrive?.(); // this member write holds its rows and is about to ask for the approver lock
        await Promise.race([gate.resetDone, new Promise<void>((res) => setTimeout(res, 4000))]);
        await actual.refuseLastPayRunApprover(...a);
        return;
      }
      await actual.refuseLastPayRunApprover(...a);
      await afterCheck();
    },
    assertPayRunApproverRetainedEverywhere: async (...a: Parameters<typeof actual.assertPayRunApproverRetainedEverywhere>) => {
      await actual.assertPayRunApproverRetainedEverywhere(...a);
      // Hold the reset (and the locks it took) until the member write has taken ITS rows and is waiting, or 1.5 s: with
      // the rows locked first the member write cannot get that far, so the timeout ends the wait.
      await Promise.race([gate.memberArrived, new Promise<void>((res) => setTimeout(res, 1500))]);
      gate.resetOpen?.();
    },
    assertPayRunApproverRetained: async (...a: Parameters<typeof actual.assertPayRunApproverRetained>) => {
      await actual.assertPayRunApproverRetained(...a);
      await afterCheck();
    },
  };
});

import { updateCompanyUserRole } from '@/modules/accounting/services/core/memberWrites';
import { PayRunApproverProtectedError } from '@/modules/accounting/services/core/payRunApproverGuard';
import { setUserCompanyRole, CompanyMembershipError } from '@/modules/admin/services/companyMembershipService';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { resetOnboarding } from '@/modules/admin/services/adminUserActionsService';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { rig, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
beforeAll(async () => {
  r = await rig('approverrace');
  await r.setup();
  await r.employee(20000);
  await r.pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [r.company, r.approver]);
  const made = await r.api.createRun(5);
  const id = String(made.body.data!.id);
  await r.api.calculate(id);
}, 90000);
afterAll(async () => { await r.teardown(); });

const roleOf = async (u: string) => (await r.pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [r.company, u])).rows[0]?.role as string;
const reset = () => { gate.arrived = 0; gate.wait = new Promise<void>((res) => { gate.release = res; }); };

/** Two managers, the only others who can approve, and a pending request raised by the admin. */
async function twoManagersAndARequest(month: number): Promise<[string, string]> {
  await r.pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND role = 'manager'", [r.company]);
  await r.pool.query("UPDATE approval_requests SET status = 'rejected' WHERE company_id = $1 AND status = 'pending'", [r.company]);
  const [a, b] = [await r.addUser('manager'), await r.addUser('manager')];
  const made = await r.api.createRun(month);
  await r.api.calculate(String(made.body.data!.id));
  const raised = await r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
    { user: r.admin, body: { action: 'request', documentType: 'pay_run', documentId: String(made.body.data!.id) } });
  expect(raised.statusCode).toBe(200);
  return [a, b];
}

describe('two concurrent demotions of the two other approvers', () => {
  it('company member writes: exactly one lands', async () => {
    const [a, b] = await twoManagersAndARequest(6);
    reset();
    // Two DIFFERENT actors, so the actor row lock memberWrites takes does not serialise them (one admin acting twice
    // would be): the second is an admin whose account was suspended after their session began, so they are not an
    // eligible approver themselves and do not make either demotion safe.
    const other = await r.addUser('admin');
    await r.pool.query('UPDATE users SET is_active = false, suspended_at = now() WHERE id = $1', [other]);
    const outcomes = await Promise.all([
      updateCompanyUserRole(r.company, a, 'viewer', r.admin).then(() => 'ok', (e: Error) => e),
      updateCompanyUserRole(r.company, b, 'viewer', other).then(() => 'ok', (e: Error) => e),
    ]);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o instanceof PayRunApproverProtectedError)).toHaveLength(1);
    expect([await roleOf(a), await roleOf(b)].sort()).toEqual(['manager', 'viewer']);
  }, 60000);

  it('platform-admin writes: exactly one lands', async () => {
    const [a, b] = await twoManagersAndARequest(7);
    reset();
    const demote = (u: string) => withAlsTransaction({ companyId: r.company, userId: r.admin }, () => setUserCompanyRole(u, r.company, 'viewer'))
      .then(() => 'ok', (e: Error) => e);
    const outcomes = await Promise.all([demote(a), demote(b)]);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o instanceof CompanyMembershipError && o.code === 'PAY_RUN_APPROVER')).toHaveLength(1);
    expect([await roleOf(a), await roleOf(b)].sort()).toEqual(['manager', 'viewer']);
  }, 60000);
});

describe('onboarding reset against a role change of the same user (lock order)', () => {
  it('no deadlock: the reset takes the member rows before the approver lock, as every member write does', async () => {
    const [x, other] = await twoManagersAndARequest(8);
    expect(other).toBeTruthy();
    gate.resetMode = true;
    gate.resetDone = new Promise<void>((res) => { gate.resetOpen = res; });
    gate.memberArrived = new Promise<void>((res) => { gate.memberArrive = res; });
    try {
      // The reset starts first and takes its locks; the role change of the same user reaches its approver lock only
      // after the reset has taken its own. In the opposite lock order the reset then waits on the role change's rows
      // and the role change on the reset's approver lock: a deadlock Postgres breaks with 40P01.
      const reset = withAlsTransaction({ companyId: r.company, userId: r.admin }, () => resetOnboarding(x)).then(() => 'ok', (e: Error) => e);
      await new Promise((res) => setTimeout(res, 150));
      const change = updateCompanyUserRole(r.company, x, 'viewer', r.admin).then(() => 'ok', (e: Error) => e);
      const [a, b] = await Promise.all([reset, change]);
      for (const o of [a, b]) {
        if (o !== 'ok') expect((o as { code?: string }).code).not.toBe('40P01');
      }
      expect(a).toBe('ok');
      expect(await roleOf(x)).toBeUndefined(); // the reset removed the user from the company
    } finally {
      gate.resetMode = false;
    }
  }, 60000);
});

describe('onboarding reset judges a request raised while it waited for the approver lock', () => {
  it('lists the user\'s companies, locks them, THEN judges: a request raised meanwhile refuses the reset', async () => {
    await r.pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND role = 'manager'", [r.company]);
    await r.pool.query("UPDATE approval_requests SET status = 'rejected' WHERE company_id = $1 AND status = 'pending'", [r.company]);
    const x = await r.addUser('manager'); // the only other member who can approve
    const made = await r.api.createRun(9);
    const run = String(made.body.data!.id);
    await r.api.calculate(run);

    // A session holds the company's approver lock, so the reset waits for it; no request is pending yet.
    const holder = await r.pool.connect();
    await holder.query('BEGIN');
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('pay_run_approvers:' || $1, 0))", [r.company]);
    try {
      const reset = withAlsTransaction({ companyId: r.company, userId: r.admin }, () => resetOnboarding(x)).then(() => 'ok', (e: Error) => e);
      for (let i = 0; i < 200; i += 1) {
        const w = await r.pool.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        if (w.rowCount) break;
        await new Promise((res) => setTimeout(res, 25));
      }
      const raised = await r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
        { user: r.admin, body: { action: 'request', documentType: 'pay_run', documentId: run } });
      expect(raised.statusCode).toBe(200);
      await holder.query('COMMIT');
      expect(await reset).toBeInstanceOf(PayRunApproverProtectedError);
      expect(await roleOf(x)).toBe('manager'); // nothing was removed
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 60000);
});

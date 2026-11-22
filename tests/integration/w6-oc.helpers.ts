/**
 * Wave 6 OC integration helpers. `refusedApproval`: what a user meets on an off-cycle run approval refuses, by both
 * paths (review #1620 breaker delta L1, submit parity): the R-035 submit answers 409 and raises no request, and the
 * live approval (its R-035 clearance skipped, so the off-cycle refusal is what answers) answers 400 with the same reason.
 */
import { expect } from 'vitest';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import type { rig, Route } from './brkr.helpers';

type Rig = Awaited<ReturnType<typeof rig>>;

/** The refusal's text (asserted the same on both paths); fails the test if either path lets the run through. */
export async function refusedApproval(r: Rig, runId: string): Promise<string> {
  const before = Number((await r.pool.query('SELECT count(*)::int AS n FROM approval_requests WHERE document_id = $1', [runId])).rows[0].n);
  const submitted = await r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined, {
    body: { action: 'request', documentType: 'pay_run', documentId: runId },
  });
  expect(submitted.statusCode, JSON.stringify(submitted.body)).toBe(409);
  expect(Number((await r.pool.query('SELECT count(*)::int AS n FROM approval_requests WHERE document_id = $1', [runId])).rows[0].n)).toBe(before);
  const planHash = (await r.api.preview(runId)).body.data?.planHash;
  const approved = await r.api.approveWith(runId, planHash, { user: r.admin });
  expect(approved.statusCode, JSON.stringify(approved.body)).toBe(400);
  expect(r.msg(approved)).toBe(r.msg(submitted));
  return r.msg(submitted) ?? '';
}

/**
 * The run's current approval moved to before its payday: 23:00 SAST on the day before its pay date (gate item 1 on
 * 06c106a94d). These suites fake the app's Date only and approve on (by their clock) or before the pay date; the
 * database stamps approved_at from its own clock (today, after that payday), so without this the approval would read as
 * one given after payday, and a later reopen would not overlap it. Written as the trusted fixture role, which the 999x
 * triggers leave as written.
 */
export async function approvedOverPayday(r: Rig, runId: string): Promise<void> {
  await r.pool.query(`UPDATE payroll_run_headers
      SET approved_at = (COALESCE(run_date, period_end)::timestamp AT TIME ZONE 'Africa/Johannesburg') - interval '1 hour'
    WHERE id = $1 AND status = 'approved'`, [runId]);
}

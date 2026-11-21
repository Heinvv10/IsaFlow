/**
 * #1670 blind breaker L4 / L5: the two check-then-act windows the Approve gates close, raced on real Postgres connections
 * (real routes: withAuth, app_user, RLS) against the disposable fixture. Each race is made deterministic: a second
 * connection holds the lock, the request is seen WAITING on it (pg_stat_activity), the holder commits its change, and the
 * outcome must reflect that change. Without the lock the request does not wait for the check and the outcome is the stale one.
 *  L4  PUT /api/accounting/recurring-transactions locks the template FOR UPDATE before judging auto_post: an approver turning
 *      autoPost on meanwhile is seen, so a writer without Suppliers & AP Approve is refused (403) and nothing is written.
 *  L5  raising a pay_run approval takes the company's pay-run approver lock (payRunApproverGuard.lockPayRunApprovers) that a
 *      member write judging pending requests holds: the raise waits for that write to commit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import recurring from '../../pages/api/accounting/recurring-transactions';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { rig, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let seededModule = false;
beforeAll(async () => {
  r = await rig('approverace');
  await r.setup();
  await r.employee(20000);
  // Migration 270 seeds permission_modules; the schema-only CI baseline holds no rows.
  seededModule = (await r.pool.query(`INSERT INTO permission_modules (module_key, module_name, display_order)
    VALUES ('suppliers', 'Suppliers & AP', 30) ON CONFLICT (module_key) DO NOTHING RETURNING id`)).rowCount === 1;
}, 90000);
afterAll(async () => {
  await r.pool.query('DELETE FROM recurring_transaction_templates WHERE company_id = $1', [r.company]).catch(() => undefined);
  await r.pool.query('DELETE FROM company_user_permissions WHERE company_id = $1', [r.company]).catch(() => undefined);
  if (seededModule) await r.pool.query("DELETE FROM permission_modules WHERE module_key = 'suppliers'").catch(() => undefined);
  await r.teardown();
});

/** Until a backend other than `holder` waits on a lock while running SQL matching `like`; false after 15 s. */
async function seenWaiting(holder: PoolClient, like: string, waitEvent?: string): Promise<boolean> {
  const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  for (let i = 0; i < 150; i += 1) {
    const { rowCount } = await r.pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE pid <> $1 AND wait_event_type = 'Lock' AND ($3::text IS NULL OR wait_event = $3)
          AND query ILIKE $2`, [holderPid, `%${like}%`, waitEvent ?? null]);
    if (rowCount) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

describe('L4: the auto-post template check holds the row through the update', () => {
  it('an approver turning autoPost on meanwhile is seen: the restricted writer is refused 403, nothing written', async () => {
    const writer = await r.addUser('manager');
    await r.pool.query(`INSERT INTO company_user_permissions (company_id, user_id, module_key, can_read, can_write, can_approve)
      VALUES ($1, $2, 'suppliers', true, true, false)`, [r.company, writer]);
    const id = crypto.randomUUID();
    await r.pool.query(`INSERT INTO recurring_transaction_templates (id, company_id, name, entity_type, template_data, frequency, auto_post, created_by)
      VALUES ($1, $2, 'Rent', 'supplier_invoice', '{}', 'monthly', false, $3)`, [id, r.company, r.admin]);

    const holder = await r.pool.connect();
    let edit: Promise<{ statusCode: number }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM recurring_transaction_templates WHERE id = $1 FOR UPDATE', [id]);
      await holder.query('UPDATE recurring_transaction_templates SET auto_post = true WHERE id = $1', [id]);
      edit = r.call(recurring as Route, 'PUT', '/api/accounting/recurring-transactions', undefined,
        { user: writer, body: { id, name: 'Rent (edited figures)' } });
      expect(await seenWaiting(holder, 'recurring_transaction_templates')).toBe(true);
      await holder.query('COMMIT');
    } finally { holder.release(); }

    expect((await edit!).statusCode).toBe(403);
    const row = (await r.pool.query('SELECT name, auto_post FROM recurring_transaction_templates WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ name: 'Rent', auto_post: true });
  }, 60000);
});

describe('L5: a pay_run raise serialises with a member write on the approver lock', () => {
  it('the raise waits on pay_run_approvers:<company> while a member write holds it, then raises', async () => {
    const made = await r.api.createRun(7);
    expect(made.statusCode).toBe(201);
    const runId = String(made.body.data!.id);
    expect((await r.api.calculate(runId)).statusCode).toBe(200);

    const holder = await r.pool.connect();
    let raised: Promise<{ statusCode: number; body: { data?: Record<string, unknown> } }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`pay_run_approvers:${r.company}`]);
      raised = r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
        { user: r.admin, body: { action: 'request', documentType: 'pay_run', documentId: runId } });
      expect(await seenWaiting(holder, 'pg_advisory_xact_lock', 'advisory')).toBe(true);
      await holder.query('COMMIT');
    } finally { holder.release(); }

    const out = await raised!;
    expect(out.statusCode).toBe(200);
    const request = out.body.data as { id: string; documentDigest: string };
    expect((await r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
      { user: r.admin, body: { action: 'reject', requestId: request.id, expectedDigest: request.documentDigest } })).statusCode).toBe(200);
  }, 90000);
});

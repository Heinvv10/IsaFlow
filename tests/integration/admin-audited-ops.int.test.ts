/**
 * Admin ops actions leave an audit row (audit 3.5): job-queue retry, bulk retry,
 * bulk cancel and Delete Old Jobs; email resend; Sage commit. logAdminAction fails
 * closed, so a Sage commit whose audit row cannot be written commits none of the
 * records it wrote.
 *
 * Disposable schema fixture only (assertDisposable). The mail transport is mocked:
 * no email leaves this suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string }>);
vi.mock('@/modules/accounting/services/core/emailService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendEmail: vi.fn(async (o: { to: string; subject: string }) => {
    sent.push({ to: o.to, subject: o.subject });
    return { success: true, messageId: 'wp10-mock' };
  }),
}));

import jobQueueRoute from '../../pages/api/admin/job-queue';
import bulkRoute from '../../pages/api/admin/job-queue/bulk-action';
import resendRoute from '../../pages/api/admin/email-log/resend';
import sageCommitRoute from '../../pages/api/admin/migration/sage-commit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { auditRows, callAdminRoute, seedSuperAdmin } from './admin-audited-exports.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const TAG = `wp10o${Date.now()}`;

async function job(status: string, ageDays = 0): Promise<string> {
  const r = await pool.query(`INSERT INTO background_jobs (company_id, job_type, status, created_at)
    VALUES ($1, $2, $3, NOW() - make_interval(days => $4)) RETURNING id`, [company, `${TAG}-job`, status, ageDays]);
  return r.rows[0].id as string;
}
async function jobStatus(id: string): Promise<string | null> {
  const r = await pool.query('SELECT status FROM background_jobs WHERE id = $1', [id]);
  return (r.rows[0]?.status as string | undefined) ?? null;
}

beforeAll(async () => {
  await seedSuperAdmin(pool, admin);
  await pool.query(`INSERT INTO companies (id, name, created_at) VALUES ($1, $2, NOW())`, [company, `${TAG} Co`]);
}, 60000);

afterAll(async () => {
  try {
    await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp10_block_sage_audit`);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM background_jobs WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM email_log WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('job queue', () => {
  it('single retry is audited with the job id', async () => {
    const id = await job('failed');
    const r = await callAdminRoute(admin, jobQueueRoute, 'POST', '/api/admin/job-queue', {}, { action: 'retry', jobId: id });
    expect(r.status, r.text).toBe(200);
    expect(await jobStatus(id)).toBe('pending');
    const rows = await auditRows(pool, admin, 'job.retry');
    expect(rows).toEqual([{ action: 'job.retry', target_type: 'background_job', target_id: id, details: null }]);
  }, 30000);

  it('bulk retry and bulk cancel are audited with the ids asked for and the count processed', async () => {
    const failed = await job('failed');
    const pending = await job('pending');
    const retry = await callAdminRoute(admin, bulkRoute, 'POST', '/api/admin/job-queue/bulk-action', {},
      { action: 'retry', ids: [failed, pending] });
    expect(retry.status, retry.text).toBe(200);
    expect(await auditRows(pool, admin, 'job.bulk_retry')).toEqual([{
      action: 'job.bulk_retry', target_type: 'background_job', target_id: null,
      details: { ids: [failed, pending], processed: 1, failed: 1 },
    }]);

    const cancel = await callAdminRoute(admin, bulkRoute, 'POST', '/api/admin/job-queue/bulk-action', {},
      { action: 'cancel', ids: [pending] });
    expect(cancel.status, cancel.text).toBe(200);
    expect(await auditRows(pool, admin, 'job.bulk_cancel')).toEqual([{
      action: 'job.bulk_cancel', target_type: 'background_job', target_id: null,
      details: { ids: [pending], processed: 1, failed: 0 },
    }]);
  }, 30000);

  it('Delete Old Jobs is audited with the cutoff and the number deleted', async () => {
    const old = await job('completed', 400);
    const r = await callAdminRoute(admin, bulkRoute, 'POST', '/api/admin/job-queue/bulk-action', {},
      { action: 'delete_old', olderThanDays: 365 });
    expect(r.status, r.text).toBe(200);
    expect(await jobStatus(old)).toBeNull();
    const rows = await auditRows(pool, admin, 'job.delete_old');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: 'background_job', target_id: null });
    expect(rows[0]!.details).toMatchObject({ older_than_days: 365 });
    expect(rows[0]!.details!.deleted).toBeGreaterThanOrEqual(1);
  }, 30000);
});

describe('email resend', () => {
  it('is audited with the email log id and type, not the recipient', async () => {
    const recipient = `${TAG}-cust@test.local`;
    const log = await pool.query(`INSERT INTO email_log (company_id, recipient_email, subject, email_type, status)
      VALUES ($1, $2, 'Invoice INV-1', 'invoice', 'failed') RETURNING id`, [company, recipient]);
    const logId = log.rows[0].id as string;
    const r = await callAdminRoute(admin, resendRoute, 'POST', '/api/admin/email-log/resend', {}, { logId });
    expect(r.status, r.text).toBe(200);
    expect(sent.map((m) => m.to)).toEqual([recipient]);
    const rows = await auditRows(pool, admin, 'email.resend');
    expect(rows).toEqual([{
      action: 'email.resend', target_type: 'email_log', target_id: logId,
      details: { email_type: 'invoice', company_id: company },
    }]);
    expect(JSON.stringify(rows[0])).not.toContain(recipient);
  }, 30000);
});

describe('Sage commit', () => {
  const pulled = (name: string) => ({ customers: { records: [{ name }] } });

  it('is audited against the target company with the per-entity counts', async () => {
    const r = await callAdminRoute(admin, sageCommitRoute, 'POST', '/api/admin/migration/sage-commit', {},
      { companyId: company, pulled: pulled(`${TAG} Cust A`) });
    expect(r.status, r.text).toBe(200);
    const rows = await auditRows(pool, admin, 'sage.commit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: 'company', target_id: company });
    expect(rows[0]!.details).toMatchObject({
      customers: { created: 1, skipped: 0, failed: 0 },
      arInvoices: { created: 0, skipped: 0, failed: 0 },
      warnings: 0,
    });
  }, 30000);

  it('a commit whose audit row cannot be written keeps none of its writes', async () => {
    await pool.query(`ALTER TABLE admin_audit_log ADD CONSTRAINT wp10_block_sage_audit
      CHECK (action <> 'sage.commit' OR admin_user_id <> '${admin}') NOT VALID`);
    try {
      const r = await callAdminRoute(admin, sageCommitRoute, 'POST', '/api/admin/migration/sage-commit', {},
        { companyId: company, pulled: pulled(`${TAG} Cust B`) });
      expect(r.status).toBe(500);
      const c = await pool.query('SELECT 1 FROM customers WHERE company_id = $1 AND name = $2', [company, `${TAG} Cust B`]);
      expect(c.rows).toHaveLength(0);
    } finally {
      await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp10_block_sage_audit`);
    }
  }, 30000);
});

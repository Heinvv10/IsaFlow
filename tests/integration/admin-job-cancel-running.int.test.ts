// Admin audit 2026-11-14, item 3.6 (code-4 F-03): cancelling a RUNNING job from
// the admin job queue must stop it. The cancel (bulk-action route) set
// status='cancelled', but the worker's own write-backs had no status guard:
// markJobFailed put a cancelled job back to 'pending' (so the next getNextJob ran
// it again) and markJobComplete flipped it to 'completed'.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import bulkAction from '../../pages/api/admin/job-queue/bulk-action';
import { getNextJob, markJobComplete, markJobFailed } from '@/modules/accounting/services/core/jobQueueService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callAdmin, createAdmin, dropAdmin } from './wp11-admin-route.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const JOB_TYPE = `wp11_cancel_${randomUUID().slice(0, 8)}`;
let admin = { id: '', token: '' };

const status = async (id: string) =>
  String((await pool.query('SELECT status FROM background_jobs WHERE id = $1', [id])).rows[0]?.status);

/** A job of this suite's own type, claimed by a worker: status 'running', attempts 1 of 3. */
async function runningJob(): Promise<string> {
  await pool.query(`INSERT INTO background_jobs (job_type, payload, max_attempts) VALUES ($1, '{}', 3)`, [JOB_TYPE]);
  const job = await getNextJob([JOB_TYPE]);
  expect(job?.status).toBe('running');
  return job!.id;
}

async function adminCancels(id: string): Promise<void> {
  const r = await callAdmin(bulkAction, admin.token, { body: { action: 'cancel', ids: [id] } });
  expect(r.status).toBe(200);
  expect(await status(id)).toBe('cancelled');
}

beforeAll(async () => { admin = await createAdmin(pool, 'wp11-jobs'); });
afterAll(async () => {
  try {
    await pool.query('DELETE FROM background_jobs WHERE job_type = $1', [JOB_TYPE]);
    await dropAdmin(pool, admin.id);
  } finally { await pool.end(); }
});

describe('cancelling a running job stops it', () => {
  it('a worker failure after the cancel does not put it back in the queue', async () => {
    const id = await runningJob();
    await adminCancels(id);
    await markJobFailed(id, 'worker failed after the admin cancelled');
    expect(await status(id)).toBe('cancelled');
    expect(await getNextJob([JOB_TYPE])).toBeNull();
  });

  it('a worker finishing after the cancel does not mark it completed', async () => {
    const id = await runningJob();
    await adminCancels(id);
    await markJobComplete(id, { done: true });
    expect(await status(id)).toBe('cancelled');
  });

  it('a running job that was not cancelled still completes and still retries on failure', async () => {
    const done = await runningJob();
    await markJobComplete(done, { done: true });
    expect(await status(done)).toBe('completed');

    const failing = await runningJob();
    await markJobFailed(failing, 'first attempt failed');
    expect(await status(failing)).toBe('pending');
  });
});

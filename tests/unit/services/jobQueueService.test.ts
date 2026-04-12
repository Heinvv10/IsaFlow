// RED phase — written before implementation
/**
 * Unit tests for jobQueueService.ts
 *
 * All DB calls are intercepted via the sql mock.
 * Verifies enqueue, claim (getNextJob), lifecycle (complete/fail),
 * and list pagination/filtering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  enqueueJob,
  getNextJob,
  markJobComplete,
  markJobFailed,
  listJobs,
} from '@/modules/accounting/services/jobQueueService';
import type { BackgroundJob } from '@/modules/accounting/services/jobQueueService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

// ── Sample data ───────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: JOB_ID,
    company_id: COMPANY_ID,
    job_type: 'send_invoice',
    payload: { invoiceId: 'inv-001' },
    status: 'pending',
    priority: 5,
    attempts: 0,
    max_attempts: 3,
    scheduled_at: '2026-04-11T06:00:00.000Z',
    started_at: null,
    completed_at: null,
    error_message: null,
    result: null,
    created_at: '2026-04-11T06:00:00.000Z',
    ...overrides,
  };
}

// ── enqueueJob ────────────────────────────────────────────────────────────────

describe('enqueueJob', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('returns the job ID string from the DB', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: JOB_ID }]);

    const id = await enqueueJob('send_invoice', { invoiceId: 'inv-001' });

    expect(id).toBe(JOB_ID);
  });

  it('calls sql with job_type and stringified payload', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: JOB_ID }]);

    await enqueueJob('send_invoice', { invoiceId: 'inv-001' });

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain('send_invoice');
    // payload is JSON-stringified before being passed to sql
    const payloadArg = interpolated.find(
      (v) => typeof v === 'string' && v.includes('invoiceId')
    );
    expect(payloadArg).toBeDefined();
  });

  it('defaults to priority 5 when no options supplied', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: JOB_ID }]);

    await enqueueJob('batch_report', {});

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(5);
  });

  it('respects custom priority when provided', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: JOB_ID }]);

    await enqueueJob('urgent_email', {}, { priority: 1 });

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(1);
  });

  it('respects custom scheduledAt when provided', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: JOB_ID }]);
    const future = new Date('2026-05-01T08:00:00.000Z');

    await enqueueJob('deferred_task', {}, { scheduledAt: future });

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(future.toISOString());
  });

  it('passes companyId when provided', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: JOB_ID }]);

    await enqueueJob('company_job', {}, { companyId: COMPANY_ID });

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(COMPANY_ID);
  });

  it('rethrows on SQL error', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(enqueueJob('broken_job', {})).rejects.toThrow('DB connection lost');
  });
});

// ── getNextJob ────────────────────────────────────────────────────────────────

describe('getNextJob', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('returns null when no pending jobs (empty sql result)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await getNextJob();

    expect(result).toBeNull();
  });

  it('returns a mapped BackgroundJob when a pending job exists', async () => {
    const jobRow = makeJob({ status: 'running', attempts: 1 });
    vi.mocked(sql).mockResolvedValueOnce([jobRow]);

    const result = await getNextJob();

    expect(result).not.toBeNull();
    expect(result!.id).toBe(JOB_ID);
    expect(result!.status).toBe('running');
    expect(result!.job_type).toBe('send_invoice');
  });

  it('result includes all BackgroundJob fields', async () => {
    const jobRow = makeJob();
    vi.mocked(sql).mockResolvedValueOnce([jobRow]);

    const result = await getNextJob();

    expect(result).toMatchObject({
      id: JOB_ID,
      company_id: COMPANY_ID,
      job_type: 'send_invoice',
      payload: { invoiceId: 'inv-001' },
      priority: 5,
      attempts: 0,
      max_attempts: 3,
    });
  });

  it('passes jobTypes filter to the UPDATE...WHERE query when provided', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeJob()]);

    await getNextJob(['send_invoice', 'batch_report']);

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    // The job types array should be passed as an interpolated value
    expect(
      interpolated.some(
        (v) => Array.isArray(v) && v.includes('send_invoice')
      )
    ).toBe(true);
  });

  it('claims atomically: single UPDATE...RETURNING call, not a SELECT then UPDATE', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeJob()]);

    await getNextJob();

    // Exactly one sql call — the atomic UPDATE ... RETURNING pattern
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('rethrows on SQL error', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('lock timeout'));

    await expect(getNextJob()).rejects.toThrow('lock timeout');
  });
});

// ── markJobComplete ───────────────────────────────────────────────────────────

describe('markJobComplete', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('calls sql UPDATE with status=completed and completed_at in the query', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await markJobComplete(JOB_ID);

    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    // 'completed' and 'completed_at' are baked into the SQL template literal, not
    // passed as interpolated parameters — inspect the template string array directly.
    const [templateStrings] = vi.mocked(sql).mock.calls[0];
    const fullSql = (templateStrings as TemplateStringsArray).join('').toLowerCase();
    expect(fullSql).toContain('completed');
    expect(fullSql).toContain('completed_at');
  });

  it('passes jobId to the UPDATE WHERE clause', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await markJobComplete(JOB_ID);

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(JOB_ID);
  });

  it('passes result payload when provided', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await markJobComplete(JOB_ID, { invoicesSent: 3 });

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    const resultArg = interpolated.find(
      (v) => typeof v === 'string' && v.includes('invoicesSent')
    );
    expect(resultArg).toBeDefined();
  });

  it('resolves without throwing on success', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await expect(markJobComplete(JOB_ID)).resolves.toBeUndefined();
  });

  it('rethrows on SQL error', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('DB error'));

    await expect(markJobComplete(JOB_ID)).rejects.toThrow('DB error');
  });
});

// ── markJobFailed ─────────────────────────────────────────────────────────────

describe('markJobFailed', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('calls sql UPDATE with the error_message', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await markJobFailed(JOB_ID, 'Connection refused');

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain('Connection refused');
  });

  it('passes jobId to the WHERE clause', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await markJobFailed(JOB_ID, 'timeout');

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(JOB_ID);
  });

  it('UPDATE includes CASE logic for attempts vs max_attempts (status conditional)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await markJobFailed(JOB_ID, 'retryable error');

    // Should call sql exactly once — the combined CASE update
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    // The SQL template string should contain 'failed' (the terminal status value)
    const [templateStrings] = vi.mocked(sql).mock.calls[0];
    const fullSql = (templateStrings as TemplateStringsArray).join('');
    expect(fullSql.toLowerCase()).toContain('failed');
  });

  it('resolves without throwing on success', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await expect(markJobFailed(JOB_ID, 'error')).resolves.toBeUndefined();
  });

  it('rethrows on SQL error', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('write failed'));

    await expect(markJobFailed(JOB_ID, 'error')).rejects.toThrow('write failed');
  });
});

// ── listJobs ──────────────────────────────────────────────────────────────────

describe('listJobs', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('returns { jobs, total } shape', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([makeJob()])          // jobs query
      .mockResolvedValueOnce([{ count: '1' }]);    // count query

    const result = await listJobs(COMPANY_ID);

    expect(result).toHaveProperty('jobs');
    expect(result).toHaveProperty('total');
    expect(result.jobs).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('total is parsed as integer (count column is TEXT from Neon)', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([makeJob()])
      .mockResolvedValueOnce([{ count: '42' }]);

    const result = await listJobs(COMPANY_ID);

    expect(typeof result.total).toBe('number');
    expect(result.total).toBe(42);
  });

  it('returns empty jobs array when no jobs found', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '0' }]);

    const result = await listJobs(COMPANY_ID);

    expect(result.jobs).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('filters by status when provided', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([makeJob({ status: 'pending' })])
      .mockResolvedValueOnce([{ count: '1' }]);

    const result = await listJobs(COMPANY_ID, { status: 'pending' });

    expect(result.jobs[0]?.status).toBe('pending');
    // status filter → both queries contain 'pending' as an interpolated arg
    const allInterpolated = vi.mocked(sql).mock.calls.flatMap((c) =>
      Array.from(c).slice(1)
    );
    expect(allInterpolated).toContain('pending');
  });

  it('filters by jobType when provided', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([makeJob()])
      .mockResolvedValueOnce([{ count: '1' }]);

    await listJobs(COMPANY_ID, { jobType: 'send_invoice' });

    const allInterpolated = vi.mocked(sql).mock.calls.flatMap((c) =>
      Array.from(c).slice(1)
    );
    expect(allInterpolated).toContain('send_invoice');
  });

  it('respects custom limit (capped at 200)', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '0' }]);

    await listJobs(null, { limit: 500 }); // above cap

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    // Effective limit should be 200 (capped)
    expect(interpolated).toContain(200);
  });

  it('works without companyId (global admin view)', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([makeJob()])
      .mockResolvedValueOnce([{ count: '1' }]);

    const result = await listJobs(null);

    expect(result.jobs).toHaveLength(1);
  });

  it('rethrows on SQL error', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('query timeout'));

    await expect(listJobs(COMPANY_ID)).rejects.toThrow('query timeout');
  });
});

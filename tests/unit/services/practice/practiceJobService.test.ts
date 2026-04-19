import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  transitionJob,
} from '@/modules/accounting/services/practice/practiceJobService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT_ID = 'cccccccc-0000-0000-0000-000000000003';
const CATEGORY_ID = 'dddddddd-0000-0000-0000-000000000004';
const USER_ID = 'eeeeeeee-0000-0000-0000-000000000005';

const jobRow = {
  id: JOB_ID,
  company_id: COMPANY,
  practice_client_id: CLIENT_ID,
  job_category_id: CATEGORY_ID,
  title: 'Annual Tax Return 2025',
  description: 'Full tax return for FY2025',
  partner_id: null,
  preparer_id: null,
  due_date: new Date('2026-03-31'),
  priority: 'normal',
  status: 'new',
  financial_year: '2025',
  billing_type: 'hourly',
  budgeted_hours: 10,
  fixed_fee_amount: null,
  started_at: null,
  completed_at: null,
  created_by: USER_ID,
  practice_client_name: 'Marneweck Holdings',
  job_category_name: 'Tax Returns',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

beforeEach(() => vi.clearAllMocks());

describe('listJobs', () => {
  it('returns mapped jobs and count', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 1 }]).mockResolvedValueOnce([jobRow]);
    const result = await listJobs(COMPANY);
    expect(result.total).toBe(1);
    expect(result.jobs[0]!.title).toBe('Annual Tax Return 2025');
    expect(result.jobs[0]!.practiceClientName).toBe('Marneweck Holdings');
    expect(result.jobs[0]!.jobCategoryName).toBe('Tax Returns');
    expect(result.jobs[0]!.companyId).toBe(COMPANY);
  });

  it('returns empty list when no jobs match status filter', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 0 }]).mockResolvedValueOnce([]);
    const result = await listJobs(COMPANY, { status: 'complete' });
    expect(result.total).toBe(0);
    expect(result.jobs).toHaveLength(0);
  });
});

describe('getJob', () => {
  it('returns null when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await getJob(COMPANY, JOB_ID);
    expect(result).toBeNull();
  });

  it('returns mapped job with joined names', async () => {
    sqlMock.mockResolvedValueOnce([jobRow]);
    const result = await getJob(COMPANY, JOB_ID);
    expect(result?.id).toBe(JOB_ID);
    expect(result?.practiceClientName).toBe('Marneweck Holdings');
    expect(result?.jobCategoryName).toBe('Tax Returns');
    expect(result?.dueDate).toBe('2026-03-31');
  });
});

describe('createJob', () => {
  it('rejects when title is empty', async () => {
    await expect(
      createJob(COMPANY, USER_ID, { practiceClientId: CLIENT_ID, title: '   ' })
    ).rejects.toThrow('job title is required');
  });

  it('rejects when practice client is not active', async () => {
    // client lookup returns empty (not active)
    sqlMock.mockResolvedValueOnce([]);
    await expect(
      createJob(COMPANY, USER_ID, { practiceClientId: CLIENT_ID, title: 'Tax Return' })
    ).rejects.toThrow('practice client not found or not active');
  });

  it('rejects when job category is not active', async () => {
    // client found active
    sqlMock.mockResolvedValueOnce([{ id: CLIENT_ID }]);
    // category not found
    sqlMock.mockResolvedValueOnce([]);
    await expect(
      createJob(COMPANY, USER_ID, {
        practiceClientId: CLIENT_ID,
        jobCategoryId: CATEGORY_ID,
        title: 'Tax Return',
      })
    ).rejects.toThrow('job category not found or not active');
  });

  it('creates job with status new by default', async () => {
    // client found active
    sqlMock.mockResolvedValueOnce([{ id: CLIENT_ID }]);
    // no category check (not provided)
    // insert returns row
    sqlMock.mockResolvedValueOnce([{ ...jobRow, status: 'new', job_category_id: null, job_category_name: null }]);
    const result = await createJob(COMPANY, USER_ID, {
      practiceClientId: CLIENT_ID,
      title: 'Annual Tax Return 2025',
    });
    expect(result.status).toBe('new');
    expect(result.id).toBe(JOB_ID);
  });
});

describe('updateJob', () => {
  it('throws when job not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(updateJob(COMPANY, JOB_ID, { title: 'New Title' })).rejects.toThrow('not found');
  });

  it('updates and returns modified job', async () => {
    const updatedRow = { ...jobRow, title: 'Updated Tax Return', updated_at: new Date() };
    // exist check
    sqlMock.mockResolvedValueOnce([{ id: JOB_ID }]);
    // update returning row with joins
    sqlMock.mockResolvedValueOnce([updatedRow]);
    const result = await updateJob(COMPANY, JOB_ID, { title: 'Updated Tax Return' });
    expect(result.title).toBe('Updated Tax Return');
  });
});

describe('transitionJob', () => {
  it('rejects invalid transition (new → approved)', async () => {
    sqlMock.mockResolvedValueOnce([{ id: JOB_ID, status: 'new' }]);
    await expect(transitionJob(COMPANY, JOB_ID, 'approved', USER_ID)).rejects.toThrow(
      'invalid status transition from new to approved'
    );
  });

  it('allows valid transition (new → in_progress) and stamps started_at when null', async () => {
    sqlMock.mockResolvedValueOnce([{ id: JOB_ID, status: 'new', started_at: null }]);
    const updatedRow = { ...jobRow, status: 'in_progress', started_at: new Date() };
    sqlMock.mockResolvedValueOnce([updatedRow]);
    const result = await transitionJob(COMPANY, JOB_ID, 'in_progress', USER_ID);
    expect(result.status).toBe('in_progress');
    expect(result.startedAt).not.toBeNull();
  });

  it('does not clobber started_at on review → in_progress round trip', async () => {
    const existingStartedAt = new Date('2026-02-01');
    sqlMock.mockResolvedValueOnce([{ id: JOB_ID, status: 'review', started_at: existingStartedAt }]);
    const updatedRow = { ...jobRow, status: 'in_progress', started_at: existingStartedAt };
    sqlMock.mockResolvedValueOnce([updatedRow]);
    const result = await transitionJob(COMPANY, JOB_ID, 'in_progress', USER_ID);
    expect(result.status).toBe('in_progress');
    // started_at should be the original value, not reset
    expect(result.startedAt).toBe(String(existingStartedAt));
  });

  it('stamps completed_at on billed → complete transition', async () => {
    sqlMock.mockResolvedValueOnce([{ id: JOB_ID, status: 'billed', started_at: new Date('2026-01-01') }]);
    const updatedRow = { ...jobRow, status: 'complete', completed_at: new Date() };
    sqlMock.mockResolvedValueOnce([updatedRow]);
    const result = await transitionJob(COMPANY, JOB_ID, 'complete', USER_ID);
    expect(result.status).toBe('complete');
    expect(result.completedAt).not.toBeNull();
  });
});

describe('deleteJob', () => {
  it('rejects when child tasks exist', async () => {
    // tasks check returns a row
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(deleteJob(COMPANY, JOB_ID)).rejects.toThrow(
      'cannot delete job with existing tasks or time entries — cancel it instead'
    );
  });

  it('rejects when time entries linked', async () => {
    // tasks check returns empty
    sqlMock.mockResolvedValueOnce([]);
    // time entries check returns a row
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(deleteJob(COMPANY, JOB_ID)).rejects.toThrow(
      'cannot delete job with existing tasks or time entries — cancel it instead'
    );
  });

  it('hard deletes when no tasks or time entries', async () => {
    // tasks check empty
    sqlMock.mockResolvedValueOnce([]);
    // time entries check empty
    sqlMock.mockResolvedValueOnce([]);
    // delete query
    sqlMock.mockResolvedValueOnce([]);
    await expect(deleteJob(COMPANY, JOB_ID)).resolves.toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });
});

// RED phase — written before implementation
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/practice/practiceUsersService', () => ({
  listCompanyUsers: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { listCompanyUsers } from '@/modules/accounting/services/practice/practiceUsersService';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

import { runDailyDigest } from '@/modules/accounting/services/practice/practiceNotificationService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const listUsersMock = listCompanyUsers as ReturnType<typeof vi.fn>;
const sendEmailMock = sendEmail as ReturnType<typeof vi.fn>;

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID    = 'cccccccc-0000-0000-0000-000000000003';
const USER_EMAIL = 'tester@example.com';

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: USER_EMAIL,
    firstName: 'Test',
    lastName: 'User',
    displayName: 'Test User',
    companyRole: 'member',
    ...overrides,
  };
}

function makeOverdueTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'File annual returns',
    due_date: '2026-04-01',
    priority: 'high',
    job_title: 'Annual Audit',
    client_name: 'Acme Corp',
    days_overdue: 18,
    ...overrides,
  };
}

/** Stubs Date.now to return the given ISO timestamp. Returns restore fn. */
function stubDateNow(isoDate: string): () => void {
  const ts = new Date(isoDate).getTime();
  const original = Date.now;
  Date.now = () => ts;
  return () => { Date.now = original; };
}

beforeEach(() => {
  vi.resetAllMocks();
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'msg-1' });
});

describe('runDailyDigest', () => {
  it('skips users with no overdue tasks and timesheet submitted', async () => {
    // Tuesday — yesterday = Monday (weekday), timesheet check runs
    const restore = stubDateNow('2026-04-21T10:00:00Z');
    // companies query
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID }]);
    listUsersMock.mockResolvedValueOnce([makeUser()]);
    // overdue tasks: empty
    sqlMock.mockResolvedValueOnce([]);
    // timesheet check: submitted (row found)
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    const result = await runDailyDigest();
    restore();

    expect(result.companiesProcessed).toBe(1);
    expect(result.recipientsSkipped).toBe(1);
    expect(result.recipientsNotified).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends digest to user with overdue tasks only', async () => {
    // Tuesday — yesterday = Monday (weekday), timesheet check runs
    const restore = stubDateNow('2026-04-21T10:00:00Z');
    // companies
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID }]);
    listUsersMock.mockResolvedValueOnce([makeUser()]);
    // overdue tasks: one row
    sqlMock.mockResolvedValueOnce([makeOverdueTask()]);
    // timesheet check: submitted
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    const result = await runDailyDigest();
    restore();

    expect(result.recipientsNotified).toBe(1);
    expect(result.recipientsSkipped).toBe(0);
    expect(sendEmailMock).toHaveBeenCalledOnce();
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe(USER_EMAIL);
    expect(call.subject).toContain('1 overdue');
    expect(call.subject).toContain('timesheet ok');
  });

  it('sends digest to user with missing timesheet only', async () => {
    // Tuesday — yesterday = Monday (weekday)
    const restore = stubDateNow('2026-04-21T10:00:00Z');
    // companies
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID }]);
    listUsersMock.mockResolvedValueOnce([makeUser()]);
    // overdue tasks: empty
    sqlMock.mockResolvedValueOnce([]);
    // timesheet check: not found
    sqlMock.mockResolvedValueOnce([]);

    const result = await runDailyDigest();
    restore();

    expect(result.recipientsNotified).toBe(1);
    expect(result.recipientsSkipped).toBe(0);
    expect(sendEmailMock).toHaveBeenCalledOnce();
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.subject).toContain('0 overdue');
    expect(call.subject).toContain('timesheet missing');
  });

  it('sends digest to user with both overdue tasks and missing timesheet', async () => {
    // Tuesday — yesterday = Monday (weekday)
    const restore = stubDateNow('2026-04-21T10:00:00Z');
    // companies
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID }]);
    listUsersMock.mockResolvedValueOnce([makeUser()]);
    // overdue tasks: two rows
    sqlMock.mockResolvedValueOnce([makeOverdueTask(), makeOverdueTask({ id: 'task-2', title: 'Submit VAT' })]);
    // timesheet check: not found
    sqlMock.mockResolvedValueOnce([]);

    const result = await runDailyDigest();
    restore();

    expect(result.recipientsNotified).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledOnce();
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.subject).toContain('2 overdue');
    expect(call.subject).toContain('timesheet missing');
    expect(call._log.emailType).toBe('practice_digest');
  });

  it('weekend skip: when yesterday was Sunday, missingTimesheetDate is null even if no entry', async () => {
    // Monday 2026-04-20 — yesterday was Sunday 2026-04-19
    const restore = stubDateNow('2026-04-20T08:00:00Z');
    // companies
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID }]);
    listUsersMock.mockResolvedValueOnce([makeUser()]);
    // overdue tasks: empty (yesterday = Sunday, no timesheet query)
    sqlMock.mockResolvedValueOnce([]);

    const result = await runDailyDigest();
    restore();

    expect(result.recipientsSkipped).toBe(1);
    expect(result.recipientsNotified).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('continues processing on per-user email failure', async () => {
    // Tuesday — yesterday = Monday (weekday)
    const restore = stubDateNow('2026-04-21T10:00:00Z');
    // companies
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID }]);
    listUsersMock.mockResolvedValueOnce([makeUser()]);
    // overdue tasks: one row
    sqlMock.mockResolvedValueOnce([makeOverdueTask()]);
    // timesheet check: submitted
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    // email fails
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'SMTP timeout' });

    const result = await runDailyDigest();
    restore();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain('SMTP timeout');
    expect(result.companiesProcessed).toBe(1);
  });

  it('returns zeros when no companies exist', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const result = await runDailyDigest();

    expect(result).toEqual({
      companiesProcessed: 0,
      recipientsNotified: 0,
      recipientsSkipped: 0,
      errors: [],
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

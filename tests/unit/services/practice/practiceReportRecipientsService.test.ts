// Tests for practiceReportRecipientsService
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  listReportRecipients,
  createReportRecipient,
  updateReportRecipient,
  deleteReportRecipient,
} from '@/modules/accounting/services/practice/practiceReportRecipientsService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACTOR_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const RECIP_ID   = 'cccccccc-0000-0000-0000-000000000003';

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECIP_ID,
    company_id: COMPANY_ID,
    email: 'partner@firm.co.za',
    name: 'Jane Partner',
    report_types: ['monthly_summary'],
    is_active: true,
    created_at: new Date('2026-03-01T08:00:00Z'),
    updated_at: new Date('2026-03-01T08:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('listReportRecipients', () => {
  it('maps DB rows to ReportRecipient shape', async () => {
    sqlMock.mockResolvedValueOnce([makeDbRow()]);
    const result = await listReportRecipients(COMPANY_ID);
    expect(result).toHaveLength(1);
    const r = result[0]!;
    expect(r.id).toBe(RECIP_ID);
    expect(r.companyId).toBe(COMPANY_ID);
    expect(r.email).toBe('partner@firm.co.za');
    expect(r.name).toBe('Jane Partner');
    expect(r.reportTypes).toEqual(['monthly_summary']);
    expect(r.isActive).toBe(true);
    expect(typeof r.createdAt).toBe('string');
  });

  it('returns empty array when no recipients', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await listReportRecipients(COMPANY_ID);
    expect(result).toHaveLength(0);
  });
});

describe('createReportRecipient', () => {
  it('rejects when email is missing @', async () => {
    await expect(
      createReportRecipient(COMPANY_ID, ACTOR_ID, { email: 'not-an-email' }),
    ).rejects.toThrow('valid email required');
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('rejects when email is missing dot', async () => {
    await expect(
      createReportRecipient(COMPANY_ID, ACTOR_ID, { email: 'no-dot@nodot' }),
    ).rejects.toThrow('valid email required');
  });

  it('creates recipient and returns mapped row', async () => {
    sqlMock.mockResolvedValueOnce([makeDbRow()]);
    const result = await createReportRecipient(COMPANY_ID, ACTOR_ID, {
      email: 'partner@firm.co.za',
      name: 'Jane Partner',
    });
    expect(result.id).toBe(RECIP_ID);
    expect(result.email).toBe('partner@firm.co.za');
    expect(sqlMock).toHaveBeenCalledOnce();
  });

  it('rewraps unique constraint violation to friendly message', async () => {
    sqlMock.mockRejectedValueOnce(new Error('unique constraint violation 23505'));
    await expect(
      createReportRecipient(COMPANY_ID, ACTOR_ID, { email: 'partner@firm.co.za' }),
    ).rejects.toThrow('recipient already exists for this company');
  });
});

describe('deleteReportRecipient', () => {
  it('issues DELETE query scoped by company_id', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await deleteReportRecipient(COMPANY_ID, RECIP_ID);
    expect(sqlMock).toHaveBeenCalledOnce();
  });
});

describe('updateReportRecipient', () => {
  it('throws not found when record does not exist', async () => {
    sqlMock.mockResolvedValueOnce([]); // existence check returns empty
    await expect(
      updateReportRecipient(COMPANY_ID, RECIP_ID, { isActive: false }),
    ).rejects.toThrow('not found');
  });

  it('toggles isActive and returns updated row', async () => {
    sqlMock.mockResolvedValueOnce([makeDbRow()]); // existence check
    sqlMock.mockResolvedValueOnce([makeDbRow({ is_active: false })]); // update returning
    const result = await updateReportRecipient(COMPANY_ID, RECIP_ID, { isActive: false });
    expect(result.isActive).toBe(false);
  });
});

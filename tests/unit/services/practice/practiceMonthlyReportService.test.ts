// Tests for practiceMonthlyReportService
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, listRecipientsMock, getUtilisationMock, getProfitabilityMock, getWipMock, listUsersMock, sendEmailMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sqlMock,
    listRecipientsMock: vi.fn(),
    getUtilisationMock: vi.fn(),
    getProfitabilityMock: vi.fn(),
    getWipMock: vi.fn(),
    listUsersMock: vi.fn(),
    sendEmailMock: vi.fn(),
  };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/practice/practiceReportRecipientsService', () => ({
  listReportRecipients: listRecipientsMock,
}));
vi.mock('@/modules/accounting/services/practice/practiceReportsService', () => ({
  getStaffUtilisation: getUtilisationMock,
  getClientProfitability: getProfitabilityMock,
  getWipAging: getWipMock,
}));
vi.mock('@/modules/accounting/services/practice/practiceUsersService', () => ({
  listCompanyUsers: listUsersMock,
}));
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: sendEmailMock,
}));
vi.mock('@/lib/email-templates-practice-monthly', () => ({
  renderMonthlyReportHtml: vi.fn(() => '<html>report</html>'),
  renderMonthlyReportSubject: vi.fn((p: { companyName: string; periodLabel: string }) => `Monthly Practice Report — ${p.companyName}, ${p.periodLabel}`),
}));

import { runMonthlyReports } from '@/modules/accounting/services/practice/practiceMonthlyReportService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const EMAIL = 'partner@firm.co.za';

function makeRecipient(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    companyId: COMPANY_ID,
    email: EMAIL,
    name: 'Jane',
    reportTypes: ['monthly_summary'],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setupReportData() {
  getUtilisationMock.mockResolvedValue([
    { userId: 'u1', totalHours: 160, billableHours: 128, nonBillableHours: 32, billableValue: 25600, utilisationPct: 80 },
  ]);
  getProfitabilityMock.mockResolvedValue([
    { practiceClientId: 'c1', legalName: 'Acme Corp', revenue: 15000, hours: 60, timeCost: null, margin: null, marginPct: null },
  ]);
  getWipMock.mockResolvedValue([
    { practiceClientId: 'c1', legalName: 'Acme Corp', total: 5000, bucket0to7: 1000, bucket8to14: 1000, bucket15to30: 1000, bucket31plus: 2000 },
  ]);
  listUsersMock.mockResolvedValue([
    { id: 'u1', email: 'staff@firm.co.za', firstName: 'John', lastName: 'Doe', displayName: 'John Doe', companyRole: 'member' },
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'msg-1' });
});

describe('runMonthlyReports', () => {
  it('returns 0 when no companies exist', async () => {
    sqlMock.mockResolvedValueOnce([]); // loadActiveCompanies

    const result = await runMonthlyReports('2026-03');
    expect(result.companiesProcessed).toBe(0);
    expect(result.recipientsEmailed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips companies with no active recipients', async () => {
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID, name: 'My Firm' }]);
    listRecipientsMock.mockResolvedValueOnce([]); // no recipients

    const result = await runMonthlyReports('2026-03');
    expect(result.companiesProcessed).toBe(1);
    expect(result.recipientsEmailed).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends email to each active recipient with aggregated data', async () => {
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID, name: 'My Firm' }]);
    listRecipientsMock.mockResolvedValueOnce([makeRecipient(), makeRecipient({ id: 'r2', email: 'director@firm.co.za', name: 'Bob' })]);
    setupReportData();

    const result = await runMonthlyReports('2026-03');
    expect(result.companiesProcessed).toBe(1);
    expect(result.recipientsEmailed).toBe(2);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe(EMAIL);
    expect(call._log.emailType).toBe('practice_monthly');
    expect(call.subject).toContain('My Firm');
  });

  it('continues on per-recipient email failure and records error', async () => {
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID, name: 'My Firm' }]);
    listRecipientsMock.mockResolvedValueOnce([makeRecipient(), makeRecipient({ id: 'r2', email: 'director@firm.co.za', name: 'Bob' })]);
    setupReportData();
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'SMTP timeout' });
    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg-2' });

    const result = await runMonthlyReports('2026-03');
    expect(result.recipientsEmailed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain('SMTP timeout');
    expect(result.errors[0]!.email).toBe(EMAIL);
  });

  it('uses explicit reportMonth to set correct period dates', async () => {
    sqlMock.mockResolvedValueOnce([{ id: COMPANY_ID, name: 'My Firm' }]);
    listRecipientsMock.mockResolvedValueOnce([makeRecipient()]);
    setupReportData();

    await runMonthlyReports('2026-02'); // February 2026

    // Feb 2026 ends on the 28th
    expect(getUtilisationMock).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ dateFrom: '2026-02-01', dateTo: '2026-02-28' }),
    );
    expect(getWipMock).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ asOfDate: '2026-02-28' }),
    );
  });
});

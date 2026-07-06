/**
 * TDD (RED first): SARS eFiling submission orchestration + the server-side
 * exceptions gate — the DIFFERENTIATOR. Submission is refused, server-side and
 * audited, unless the ISV channel is configured AND the pre-filing exceptions
 * report is clean. The UI gate is a convenience; THIS is the enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getEfilingConfig: vi.fn(),
  getVatExceptions: vi.fn(),
  generateVAT201: vi.fn(),
  authenticate: vi.fn(),
  submitVAT201: vi.fn(),
  pollStatus: vi.fn(),
  getEfilingSubmission: vi.fn(),
  getCompanyVatInfo: vi.fn(),
  markSubmissionSubmitted: vi.fn(),
  applyPollResult: vi.fn(),
  insertEfilingEvent: vi.fn(),
}));

vi.mock('@/modules/accounting/services/reports/sarsEfilingConfig', () => ({
  getEfilingConfig: m.getEfilingConfig,
  isEfilingConfigured: () => m.getEfilingConfig() !== null,
}));
vi.mock('@/modules/accounting/services/reports/vatExceptionsService', () => ({ getVatExceptions: m.getVatExceptions }));
vi.mock('@/modules/accounting/services/reports/vat201Service', () => ({ generateVAT201: m.generateVAT201 }));
vi.mock('@/modules/accounting/services/reports/sarsEfilingClient', () => ({
  authenticate: m.authenticate,
  submitVAT201: m.submitVAT201,
  pollStatus: m.pollStatus,
}));
vi.mock('@/modules/accounting/services/reports/sarsEfilingRepo', () => ({
  getEfilingSubmission: m.getEfilingSubmission,
  getCompanyVatInfo: m.getCompanyVatInfo,
  markSubmissionSubmitted: m.markSubmissionSubmitted,
  applyPollResult: m.applyPollResult,
  insertEfilingEvent: m.insertEfilingEvent,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  evaluateEfilingGate,
  submitVAT201ToSars,
  pollVAT201Status,
  EfilingNotConfiguredError,
  EfilingBlockedError,
  EfilingSubmissionNotFoundError,
} from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';

const CID = '11111111-1111-1111-1111-111111111111';
const SID = '22222222-2222-2222-2222-222222222222';
const UID = '33333333-3333-3333-3333-333333333333';

function cleanReport(over: Record<string, unknown> = {}) {
  return { totalExceptions: 0, degradedData: false, degradedSources: [], ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getEfilingConfig.mockReturnValue({ baseUrl: 'http://x', isvLogin: 'l', activationKey: 'k' });
  m.getEfilingSubmission.mockResolvedValue({
    id: SID, companyId: CID, formType: 'VAT201',
    periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
    efilingCorrelationId: null, efilingLastStatus: null,
  });
  m.getVatExceptions.mockResolvedValue(cleanReport());
  m.generateVAT201.mockResolvedValue({
    field1_standardRatedSupplies: 1000000, field5_outputVAT: 150000,
    field10_totalInputVAT: 100000, field11_vatPayableOrRefundable: 50000,
  });
  m.getCompanyVatInfo.mockResolvedValue({ vatNumber: '4123456789', companyName: 'Test Co' });
  m.authenticate.mockResolvedValue({ token: 'tok' });
  m.submitVAT201.mockResolvedValue({ correlationId: 'CORR-1', status: 'received', httpStatus: 202 });
  m.pollStatus.mockResolvedValue({ status: 'accepted', sarsReference: 'REF-1', errors: [], httpStatus: 200 });
});

describe('evaluateEfilingGate (pure)', () => {
  it('allows a clean report', () => {
    expect(evaluateEfilingGate(cleanReport() as never)).toEqual({ allowed: true, reason: null });
  });
  it('blocks when there are exceptions', () => {
    const g = evaluateEfilingGate(cleanReport({ totalExceptions: 3 }) as never);
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain('3');
  });
  it('blocks when the VAT201 source data is degraded', () => {
    const g = evaluateEfilingGate(cleanReport({ degradedData: true, degradedSources: ['customer_invoices'] }) as never);
    expect(g.allowed).toBe(false);
    expect(g.reason?.toLowerCase()).toContain('incomplete');
  });
});

describe('submitVAT201ToSars', () => {
  it('refuses when the ISV channel is not configured — no network call', async () => {
    m.getEfilingConfig.mockReturnValue(null);
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingNotConfiguredError);
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('throws when the submission does not exist', async () => {
    m.getEfilingSubmission.mockResolvedValue(null);
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingSubmissionNotFoundError);
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('BLOCKS submission when exceptions are present, and audits the block', async () => {
    m.getVatExceptions.mockResolvedValue(cleanReport({ totalExceptions: 2 }));
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingBlockedError);
    expect(m.submitVAT201).not.toHaveBeenCalled();
    expect(m.markSubmissionSubmitted).not.toHaveBeenCalled();
    expect(m.insertEfilingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: CID, submissionId: SID, eventType: 'blocked' }),
    );
  });

  it('BLOCKS submission when the source data is degraded', async () => {
    m.getVatExceptions.mockResolvedValue(cleanReport({ degradedData: true, degradedSources: ['supplier_invoices'] }));
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingBlockedError);
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('BLOCKS submission when the company VAT number is missing/invalid', async () => {
    m.getCompanyVatInfo.mockResolvedValue({ vatNumber: null, companyName: 'Test Co' });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingBlockedError);
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('submits, persists status, and audits on a clean+configured run', async () => {
    const out = await submitVAT201ToSars(CID, SID, UID);
    expect(out.correlationId).toBe('CORR-1');
    expect(m.submitVAT201).toHaveBeenCalledTimes(1);
    // payload carries the generated box totals + company VAT number
    const payload = m.submitVAT201.mock.calls[0][2];
    expect(payload).toMatchObject({ vatNumber: '4123456789' });
    expect(payload.fields.field11_vatPayableOrRefundable).toBe(50000);
    expect(m.markSubmissionSubmitted).toHaveBeenCalledWith(CID, SID, 'CORR-1', 'received', UID);
    expect(m.insertEfilingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'submit', correlationId: 'CORR-1' }),
    );
  });

  it('audits a transport error and does NOT mark submitted', async () => {
    m.authenticate.mockRejectedValue(Object.assign(new Error('auth 500'), { httpStatus: 500 }));
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toThrow();
    expect(m.markSubmissionSubmitted).not.toHaveBeenCalled();
    expect(m.insertEfilingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'error', httpStatus: 500 }),
    );
  });
});

describe('pollVAT201Status', () => {
  it('refuses when there is no ISV correlation id to poll', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
      efilingCorrelationId: null, efilingLastStatus: null,
    });
    await expect(pollVAT201Status(CID, SID)).rejects.toBeInstanceOf(EfilingBlockedError);
    expect(m.pollStatus).not.toHaveBeenCalled();
  });

  it('polls, maps accepted -> accepted, stores the SARS reference, and audits', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'submitted',
      efilingCorrelationId: 'CORR-1', efilingLastStatus: 'received',
    });
    const out = await pollVAT201Status(CID, SID);
    expect(out.status).toBe('accepted');
    expect(m.applyPollResult).toHaveBeenCalledWith(CID, SID, expect.objectContaining({
      submissionStatus: 'accepted', efilingStatus: 'accepted', sarsReference: 'REF-1',
    }));
    expect(m.insertEfilingEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'poll' }));
  });
});

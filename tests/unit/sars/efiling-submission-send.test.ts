/**
 * SARS eFiling submission orchestration, part 2: submitVAT201ToSars (the gates, the send, the persisted result, transport errors).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getEfilingConfig: vi.fn(),
  getVatExceptions: vi.fn(),
  getVat201Return: vi.fn(),
  payloadMapped: vi.fn(),
  authenticate: vi.fn(),
  submitVAT201: vi.fn(),
  pollStatus: vi.fn(),
  getEfilingSubmission: vi.fn(),
  getCompanyVatInfo: vi.fn(),
  markSubmissionSubmitted: vi.fn(),
  applyPollResult: vi.fn(),
  insertEfilingEvent: vi.fn(),
  insertEfilingEventCommitted: vi.fn(),
  withEventWriter: vi.fn(),
  latestEfilingEvent: vi.fn(),
  periodHasReturnVersion: vi.fn(),
  takeDraftPeriodLock: vi.fn(),
  order: [] as string[],
}));

// R-032 L5: the Login-as guard runs its own query first; it is covered by
// tests/unit/auth/statutoryImpersonationGuards.test.ts and the r-032 integration suites.
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));
vi.mock('@/modules/accounting/services/reports/sarsEfilingConfig', () => ({
  getEfilingConfig: m.getEfilingConfig,
  isEfilingConfigured: () => m.getEfilingConfig() !== null,
}));
vi.mock('@/modules/accounting/services/reports/vatExceptionsService', () => ({ getVatExceptions: m.getVatExceptions }));
// Only the IO is mocked. `evaluateVat201Filability` is pure and is the gate
// under test here, so it runs for real.
vi.mock('@/modules/accounting/services/reports/vat201Return', () => ({ getVat201Return: m.getVat201Return }));
// The ISV payload is refused until it is remapped to SARS field numbers; the
// tests of the gates BEHIND that refusal run as if it had shipped, and the
// refusal itself is tested below with the real flag.
vi.mock('@/modules/accounting/services/reports/sarsEfilingPayloadGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/reports/sarsEfilingPayloadGuard')>()),
  isvPayloadMappedToSarsFields: m.payloadMapped,
}));
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
  insertEfilingEventCommitted: m.insertEfilingEventCommitted,
  withEventWriter: m.withEventWriter,
  latestEfilingEvent: m.latestEfilingEvent,
}));
// Wave 5 L1b: a period with a return version is the lifecycle's, and the ISV path queues behind the period's draft key.
vi.mock('@/modules/accounting/services/returns/versionExists', () => ({ periodHasReturnVersion: m.periodHasReturnVersion }));
vi.mock('@/modules/accounting/services/reports/sarsComplianceService', () => ({ takeDraftPeriodLock: m.takeDraftPeriodLock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  draftBlockReason, DRAFT_NO_FIGURES_REASON, DRAFT_PREDATES_REASON,
} from '@/modules/accounting/services/reports/sarsEfilingDraftDrift';
import {
  evaluateEfilingGate,
  submitVAT201ToSars,
  pollVAT201Status,
  EfilingNotConfiguredError,
  EfilingBlockedError,
  EfilingSubmissionNotFoundError,
  EfilingAlreadyFiledError,
  EfilingPayloadUnmappedError,
  draftDrift,
} from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';

const CID = '11111111-1111-1111-1111-111111111111';
const SID = '22222222-2222-2222-2222-222222222222';
const UID = '33333333-3333-3333-3333-333333333333';

function cleanReport(over: Record<string, unknown> = {}) {
  return { totalExceptions: 0, degradedData: false, degradedSources: [], ...over };
}

/** The eleven figures, matching between the saved draft and the regenerated return. */
const FILED_FIELDS = {
  field1_standardRatedSupplies: 1000000, field2_zeroRatedSupplies: 0, field3_exemptSupplies: 0,
  field4_totalImports: 0, field5_outputVAT: 150000, field6_capitalGoods: 0,
  field7_otherGoods: 100000, field8_services: 0, field9_imports: 0,
  field10_totalInputVAT: 100000, field11_vatPayableOrRefundable: 50000,
};

function tiedRateCheck(over: Record<string, unknown> = {}) {
  return {
    rate: 0.15, outputImpliedTax: 150000, outputVariance: 0,
    inputImpliedTax: 100000, inputVariance: 0, ties: true,
    entriesWithoutBase: [], entriesWithoutBaseTotal: 0, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.payloadMapped.mockReturnValue(true);
  m.order.length = 0;
  m.periodHasReturnVersion.mockResolvedValue(false);
  m.takeDraftPeriodLock.mockImplementation(async () => { m.order.push('lock'); });
  m.insertEfilingEventCommitted.mockResolvedValue(undefined);
  m.latestEfilingEvent.mockResolvedValue(null);
  // the event connection is opened FIRST (before the draft lock), and every event on it is a committed write
  m.withEventWriter.mockImplementation(async (fn: (w: { write: unknown }) => Promise<unknown>) => {
    m.order.push('connection');
    return fn({ write: async (evt: { efilingStatus?: string; eventType: string }) => { m.order.push(`event:${evt.eventType}:${evt.efilingStatus ?? ''}`); return m.insertEfilingEventCommitted(evt); } });
  });
  m.authenticate.mockImplementation(async () => { m.order.push('authenticate'); return { token: 'tok' }; });
  m.getEfilingConfig.mockReturnValue({ baseUrl: 'http://x', isvLogin: 'l', activationKey: 'k' });
  m.getEfilingSubmission.mockResolvedValue({
    id: SID, companyId: CID, formType: 'VAT201',
    periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
    efilingCorrelationId: null, efilingLastStatus: null, formData: { ...FILED_FIELDS },
  });
  m.getVatExceptions.mockResolvedValue(cleanReport());
  m.getVat201Return.mockResolvedValue({ ...FILED_FIELDS, rateCheck: tiedRateCheck() });
  m.getCompanyVatInfo.mockResolvedValue({ vatNumber: '4123456789', companyName: 'Test Co' });
  m.submitVAT201.mockResolvedValue({ correlationId: 'CORR-1', status: 'received', httpStatus: 202 });
  m.pollStatus.mockResolvedValue({ status: 'accepted', sarsReference: 'REF-1', errors: [], httpStatus: 200 });
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

  it('refuses to re-file a submission already sent to SARS (idempotency — no double filing)', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'submitted',
      efilingCorrelationId: 'CORR-EXISTING', efilingLastStatus: 'received', formData: { ...FILED_FIELDS },
    });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingAlreadyFiledError);
    expect(m.submitVAT201).not.toHaveBeenCalled();
    expect(m.markSubmissionSubmitted).not.toHaveBeenCalled();
  });

  it('refuses to re-file an already-accepted submission', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'accepted',
      efilingCorrelationId: null, efilingLastStatus: 'accepted', formData: { ...FILED_FIELDS },
    });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingAlreadyFiledError);
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
    expect(m.insertEfilingEventCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'submit', correlationId: 'CORR-1' }),
    );
  });

  it('audits a transport error and does NOT mark submitted', async () => {
    m.authenticate.mockRejectedValue(Object.assign(new Error('auth 500'), { httpStatus: 500 }));
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toThrow();
    expect(m.markSubmissionSubmitted).not.toHaveBeenCalled();
    expect(m.insertEfilingEventCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'error', httpStatus: 500 }),
    );
  });

  it('BLOCKS a return that fails SARS\'s own 15% check, and audits it', async () => {
    // R1 000 000 of standard supplies implies R150 000 of tax; R158 000 is
    // R8 000 out, well over the 0.5% bar of R790.
    m.getVat201Return.mockResolvedValue({
      ...FILED_FIELDS,
      field5_outputVAT: 158000,
      rateCheck: tiedRateCheck({ ties: false, outputVariance: 8000, inputVariance: 0 }),
    });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingBlockedError);
    expect(m.submitVAT201).not.toHaveBeenCalled();
    expect(m.insertEfilingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'blocked', detail: expect.objectContaining({ rateCheckTies: false }) }),
    );
  });

  it('files a variance that is immaterial against the tax declared', async () => {
    // R200 out on R150 000 is 0.13% — under the bar. vatBoxBasis's own R1
    // absolute tolerance would refuse this book forever.
    m.getVat201Return.mockResolvedValue({
      ...FILED_FIELDS,
      field5_outputVAT: 150200,
      rateCheck: tiedRateCheck({ ties: false, outputVariance: 200 }),
    });
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
      efilingCorrelationId: null, efilingLastStatus: null,
      formData: { ...FILED_FIELDS, field5_outputVAT: 150200 },
    });
    await submitVAT201ToSars(CID, SID, UID);
    expect(m.submitVAT201).toHaveBeenCalledTimes(1);
  });

  it('BLOCKS an input breakdown that contradicts its own total', async () => {
    const contradicted = { ...FILED_FIELDS, field7_otherGoods: -50000, field8_services: 150000 };
    m.getVat201Return.mockResolvedValue({ ...contradicted, rateCheck: tiedRateCheck() });
    // Saved draft matches, so this is the filability gate and not draft drift.
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
      efilingCorrelationId: null, efilingLastStatus: null, formData: { ...contradicted },
    });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toThrow(/exceeds what the ledger claims/);
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('BLOCKS a return declaring a negative supply value', async () => {
    m.getVat201Return.mockResolvedValue({
      ...FILED_FIELDS, field1_standardRatedSupplies: -4000, rateCheck: tiedRateCheck(),
    });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toThrow(/negative/);
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('BLOCKS when the ledger has moved since the reviewed draft was saved', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
      efilingCorrelationId: null, efilingLastStatus: null,
      formData: { ...FILED_FIELDS, field5_outputVAT: 151000 },
    });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toThrow(/ledger has moved/);
    expect(m.submitVAT201).not.toHaveBeenCalled();
    expect(m.markSubmissionSubmitted).not.toHaveBeenCalled();
  });

  it('BLOCKS a draft that holds no figures to compare against', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
      efilingCorrelationId: null, efilingLastStatus: null, formData: null,
    });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingBlockedError);
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('never sends rateCheck to SARS', async () => {
    await submitVAT201ToSars(CID, SID, UID);
    const payload = m.submitVAT201.mock.calls[0][2];
    expect(payload.fields).not.toHaveProperty('rateCheck');
    expect(payload.fields).not.toHaveProperty('outputInvoices');
  });
});

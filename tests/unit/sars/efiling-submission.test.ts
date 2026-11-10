/**
 * SARS eFiling submission orchestration, part 1: the pure exceptions gate, the wave 5 L1b steps before anything leaves for SARS (the
 * event connection, the period lock, the re-reads, the committed intent), and the refusal while the payload is unmapped.
 * Split from one file (a pure move); parts 2 and 3 are efiling-submission-send and efiling-submission-poll.
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
  EfilingSendUncertainError,
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

describe('the ISV path before anything leaves for SARS (wave 5 L1b)', () => {
  it('takes the period draft lock, then commits the intent in its own transaction, then authenticates and sends', async () => {
    await submitVAT201ToSars(CID, SID, UID);
    // the connection first, then the lock, the intent, SARS, and the RESULT (with the correlation id) committed too
    expect(m.order).toEqual(['connection', 'lock', 'event:submit:sending', 'authenticate', 'event:submit:received']);
    expect(m.insertEfilingEventCommitted).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: 'submit', correlationId: 'CORR-1' }));
    expect(m.takeDraftPeriodLock).toHaveBeenCalledWith(CID, 'VAT201', '2026-03-01', '2026-03-31');
    expect(m.insertEfilingEventCommitted).toHaveBeenCalledWith(expect.objectContaining({ submissionId: SID, eventType: 'submit', efilingStatus: 'sending' }));
  });

  it('sends nothing when the intent cannot be recorded', async () => {
    m.insertEfilingEventCommitted.mockRejectedValue(new Error('disk full'));
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toThrow('disk full');
    expect(m.authenticate).not.toHaveBeenCalled();
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('refuses a submission that was filed while it waited for the lock (re-read under it), before any send', async () => {
    m.getEfilingSubmission.mockResolvedValueOnce({
      id: SID, companyId: CID, formType: 'VAT201', periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
      efilingCorrelationId: null, efilingLastStatus: null, formData: { ...FILED_FIELDS },
    }).mockResolvedValueOnce({
      id: SID, companyId: CID, formType: 'VAT201', periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'submitted',
      efilingCorrelationId: null, efilingLastStatus: null, formData: { ...FILED_FIELDS },
    });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingAlreadyFiledError);
    expect(m.insertEfilingEventCommitted).not.toHaveBeenCalled();
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('refuses to send again when the latest event is an intent with no result (a previous send may have reached SARS)', async () => {
    m.latestEfilingEvent.mockResolvedValue({ eventType: 'submit', efilingStatus: 'sending', correlationId: null });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingSendUncertainError);
    expect(m.authenticate).not.toHaveBeenCalled();
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('refuses to send again when the latest event is a failure carrying the correlation id of an accepted send', async () => {
    m.latestEfilingEvent.mockResolvedValue({ eventType: 'error', efilingStatus: null, correlationId: 'CORR-LOST' });
    const err = await submitVAT201ToSars(CID, SID, UID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EfilingSendUncertainError);
    expect((err as EfilingSendUncertainError).correlationId).toBe('CORR-LOST');
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('sends again after a failure that never reached SARS (no correlation id)', async () => {
    m.latestEfilingEvent.mockResolvedValue({ eventType: 'error', efilingStatus: null, correlationId: null });
    await expect(submitVAT201ToSars(CID, SID, UID)).resolves.toMatchObject({ correlationId: 'CORR-1' });
  });

  it('when the RESULT event cannot be recorded after SARS accepted, the failure event carries the correlation id', async () => {
    m.insertEfilingEventCommitted.mockImplementation(async (evt: { eventType: string; correlationId?: string | null; efilingStatus?: string }) => {
      if (evt.eventType === 'submit' && evt.efilingStatus === 'received') throw new Error('connection lost');
    });
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toThrow('connection lost');
    expect(m.markSubmissionSubmitted).not.toHaveBeenCalled();
    expect(m.insertEfilingEventCommitted).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: 'error', correlationId: 'CORR-1', message: 'connection lost' }),
    );
  });

  it('refuses a period that gained a return version while it waited for the lock', async () => {
    m.periodHasReturnVersion.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(submitVAT201ToSars(CID, SID, UID)).rejects.toBeInstanceOf(EfilingBlockedError);
    expect(m.insertEfilingEventCommitted).not.toHaveBeenCalled();
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });
});

describe('the ISV payload is refused until it is mapped to SARS field numbers', () => {
  it('refuses with a typed error, audits it, and reaches neither the gates nor SARS', async () => {
    m.payloadMapped.mockReturnValue(false);
    const err = await submitVAT201ToSars(CID, SID, UID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EfilingPayloadUnmappedError);
    expect(err).toBeInstanceOf(EfilingBlockedError);
    expect((err as EfilingBlockedError).reason).toBe('payload not yet mapped to SARS field numbers');
    expect(m.insertEfilingEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'blocked', message: 'payload not yet mapped to SARS field numbers',
    }));
    expect(m.getVatExceptions).not.toHaveBeenCalled();
    expect(m.authenticate).not.toHaveBeenCalled();
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });

  it('is still unmapped in the shipped flag (flip it only in the change that sends sarsFields)', async () => {
    const real = await vi.importActual<typeof import('@/modules/accounting/services/reports/sarsEfilingPayloadGuard')>(
      '@/modules/accounting/services/reports/sarsEfilingPayloadGuard',
    );
    expect(real.isvPayloadMappedToSarsFields()).toBe(false);
  });

  it('keeps the SARS form out of the payload once it is mapped to the legacy keys', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201', periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
      efilingCorrelationId: null, efilingLastStatus: null, formData: { ...FILED_FIELDS, sarsFields: [] },
    });
    m.getVat201Return.mockResolvedValue({
      ...FILED_FIELDS, rateCheck: tiedRateCheck(), sarsFields: [], warnings: [], filability: { filable: true, reason: null },
    });
    await submitVAT201ToSars(CID, SID, UID);
    const sent = m.submitVAT201.mock.calls[0]![2].fields as Record<string, unknown>;
    expect(Object.keys(sent)).not.toEqual(expect.arrayContaining(['sarsFields']));
    expect(sent).not.toHaveProperty('warnings');
    expect(sent).not.toHaveProperty('filability');
  });
});

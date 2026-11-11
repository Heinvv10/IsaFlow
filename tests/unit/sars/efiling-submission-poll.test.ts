/**
 * SARS eFiling submission orchestration, part 3: draftDrift (pure) and pollVAT201Status.
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
  sendMayHaveReached: vi.fn(),
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
  sendMayHaveReached: m.sendMayHaveReached,
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
  m.sendMayHaveReached.mockResolvedValue(null);
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

describe('draftDrift (pure)', () => {
  const regenerated = { ...FILED_FIELDS, rateCheck: tiedRateCheck() } as never;

  it('reports nothing when the draft matches', () => {
    expect(draftDrift({ ...FILED_FIELDS }, regenerated)).toEqual([]);
  });
  it('names each field that moved', () => {
    const drift = draftDrift({ ...FILED_FIELDS, field5_outputVAT: 151000, field1_standardRatedSupplies: 999000 }, regenerated);
    expect(drift).toHaveLength(2);
    expect(drift.join(' ')).toContain('field5_outputVAT');
    expect(drift.join(' ')).toContain('field1_standardRatedSupplies');
  });
  it('ignores a sub-cent difference', () => {
    expect(draftDrift({ ...FILED_FIELDS, field5_outputVAT: 150000.001 }, regenerated)).toEqual([]);
  });
  it('refuses a draft with no figures rather than passing it', () => {
    expect(draftDrift(null, regenerated)).toHaveLength(1);
    expect(draftDrift({ some: 'other shape' }, regenerated)).toHaveLength(1);
  });
});

describe('draftDrift — the SARS form', () => {
  const field = (f: string, amount: number | null) => ({ field: f, amount });
  const form = (over: Record<string, number | null> = {}) => {
    const base: Record<string, number | null> = { '1': 11500, '1A': 0, '2': 0, '2A': 0, '3': 0, '12': 0, '15': 900, '17': 0, '18': 0, '14A': null, ...over };
    return Object.entries(base).map(([f, a]) => field(f, a));
  };
  const saved = (sarsFields: unknown) => ({ ...FILED_FIELDS, sarsFields });
  const now = (sarsFields: unknown) => ({ ...FILED_FIELDS, rateCheck: tiedRateCheck(), sarsFields }) as never;

  it('passes when the saved SARS form matches', () => {
    expect(draftDrift(saved(form()), now(form()))).toEqual([]);
  });

  it.each([
    ['1 -> 1A', { '1': 0, '1A': 11500 }],
    ['1 -> 12', { '1': 10000, '12': 1500 }],
    ['15 -> 17', { '15': 0, '17': 900 }],
    ['15 -> 18', { '15': 0, '18': 900 }],
    ['2 -> 2A', { '2': 0, '2A': 400 }],
  ])('blocks a reclassification that moves only SARS boxes (%s) with every legacy total unchanged', (_name, moved) => {
    const drift = draftDrift(saved(form()), now(form(moved)));
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.every((d) => d.startsWith('SARS field '))).toBe(true);
  });

  it('names the field and both amounts', () => {
    const drift = draftDrift(saved(form()), now(form({ '1A': 500 })));
    expect(drift).toEqual(['SARS field 1A 0.00 -> 500.00']);
  });

  it('sees an uncomputed field turn into a figure, and back', () => {
    expect(draftDrift(saved(form({ '14A': null })), now(form({ '14A': 10 })))).toEqual(['SARS field 14A none -> 10.00']);
    expect(draftDrift(saved(form({ '14A': 10 })), now(form({ '14A': null })))).toEqual(['SARS field 14A 10.00 -> none']);
  });

  it('treats a draft saved without the SARS form as drift (re-save needed), never as a pass', () => {
    const drift = draftDrift({ ...FILED_FIELDS }, now(form()));
    expect(drift).toEqual([DRAFT_PREDATES_REASON]);
  });

  it('words an uncomparable draft in its own terms and a moved figure as the ledger having moved', () => {
    expect(draftBlockReason([DRAFT_NO_FIGURES_REASON]))
      .toBe(`This ${DRAFT_NO_FIGURES_REASON} — re-save the draft and review it before filing`);
    expect(draftBlockReason(['field5_outputVAT 100.00 -> 150.00'])).toMatch(/^The ledger has moved since this draft was saved \(field5_outputVAT/);
  });

  it('names BOTH when a draft predates the mapping and its figures have also moved', () => {
    const drift = draftDrift({ ...FILED_FIELDS, field5_outputVAT: 140000 }, now(form()));
    expect(drift).toHaveLength(2);
    expect(draftBlockReason(drift)).toBe(
      `This ${DRAFT_PREDATES_REASON}; the ledger has moved since this draft was saved `
      + '(field5_outputVAT 140000.00 -> 150000.00) — re-save the draft and review it before filing',
    );
  });

  it('blocks filing such a draft, naming the reason', async () => {
    m.getVat201Return.mockResolvedValue({ ...FILED_FIELDS, rateCheck: tiedRateCheck(), sarsFields: form(), warnings: [], filability: { filable: true, reason: null } });
    const err = await submitVAT201ToSars(CID, SID, UID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EfilingBlockedError);
    expect((err as EfilingBlockedError).reason).toBe(`This ${DRAFT_PREDATES_REASON} — re-save the draft and review it before filing`);
    expect((err as EfilingBlockedError).reason).not.toMatch(/ledger has moved/);
    expect(m.submitVAT201).not.toHaveBeenCalled();
  });
});

describe('pollVAT201Status', () => {
  it('refuses when there is no ISV correlation id to poll', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'draft',
      efilingCorrelationId: null, efilingLastStatus: null, formData: { ...FILED_FIELDS },
    });
    await expect(pollVAT201Status(CID, SID)).rejects.toBeInstanceOf(EfilingBlockedError);
    expect(m.pollStatus).not.toHaveBeenCalled();
  });

  it('polls, maps accepted -> accepted, stores the SARS reference, and audits', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'submitted',
      efilingCorrelationId: 'CORR-1', efilingLastStatus: 'received', formData: { ...FILED_FIELDS },
    });
    const out = await pollVAT201Status(CID, SID);
    expect(out.status).toBe('accepted');
    expect(m.applyPollResult).toHaveBeenCalledWith(CID, SID, expect.objectContaining({
      submissionStatus: 'accepted', efilingStatus: 'accepted', sarsReference: 'REF-1',
    }));
    expect(m.insertEfilingEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'poll' }));
  });

  it('records a poll failure on a connection of its own, so a transaction the failure aborted (25P02) cannot swallow it', async () => {
    m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', status: 'submitted',
      efilingCorrelationId: 'CORR-1', efilingLastStatus: 'received', formData: { ...FILED_FIELDS },
    });
    m.applyPollResult.mockRejectedValue(Object.assign(new Error('trigger refused'), { httpStatus: null }));
    await expect(pollVAT201Status(CID, SID)).rejects.toThrow('trigger refused');
    expect(m.insertEfilingEventCommitted).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'error', message: 'trigger refused' }));
    expect(m.insertEfilingEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'error' }));
  });

  it('maps received and processing to submitted, and an UNKNOWN SARS status to a no-op with a warning (never to submitted)', async () => {
    const draftRow = (status: string) => m.getEfilingSubmission.mockResolvedValue({
      id: SID, companyId: CID, formType: 'VAT201', periodStart: '2026-03-01', periodEnd: '2026-03-31', status,
      efilingCorrelationId: 'CORR-1', efilingLastStatus: null, formData: { ...FILED_FIELDS },
    });
    draftRow('draft');
    m.applyPollResult.mockResolvedValue(undefined);
    m.pollStatus.mockResolvedValue({ status: 'processing', sarsReference: null, errors: [], httpStatus: 200 });
    await pollVAT201Status(CID, SID);
    expect(m.applyPollResult).toHaveBeenLastCalledWith(CID, SID, expect.objectContaining({ submissionStatus: 'submitted' }));
    m.pollStatus.mockResolvedValue({ status: 'unknown', sarsReference: null, errors: [], httpStatus: 200 });
    await pollVAT201Status(CID, SID);
    expect(m.applyPollResult).toHaveBeenLastCalledWith(CID, SID, expect.objectContaining({ submissionStatus: 'draft' })); // unchanged
    const { log } = await import('@/lib/logger');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('does not know'), expect.objectContaining({ efilingStatus: 'unknown' }), expect.any(String));
  });
});

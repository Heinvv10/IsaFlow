/**
 * Forensic-controls step 2's two bank gates, stubbed open for unit tests whose
 * `sql` is a mock: each gate reads Postgres (enforcement, the batch's importer,
 * the session, the allocator), and a mocked `sql` answers those reads with
 * whatever the test queued for something else. The gates themselves are proven
 * against real Postgres in tests/integration/bank-controls-*.int.test.ts.
 *
 *   vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () =>
 *     (await import('../helpers/bankControlGateMocks')).importerGateOpen());
 */
import { vi } from 'vitest';

export function importerGateOpen() {
  // No vi.importActual: loading the real module pulls the approval kernel's graph, which cost a fresh-module test
  // (bankAllocationUnwind) its 5 s budget under the full suite. Every export is stubbed open; the arm is irrelevant
  // when nothing is ever held.
  return {
    armLabel: vi.fn((arm: string) => arm),
    importerArmOf: vi.fn(() => null),
    armEnforced: vi.fn(async () => false),
    isSoleAsCaller: vi.fn(async () => false),
    importerAllocationRefusal: vi.fn(async () => null),
    assertImporterMayAllocate: vi.fn(async () => undefined),
    assertImporterMayAllocateAs: vi.fn(async () => undefined),
    importerRefusalForLineId: vi.fn(async () => null),
    importerHeldLineSkips: vi.fn(async () => new Map()),
    assertImporterMayMatch: vi.fn(async () => undefined),
    importerHeldMatchPairs: vi.fn(async () => new Set<string>()),
  };
}

/**
 * WP2 row 10's other-legs reset (transferLegReset) with no second live line on the journal: its peeks read Postgres.
 * Proven against real Postgres in tests/integration/bank-reversed-journal-line.int.test.ts.
 */
export function transferLegResetNone() {
  return {
    lockOtherLegs: vi.fn(async () => new Map()), takeOtherLegs: vi.fn(async () => [] as string[]),
    journalReversedNow: vi.fn(async () => false),
  };
}

export function reversalGateOpen() {
  return {
    assertMayReverse: vi.fn(async () => null),
    auditedReversal: vi.fn(async (_c: string, _t: string, _u: string, _cl: unknown, result: unknown) => result),
    agentReversalRefusal: vi.fn(async () => null),
    assertMayUndoRun: vi.fn(async () => null),
    auditRunUndo: vi.fn(async () => undefined),
    assertMayReverseMatchedLeg: vi.fn(async () => async () => undefined),
    // The GL reversal entrance stays the D12 lock (whatever the test made of reconciledCash), minus the step-2 gate.
    lockJournalCashForGlReversal: vi.fn(async (companyId: string, journalEntryId: string) =>
      (await import('@/modules/accounting/services/bank/reconciledCash')).refuseJournalCashOfCompletedReconciliation(companyId, journalEntryId)),
  };
}

/**
 * WP2 row 5's bank-contra pre-checks with no bank contra in the batch: each reads gl_accounts / bank_transactions.
 * Proven against real Postgres in tests/integration/bank-contra-transfer-r2.int.test.ts.
 *
 *   vi.mock('@/modules/accounting/services/bank/bankContraLineSkips', async () =>
 *     (await import('../helpers/bankControlGateMocks')).bankContraOpen());
 *   vi.mock('@/modules/accounting/services/bank/transferSweepPrelock', async () =>
 *     (await import('../helpers/bankControlGateMocks')).transferPrelockOpen());
 */
export function bankContraOpen() {
  return {
    TRANSFER_DRY_RUN_CAVEAT: 'transfer caveat',
    batchPostsTransfers: vi.fn(async () => false),
    bankContraLineSkips: vi.fn(async () => new Map<string, string>()),
  };
}

export function transferPrelockOpen() {
  return { preLockSweepTransfers: vi.fn(async () => ({ transfers: new Set<string>(), contended: new Set<string>() })) };
}

/**
 * contactControlGuard with every account open (not AP/AR control): its batch reads hit Postgres. The refusal itself
 * is proven in tests/unit/services/bank/contactControlGuard.test.ts and the allocate-control-account-refused int test.
 */
export async function contactControlOpen() {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/bank/contactControlGuard')>(
    '@/modules/accounting/services/bank/contactControlGuard');
  return {
    ...actual,
    contactControlLineSkips: vi.fn(async () => new Map<string, string>()),
    contactControlAccountIds: vi.fn(async () => new Set<string>()),
    assertNotContactControl: vi.fn(async () => undefined),
  };
}


/**
 * bankAccountGuard accepting every id as an active bank account of the company: its read hits Postgres, and a mocked
 * `sql` would answer it with whatever the test queued for something else. The refusals (another company's account, a
 * non-bank account, a deactivated one) are proven in tests/integration/bank-account-guard-*.int.test.ts.
 */
export async function bankAccountGuardOpen() {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/bank/bankAccountGuard')>(
    '@/modules/accounting/services/bank/bankAccountGuard');
  return {
    ...actual,
    assertBankAccountInCompany: vi.fn(async (_companyId: string, id: unknown) =>
      ({ id: String(id), accountName: 'Bank', bankAccountNumber: null })),
  };
}

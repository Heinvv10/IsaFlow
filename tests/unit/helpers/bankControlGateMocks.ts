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
  };
}

export function reversalGateOpen() {
  return {
    assertMayReverse: vi.fn(async () => null),
    auditedReversal: vi.fn(async (_c: string, _t: string, _u: string, _cl: unknown, result: unknown) => result),
    agentReversalRefusal: vi.fn(async () => null),
    assertMayUndoRun: vi.fn(async () => null),
    auditRunUndo: vi.fn(async () => undefined),
    assertNotBankAllocationReversal: vi.fn(async () => undefined),
  };
}

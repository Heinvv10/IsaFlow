/**
 * `bank-transactions-action` split_allocate: each line's VAT code reaches the
 * service.
 *
 * WHAT WAS BROKEN. BL-33 (5d4f41045, 2026-04-15) put the split body behind a zod
 * schema whose line object had no `vatCode`. zod strips unknown keys, so the
 * VAT code the split modal sends on every line was dropped before
 * `splitAllocateTransaction` saw it: every split saved from the bank screen
 * posted its lines gross, with no VAT leg, whatever the user chose. The MCP
 * split builds its lines itself and was unaffected.
 *
 * The real handler and schema run; only the service and the I/O are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', async () => (await import('../helpers/bankControlGateMocks')).importerGateOpen());
vi.mock('@/modules/accounting/services/bank/bankReversalGate', async () => (await import('../helpers/bankControlGateMocks')).reversalGateOpen());
vi.mock('@/modules/accounting/services/bank/bankControlResponse', () => ({ respondIfBankControlRefused: () => false }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  matchTransaction: vi.fn(), unmatchTransaction: vi.fn(), excludeTransaction: vi.fn(), autoMatchTransactions: vi.fn(),
  allocateTransaction: vi.fn(), splitAllocateTransaction: vi.fn(async () => ({ journalEntryId: 'je-1' })),
  deleteTransactions: vi.fn(), bulkAcceptTransactions: vi.fn(), reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, message: string) => ({ kind: 'badRequest', message })),
    conflict: vi.fn((_res: unknown, message: string) => ({ kind: 'conflict', message })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

import handler from '../../../pages/api/accounting/bank-transactions-action';
import { splitAllocateTransaction } from '@/modules/accounting/services/bank/bankReconciliationService';

const TX = '00000000-0000-4000-8000-000000000003';
const FUEL = '00000000-0000-4000-8000-0000000000aa';
const TOLLS = '00000000-0000-4000-8000-0000000000bb';
const split = (lines: Record<string, unknown>[]) => handler(
  { method: 'POST', companyId: 'c-1', user: { id: 'u-1' }, body: { action: 'split_allocate', bankTransactionId: TX, lines } } as never,
  {} as never,
);

beforeEach(() => vi.clearAllMocks());

describe('split_allocate passes each line\'s VAT code to the service', () => {
  it('the split modal\'s body: every code, line by line', async () => {
    // Exactly what SplitTransactionModal posts (vatCode from VAT_OPTIONS).
    const lines = [
      { contraAccountId: FUEL, amount: 69, vatCode: 'standard', description: 'Fuel' },
      { contraAccountId: TOLLS, amount: 46, vatCode: 'none' },
      { contraAccountId: FUEL, amount: 10, vatCode: 'zero_rated' },
      { contraAccountId: TOLLS, amount: 5, vatCode: 'exempt' },
    ];
    expect(await split(lines)).toMatchObject({ kind: 'success' });
    const sent = vi.mocked(splitAllocateTransaction).mock.calls[0]![2] as { vatCode?: string }[];
    expect(sent.map((l) => l.vatCode)).toEqual(['standard', 'none', 'zero_rated', 'exempt']);
  });

  it('a line with no VAT code still posts (none is the default)', async () => {
    expect(await split([{ contraAccountId: FUEL, amount: 115 }])).toMatchObject({ kind: 'success' });
    expect((vi.mocked(splitAllocateTransaction).mock.calls[0]![2] as { vatCode?: string }[])[0]!.vatCode).toBeUndefined();
  });

  it('refuses a VAT code on a supplier line: the bill already carried the VAT', async () => {
    const SUP = '00000000-0000-4000-8000-0000000000cc';
    expect(await split([{ contactType: 'supplier', contactId: SUP, amount: 115, vatCode: 'standard' }])).toMatchObject({ kind: 'validationError' });
    expect(await split([{ contactType: 'supplier', contactId: SUP, amount: 115, vatCode: 'none' }])).toMatchObject({ kind: 'success' });
    expect(splitAllocateTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses a VAT code that is not one of the four, rather than posting it as no VAT', async () => {
    expect(await split([{ contraAccountId: FUEL, amount: 115, vatCode: 'standard15' }])).toMatchObject({ kind: 'validationError' });
    expect(splitAllocateTransaction).not.toHaveBeenCalled();
  });
});

/**
 * Changing a bank row's Type select (e.g. to Supplier) persists the cleared selection. It used to send
 * `selectionEntityId: null` and `vatCode: null`, which the route's zod schema (`.optional()`, not
 * `.nullable()`) refuses with a 422 on every type change. The body the page really builds is fed to the
 * real route: it must be accepted, and must clear the persisted suggestion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(), assertSupplierInCompany: vi.fn(),
}));

import handler from '../../../pages/api/accounting/bank-transactions-action';
import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';

const COMPANY = '00000000-0000-4000-8000-000000000001';
const TX = '00000000-0000-4000-8000-000000000003';
const SUP = '00000000-0000-4000-8000-000000000005';

function actions() {
  return buildBankTxActions({
    transactions: [], glAccounts: [], selectedBank: 'b', selectedIds: new Set(), rowSelections: {}, batchType: 'account',
    excludingTxId: null, createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(),
    setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(), loadTransactions: vi.fn(),
    refreshBankAccounts: vi.fn(),
  } as unknown as Parameters<typeof buildBankTxActions>[0]);
}
const sent = () => vi.mocked(apiFetch).mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

async function post(body: unknown) {
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json: vi.fn(), setHeader: vi.fn() };
  await handler({ method: 'POST', companyId: COMPANY, user: { id: 'u' }, body } as never, res as unknown as NextApiResponse);
  return res.statusCode;
}

describe('row Type change -> save_selection', () => {
  beforeEach(() => { vi.clearAllMocks(); sqlMock.mockResolvedValueOnce([{ feed_state: 'posted' }]).mockResolvedValue([]); });

  it('sends a body the route accepts, and the route clears the saved suggestion', async () => {
    actions().handleRowTypeChange(TX, 'supplier');
    const bodies = sent();
    expect(bodies).toHaveLength(1);
    expect(await post(bodies[0])).toBe(200);
    // second sql call is the UPDATE; its supplier/customer/gl bindings are all NULL
    const update = sqlMock.mock.calls[1]!;
    expect((update.slice(1) as unknown[]).slice(0, 4)).toEqual([null, null, null, null]);
  });

  it('choosing a supplier then saves once, with the supplier id', async () => {
    actions().handleRowEntityChange(TX, SUP, 'Acme');
    const bodies = sent();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ action: 'save_selection', bankTransactionId: TX, selectionEntityId: SUP });
    expect(await post(bodies[0])).toBe(200);
  });
});

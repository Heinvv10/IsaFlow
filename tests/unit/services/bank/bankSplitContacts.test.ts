/**
 * planSplitContacts (bankSplitContacts.ts): every refusal for the SUPPLIER /
 * CUSTOMER lines of a split, from reads, before anything is written.
 *
 *   · VAT or dimensions on a contact line
 *   · a contact that is not this company's (cross-tenant)
 *   · a hand-keyed payment to one supplier, judged at that supplier's TOTAL
 *   · the statement's own importer allocating it (per contact line, per arm)
 *   · a refund past the contact's credit, judged at that contact's TOTAL
 *   · ids compared lowercased, so one contact cannot be counted twice
 *
 * The service flows (journal, documents) are in bankSplitAllocateContacts.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ name: 'Contact' }]) }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/core/contactDirectoryService')>()),
  assertSupplierInCompany: vi.fn(), assertCustomerInCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/bankLinePaymentGate', () => ({ assertBankLineMayPaySupplier: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', () => ({ assertImporterMayAllocateAs: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierRefundDocument', () => ({ planSupplierRefund: vi.fn(), recordSupplierRefund: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerRefundDocument', () => ({ planCustomerRefund: vi.fn(), recordCustomerRefund: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierAutoAllocate', () => ({ recordSupplierBankPayment: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerAutoAllocate', () => ({ autoApplyCustomerReceipt: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ resolveUserUuid: vi.fn(async (u: string) => u) }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async (kind: string) => (kind === 'payable' ? 'ap-1' : 'ar-1')),
}));

import {
  CustomerNotInCompanyError, SupplierNotInCompanyError, assertCustomerInCompany, assertSupplierInCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { assertBankLineMayPaySupplier } from '@/modules/accounting/services/ap/bankLinePaymentGate';
import { assertImporterMayAllocateAs } from '@/modules/accounting/services/bank/bankLineImporterGate';
import { planSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { planCustomerRefund } from '@/modules/accounting/services/ar/customerRefundDocument';
import { planSplitContacts } from '@/modules/accounting/services/bank/bankSplitContacts';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import type { SplitLine } from '@/modules/accounting/services/bank/bankAllocationTypes';

const COMPANY = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const USER = '00000000-0000-0000-0000-000000000001';
const SUP_A = '2c4b0a2e-1111-4111-8111-aaaaaaaaaaaa';
const SUP_B = '9f0d7c1a-2222-4222-8222-bbbbbbbbbbbb';
const CUST = '5e6f7a8b-3333-4333-8333-cccccccccccc';
const OUT = { id: 'tx-1', bank_account_id: 'bank', amount: -1000, transaction_date: '2026-10-07' };
const IN = { ...OUT, amount: 1000 };

const plan = (tx: typeof OUT, lines: SplitLine[]) => planSplitContacts(COMPANY, tx, lines, USER);
const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const sup = (contactId: string, amount: number, extra: Partial<SplitLine> = {}): SplitLine =>
  ({ contactType: 'supplier', contactId, amount, ...extra });
const cust = (amount: number, extra: Partial<SplitLine> = {}): SplitLine =>
  ({ contactType: 'customer', contactId: CUST, amount, ...extra });

beforeEach(() => {
  vi.resetAllMocks(); // resets once-queues too, not only calls (clearAllMocks would leak them)
  vi.mocked(assertSupplierInCompany).mockResolvedValue(undefined);
  vi.mocked(assertCustomerInCompany).mockResolvedValue(undefined);
});

describe('settlement lines carry no VAT and no dimensions', () => {
  it('refuses VAT on a supplier line', async () => {
    const err = await refusalOf(plan(OUT, [sup(SUP_A, 1000, { vatCode: 'standard' })]));
    expect(isBankAllocationRefusal(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/carries no VAT/);
  });

  it('refuses dimensions on a customer line', async () => {
    const err = await refusalOf(plan(IN, [cust(1000, { cc2Id: 'lawley' })]));
    expect(isBankAllocationRefusal(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/carries no CC1\/CC2\/BU/);
  });

  it('ignores GL-account lines entirely', async () => {
    expect(await plan(OUT, [{ contraAccountId: 'fuel', amount: 1000, vatCode: 'standard' }])).toEqual([]);
    expect(assertImporterMayAllocateAs).not.toHaveBeenCalled();
  });
});

describe('cross-tenant: the contact must be this company\'s', () => {
  it('refuses another company\'s supplier before the importer check or any refund plan', async () => {
    vi.mocked(assertSupplierInCompany).mockRejectedValueOnce(new SupplierNotInCompanyError(SUP_A));
    const err = await refusalOf(plan(IN, [sup(SUP_A, 1000)]));
    expect(err).toBeInstanceOf(SupplierNotInCompanyError);
    expect(vi.mocked(assertSupplierInCompany).mock.calls[0]).toEqual([COMPANY, SUP_A]);
    expect(assertImporterMayAllocateAs).not.toHaveBeenCalled();
    expect(planSupplierRefund).not.toHaveBeenCalled();
  });

  it('refuses another company\'s customer', async () => {
    vi.mocked(assertCustomerInCompany).mockRejectedValueOnce(new CustomerNotInCompanyError(CUST));
    const err = await refusalOf(plan(IN, [cust(1000)]));
    expect(err).toBeInstanceOf(CustomerNotInCompanyError);
    expect(vi.mocked(assertCustomerInCompany).mock.calls[0]).toEqual([COMPANY, CUST]);
  });
});

describe('a hand-keyed payment is judged at what each SUPPLIER is paid', () => {
  it('sums one supplier\'s lines — whatever the id\'s case — into one gate call', async () => {
    await plan(OUT, [sup(SUP_A, 400), sup(SUP_A.toUpperCase(), 350), sup(SUP_B, 250)]);
    expect(vi.mocked(assertBankLineMayPaySupplier).mock.calls).toEqual([
      [COMPANY, OUT, 750],
      [COMPANY, OUT, 250],
    ]);
  });

  it('a gate refusal of the summed payment refuses the split', async () => {
    vi.mocked(assertBankLineMayPaySupplier).mockRejectedValueOnce(new Error('needs admin approval'));
    await expect(plan(OUT, [sup(SUP_A, 500), sup(SUP_A, 500)])).rejects.toThrow(/needs admin approval/);
  });

  it('money IN from a supplier is a refund, not a payment: no payment gate', async () => {
    await plan(IN, [sup(SUP_A, 1000)]);
    expect(assertBankLineMayPaySupplier).not.toHaveBeenCalled();
    expect(planSupplierRefund).toHaveBeenCalledWith(COMPANY, SUP_A, 1000, '2026-10-07');
  });
});

describe('the statement\'s importer may not allocate it — per contact line, per arm', () => {
  it('asks the importer check for every contact line, with the lowercased id', async () => {
    await plan(OUT, [sup(SUP_A.toUpperCase(), 600), cust(400)]);
    expect(vi.mocked(assertImporterMayAllocateAs).mock.calls).toEqual([
      [COMPANY, OUT, USER, 'supplier', SUP_A],
      [COMPANY, OUT, USER, 'customer', CUST],
    ]);
  });

  it('an importer refusal refuses the split', async () => {
    vi.mocked(assertImporterMayAllocateAs).mockRejectedValueOnce(new Error('IMPORTER_MAY_NOT_ALLOCATE'));
    await expect(plan(OUT, [sup(SUP_A, 1000)])).rejects.toThrow(/IMPORTER_MAY_NOT_ALLOCATE/);
  });
});

describe('a refund is judged at what each CONTACT is refunded', () => {
  it('sums one supplier\'s refund lines, whatever the id\'s case', async () => {
    await plan(IN, [sup(SUP_A, 100), sup(SUP_A.toUpperCase(), 200)]);
    expect(vi.mocked(planSupplierRefund).mock.calls).toEqual([[COMPANY, SUP_A, 300, '2026-10-07']]);
  });

  it('money OUT to a customer is a refund, checked against the customer\'s credit', async () => {
    vi.mocked(planCustomerRefund).mockRejectedValueOnce(new Error('exceeds the customer\'s credit'));
    await expect(plan(OUT, [cust(600), cust(400)])).rejects.toThrow(/exceeds the customer's credit/);
    expect(vi.mocked(planCustomerRefund).mock.calls[0]).toEqual([COMPANY, CUST, 1000, '2026-10-07']);
  });

  it('money IN from a customer is a receipt: no refund ceiling', async () => {
    await plan(IN, [cust(1000)]);
    expect(planCustomerRefund).not.toHaveBeenCalled();
  });

  it('plans (and so locks) the contacts in id order, whatever the line order', async () => {
    await plan(IN, [sup(SUP_B, 500), sup(SUP_A, 500)]);
    expect(vi.mocked(planSupplierRefund).mock.calls.map((c) => c[1])).toEqual([SUP_A, SUP_B]);
  });
});

describe('the plan', () => {
  it('names the control account, the direction\'s wording and the auto-apply mode', async () => {
    const planned = await plan(OUT, [sup(SUP_A, 600, { autoApply: 'none' }), cust(400)]);
    expect(planned).toEqual([
      expect.objectContaining({ index: 0, kind: 'supplier', contactId: SUP_A, controlAccountId: 'ap-1', amount: 600, autoApply: 'none', description: 'Payment to Contact' }),
      expect.objectContaining({ index: 1, kind: 'customer', contactId: CUST, controlAccountId: 'ar-1', amount: 400, autoApply: 'fifo', description: 'Refund to Contact' }),
    ]);
  });
});

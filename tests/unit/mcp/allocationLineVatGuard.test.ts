/**
 * The MCP allocation path refuses a VAT claim on an account where no supply
 * can arise — and tells the caller it did.
 *
 * WHY HERE, OF ALL PLACES. Every one of the 35 non-supply VAT lines in
 * production was posted by `mcp:bulk_allocate_bank_transactions:v1` —
 * Velocity's 34 salary lines (R237,021.60 of manufactured input tax) and
 * Brightsphere's investment disposal (R9,782.61). None by a human, none by the
 * rule sweep, none by the confidence gate, none by provisional posting. That
 * tool posts roughly 8,200 of the ~10,900 bank allocations in the ledger,
 * three times what humans post.
 *
 * `allocateTransaction` coerces nothing by design — it is the attended path,
 * where a screen showed the warning and the user chose. Nothing shows a
 * warning here, so this path guards itself like the other unattended posters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { allocateTransaction, resolveRuleVatCode } = vi.hoisted(() => ({
  allocateTransaction: vi.fn(),
  resolveRuleVatCode: vi.fn(),
}));

vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({ allocateTransaction }));
vi.mock('@/modules/accounting/services/gl/ruleVatResolution', () => ({ resolveRuleVatCode }));
vi.mock('@/modules/accounting/services/ar/receiptMatchConfirmService', () => ({
  confirmReceiptMatch: vi.fn(), validateBankReceiptApplication: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierBankPaymentService', () => ({
  applyBankLineToSupplierInvoices: vi.fn(), validateBankSupplierPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankMatchDbQueries', () => ({
  fetchBankTransaction: vi.fn(),
}));

import { postAllocationLine, type AllocationLine } from '@/lib/mcp/tools/allocationLine';

const CTX = {
  companyId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  userId: 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu',
  tokenJti: 'jti-123',
} as never;
const TX = 'tttttttt-tttt-tttt-tttt-tttttttttttt';
const ACCT = 'gggggggg-gggg-gggg-gggg-gggggggggggg';

const line = (over: Partial<AllocationLine> = {}): AllocationLine => ({
  allocType: 'account',
  entityId: undefined,
  invoiceId: undefined,
  contraAccountId: ACCT,
  description: 'Salary run',
  vatCode: 'standard',
  ...over,
} as AllocationLine);

/** The vat code actually handed to allocateTransaction (8th positional arg). */
const postedVat = () => allocateTransaction.mock.calls[0]![7];

beforeEach(() => {
  vi.clearAllMocks();
  allocateTransaction.mockResolvedValue({
    journalEntryId: 'je-1', bankTransaction: { id: TX },
  });
});

describe('postAllocationLine — the non-supply coercion', () => {
  it('posts gross when no supply can arise, and reports the coercion', async () => {
    resolveRuleVatCode.mockResolvedValue({
      vatCode: 'none', denied: false, nonSupplyCoerced: true, settlementDropped: false,
    });

    const r = await postAllocationLine(CTX, TX, line(), 'bulk_allocate_bank_transactions');

    expect(postedVat(), 'the agent asked for standard; it must not post').toBe('none');
    expect(r.vatCoerced).toEqual({ from: 'standard', to: 'none', reason: 'no_supply' });
  });

  it('reports an entertainment denial distinctly from a non-supply', async () => {
    // Two counters exist so someone fixes the right configuration. A denial
    // relabelled as a non-supply sends them to the wrong place.
    resolveRuleVatCode.mockResolvedValue({
      vatCode: 'none', denied: true, nonSupplyCoerced: false, settlementDropped: false,
    });

    const r = await postAllocationLine(CTX, TX, line(), 'allocate_bank_transaction');

    expect(postedVat()).toBe('none');
    expect(r.vatCoerced).toEqual({ from: 'standard', to: 'none', reason: 'input_tax_denied' });
  });

  it('leaves a real supply claiming, and says nothing', async () => {
    resolveRuleVatCode.mockResolvedValue({
      vatCode: 'standard', denied: false, nonSupplyCoerced: false, settlementDropped: false,
    });

    const r = await postAllocationLine(CTX, TX, line(), 'allocate_bank_transaction');

    expect(postedVat()).toBe('standard');
    expect(r.vatCoerced).toBeUndefined();
  });

  it('passes an absent code through untouched, exactly as before the guard', async () => {
    // A line nobody objects to must post byte-identically to how it did
    // before this guard existed — `undefined`, not the string 'none'.
    resolveRuleVatCode.mockResolvedValue({
      vatCode: 'none', denied: false, nonSupplyCoerced: false, settlementDropped: false,
    });

    const r = await postAllocationLine(CTX, TX, line({ vatCode: undefined }), 'x');

    expect(postedVat()).toBeUndefined();
    expect(r.vatCoerced).toBeUndefined();
  });

  // K-016/K-017 review, MEDIUM: the drop was invisible. An agent that sends
  // vat_code 'standard' on a supplier line gets a correct posting either way,
  // but a success-shaped reply that says nothing is how a misconfigured caller
  // keeps sending it.
  it('reports a settlement drop as its own reason, not as a statutory guard', async () => {
    resolveRuleVatCode.mockResolvedValue({
      vatCode: 'none', denied: false, nonSupplyCoerced: false, settlementDropped: true,
    });

    const r = await postAllocationLine(
      CTX, TX, line({ allocType: 'supplier', contraAccountId: undefined }), 'allocate_bank_transaction',
    );

    expect(postedVat()).toBe('none');
    expect(r.vatCoerced).toEqual({ from: 'standard', to: 'none', reason: 'settlement' });
  });

  // The other half of it: every supplier line is a settlement, so reporting a
  // coercion from 'none' to 'none' would put noise on all of them.
  it('says nothing when a settlement line asked for no VAT anyway', async () => {
    resolveRuleVatCode.mockResolvedValue({
      vatCode: 'none', denied: false, nonSupplyCoerced: false, settlementDropped: true,
    });

    const r = await postAllocationLine(
      CTX, TX, line({ allocType: 'supplier', contraAccountId: undefined, vatCode: undefined }), 'x',
    );

    expect(postedVat(), 'unchanged callers still post undefined, not "none"').toBeUndefined();
    expect(r.vatCoerced).toBeUndefined();
  });

  it('asks the guard about the contra account the line actually names', async () => {
    resolveRuleVatCode.mockResolvedValue({
      vatCode: 'standard', denied: false, nonSupplyCoerced: false, settlementDropped: false,
    });

    await postAllocationLine(CTX, TX, line(), 'bulk_allocate_bank_transactions');

    expect(resolveRuleVatCode).toHaveBeenCalledWith(expect.objectContaining({
      allocType: 'account',
      companyId: CTX.companyId,
      requestedVatCode: 'standard',
      glAccountId: ACCT,
    }));
  });
});

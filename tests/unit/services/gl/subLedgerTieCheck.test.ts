/**
 * The AR / AP "sub-ledger ties to GL" close gate, read POINT IN TIME.
 *
 * The regression: the gate summed each document's CURRENT balance filtered by
 * CURRENT status and compared it with the control balance AS AT period end.
 * An invoice open at period end and paid since dropped out of one side only,
 * so Velocity Fibre's July 2025 read "AR sub-ledger R0.00 vs GL receivable
 * R210,573.82" while reconcile_subledger(ar, 2025-07-31) tied to the cent, and
 * close_fiscal_period refused every month-end.
 *
 * The gate now delegates both sides to reconcileSubledger(companyId, role,
 * endDate) and takes its verdict over the typed control-bridge items.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withSavepoint: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/reconciliation/subledgerReconciliationService', () => ({
  reconcileSubledger: vi.fn(),
}));

import { sql, withSavepoint } from '@/lib/neon';
import {
  reconcileSubledger,
  type SubledgerReconciliation,
} from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import type { ReconcilingItem } from '@/modules/accounting/services/reconciliation/reconcilingItemTypes';
import { arSubLedgerCheck, SUB_LEDGER_FAIL_THRESHOLD } from '@/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck';
import { apSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/apSubLedgerCheck';

const mockReconcile = vi.mocked(reconcileSubledger);
const COMPANY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function rec(over: Partial<SubledgerReconciliation> = {}): SubledgerReconciliation {
  return {
    subledger: 'ar',
    as_at: '2025-07-31',
    agedTotal: 0,
    subledgerTotal: 0,
    subledgerUnavailable: null,
    controlAccounts: [],
    controlAccountBalance: 0,
    controlAccountAmbiguous: false,
    difference: 0,
    reconcilingItems: [],
    unexplainedDifference: 0,
    excludedRows: [],
    settlementFlagged: {} as SubledgerReconciliation['settlementFlagged'],
    invariants: [],
    postedThrough: null,
    ...over,
  };
}

function it_(type: string, amount: number, numbers: string[] = [], bridge: ReconcilingItem['bridge'] = 'subledger_to_control'): ReconcilingItem {
  return {
    bridge, type, description: type, amount,
    documentIds: numbers.map((_, i) => `id-${type}-${i}`),
    documentNumbers: numbers,
    citedGross: Math.abs(amount), citedAbsAmount: Math.abs(amount),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('arSubLedgerCheck — point in time', () => {
  it('asks reconcileSubledger for AR AS AT the period end, scoped to the company', async () => {
    mockReconcile.mockResolvedValueOnce(rec());
    await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' });
    expect(mockReconcile).toHaveBeenCalledWith(COMPANY_A, 'ar', '2025-07-31');
    // No raw SQL of its own — the reconciliation owns every (company-scoped) read.
    expect(sql).not.toHaveBeenCalled();
    expect(withSavepoint).toHaveBeenCalledWith('ar_tie_recon', expect.any(Function));
  });

  it('forwards whichever company it is given — never a cross-tenant read', async () => {
    mockReconcile.mockResolvedValue(rec());
    await arSubLedgerCheck(COMPANY_B, { endDate: '2025-07-31' });
    expect(mockReconcile.mock.calls[0]![0]).toBe(COMPANY_B);
    expect(mockReconcile.mock.calls.every((c) => c[0] === COMPANY_B)).toBe(true);
  });

  it('PASSES an invoice open at period end and paid since (the Velocity July 2025 case)', async () => {
    // The as-at rewind keeps the invoice open on the subledger side, so both
    // sides read R210,573.82 and there are no reconciling items.
    mockReconcile.mockResolvedValueOnce(rec({
      subledgerTotal: 210573.82, controlAccountBalance: 210573.82, difference: 0,
    }));
    const item = await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' });
    expect(item).toMatchObject({ key: 'ar_ties', label: 'AR sub-ledger ties to GL', status: 'pass', fixHref: '/accounting/customer-invoices' });
    expect(item.reason).toContain('R210573.82');
  });

  it('passes when the only items are unapplied cash and unapplied credit notes, and names them', async () => {
    mockReconcile.mockResolvedValueOnce(rec({
      subledgerTotal: 1000, controlAccountBalance: 700, difference: 300,
      reconcilingItems: [
        it_('unapplied_receipt', 250, ['RC-1', 'RC-2']),
        it_('unapplied_credit_note', 50, ['CN-1']),
        it_('disputed_amount', 999, ['INV-9'], 'aged_to_subledger'), // other bridge: ignored
      ],
    }));
    const item = await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' });
    expect(item.status).toBe('pass');
    expect(item.reason).toContain('unapplied_receipt R250.00');
    expect(item.reason).toContain('unapplied_credit_note R50.00');
  });

  it('FAILS on posting_with_no_document, naming it and its amount', async () => {
    mockReconcile.mockResolvedValueOnce(rec({
      subledgerTotal: 0, controlAccountBalance: 5000, difference: -5000,
      reconcilingItems: [it_('posting_with_no_document', -5000, ['JE-2025-00001'])],
    }));
    const item = await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' });
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('posting_with_no_document R-5000.00');
    expect(item.reason).toContain('JE-2025-00001');
    expect(item.reason).toContain('GL receivable R5000.00');
  });

  it('FAILS on an unexplained difference', async () => {
    mockReconcile.mockResolvedValueOnce(rec({
      subledgerTotal: 1500, controlAccountBalance: 1000, difference: 500, unexplainedDifference: 500,
      reconcilingItems: [it_('unexplained_difference', 500)],
    }));
    const item = await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' });
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('unexplained_difference R500.00');
  });

  it('warns (not fails) when the failing items total <= the threshold, passes within 0.01', async () => {
    mockReconcile.mockResolvedValueOnce(rec({ reconcilingItems: [it_('unexplained_difference', SUB_LEDGER_FAIL_THRESHOLD)] }));
    expect((await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' })).status).toBe('warn');
    mockReconcile.mockResolvedValueOnce(rec({ reconcilingItems: [it_('unexplained_difference', 0.01)] }));
    expect((await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' })).status).toBe('pass');
  });

  it('sums failing items by ABSOLUTE value — opposite signs cannot cancel into a pass', async () => {
    mockReconcile.mockResolvedValueOnce(rec({
      reconcilingItems: [it_('posting_with_no_document', 400), it_('document_not_on_control_account', -400, ['INV-1'])],
    }));
    const item = await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' });
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('R800.00 does not tie');
  });

  it('warns "Could not compute" when reconcileSubledger throws — never a fabricated pass', async () => {
    mockReconcile.mockRejectedValueOnce(new Error('relation does not exist'));
    const item = await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' });
    expect(item.status).toBe('warn');
    expect(item.reason).toMatch(/^Could not compute/);
    expect(item.key).toBe('ar_ties');
  });

  it('warns "Could not compute" when there are open documents but no control account', async () => {
    mockReconcile.mockResolvedValueOnce(rec({ subledgerTotal: 800, controlAccountBalance: null, difference: null }));
    const item = await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' });
    expect(item.status).toBe('warn');
    expect(item.reason).toMatch(/^Could not compute/);
  });

  it('warns "Could not compute" when the subledger side is null', async () => {
    mockReconcile.mockResolvedValueOnce(rec({ subledgerTotal: null, difference: null }));
    const item = await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' });
    expect(item.status).toBe('warn');
    expect(item.reason).toMatch(/^Could not compute/);
  });

  it('passes a company with no control account AND nothing open (nothing to tie)', async () => {
    mockReconcile.mockResolvedValueOnce(rec({ subledgerTotal: 0, controlAccountBalance: null, difference: null }));
    expect((await arSubLedgerCheck(COMPANY_A, { endDate: '2025-07-31' })).status).toBe('pass');
  });
});

describe('apSubLedgerCheck — point in time', () => {
  it('asks reconcileSubledger for AP AS AT the period end', async () => {
    mockReconcile.mockResolvedValueOnce(rec({ subledger: 'ap' }));
    const item = await apSubLedgerCheck(COMPANY_A, { endDate: '2025-05-31' });
    expect(mockReconcile).toHaveBeenCalledWith(COMPANY_A, 'ap', '2025-05-31');
    expect(item).toMatchObject({ key: 'ap_ties', label: 'AP sub-ledger ties to GL', status: 'pass', fixHref: '/accounting/supplier-invoices' });
  });

  it('FAILS on document_not_on_control_account (bills journalled after period end) and names the bills', async () => {
    // Velocity May 2025: subledger R3,085,503.62 vs control R2,802,373.62, the
    // R283,130.00 difference is 4 bills whose journals are dated after 31 May.
    mockReconcile.mockResolvedValueOnce(rec({
      subledger: 'ap', subledgerTotal: 3085503.62, controlAccountBalance: 2802373.62, difference: 283130,
      reconcilingItems: [
        it_('document_not_on_control_account', 283130, ['SIV-1', 'SIV-2', 'SIV-3', 'SIV-4', 'SIV-5']),
        it_('unapplied_receipt', -1000, ['SP-1']),
      ],
    }));
    const item = await apSubLedgerCheck(COMPANY_A, { endDate: '2025-05-31' });
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('AP sub-ledger R3085503.62 vs GL payable R2802373.62');
    expect(item.reason).toContain('document_not_on_control_account R283130.00');
    expect(item.reason).toContain('SIV-1, SIV-2, SIV-3, SIV-4, +1 more');
    expect(item.reason).toContain('Tolerated, not errors: unapplied_receipt R-1000.00');
  });

  it('PASSES a prepayment: bill dated after period end, payment before it (settlement_before_document)', async () => {
    mockReconcile.mockResolvedValueOnce(rec({
      subledger: 'ap', subledgerTotal: 1000, controlAccountBalance: 700, difference: 300,
      reconcilingItems: [it_('settlement_before_document', 300, ['SIV-JUN-1'])],
    }));
    const item = await apSubLedgerCheck(COMPANY_A, { endDate: '2025-05-31' });
    expect(item.status).toBe('pass');
    expect(item.reason).toContain('settlement_before_document R300.00');
  });

  it('FAILS a true cut-off: bill dated in the period, journal after it (document_not_on_control_account)', async () => {
    mockReconcile.mockResolvedValueOnce(rec({
      subledger: 'ap', subledgerTotal: 1300, controlAccountBalance: 700, difference: 600,
      reconcilingItems: [
        it_('settlement_before_document', 300, ['SIV-JUN-1']),
        it_('document_not_on_control_account', 300, ['SIV-MAY-9']),
      ],
    }));
    const item = await apSubLedgerCheck(COMPANY_A, { endDate: '2025-05-31' });
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('document_not_on_control_account R300.00 (1: SIV-MAY-9)');
    expect(item.reason).not.toContain('does not tie: settlement_before_document');
  });

  it('passes on unapplied payments only', async () => {
    mockReconcile.mockResolvedValueOnce(rec({
      subledger: 'ap', subledgerTotal: 500, controlAccountBalance: 300, difference: 200,
      reconcilingItems: [it_('unapplied_receipt', 200, ['SP-9'])],
    }));
    expect((await apSubLedgerCheck(COMPANY_A, { endDate: '2025-05-31' })).status).toBe('pass');
  });

  it('warns "Could not compute" when reconcileSubledger throws', async () => {
    mockReconcile.mockRejectedValueOnce(new Error('boom'));
    const item = await apSubLedgerCheck(COMPANY_A, { endDate: '2025-05-31' });
    expect(item).toMatchObject({ key: 'ap_ties', status: 'warn' });
    expect(item.reason).toMatch(/^Could not compute/);
    expect(withSavepoint).toHaveBeenCalledWith('ap_tie_recon', expect.any(Function));
  });
});

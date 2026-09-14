/**
 * The VAT code an unattended provisional posting asks the controlled allocation for.
 *
 * Its own file, and its own concern: everything else in postProvisional is prediction and skip guards
 * (provisionalPostingService.test.ts), while this decides whether a machine claims input tax with nobody watching, and
 * in what vocabulary. Three statutory guards may drop the predicted claim; whatever survives has to be a code the
 * PLAN's schema accepts, because the allocation — not this service — does the net/VAT arithmetic and raises the VAT leg.
 *
 * `parseBankAllocationPlan` is imported for real here rather than mocked: the property worth pinning is that the code
 * this service hands over is one the plan will actually take, which a hand-written list of strings cannot prove.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') }),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, fmtDate: (x: unknown) => String(x) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateProvisionalTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({ id: 'acc-suspense-1' }),
  getSystemAccountId: vi.fn().mockResolvedValue('acc-suspense-1'),
}));

import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';
import { allocateProvisionalTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import { parseBankAllocationPlan } from '@/modules/accounting/services/bank/bankAllocationPlan';

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const BANK_TX_ID  = 'cccccccc-0000-0000-0000-000000000003';
const USER_ID     = 'dddddddd-0000-0000-0000-000000000004';
const GL_ACC_ID   = 'eeeeeeee-0000-0000-0000-000000000005';

function makeHistoryRows(vatCode: string, count: number) {
  return Array.from({ length: count }, () => ({
    gl_account_id: GL_ACC_ID, vat_code: vatCode, cost_centre_id: null, project_id: null,
  }));
}
/** The prediction reads: bank row, suppliers, then that supplier's coding history. */
function predictionReads(vatCode: string, over: { amount?: number; description?: string } = {}) {
  // `feed_state` is part of the row the service SELECTs, and `feedStateOf` THROWS on a row
  // without it rather than treating the absence as 'posted' — a SELECT that forgot the column
  // must not read as a posted line. A fixture without it is a row pg never returns.
  vi.mocked(sqlMock).mockResolvedValueOnce([{ id: BANK_TX_ID, amount: over.amount ?? -1150,
    description: over.description ?? 'ESKOM HOLDINGS PAYMENT', status: 'imported', bank_account_id: 'ba-1',
    feed_state: 'posted', transaction_date: '2026-04-10' }] as never);
  vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: over.description ?? 'Eskom Holdings' }] as never);
  vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(vatCode, 4) as never);
}
/** The code handed to the controlled allocation (its 7th argument). */
function requestedVatCode(): unknown {
  return vi.mocked(allocateProvisionalTransaction).mock.calls[0]![6];
}
/**
 * Whether the plan's schema takes that code on the single-line account allocation this service builds. The ids here are
 * version-4 UUIDs rather than the readable fixture constants above, because the plan's `z.string().uuid()` rejects a
 * padded id whose version nibble is wrong — a detail of the schema, not of this service.
 */
const PLAN_BANK_TX = '9f1c0f5a-3b7e-4a1d-8c22-2b5a7e6d4c31';
const PLAN_ACCOUNT = '6d2a8e14-5c9b-4f3a-9e77-1a4c8b2d6f90';
function planAccepts(vatCode: unknown) {
  return parseBankAllocationPlan({ version: 1, kind: 'account', bankTransactionId: PLAN_BANK_TX,
    lines: [{ accountId: PLAN_ACCOUNT, amount: '1150.00', vatCode }], provisional: { confidence: 0.9 } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(allocateProvisionalTransaction).mockResolvedValue({ journalEntryId: 'je-001', bankTransaction: { id: 'bt-1' } } as never);
  vi.mocked(getSystemAccountId).mockResolvedValue('acc-suspense-1' as never);
});

describe('the vat code postProvisional asks the controlled allocation for', () => {
  it('normalises a legacy spelling to a code the plan actually accepts', async () => {
    // supplier_coding_history holds legacy spellings ('S', 'Z') beside the current vocabulary. Unnormalised, 'S' would
    // reach the plan and be a ZodError — a FAULT that aborts the whole sweep — where the old arithmetic simply took the
    // no-VAT branch, because it split only on 'standard'. So the same predicate, expressed in the plan's vocabulary.
    predictionReads('S');
    vi.mocked(sqlMock).mockResolvedValue([] as never);

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    expect(requestedVatCode()).toBe('none');
    // The real schema takes what this service asked for …
    expect(planAccepts(requestedVatCode()).lines[0]!.vatCode).toBe('none');
    // … and would have refused the raw legacy spelling, which is the whole reason the normalisation exists.
    expect(() => planAccepts('S')).toThrow();
  });

  it('drops a claim its own history taught it, so no VAT leg can be raised', async () => {
    // The prediction is the most frequent vat_code on that supplier's prior lines, so a ledger already carrying the
    // defect trains this path to reproduce it — Velocity's salary account has 34 historical lines at 'standard'.
    predictionReads('standard', { amount: -1150, description: 'Payroll Services' });
    vi.mocked(sqlMock).mockResolvedValueOnce(
      [{ vat_input_denied: false, account_code: '49784360', account_name: 'Salaries & Wages - EX4000' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ account_name: 'Salaries & Wages - EX4000' }] as never);
    vi.mocked(sqlMock).mockResolvedValue([] as never);

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    // 'none' is what makes the allocation post the gross with no VAT line: the guard decides the claim, the allocation
    // does the arithmetic. A 'standard' surviving here is the R237,021.60 shape.
    expect(requestedVatCode()).toBe('none');
    expect(planAccepts(requestedVatCode()).lines[0]!.vatCode).toBe('none');
    // vat_input is never resolved by this service at all — the allocation owns the VAT account.
    expect(vi.mocked(getSystemAccountId).mock.calls.map((c) => c[0])).not.toContain('vat_input');
  });

  it('passes a surviving claim through as standard, leaving the VAT account to the allocation', async () => {
    predictionReads('standard');
    // The unattended guards read the predicted account before the lines are built — once per statute, on a real supply
    // name, so the claim passes through; then the contra's subtype, because a contra that IS a bank account is a
    // transfer and claims nothing.
    vi.mocked(sqlMock).mockResolvedValueOnce(
      [{ vat_input_denied: false, account_code: '5700', account_name: 'Electricity & Water' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ account_name: 'Electricity & Water' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ account_subtype: 'default_expense' }] as never);
    vi.mocked(sqlMock).mockResolvedValue([] as never);

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    expect(requestedVatCode()).toBe('standard');
    expect(planAccepts(requestedVatCode()).lines[0]!.vatCode).toBe('standard');
    // The allocation resolves the VAT system account and refuses when it is missing or ambiguous ('Allocation VAT
    // account unavailable'); this service neither resolves it nor splits the amount.
    expect(vi.mocked(getSystemAccountId).mock.calls.map((c) => c[0])).not.toContain('vat_input');
  });

  it('hands over the statement narrative with it, and no posting metadata', async () => {
    // 'ai-provisional:v1' is stamped by the allocation effect from the plan's provisional block, not passed from here —
    // proven on the real route in tests/integration/controls/provisionalControl.int.test.ts.
    predictionReads('S');
    vi.mocked(sqlMock).mockResolvedValue([] as never);

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    const call = vi.mocked(allocateProvisionalTransaction).mock.calls[0]!;
    expect(call[5]).toBe('ESKOM HOLDINGS PAYMENT');
    expect(call.length).toBe(7);
  });
});

/**
 * A bank line's SIGN decides the direction of the journal it posts.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `allocateTransaction` computes `isSpent` from the sign of the bank amount and
 * used it in exactly two of its four branches. The `supplier` branch always
 * posted DR Accounts Payable / CR Bank and the `customer` branch always posted
 * DR Bank / CR Accounts Receivable, whatever the line's sign. So a supplier
 * REFUND — money in — was booked as if it were a payment out: the bank was
 * credited when it should have been debited, and the account finished wrong by
 * TWICE the line value.
 *
 * Nothing failed. The call returned success and the row showed as allocated;
 * the only symptom was a bank balance that no longer tied, with no unallocated
 * line to point at. On Velocity Fibre that was R261,651.64 across five lines
 * (RohCap +R120,290 in FY26, four on-account refunds in FY27), found only by a
 * full GL-vs-bank diff on (date, signed amount).
 *
 * The customer arm had the mirror bug and no occurrence yet: a customer refund
 * (money OUT) posted DR Bank / CR AR, moving the bank the wrong way by twice.
 *
 * ── WHAT ELSE FOLLOWS THE SIGN ──────────────────────────────────────────────
 *
 * Three things, and each was wrong on a refund for its own reason:
 *
 *   · the VAT side. `vatAccountKey` is derived from `isSpent`, so a supplier
 *     refund reached for vat_OUTPUT. A refund reverses the original purchase,
 *     so it reverses INPUT tax — the account follows the alloc type, which is
 *     what the entity is, not the direction the cash happened to move.
 *   · the 4-way match. A refund is not a payment; flagging the most recent
 *     unpaid bill `payment_matched` for money coming back in is a settlement
 *     that never happened.
 *   · the receipt document. A customer refund is cash going OUT, so it must not
 *     mint a `customer_payments` row — a receipt for money the company paid.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  return { sql: vi.fn(), withTransaction: vi.fn(), fmtDate: actual.fmtDate };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(), postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({
  mapTxRow: vi.fn((row: unknown) => row),
}));
vi.mock('@/modules/accounting/services/capture/fourWayMatchService', () => ({
  recordPaymentMatch: vi.fn(),
}));

import { sql, withTransaction } from '@/lib/neon';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import { recordPaymentMatch } from '@/modules/accounting/services/capture/fourWayMatchService';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { enterFakeRequestCtx } from '../helpers/requestCtx';

beforeEach(() => enterFakeRequestCtx());

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const mockWithTx = withTransaction as unknown as MockedFunction<
  (fn: (wTx: unknown) => Promise<void>) => Promise<void>
>;
const mockGetSystemAccountId = getSystemAccountId as MockedFunction<typeof getSystemAccountId>;
const mockCreateJE = createJournalEntry as MockedFunction<typeof createJournalEntry>;
const mockPostJE = postJournalEntry as MockedFunction<typeof postJournalEntry>;
const mockRecordPaymentMatch = recordPaymentMatch as MockedFunction<typeof recordPaymentMatch>;

const COMPANY_ID = '4a159669-2f50-46b5-a7b8-2e94dab3d495'; // Velocity Fibre
const BANK_TX_ID = 'btx-0000-0000-0000-000000000001';
const BANK_ACCOUNT_ID = 'ba-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'sup-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'cus-0000-0000-0000-000000000001';
const AP_ID = 'ap-0000-0000-0000-000000000001';
const AR_ID = 'ar-0000-0000-0000-000000000001';
const VAT_INPUT_ID = 'vatin-0000-0000-0000-00000000001';
const VAT_OUTPUT_ID = 'vatout-0000-0000-0000-0000000001';
const JE_ID = 'je-0000-0000-0000-000000000001';
const JL_ID = 'jl-0000-0000-0000-000000000001';

function txRow(amount: number) {
  return {
    id: BANK_TX_ID,
    bank_account_id: BANK_ACCOUNT_ID,
    amount,
    transaction_date: new Date('2026-02-04'),
    status: 'imported',
    description: 'ROHCAP REFUND',
    reference: 'RC-1187',
  };
}

/**
 * Wire the mocks for one supplier/customer allocation.
 *
 * The `sql` queue is positional, so it mirrors the service's real read order:
 * the locked bank row, the entity name, the source-document lookup, the journal
 * line, then — for a money-OUT supplier line only — the 4-way match candidate,
 * and finally the row read back. `mockResolvedValue` backstops the tail so a
 * branch that legitimately reads one fewer time does not fall off the end.
 */
function setup(kind: 'supplier' | 'customer', amount: number) {
  mockSql
    .mockResolvedValueOnce([txRow(amount)])
    .mockResolvedValueOnce([{ name: kind === 'supplier' ? 'RohCap' : 'Fibertime' }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: JL_ID }])
    .mockResolvedValue([txRow(amount)]);

  mockWithTx.mockImplementation(async (fn) => { await fn(vi.fn().mockResolvedValue(undefined)); });

  mockGetSystemAccountId.mockImplementation(async (key: string) => {
    if (key === 'payable') return AP_ID;
    if (key === 'receivable') return AR_ID;
    if (key === 'vat_input') return VAT_INPUT_ID;
    if (key === 'vat_output') return VAT_OUTPUT_ID;
    throw new Error(`unexpected system account ${key}`);
  });

  mockCreateJE.mockResolvedValue({
    id: JE_ID, companyId: COMPANY_ID, entryDate: '2026-02-04',
    description: 'x', status: 'draft', source: 'auto_supplier_payment',
  } as never);
  mockPostJE.mockResolvedValue(undefined);
}

async function allocate(
  kind: 'supplier' | 'customer', amount: number, vatCode?: string,
): Promise<JournalLineInput[]> {
  setup(kind, amount);
  const { allocateTransaction } = await import(
    '@/modules/accounting/services/bank/bankAllocationService'
  );
  await allocateTransaction(
    COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, kind,
    kind === 'supplier' ? SUPPLIER_ID : CUSTOMER_ID, vatCode,
  );
  const [, jeInput] = mockCreateJE.mock.calls[0]!;
  return jeInput.lines as JournalLineInput[];
}

/** The one line touching `accountId`, which every assertion here is about. */
function lineFor(lines: JournalLineInput[], accountId: string): JournalLineInput {
  const found = lines.filter((l) => l.glAccountId === accountId);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe('allocateTransaction — supplier lines follow the sign', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts DR AP / CR Bank for a payment OUT (unchanged)', async () => {
    const lines = await allocate('supplier', -115);
    expect(lineFor(lines, AP_ID)).toMatchObject({ debit: 115, credit: 0 });
    expect(lineFor(lines, BANK_ACCOUNT_ID)).toMatchObject({ debit: 0, credit: 115 });
  });

  // The regression the brief asks for by name: a positive line must NEVER post
  // DR AP / CR Bank. R120,290 in, booked as R120,290 out, is R240,580 of drift.
  it('posts DR Bank / CR AP for a refund IN — never the payment direction', async () => {
    const lines = await allocate('supplier', 120290);
    const bank = lineFor(lines, BANK_ACCOUNT_ID);
    const ap = lineFor(lines, AP_ID);
    expect(bank).toMatchObject({ debit: 120290, credit: 0 });
    expect(ap).toMatchObject({ debit: 0, credit: 120290 });
    expect(ap.debit).toBe(0);
    expect(bank.credit).toBe(0);
  });

  it('balances either way', async () => {
    for (const amount of [-115, 120290]) {
      vi.clearAllMocks();
      const lines = await allocate('supplier', amount);
      const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
      const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(debit).toBeCloseTo(credit, 2);
      expect(debit).toBeCloseTo(Math.abs(amount), 2);
    }
  });

  it('reverses INPUT tax on a refund, not output tax', async () => {
    const lines = await allocate('supplier', 115, 'standard');
    expect(mockGetSystemAccountId).toHaveBeenCalledWith('vat_input', COMPANY_ID);
    expect(mockGetSystemAccountId).not.toHaveBeenCalledWith('vat_output', COMPANY_ID);
    expect(lineFor(lines, VAT_INPUT_ID)).toMatchObject({ debit: 0, credit: 15 });
    expect(lineFor(lines, AP_ID)).toMatchObject({ debit: 0, credit: 100 });
    expect(lineFor(lines, BANK_ACCOUNT_ID)).toMatchObject({ debit: 115, credit: 0 });
  });

  it('still claims INPUT tax on a payment out', async () => {
    const lines = await allocate('supplier', -115, 'standard');
    expect(lineFor(lines, VAT_INPUT_ID)).toMatchObject({ debit: 15, credit: 0 });
  });

  it('does not 4-way match a refund against an unpaid bill', async () => {
    await allocate('supplier', 120290);
    expect(mockRecordPaymentMatch).not.toHaveBeenCalled();
  });

  it('still 4-way matches a payment out', async () => {
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([txRow(-115)])
      .mockResolvedValueOnce([{ name: 'RohCap' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: JL_ID }])
      .mockResolvedValueOnce([{ id: 'inv-1' }])
      .mockResolvedValue([txRow(-115)]);
    mockWithTx.mockImplementation(async (fn) => { await fn(vi.fn().mockResolvedValue(undefined)); });
    mockGetSystemAccountId.mockResolvedValue(AP_ID);
    mockCreateJE.mockResolvedValue({ id: JE_ID } as never);
    mockPostJE.mockResolvedValue(undefined);

    const { allocateTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService'
    );
    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'supplier', SUPPLIER_ID,
    );
    expect(mockRecordPaymentMatch).toHaveBeenCalledWith(COMPANY_ID, 'inv-1', 115);
  });
});

describe('allocateTransaction — customer lines follow the sign', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts DR Bank / CR AR for a receipt IN (unchanged)', async () => {
    const lines = await allocate('customer', 500);
    expect(lineFor(lines, BANK_ACCOUNT_ID)).toMatchObject({ debit: 500, credit: 0 });
    expect(lineFor(lines, AR_ID)).toMatchObject({ debit: 0, credit: 500 });
  });

  it('posts DR AR / CR Bank for a refund OUT — the mirror of the supplier bug', async () => {
    const lines = await allocate('customer', -500);
    const bank = lineFor(lines, BANK_ACCOUNT_ID);
    const ar = lineFor(lines, AR_ID);
    expect(ar).toMatchObject({ debit: 500, credit: 0 });
    expect(bank).toMatchObject({ debit: 0, credit: 500 });
  });

  it('reverses OUTPUT tax on a customer refund', async () => {
    const lines = await allocate('customer', -115, 'standard');
    expect(mockGetSystemAccountId).toHaveBeenCalledWith('vat_output', COMPANY_ID);
    expect(mockGetSystemAccountId).not.toHaveBeenCalledWith('vat_input', COMPANY_ID);
    expect(lineFor(lines, VAT_OUTPUT_ID)).toMatchObject({ debit: 15, credit: 0 });
  });

  // A receipt document for money going OUT is the orphan-shaped defect this
  // codebase already paid for once: it lands in list_unapplied_receipts and on
  // the customer statement as cash that came in.
  it('does not mint a customer_payments receipt for a refund out', async () => {
    const inserts: string[] = [];
    setup('customer', -500);
    mockWithTx.mockImplementation(async (fn) => {
      await fn(vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        inserts.push(strings.join(''));
        return Promise.resolve(undefined);
      }));
    });
    const { allocateTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService'
    );
    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'customer', CUSTOMER_ID,
    );
    expect(inserts.some((q) => /INSERT INTO customer_payments/.test(q))).toBe(false);
    expect(inserts.some((q) => /UPDATE bank_transactions/.test(q))).toBe(true);
  });

  it('still mints one for a receipt in', async () => {
    const inserts: string[] = [];
    setup('customer', 500);
    mockWithTx.mockImplementation(async (fn) => {
      await fn(vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        inserts.push(strings.join(''));
        return Promise.resolve(undefined);
      }));
    });
    const { allocateTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService'
    );
    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, undefined, 'customer', CUSTOMER_ID,
    );
    expect(inserts.some((q) => /INSERT INTO customer_payments/.test(q))).toBe(true);
  });
});

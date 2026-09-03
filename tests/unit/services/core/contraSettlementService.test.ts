// RED phase — the balance-sheet restriction did not exist when these were written.
/**
 * contraSettlementService — which account a debt may legitimately be netted
 * against.
 *
 * A contra settles one party's balance against ANOTHER BALANCE-SHEET POSITION:
 * a loan, an intercompany account, a director's account. Settling a payable
 * against an EXPENSE or a receivable against REVENUE is not a contra at all —
 * it is a write-off, `ar/writeOffService` already does that with its own
 * treatment, and posting one through this tool would put R371,470 somewhere
 * plausible and wrong.
 *
 * THE CLASSIFICATION IS STRUCTURAL, NEVER BY NAME OR CODE. Two accounts typed
 * `default_expense` overstated gross profit by R562,428 in these very books
 * because a bucket was chosen by account NAME. So the side is derived from
 * `account_type` + `account_subtype`, validated against
 * `GL_ACCOUNT_SUBTYPES_BY_TYPE` — which also closes the NULL-subtype trap: an
 * account whose subtype is NULL or not legal for its type cannot be classified
 * at all, and guessing would be the same failure one level down.
 *
 * Also pinned: a BANK contra account is refused (that is the phantom payment
 * the whole operation exists to avoid) and so is the subledger's own control
 * account (DR AR / CR AR balances perfectly and settles the document against
 * itself).
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  assertContraAccountUsable,
  loadContraDocument,
} from '@/modules/accounting/services/core/contraSettlementService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '77777777-7777-4777-8777-777777777777';
const DOC = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;
const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<Row[]>>;

function accountRow(over: Row = {}): Row {
  return {
    id: ACCOUNT,
    account_code: '2400',
    account_name: 'Loan — Director',
    account_type: 'liability',
    account_subtype: 'other_current_liability',
    is_active: true,
    is_parent: false,
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSystemAccount).mockResolvedValue({ id: 'control-id' } as never);
});

describe('assertContraAccountUsable — which side of the books', () => {
  it.each([
    ['liability', 'other_current_liability', 'a director loan'],
    ['asset', 'other_current_asset', 'an intercompany receivable'],
    ['equity', 'equity', 'a shareholder account'],
  ])('ACCEPTS a balance-sheet account: %s / %s (%s)', async (type, subtype) => {
    sqlMock.mockResolvedValueOnce([accountRow({ account_type: type, account_subtype: subtype })]);
    const result = await assertContraAccountUsable(COMPANY, 'ap', ACCOUNT);
    expect(result.accountId).toBe(ACCOUNT);
    expect(result.accountType).toBe(type);
  });

  it.each([
    ['expense', 'operating_expense'],
    ['expense', 'default_expense'],
    ['expense', 'cost_of_sales'],
    ['revenue', 'revenue'],
    ['revenue', 'other_income'],
  ])('REFUSES an income-statement account (%s / %s) and names write_off', async (type, subtype) => {
    sqlMock.mockResolvedValueOnce([accountRow({ account_type: type, account_subtype: subtype })]);
    await expect(assertContraAccountUsable(COMPANY, 'ap', ACCOUNT))
      .rejects.toThrow(/write.?off/i);
  });

  it('the income-statement refusal explains WHY, not just that it refused', async () => {
    sqlMock.mockResolvedValueOnce([
      accountRow({ account_type: 'expense', account_subtype: 'operating_expense' }),
    ]);
    await expect(assertContraAccountUsable(COMPANY, 'ap', ACCOUNT))
      .rejects.toThrow(/balance sheet|balance-sheet/i);
  });

  it('REFUSES A NULL SUBTYPE rather than guessing the side from the type alone', async () => {
    // The same NULL-subtype trap that made 27 paycards unable to receive a
    // statement import. An account that cannot be classified must not be
    // classified by inference.
    sqlMock.mockResolvedValueOnce([accountRow({ account_subtype: null })]);
    await expect(assertContraAccountUsable(COMPANY, 'ap', ACCOUNT))
      .rejects.toThrow(/update_gl_account/);
  });

  it('REFUSES A SUBTYPE THAT IS NOT LEGAL FOR ITS TYPE', async () => {
    // account_subtype is plain TEXT with no CHECK, so a typo writes fine and
    // then behaves exactly like NULL.
    sqlMock.mockResolvedValueOnce([
      accountRow({ account_type: 'liability', account_subtype: 'operating_expense' }),
    ]);
    await expect(assertContraAccountUsable(COMPANY, 'ap', ACCOUNT))
      .rejects.toThrow(/update_gl_account/);
  });

  it('refuses a BANK account — that is the payment that never happened', async () => {
    sqlMock.mockResolvedValueOnce([
      accountRow({ account_type: 'asset', account_subtype: 'bank' }),
    ]);
    await expect(assertContraAccountUsable(COMPANY, 'ar', ACCOUNT))
      .rejects.toThrow(/BANK account/);
  });

  it("refuses the subledger's own control account", async () => {
    sqlMock.mockResolvedValueOnce([accountRow({ id: 'control-id' })]);
    vi.mocked(getSystemAccount).mockResolvedValue({ id: 'control-id' } as never);
    await expect(assertContraAccountUsable(COMPANY, 'ar', ACCOUNT))
      .rejects.toThrow(/control account itself/);
  });

  it('refuses a parent header account — the balance sheet excludes headers', async () => {
    sqlMock.mockResolvedValueOnce([accountRow({ is_parent: true })]);
    await expect(assertContraAccountUsable(COMPANY, 'ap', ACCOUNT))
      .rejects.toThrow(/header account/);
  });

  it('refuses a deactivated account, naming the remedy', async () => {
    sqlMock.mockResolvedValueOnce([accountRow({ is_active: false })]);
    await expect(assertContraAccountUsable(COMPANY, 'ap', ACCOUNT))
      .rejects.toThrow(/deactivated/i);
  });

  it('reports an account outside the company the same way as a genuine miss', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(assertContraAccountUsable(COMPANY, 'ap', ACCOUNT))
      .rejects.toThrow(/not found/i);
  });

  it('scopes the account read to the company', async () => {
    sqlMock.mockResolvedValueOnce([accountRow()]);
    await assertContraAccountUsable(COMPANY, 'ap', ACCOUNT);
    expect(sqlMock.mock.calls[0]!.slice(1)).toContain(COMPANY);
  });

  it('NEVER decides the side from the account name or code', async () => {
    // An account NAMED "Bad Debts Written Off" but typed as a liability is a
    // balance-sheet position and must be accepted; the name is not evidence.
    sqlMock.mockResolvedValueOnce([accountRow({
      account_name: 'Bad Debts Written Off',
      account_code: '5400',
      account_type: 'liability',
      account_subtype: 'other_current_liability',
    })]);
    await expect(assertContraAccountUsable(COMPANY, 'ap', ACCOUNT)).resolves.toMatchObject({
      accountName: 'Bad Debts Written Off',
    });
  });
});

describe('loadContraDocument', () => {
  function invoiceRow(over: Row = {}): Row {
    return {
      id: DOC,
      invoice_number: 'INV0001',
      counterparty_id: CUSTOMER,
      total_amount: '1000.00',
      amount_paid: '0',
      status: 'approved',
      ...over,
    };
  }

  it('resolves the AR counterparty with COALESCE(client_id, customer_id)', async () => {
    sqlMock.mockResolvedValueOnce([invoiceRow()]);
    await loadContraDocument(COMPANY, 'ar', DOC, 400);
    const text = (sqlMock.mock.calls[0]![0] as string[]).join('?');
    expect(text).toMatch(/COALESCE\(ci\.client_id,\s*ci\.customer_id\)/);
  });

  it('refuses an amount above the outstanding balance', async () => {
    sqlMock.mockResolvedValueOnce([invoiceRow({ amount_paid: '900.00' })]);
    await expect(loadContraDocument(COMPANY, 'ar', DOC, 400))
      .rejects.toThrow(/exceeds the R100\.00 outstanding/);
  });

  it('refuses a cancelled document', async () => {
    sqlMock.mockResolvedValueOnce([invoiceRow({ status: 'cancelled' })]);
    await expect(loadContraDocument(COMPANY, 'ar', DOC, 100)).rejects.toThrow(/cancelled/);
  });

  it('refuses a document naming no counterparty', async () => {
    sqlMock.mockResolvedValueOnce([invoiceRow({ counterparty_id: null })]);
    await expect(loadContraDocument(COMPANY, 'ar', DOC, 100)).rejects.toThrow(/names no customer/);
  });

  it('reads supplier_invoices for the ap side, scoped to the company', async () => {
    sqlMock.mockResolvedValueOnce([invoiceRow()]);
    await loadContraDocument(COMPANY, 'ap', DOC, 400);
    const call = sqlMock.mock.calls[0]!;
    expect((call[0] as string[]).join('?')).toContain('FROM supplier_invoices');
    expect(call.slice(1)).toContain(COMPANY);
  });
});

/**
 * The classification half of billLineAccountGuard. The query half — ownership,
 * `has_children` scoped to the company, one round trip — is pinned against a
 * real chart by tests/integration/bill-line-account-guard.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import {
  BillLineAccountRefusal,
  assertBillLineAccounts,
  billLineAccountProblem,
  billLineAccountRefusal,
  type BillLineAccountRow,
} from '@/modules/accounting/services/ap/billLineAccountGuard';

const row = (over: Partial<BillLineAccountRow> = {}): BillLineAccountRow => ({
  account_code: '6000', account_name: 'Materials', account_subtype: 'operating_expense',
  is_active: true, has_children: false, ...over,
});

describe('billLineAccountProblem', () => {
  it.each([
    ['payable', /control account/],
    ['accounts_payable', /control account/],
    ['creditors', /control account/],
    ['receivable', /control account/],
    ['trade_receivables', /control account/],
    ['bank', /bank account/],
    ['bank_account', /bank account/],
    ['vat_input', /VAT return/],
    ['vat_output', /VAT return/],
    ['tax', /VAT return/],
  ])('refuses subtype %s', (subtype, message) => {
    expect(billLineAccountProblem(row({ account_subtype: subtype }))).toMatch(message);
  });

  it.each(['opening_balance_equity', 'retained_earnings', 'accumulated_depreciation'])(
    'refuses system-only subtype %s', (subtype) => {
      expect(billLineAccountProblem(row({ account_subtype: subtype }))).not.toBeNull();
    },
  );

  it.each(['SYS-7', 'SYS8', 'sys-9', 'SYS10', 'SYS13', 'SYS-15', 'SYS-24'])('refuses Sage control code %s whatever its subtype', (code) => {
    expect(billLineAccountProblem(row({ account_code: code, account_subtype: null }))).toMatch(/Sage control or system/);
  });

  it.each(['SYS1', 'SYS2', 'SYS6', 'SYS14', 'SYS80'])('accepts Sage non-control code %s', (code) => {
    expect(billLineAccountProblem(row({ account_code: code }))).toBeNull();
  });

  it('refuses a header and an inactive account', () => {
    expect(billLineAccountProblem(row({ has_children: true }))).toMatch(/header/);
    expect(billLineAccountProblem(row({ is_active: false }))).toMatch(/inactive/);
  });

  it.each([
    'operating_expense', 'default_expense', 'cost_of_sales', 'fixed_asset', 'inventory',
    'prepaid_expense', 'payroll_liability', 'cash', null,
  ])('accepts subtype %s', (subtype) => {
    expect(billLineAccountProblem(row({ account_subtype: subtype }))).toBeNull();
  });
});

describe('the thrown refusal', () => {
  it('carries a code the MCP boundary passes through, so an agent reads the reason', async () => {
    vi.mocked(sql).mockResolvedValue([row({ account_subtype: 'bank' })] as never);
    const err = await assertBillLineAccounts('c1', ['a']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillLineAccountRefusal);
    expect(isRefusalCoded(err)).toBe(true);
  });
});

describe('billLineAccountRefusal', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('sends no query when no line names an account', async () => {
    expect(await billLineAccountRefusal('c1', [undefined, null, ''])).toBeNull();
    expect(sql).not.toHaveBeenCalled();
  });

  it('treats a missing row as foreign, with the ownership wording', async () => {
    vi.mocked(sql).mockResolvedValue([row()] as never);
    expect(await billLineAccountRefusal('c1', ['a', 'b'])).toMatch(/not GL accounts in your company/);
  });

  it('names the first refused account by code and name', async () => {
    vi.mocked(sql).mockResolvedValue([row(), row({ account_code: '1000', account_name: 'Bank', account_subtype: 'bank' })] as never);
    expect(await billLineAccountRefusal('c1', ['a', 'b', 'a'])).toBe(
      'A bill line cannot be coded to 1000 Bank: it is a bank account.',
    );
  });
});

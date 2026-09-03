/**
 * `getBankAccountsStatus` is genuinely dual-use, so `is_active` gets an opt-in
 * rather than a removal.
 *
 * Two consumers, two different questions:
 *   - pages/accounting/bank-transactions/new.tsx and bank/statements/import-pdf.tsx
 *     use it as a PICKER — which account do I code this transaction against?
 *     A deactivated account must not be offered.
 *   - pages/accounting/bank-accounts/index.tsx, BankSummaryWidget and the MCP
 *     bank_accounts_status tool ask about MONEY — balances, unreconciled
 *     amounts, allocation backlog. A deactivated account still holds all three,
 *     and omitting it hides work nobody can see is outstanding.
 *
 * So: `includeInactive` defaults to FALSE. The failure mode of wrongly offering
 * a retired account in a picker (someone posts to it) is worse and more
 * immediate than a balance view omitting one, and the balance paths are being
 * fixed at their own call sites. Callers that want money opt in explicitly.
 *
 * Every row carries `isActive` either way, so a consumer can label an inactive
 * account rather than have it silently absent.
 *
 * All DB calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';

/** Joined template text with SQL comments stripped and whitespace collapsed. */
function sqlText(): string {
  const args = sqlMock.mock.calls[0]!;
  return (args[0] as readonly string[])
    .join(' ? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Interpolated values, which is where the include-inactive flag actually lives. */
function sqlValues(): unknown[] {
  return sqlMock.mock.calls[0]!.slice(1);
}

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct-1', account_code: '1110', account_name: 'Bank - Primary', description: null,
    bank_account_number: null, bank_name: null, bank_branch_name: null, bank_branch_code: null,
    bank_account_type: 'current', bank_is_default: false, bank_default_payment_method: 'eft',
    bank_opening_balance: 0, bank_opening_balance_date: null,
    is_active: false,
    group_id: null, group_name: null, group_code: null,
    txn_count: 0, total_debits: 0, total_credits: 0, balance: 6550,
    reconciled_balance: 0, unreconciled_balance: 0, unreconciled_count: 0,
    allocated_count: 0, suggested_count: 0, unallocated_count: 0,
    first_date: null, last_date: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([accountRow()]);
});

describe('getBankAccountsStatus includeInactive', () => {
  it('defaults to active-only so no picker path can regress', async () => {
    await getBankAccountsStatus(COMPANY);

    expect(sqlText()).toMatch(/\?\s*::boolean = true OR ga\.is_active = TRUE/);
    expect(sqlValues()).toContain(false);
    expect(sqlValues()).not.toContain(true);
  });

  it('is active-only when includeInactive is passed explicitly false', async () => {
    await getBankAccountsStatus(COMPANY, { includeInactive: false });

    expect(sqlValues()).toContain(false);
    expect(sqlValues()).not.toContain(true);
  });

  it('admits inactive accounts when includeInactive is true', async () => {
    await getBankAccountsStatus(COMPANY, { includeInactive: true });

    expect(sqlText()).toMatch(/\?\s*::boolean = true OR ga\.is_active = TRUE/);
    expect(sqlValues()).toContain(true);
  });

  it('only true opts in — a truthy non-boolean does not', async () => {
    await getBankAccountsStatus(COMPANY, { includeInactive: 'yes' as unknown as boolean });

    expect(sqlValues()).toContain(false);
  });

  it('every row carries isActive so an inactive account can be labelled, not hidden', async () => {
    const rows = await getBankAccountsStatus(COMPANY, { includeInactive: true });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('isActive', false);
    // The balance is the whole reason to include it.
    expect(rows[0]).toHaveProperty('balance', 6550);
  });

  it('keeps the bank subtype and leaf-account restrictions in every mode', async () => {
    await getBankAccountsStatus(COMPANY, { includeInactive: true });

    const q = sqlText();
    expect(q).toMatch(/ga\.account_subtype = 'bank'/);
    expect(q).toMatch(/NOT EXISTS \( SELECT 1 FROM gl_accounts child/);
  });
});

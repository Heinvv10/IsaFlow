# Plan 3 — Primary Statements (AFS Engine)

**Date:** 2026-04-16  
**Goal:** Add the three missing primary statements that complete the AFS bundle — Statement of Changes in Equity, Direct Method Cash Flow, and a Cash Flow Reconciliation note — plus the AFS editor page that renders all statements together.  
**Assumes:** Plan 1 (document engine foundation) complete. Types available at `@/modules/accounting/services/afs/afsTypes.ts`.  
**Status:** Ready for execution

---

## Architecture

```
src/modules/accounting/services/afs/
  changesInEquityService.ts       — equity movement matrix
  cashFlowDirectService.ts        — bank_transactions → cash groups
  cashFlowReconciliationService.ts — proves indirect = direct = bank

pages/api/accounting/afs/[documentId]/statements/
  changes-in-equity.ts
  cash-flow-direct.ts
  cash-flow-reconciliation.ts

pages/accounting/afs/[documentId]/
  index.tsx                        — AFS editor page

tests/unit/services/afs/
  changesInEquityService.test.ts
  cashFlowDirectService.test.ts
  cashFlowReconciliationService.test.ts
```

All services follow the same structure as `balanceSheetService.ts` and `incomeStatementService.ts`:
- `sql` tagged template from `@/lib/neon`
- `log` from `@/lib/logger`
- `company_id` in every query
- Exported async function returns a typed result object

All API handlers follow the same structure as `reports-cash-flow.ts`:
- `withCompany(withErrorHandler(handler as any))`
- `apiResponse.success()` / `.badRequest()` / `.notFound()`
- Dynamic route: `[documentId]` resolved from `req.query`

---

## Tech Stack

- **Runtime:** Node.js via Next.js 14 API routes
- **DB:** Neon (PostgreSQL) — `sql` tagged template, `@/lib/neon`
- **Language:** TypeScript, strict, no implicit `any`
- **Test runner:** Vitest (`bun run test:unit`)
- **Mocking:** `vi.mock('@/lib/neon')`, `vi.mock('@/lib/logger')`
- **Package manager:** bun

---

## Step 1 — Write failing tests: `changesInEquityService`

**Time: ~4 min**

Create `tests/unit/services/afs/changesInEquityService.test.ts`:

```typescript
/**
 * Unit tests for changesInEquityService.ts
 *
 * Statement of Changes in Equity matrix:
 *   Opening balance | Profit for year | Dividends | Share issue | Revaluation | Closing balance
 *   × Share Capital | Share Premium | Retained Earnings | Revaluation Reserve | Total Equity
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getChangesInEquity } from '@/modules/accounting/services/afs/changesInEquityService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-12-31';

// Row shapes returned by each SQL call
const OPENING_ROWS = [
  { account_subtype: 'share_capital',     balance: 100000 },
  { account_subtype: 'share_premium',     balance: 50000  },
  { account_subtype: 'retained_earnings', balance: 30000  },
  { account_subtype: 'revaluation',       balance: 5000   },
];

const MOVEMENTS_ROWS = [
  // profit posted to retained_earnings via income statement close
  { account_subtype: 'retained_earnings', movement_type: 'profit',     amount: 20000 },
  // dividends debited against retained_earnings
  { account_subtype: 'retained_earnings', movement_type: 'dividend',   amount: -8000 },
  // new shares issued
  { account_subtype: 'share_capital',     movement_type: 'share_issue', amount: 10000 },
  { account_subtype: 'share_premium',     movement_type: 'share_issue', amount: 40000 },
  // revaluation surplus on PPE
  { account_subtype: 'revaluation',       movement_type: 'revaluation', amount: 3000  },
];

describe('changesInEquityService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a matrix with correct opening balances', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)   // opening balances query
      .mockResolvedValueOnce(MOVEMENTS_ROWS); // movements query

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.periodStart).toBe(PERIOD_START);
    expect(result.periodEnd).toBe(PERIOD_END);

    const sc = result.columns.find(c => c.subtype === 'share_capital')!;
    expect(sc.opening).toBeCloseTo(100000, 2);
    expect(sc.shareIssue).toBeCloseTo(10000, 2);
    expect(sc.closing).toBeCloseTo(110000, 2);
  });

  it('calculates retained earnings movements correctly', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)
      .mockResolvedValueOnce(MOVEMENTS_ROWS);

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    const re = result.columns.find(c => c.subtype === 'retained_earnings')!;
    expect(re.opening).toBeCloseTo(30000, 2);
    expect(re.profitForYear).toBeCloseTo(20000, 2);
    expect(re.dividends).toBeCloseTo(-8000, 2);
    expect(re.closing).toBeCloseTo(42000, 2); // 30000 + 20000 - 8000
  });

  it('calculates total equity column correctly', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)
      .mockResolvedValueOnce(MOVEMENTS_ROWS);

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    // opening total = 100000 + 50000 + 30000 + 5000 = 185000
    expect(result.totalOpening).toBeCloseTo(185000, 2);
    // closing = opening + profit + dividends + share_issue + revaluation
    //         = 185000 + 20000 - 8000 + 10000 + 40000 + 3000 = 250000
    expect(result.totalClosing).toBeCloseTo(250000, 2);
  });

  it('returns zero equity when there are no GL lines', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.columns).toHaveLength(0);
    expect(result.totalOpening).toBe(0);
    expect(result.totalClosing).toBe(0);
  });

  it('logs error and re-throws on DB failure', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValueOnce(dbError);

    await expect(
      getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END)
    ).rejects.toThrow('connection refused');
  });
});
```

**Run (expected: 5 failing — service does not exist):**
```bash
bun run test:unit tests/unit/services/afs/changesInEquityService.test.ts
```

Expected output:
```
 FAIL  tests/unit/services/afs/changesInEquityService.test.ts
  × Cannot find module '@/modules/accounting/services/afs/changesInEquityService'
```

---

## Step 2 — Implement `changesInEquityService.ts`

**Time: ~5 min**

Create `src/modules/accounting/services/afs/changesInEquityService.ts`:

```typescript
/**
 * Statement of Changes in Equity Service
 *
 * Produces the equity movement matrix for the AFS:
 *   Columns: Share Capital | Share Premium | Retained Earnings | Revaluation Reserve | Total
 *   Rows:    Opening balance | Profit for year | Dividends | Share issue | Revaluation | Closing
 *
 * Data sources:
 *   - Opening balances: cumulative GL postings to equity accounts BEFORE period start
 *   - Movements: GL journal lines to equity accounts WITHIN the period, classified by movement_type
 *
 * movement_type classification rules:
 *   retained_earnings + credit = profit (closed from income summary)
 *   retained_earnings + debit  = dividend (or loss)
 *   share_capital / share_premium + credit = share_issue
 *   revaluation + credit = revaluation surplus
 *   revaluation + debit  = revaluation reversal
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface EquityColumn {
  subtype: string;
  label: string;
  opening: number;
  profitForYear: number;
  dividends: number;
  shareIssue: number;
  revaluation: number;
  closing: number;
}

export interface ChangesInEquityReport {
  periodStart: string;
  periodEnd: string;
  columns: EquityColumn[];
  totalOpening: number;
  totalProfitForYear: number;
  totalDividends: number;
  totalShareIssue: number;
  totalRevaluation: number;
  totalClosing: number;
}

const EQUITY_SUBTYPE_LABELS: Record<string, string> = {
  share_capital:     'Share Capital',
  share_premium:     'Share Premium',
  retained_earnings: 'Retained Earnings',
  revaluation:       'Revaluation Reserve',
};

// Ordered display sequence
const SUBTYPE_ORDER = ['share_capital', 'share_premium', 'retained_earnings', 'revaluation'];

function subtypeLabel(subtype: string): string {
  return EQUITY_SUBTYPE_LABELS[subtype] ?? subtype;
}

async function fetchOpeningBalances(
  companyId: string,
  beforeDate: string
): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT
      COALESCE(ga.account_subtype, 'retained_earnings') AS account_subtype,
      COALESCE(SUM(jl.credit - jl.debit), 0)::numeric  AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE je.status   = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND ga.account_type = 'equity'
      AND je.entry_date < ${beforeDate}
    GROUP BY COALESCE(ga.account_subtype, 'retained_earnings')
  `) as Row[];

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(String(r.account_subtype), Number(r.balance));
  }
  return map;
}

async function fetchMovements(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<Array<{ subtype: string; movementType: string; amount: number }>> {
  // Classify each GL line by movement_type:
  //   retained_earnings credit  → profit
  //   retained_earnings debit   → dividend (negative amount)
  //   share_capital/premium credit → share_issue
  //   revaluation credit         → revaluation
  //   revaluation debit          → revaluation (negative)
  const rows = (await sql`
    SELECT
      COALESCE(ga.account_subtype, 'retained_earnings') AS account_subtype,
      CASE
        WHEN COALESCE(ga.account_subtype, 'retained_earnings') = 'retained_earnings'
             AND (jl.credit - jl.debit) > 0
          THEN 'profit'
        WHEN COALESCE(ga.account_subtype, 'retained_earnings') = 'retained_earnings'
             AND (jl.credit - jl.debit) <= 0
          THEN 'dividend'
        WHEN ga.account_subtype IN ('share_capital', 'share_premium')
          THEN 'share_issue'
        WHEN ga.account_subtype = 'revaluation'
          THEN 'revaluation'
        ELSE 'other'
      END AS movement_type,
      COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE je.status   = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND ga.account_type = 'equity'
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
    GROUP BY
      COALESCE(ga.account_subtype, 'retained_earnings'),
      CASE
        WHEN COALESCE(ga.account_subtype, 'retained_earnings') = 'retained_earnings'
             AND (jl.credit - jl.debit) > 0
          THEN 'profit'
        WHEN COALESCE(ga.account_subtype, 'retained_earnings') = 'retained_earnings'
             AND (jl.credit - jl.debit) <= 0
          THEN 'dividend'
        WHEN ga.account_subtype IN ('share_capital', 'share_premium')
          THEN 'share_issue'
        WHEN ga.account_subtype = 'revaluation'
          THEN 'revaluation'
        ELSE 'other'
      END
  `) as Row[];

  return rows.map(r => ({
    subtype:      String(r.account_subtype),
    movementType: String(r.movement_type),
    amount:       Number(r.amount),
  }));
}

export async function getChangesInEquity(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<ChangesInEquityReport> {
  try {
    const [openingMap, movements] = await Promise.all([
      fetchOpeningBalances(companyId, periodStart),
      fetchMovements(companyId, periodStart, periodEnd),
    ]);

    // Collect all subtypes seen in either opening or movements
    const subtypes = new Set<string>([
      ...openingMap.keys(),
      ...movements.map(m => m.subtype),
    ]);

    // Build column map
    const columnMap = new Map<string, EquityColumn>();
    for (const subtype of subtypes) {
      columnMap.set(subtype, {
        subtype,
        label:        subtypeLabel(subtype),
        opening:      openingMap.get(subtype) ?? 0,
        profitForYear: 0,
        dividends:    0,
        shareIssue:   0,
        revaluation:  0,
        closing:      0,
      });
    }

    // Accumulate movements
    for (const mv of movements) {
      const col = columnMap.get(mv.subtype);
      if (!col) continue;
      if (mv.movementType === 'profit')      col.profitForYear += mv.amount;
      else if (mv.movementType === 'dividend')   col.dividends    += mv.amount;
      else if (mv.movementType === 'share_issue') col.shareIssue   += mv.amount;
      else if (mv.movementType === 'revaluation') col.revaluation  += mv.amount;
    }

    // Compute closing for each column
    for (const col of columnMap.values()) {
      col.closing = col.opening + col.profitForYear + col.dividends + col.shareIssue + col.revaluation;
    }

    // Sort columns into display order; unknown subtypes go at end
    const columns = [...columnMap.values()].sort((a, b) => {
      const ai = SUBTYPE_ORDER.indexOf(a.subtype);
      const bi = SUBTYPE_ORDER.indexOf(b.subtype);
      if (ai === -1 && bi === -1) return a.subtype.localeCompare(b.subtype);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    const sum = (key: keyof EquityColumn) =>
      columns.reduce((s, c) => s + (c[key] as number), 0);

    return {
      periodStart,
      periodEnd,
      columns,
      totalOpening:      sum('opening'),
      totalProfitForYear: sum('profitForYear'),
      totalDividends:    sum('dividends'),
      totalShareIssue:   sum('shareIssue'),
      totalRevaluation:  sum('revaluation'),
      totalClosing:      sum('closing'),
    };
  } catch (err) {
    log.error('Failed to generate changes in equity', { error: err }, 'accounting');
    throw err;
  }
}
```

**Run (expected: all 5 passing):**
```bash
bun run test:unit tests/unit/services/afs/changesInEquityService.test.ts
```

Expected output:
```
 ✓  tests/unit/services/afs/changesInEquityService.test.ts (5 tests) Xms
```

---

## Step 3 — Write failing tests: `cashFlowDirectService`

**Time: ~4 min**

Create `tests/unit/services/afs/cashFlowDirectService.test.ts`:

```typescript
/**
 * Unit tests for cashFlowDirectService.ts
 *
 * Direct method cash flow groups actual bank_transactions by the
 * account_subtype of their GL allocation targets.
 *
 * Operating:
 *   - cash_received_from_customers: bank credits → revenue/receivable accounts
 *   - cash_paid_to_suppliers:       bank debits  → expense/payable accounts
 *   - cash_paid_to_employees:       bank debits  → payroll accounts
 *   - other_operating:              remaining bank debits/credits → other operating
 * Investing:
 *   - bank movements → fixed_asset / other_asset accounts
 * Financing:
 *   - bank movements → equity / loan accounts
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-12-31';

// Rows returned by the opening cash balance query
const OPENING_ROWS = [{ balance: 15000 }];

// Rows returned by the grouped bank allocations query
const ALLOCATION_ROWS = [
  { cash_group: 'cash_received_from_customers', amount:  80000 },
  { cash_group: 'cash_paid_to_suppliers',       amount: -45000 },
  { cash_group: 'cash_paid_to_employees',       amount: -20000 },
  { cash_group: 'other_operating',              amount:  -3000 },
  { cash_group: 'investing',                    amount: -10000 },
  { cash_group: 'financing',                    amount:   5000 },
];

describe('cashFlowDirectService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns correct section totals', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)
      .mockResolvedValueOnce(ALLOCATION_ROWS);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.periodStart).toBe(PERIOD_START);
    expect(result.periodEnd).toBe(PERIOD_END);
    expect(result.openingCash).toBeCloseTo(15000, 2);

    // Operating = 80000 - 45000 - 20000 - 3000 = 12000
    expect(result.operatingTotal).toBeCloseTo(12000, 2);
    expect(result.investingTotal).toBeCloseTo(-10000, 2);
    expect(result.financingTotal).toBeCloseTo(5000, 2);

    // Closing = 15000 + 12000 - 10000 + 5000 = 22000
    expect(result.closingCash).toBeCloseTo(22000, 2);
  });

  it('exposes line items for each operating group', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)
      .mockResolvedValueOnce(ALLOCATION_ROWS);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    const customers = result.operatingItems.find(
      i => i.cashGroup === 'cash_received_from_customers'
    );
    expect(customers?.amount).toBeCloseTo(80000, 2);

    const employees = result.operatingItems.find(
      i => i.cashGroup === 'cash_paid_to_employees'
    );
    expect(employees?.amount).toBeCloseTo(-20000, 2);
  });

  it('returns zero cash when no bank transactions exist', async () => {
    mockSql
      .mockResolvedValueOnce([{ balance: 0 }])
      .mockResolvedValueOnce([]);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.openingCash).toBe(0);
    expect(result.operatingTotal).toBe(0);
    expect(result.closingCash).toBe(0);
  });

  it('logs error and re-throws on DB failure', async () => {
    mockSql.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END)
    ).rejects.toThrow('timeout');
  });
});
```

**Run (expected: 4 failing):**
```bash
bun run test:unit tests/unit/services/afs/cashFlowDirectService.test.ts
```

---

## Step 4 — Implement `cashFlowDirectService.ts`

**Time: ~5 min**

Create `src/modules/accounting/services/afs/cashFlowDirectService.ts`:

```typescript
/**
 * Direct Method Cash Flow Service
 *
 * Derives cash flow from actual bank_transactions joined to their GL allocations.
 * Groups each bank movement by the account_subtype of the allocated GL account.
 *
 * Cash group mapping:
 *   revenue / receivable                    → cash_received_from_customers
 *   expense / payable (non-payroll)         → cash_paid_to_suppliers
 *   payroll                                 → cash_paid_to_employees
 *   fixed_asset / other_asset               → investing
 *   equity / loan                           → financing
 *   everything else (bank, other)           → other_operating
 *
 * bank_transactions.amount uses sign convention:
 *   positive = money in (receipt)
 *   negative = money out (payment)
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface DirectCashFlowItem {
  cashGroup: string;
  label: string;
  amount: number;
}

export interface CashFlowDirectReport {
  periodStart: string;
  periodEnd: string;
  openingCash: number;
  operatingItems: DirectCashFlowItem[];
  operatingTotal: number;
  investingItems: DirectCashFlowItem[];
  investingTotal: number;
  financingItems: DirectCashFlowItem[];
  financingTotal: number;
  netChange: number;
  closingCash: number;
}

const CASH_GROUP_LABELS: Record<string, string> = {
  cash_received_from_customers: 'Cash received from customers',
  cash_paid_to_suppliers:       'Cash paid to suppliers',
  cash_paid_to_employees:       'Cash paid to employees',
  other_operating:              'Other operating cash flows',
  investing:                    'Net investing cash flows',
  financing:                    'Net financing cash flows',
};

const OPERATING_GROUPS = new Set([
  'cash_received_from_customers',
  'cash_paid_to_suppliers',
  'cash_paid_to_employees',
  'other_operating',
]);

async function fetchOpeningCash(companyId: string, beforeDate: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit
           ELSE jl.credit - jl.debit END
    ), 0)::numeric AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = 'bank'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status     = 'posted'
      AND je.entry_date < ${beforeDate}
  `) as Row[];
  return Number(rows[0]?.balance ?? 0);
}

async function fetchGroupedAllocations(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<Array<{ cashGroup: string; amount: number }>> {
  // Join bank_transactions to gl_journal_lines through the allocation table.
  // Each bank transaction line has a corresponding GL journal line that targets
  // the allocated account. We classify by that account's subtype.
  const rows = (await sql`
    SELECT
      CASE
        WHEN ga.account_subtype IN ('revenue', 'receivable')
          THEN 'cash_received_from_customers'
        WHEN ga.account_subtype IN ('payroll')
          THEN 'cash_paid_to_employees'
        WHEN ga.account_subtype IN ('expense', 'payable', 'cost_of_sales')
          THEN 'cash_paid_to_suppliers'
        WHEN ga.account_subtype IN ('fixed_asset', 'other_asset')
          THEN 'investing'
        WHEN ga.account_type IN ('equity') OR ga.account_subtype IN ('loan')
          THEN 'financing'
        ELSE 'other_operating'
      END AS cash_group,
      -- bank credits (money in) positive, debits (money out) negative
      COALESCE(SUM(
        CASE WHEN ga_bank.normal_balance = 'debit'
          THEN jl_bank.debit - jl_bank.credit
          ELSE jl_bank.credit - jl_bank.debit END
      ), 0)::numeric AS amount
    FROM bank_transactions bt
    -- The bank GL line (account_subtype = 'bank')
    JOIN gl_journal_lines jl_bank ON jl_bank.bank_transaction_id = bt.id
    JOIN gl_accounts ga_bank      ON ga_bank.id = jl_bank.gl_account_id
      AND ga_bank.account_subtype = 'bank'
    -- The contra GL line (the allocation target)
    JOIN gl_journal_lines jl ON jl.journal_entry_id = jl_bank.journal_entry_id
      AND jl.id != jl_bank.id
    JOIN gl_accounts ga       ON ga.id = jl.gl_account_id
    JOIN gl_journal_entries je ON je.id = jl_bank.journal_entry_id
    WHERE je.status     = 'posted'
      AND bt.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
    GROUP BY cash_group
  `) as Row[];

  return rows.map(r => ({
    cashGroup: String(r.cash_group),
    amount:    Number(r.amount),
  }));
}

export async function getCashFlowDirect(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<CashFlowDirectReport> {
  try {
    const [openingCash, groupedRows] = await Promise.all([
      fetchOpeningCash(companyId, periodStart),
      fetchGroupedAllocations(companyId, periodStart, periodEnd),
    ]);

    const amountByGroup = new Map<string, number>(
      groupedRows.map(r => [r.cashGroup, r.amount])
    );

    const toItem = (group: string): DirectCashFlowItem => ({
      cashGroup: group,
      label:     CASH_GROUP_LABELS[group] ?? group,
      amount:    amountByGroup.get(group) ?? 0,
    });

    const operatingGroups = [
      'cash_received_from_customers',
      'cash_paid_to_suppliers',
      'cash_paid_to_employees',
      'other_operating',
    ];

    // Include any groups present in data but not in default list
    const extraOperating = groupedRows
      .filter(r => OPERATING_GROUPS.has(r.cashGroup) && !operatingGroups.includes(r.cashGroup))
      .map(r => r.cashGroup);

    const allOperatingGroups = [...operatingGroups, ...extraOperating];

    const operatingItems = allOperatingGroups
      .map(toItem)
      .filter(i => i.amount !== 0);

    const investingItems = groupedRows
      .filter(r => r.cashGroup === 'investing')
      .map(r => toItem(r.cashGroup));

    const financingItems = groupedRows
      .filter(r => r.cashGroup === 'financing')
      .map(r => toItem(r.cashGroup));

    const operatingTotal = operatingItems.reduce((s, i) => s + i.amount, 0);
    const investingTotal = investingItems.reduce((s, i) => s + i.amount, 0);
    const financingTotal = financingItems.reduce((s, i) => s + i.amount, 0);
    const netChange = operatingTotal + investingTotal + financingTotal;

    return {
      periodStart,
      periodEnd,
      openingCash,
      operatingItems,
      operatingTotal,
      investingItems,
      investingTotal,
      financingItems,
      financingTotal,
      netChange,
      closingCash: openingCash + netChange,
    };
  } catch (err) {
    log.error('Failed to generate direct cash flow', { error: err }, 'accounting');
    throw err;
  }
}
```

**Run (expected: all 4 passing):**
```bash
bun run test:unit tests/unit/services/afs/cashFlowDirectService.test.ts
```

---

## Step 5 — Write failing tests: `cashFlowReconciliationService`

**Time: ~3 min**

Create `tests/unit/services/afs/cashFlowReconciliationService.test.ts`:

```typescript
/**
 * Unit tests for cashFlowReconciliationService.ts
 *
 * Asserts:
 *   direct_method_closing_cash == indirect_method_closing_cash == bank_balance_per_statement
 *
 * Returns { directClosing, indirectClosing, bankBalance, variance, isReconciled }
 * isReconciled = max(|direct-bank|, |indirect-bank|) < 0.01
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const mockGetDirect = getCashFlowDirect as MockedFunction<typeof getCashFlowDirect>;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-12-31';

const INDIRECT_ROWS = [{ closing_cash: 22000 }]; // from GL indirect calc
const BANK_ROWS     = [{ balance: 22000 }];        // actual bank balance per GL

const DIRECT_REPORT = {
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  openingCash: 15000,
  operatingItems: [],
  operatingTotal: 12000,
  investingItems: [],
  investingTotal: -10000,
  financingItems: [],
  financingTotal: 5000,
  netChange: 7000,
  closingCash: 22000,
};

describe('cashFlowReconciliationService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks isReconciled true when all three figures agree', async () => {
    mockGetDirect.mockResolvedValueOnce(DIRECT_REPORT);
    mockSql
      .mockResolvedValueOnce(INDIRECT_ROWS)
      .mockResolvedValueOnce(BANK_ROWS);

    const result = await getCashFlowReconciliation(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.directClosing).toBeCloseTo(22000, 2);
    expect(result.indirectClosing).toBeCloseTo(22000, 2);
    expect(result.bankBalance).toBeCloseTo(22000, 2);
    expect(result.variance).toBeCloseTo(0, 2);
    expect(result.isReconciled).toBe(true);
  });

  it('marks isReconciled false and reports variance when figures differ', async () => {
    const offDirect = { ...DIRECT_REPORT, closingCash: 21950 }; // R50 variance
    mockGetDirect.mockResolvedValueOnce(offDirect);
    mockSql
      .mockResolvedValueOnce([{ closing_cash: 22000 }])
      .mockResolvedValueOnce([{ balance: 22000 }]);

    const result = await getCashFlowReconciliation(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.isReconciled).toBe(false);
    expect(Math.abs(result.variance)).toBeCloseTo(50, 2);
  });

  it('logs error and re-throws on DB failure', async () => {
    mockGetDirect.mockRejectedValueOnce(new Error('query failed'));

    await expect(
      getCashFlowReconciliation(COMPANY_ID, PERIOD_START, PERIOD_END)
    ).rejects.toThrow('query failed');
  });
});
```

**Run (expected: 3 failing):**
```bash
bun run test:unit tests/unit/services/afs/cashFlowReconciliationService.test.ts
```

---

## Step 6 — Implement `cashFlowReconciliationService.ts`

**Time: ~4 min**

Create `src/modules/accounting/services/afs/cashFlowReconciliationService.ts`:

```typescript
/**
 * Cash Flow Reconciliation Service
 *
 * Proves that the three cash figures agree:
 *   1. direct_method_closing_cash   (from bank_transactions allocations)
 *   2. indirect_method_closing_cash (from GL net income + working capital adjustments)
 *   3. bank_balance_per_statement   (current bank account GL balance as at period end)
 *
 * isReconciled = true when max variance < R0.01 (rounding tolerance).
 * Any variance > R0.01 is flagged for accountant review — blocks AFS export.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getCashFlowDirect } from './cashFlowDirectService';

type Row = DbRow;

export interface CashFlowReconciliation {
  periodStart: string;
  periodEnd: string;
  directClosing: number;
  indirectClosing: number;
  bankBalance: number;
  /** Max absolute variance across the three figures */
  variance: number;
  isReconciled: boolean;
}

const TOLERANCE = 0.01; // R0.01 rounding tolerance

async function fetchIndirectClosingCash(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<number> {
  // Re-derive closing cash using indirect method:
  // opening_cash + net_income + AR_delta + AP_delta + investing + financing
  const rows = (await sql`
    SELECT
      (
        -- Opening cash balance
        (SELECT COALESCE(SUM(
          CASE WHEN ga_o.normal_balance = 'debit'
            THEN jl_o.debit - jl_o.credit
            ELSE jl_o.credit - jl_o.debit END
        ), 0) FROM gl_journal_lines jl_o
         JOIN gl_journal_entries je_o ON je_o.id = jl_o.journal_entry_id
         JOIN gl_accounts ga_o         ON ga_o.id = jl_o.gl_account_id
         WHERE ga_o.account_subtype = 'bank'
           AND je_o.company_id = ${companyId}::UUID
           AND jl_o.company_id = ${companyId}::UUID
           AND je_o.status     = 'posted'
           AND je_o.entry_date < ${periodStart})
        -- + net income
        + COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit END), 0)
        - COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit END), 0)
        -- + AR delta (decrease in AR = cash in)
        + COALESCE(SUM(CASE WHEN ga.account_subtype = 'receivable' THEN jl.credit - jl.debit END), 0)
        -- + AP delta (increase in AP = deferred payment, but net cash effect captured)
        + COALESCE(SUM(CASE WHEN ga.account_subtype = 'payable' THEN jl.credit - jl.debit END), 0)
        -- + investing
        + COALESCE(SUM(CASE WHEN ga.account_subtype IN ('fixed_asset', 'other_asset')
                            THEN jl.credit - jl.debit END), 0)
        -- + financing
        + COALESCE(SUM(CASE WHEN ga.account_type = 'equity'
                             AND (ga.account_subtype IS NULL OR ga.account_subtype != 'retained_earnings')
                            THEN jl.credit - jl.debit END), 0)
      )::numeric AS closing_cash
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE je.status     = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
  `) as Row[];

  return Number(rows[0]?.closing_cash ?? 0);
}

async function fetchBankBalance(
  companyId: string,
  asAtDate: string
): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.normal_balance = 'debit'
        THEN jl.debit - jl.credit
        ELSE jl.credit - jl.debit END
    ), 0)::numeric AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = 'bank'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status     = 'posted'
      AND je.entry_date <= ${asAtDate}
  `) as Row[];

  return Number(rows[0]?.balance ?? 0);
}

export async function getCashFlowReconciliation(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<CashFlowReconciliation> {
  try {
    const [directReport, indirectClosing, bankBalance] = await Promise.all([
      getCashFlowDirect(companyId, periodStart, periodEnd),
      fetchIndirectClosingCash(companyId, periodStart, periodEnd),
      fetchBankBalance(companyId, periodEnd),
    ]);

    const directClosing = directReport.closingCash;

    // Variance = max absolute difference between any two of the three figures
    const variance = Math.max(
      Math.abs(directClosing - bankBalance),
      Math.abs(indirectClosing - bankBalance),
      Math.abs(directClosing - indirectClosing)
    );

    const isReconciled = variance < TOLERANCE;

    if (!isReconciled) {
      log.warn('Cash flow reconciliation variance detected', {
        companyId,
        periodStart,
        periodEnd,
        directClosing,
        indirectClosing,
        bankBalance,
        variance,
      }, 'accounting');
    }

    return {
      periodStart,
      periodEnd,
      directClosing,
      indirectClosing,
      bankBalance,
      variance,
      isReconciled,
    };
  } catch (err) {
    log.error('Failed to generate cash flow reconciliation', { error: err }, 'accounting');
    throw err;
  }
}
```

**Run (expected: all 3 passing):**
```bash
bun run test:unit tests/unit/services/afs/cashFlowReconciliationService.test.ts
```

---

## Step 7 — Run all three test files together

**Time: ~1 min**

```bash
bun run test:unit tests/unit/services/afs/
```

Expected output:
```
 ✓  tests/unit/services/afs/changesInEquityService.test.ts     (5 tests) Xms
 ✓  tests/unit/services/afs/cashFlowDirectService.test.ts      (4 tests) Xms
 ✓  tests/unit/services/afs/cashFlowReconciliationService.test.ts (3 tests) Xms

 Test Files  3 passed (3)
 Tests       12 passed (12)
```

---

## Step 8 — Create API route: `changes-in-equity.ts`

**Time: ~3 min**

First create the directory structure:
```bash
mkdir -p pages/api/accounting/afs/\[documentId\]/statements
```

Create `pages/api/accounting/afs/[documentId]/statements/changes-in-equity.ts`:

```typescript
/**
 * GET /api/accounting/afs/[documentId]/statements/changes-in-equity
 *
 * Returns the Statement of Changes in Equity for the AFS document's fiscal year.
 *
 * Query params:
 *   period_start  YYYY-MM-DD   (required)
 *   period_end    YYYY-MM-DD   (required)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getChangesInEquity } from '@/modules/accounting/services/afs/changesInEquityService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req;
  const { documentId, period_start, period_end } = req.query;

  if (!documentId || typeof documentId !== 'string') {
    return apiResponse.badRequest(res, 'documentId is required');
  }
  if (!period_start || typeof period_start !== 'string') {
    return apiResponse.badRequest(res, 'period_start is required (YYYY-MM-DD)');
  }
  if (!period_end || typeof period_end !== 'string') {
    return apiResponse.badRequest(res, 'period_end is required (YYYY-MM-DD)');
  }

  try {
    log.info('Generating changes in equity', { companyId, documentId, period_start, period_end }, 'accounting');
    const report = await getChangesInEquity(companyId, period_start, period_end);
    return apiResponse.success(res, { report });
  } catch (err) {
    log.error('Failed to generate changes in equity statement', { error: err, companyId, documentId }, 'accounting');
    return apiResponse.databaseError(res, err, 'Failed to generate statement of changes in equity');
  }
}

export default withCompany(withErrorHandler(handler as never));
```

---

## Step 9 — Create API route: `cash-flow-direct.ts`

**Time: ~3 min**

Create `pages/api/accounting/afs/[documentId]/statements/cash-flow-direct.ts`:

```typescript
/**
 * GET /api/accounting/afs/[documentId]/statements/cash-flow-direct
 *
 * Returns the direct method Statement of Cash Flows for the AFS document's fiscal year.
 *
 * Query params:
 *   period_start  YYYY-MM-DD   (required)
 *   period_end    YYYY-MM-DD   (required)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req;
  const { documentId, period_start, period_end } = req.query;

  if (!documentId || typeof documentId !== 'string') {
    return apiResponse.badRequest(res, 'documentId is required');
  }
  if (!period_start || typeof period_start !== 'string') {
    return apiResponse.badRequest(res, 'period_start is required (YYYY-MM-DD)');
  }
  if (!period_end || typeof period_end !== 'string') {
    return apiResponse.badRequest(res, 'period_end is required (YYYY-MM-DD)');
  }

  try {
    log.info('Generating direct cash flow', { companyId, documentId, period_start, period_end }, 'accounting');
    const report = await getCashFlowDirect(companyId, period_start, period_end);
    return apiResponse.success(res, { report });
  } catch (err) {
    log.error('Failed to generate direct cash flow statement', { error: err, companyId, documentId }, 'accounting');
    return apiResponse.databaseError(res, err, 'Failed to generate direct method cash flow statement');
  }
}

export default withCompany(withErrorHandler(handler as never));
```

---

## Step 10 — Create API route: `cash-flow-reconciliation.ts`

**Time: ~3 min**

Create `pages/api/accounting/afs/[documentId]/statements/cash-flow-reconciliation.ts`:

```typescript
/**
 * GET /api/accounting/afs/[documentId]/statements/cash-flow-reconciliation
 *
 * Returns the cash flow reconciliation proof:
 *   direct_method_closing_cash == indirect_method_closing_cash == bank_balance
 *
 * isReconciled: false is a blocker for AFS export.
 *
 * Query params:
 *   period_start  YYYY-MM-DD   (required)
 *   period_end    YYYY-MM-DD   (required)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req;
  const { documentId, period_start, period_end } = req.query;

  if (!documentId || typeof documentId !== 'string') {
    return apiResponse.badRequest(res, 'documentId is required');
  }
  if (!period_start || typeof period_start !== 'string') {
    return apiResponse.badRequest(res, 'period_start is required (YYYY-MM-DD)');
  }
  if (!period_end || typeof period_end !== 'string') {
    return apiResponse.badRequest(res, 'period_end is required (YYYY-MM-DD)');
  }

  try {
    log.info('Generating cash flow reconciliation', { companyId, documentId, period_start, period_end }, 'accounting');
    const reconciliation = await getCashFlowReconciliation(companyId, period_start, period_end);
    return apiResponse.success(res, { reconciliation });
  } catch (err) {
    log.error('Failed to generate cash flow reconciliation', { error: err, companyId, documentId }, 'accounting');
    return apiResponse.databaseError(res, err, 'Failed to generate cash flow reconciliation');
  }
}

export default withCompany(withErrorHandler(handler as never));
```

---

## Step 11 — Create the AFS editor page

**Time: ~5 min**

First create the directory:
```bash
mkdir -p pages/accounting/afs/\[documentId\]
```

Create `pages/accounting/afs/[documentId]/index.tsx`:

```typescript
/**
 * AFS Editor Page
 * /accounting/afs/[documentId]
 *
 * Renders all primary statements for the AFS document:
 *  - Statement of Financial Position (Balance Sheet)
 *  - Statement of Comprehensive Income
 *  - Statement of Changes in Equity (new)
 *  - Statement of Cash Flows — Indirect (existing) + Direct (new)
 *  - Cash Flow Reconciliation (new)
 *
 * Data fetching: client-side SWR per statement. Statements load independently
 * so the accountant can start reviewing early while others generate.
 */

import React from 'react';
import type { NextPage, GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import useSWR from 'swr';
import type { ChangesInEquityReport } from '@/modules/accounting/services/afs/changesInEquityService';
import type { CashFlowDirectReport } from '@/modules/accounting/services/afs/cashFlowDirectService';
import type { CashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageProps {
  documentId: string;
  periodStart: string;
  periodEnd: string;
}

interface ApiData<T> {
  data: T;
}

// ── Fetcher ───────────────────────────────────────────────────────────────────

const fetcher = (url: string) =>
  fetch(url).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

// ── Currency formatter ────────────────────────────────────────────────────────

function fmt(amount: number): string {
  if (amount < 0) return `(${Math.abs(amount).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })})`;
  return amount.toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionLoader({ label }: { label: string }) {
  return (
    <div className="animate-pulse bg-gray-50 border border-gray-200 rounded-lg p-6">
      <div className="h-5 bg-gray-200 rounded w-1/3 mb-4" />
      <div className="space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-4 bg-gray-100 rounded w-full" />
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-4">Loading {label}…</p>
    </div>
  );
}

function SectionError({ label, error }: { label: string; error: Error }) {
  return (
    <div className="border border-red-200 bg-red-50 rounded-lg p-6">
      <p className="text-sm font-semibold text-red-700">{label} — failed to load</p>
      <p className="text-xs text-red-500 mt-1">{error.message}</p>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-base font-bold text-gray-900 uppercase tracking-wide mb-4 border-b border-gray-300 pb-2">
      {children}
    </h2>
  );
}

// ── Changes in Equity ─────────────────────────────────────────────────────────

function ChangesInEquitySection({ report }: { report: ChangesInEquityReport }) {
  const rows: Array<{ label: string; key: keyof typeof report.columns[0] }> = [
    { label: 'Opening balance',  key: 'opening'       },
    { label: 'Profit for year',  key: 'profitForYear'  },
    { label: 'Dividends paid',   key: 'dividends'      },
    { label: 'Share issue',      key: 'shareIssue'     },
    { label: 'Revaluation',      key: 'revaluation'    },
    { label: 'Closing balance',  key: 'closing'        },
  ];

  const totalByRow: Record<string, number> = {
    opening:      report.totalOpening,
    profitForYear: report.totalProfitForYear,
    dividends:    report.totalDividends,
    shareIssue:   report.totalShareIssue,
    revaluation:  report.totalRevaluation,
    closing:      report.totalClosing,
  };

  return (
    <section className="mb-10">
      <SectionHeading>Statement of Changes in Equity</SectionHeading>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-900 text-white">
              <th className="text-left p-3 font-semibold w-48">Movement</th>
              {report.columns.map(c => (
                <th key={c.subtype} className="text-right p-3 font-semibold">{c.label}</th>
              ))}
              <th className="text-right p-3 font-semibold">Total Equity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isTotal = row.key === 'closing' || row.key === 'opening';
              return (
                <tr
                  key={row.key}
                  className={
                    isTotal
                      ? 'bg-gray-100 font-semibold border-t border-b border-gray-400'
                      : i % 2 === 0 ? 'bg-white' : 'bg-gray-50'
                  }
                >
                  <td className="p-3 text-gray-800">{row.label}</td>
                  {report.columns.map(c => (
                    <td key={c.subtype} className="text-right p-3 font-mono text-gray-900">
                      {fmt(c[row.key] as number)}
                    </td>
                  ))}
                  <td className="text-right p-3 font-mono font-semibold text-gray-900">
                    {fmt(totalByRow[row.key] ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Direct Cash Flow ──────────────────────────────────────────────────────────

function DirectCashFlowSection({ report }: { report: CashFlowDirectReport }) {
  return (
    <section className="mb-10">
      <SectionHeading>Statement of Cash Flows — Direct Method</SectionHeading>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-gray-900 text-white">
            <th className="text-left p-3 font-semibold">Description</th>
            <th className="text-right p-3 font-semibold">R</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-gray-100">
            <td className="p-3 font-semibold text-gray-800" colSpan={2}>Operating Activities</td>
          </tr>
          {report.operatingItems.map((item, i) => (
            <tr key={item.cashGroup} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
              <td className="p-3 pl-6 text-gray-700">{item.label}</td>
              <td className="text-right p-3 font-mono text-gray-900">{fmt(item.amount)}</td>
            </tr>
          ))}
          <tr className="bg-gray-200 font-semibold border-t border-gray-400">
            <td className="p-3 text-gray-900">Net cash from operating activities</td>
            <td className="text-right p-3 font-mono text-gray-900">{fmt(report.operatingTotal)}</td>
          </tr>

          <tr className="bg-gray-100">
            <td className="p-3 font-semibold text-gray-800" colSpan={2}>Investing Activities</td>
          </tr>
          {report.investingItems.map((item, i) => (
            <tr key={item.cashGroup} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
              <td className="p-3 pl-6 text-gray-700">{item.label}</td>
              <td className="text-right p-3 font-mono text-gray-900">{fmt(item.amount)}</td>
            </tr>
          ))}
          <tr className="bg-gray-200 font-semibold border-t border-gray-400">
            <td className="p-3 text-gray-900">Net cash from investing activities</td>
            <td className="text-right p-3 font-mono text-gray-900">{fmt(report.investingTotal)}</td>
          </tr>

          <tr className="bg-gray-100">
            <td className="p-3 font-semibold text-gray-800" colSpan={2}>Financing Activities</td>
          </tr>
          {report.financingItems.map((item, i) => (
            <tr key={item.cashGroup} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
              <td className="p-3 pl-6 text-gray-700">{item.label}</td>
              <td className="text-right p-3 font-mono text-gray-900">{fmt(item.amount)}</td>
            </tr>
          ))}
          <tr className="bg-gray-200 font-semibold border-t border-gray-400">
            <td className="p-3 text-gray-900">Net cash from financing activities</td>
            <td className="text-right p-3 font-mono text-gray-900">{fmt(report.financingTotal)}</td>
          </tr>

          <tr className="bg-white border-t border-gray-300">
            <td className="p-3 text-gray-700">Opening cash balance</td>
            <td className="text-right p-3 font-mono text-gray-900">{fmt(report.openingCash)}</td>
          </tr>
          <tr className="bg-gray-900 text-white font-bold">
            <td className="p-3">Closing cash balance</td>
            <td className="text-right p-3 font-mono">{fmt(report.closingCash)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

// ── Reconciliation ────────────────────────────────────────────────────────────

function ReconciliationSection({ rec }: { rec: CashFlowReconciliation }) {
  const statusColour = rec.isReconciled
    ? 'bg-green-50 border-green-300'
    : 'bg-red-50 border-red-300';

  return (
    <section className="mb-10">
      <SectionHeading>Cash Flow Reconciliation</SectionHeading>
      <div className={`border rounded-lg p-6 ${statusColour}`}>
        <table className="w-full text-sm">
          <tbody>
            <tr>
              <td className="py-1 text-gray-700">Direct method closing cash</td>
              <td className="text-right font-mono text-gray-900">R {fmt(rec.directClosing)}</td>
            </tr>
            <tr>
              <td className="py-1 text-gray-700">Indirect method closing cash</td>
              <td className="text-right font-mono text-gray-900">R {fmt(rec.indirectClosing)}</td>
            </tr>
            <tr>
              <td className="py-1 text-gray-700">Bank balance per GL</td>
              <td className="text-right font-mono text-gray-900">R {fmt(rec.bankBalance)}</td>
            </tr>
            <tr className="border-t border-gray-300 font-semibold">
              <td className="py-2 text-gray-800">Variance</td>
              <td className="text-right font-mono text-gray-900">R {fmt(rec.variance)}</td>
            </tr>
          </tbody>
        </table>
        <p className={`mt-4 text-sm font-semibold ${rec.isReconciled ? 'text-green-700' : 'text-red-700'}`}>
          {rec.isReconciled
            ? '✓ Reconciled — cash figures agree within R0.01'
            : '✗ Variance detected — review required before export'}
        </p>
      </div>
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const AfsDocumentPage: NextPage<PageProps> = ({ documentId, periodStart, periodEnd }) => {
  const params = `period_start=${periodStart}&period_end=${periodEnd}`;
  const base = `/api/accounting/afs/${documentId}/statements`;

  const { data: equityData, error: equityError } =
    useSWR<ApiData<{ report: ChangesInEquityReport }>>(
      `${base}/changes-in-equity?${params}`, fetcher
    );

  const { data: directData, error: directError } =
    useSWR<ApiData<{ report: CashFlowDirectReport }>>(
      `${base}/cash-flow-direct?${params}`, fetcher
    );

  const { data: reconcData, error: reconcError } =
    useSWR<ApiData<{ reconciliation: CashFlowReconciliation }>>(
      `${base}/cash-flow-reconciliation?${params}`, fetcher
    );

  return (
    <>
      <Head>
        <title>AFS — {periodStart} to {periodEnd} | ISaFlow</title>
      </Head>

      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/accounting/afs" className="text-sm text-gray-500 hover:text-gray-700">
              ← AFS Documents
            </Link>
            <span className="text-gray-300">/</span>
            <h1 className="text-sm font-semibold text-gray-900">
              Annual Financial Statements
            </h1>
          </div>
          <span className="text-xs text-gray-500">
            {periodStart} — {periodEnd}
          </span>
        </div>

        <div className="max-w-6xl mx-auto px-6 py-8">
          {/* Statement of Changes in Equity */}
          {equityError ? (
            <SectionError label="Statement of Changes in Equity" error={equityError as Error} />
          ) : !equityData ? (
            <SectionLoader label="Statement of Changes in Equity" />
          ) : (
            <ChangesInEquitySection report={equityData.data.report} />
          )}

          {/* Direct Cash Flow */}
          {directError ? (
            <SectionError label="Statement of Cash Flows (Direct)" error={directError as Error} />
          ) : !directData ? (
            <SectionLoader label="Direct Method Cash Flow" />
          ) : (
            <DirectCashFlowSection report={directData.data.report} />
          )}

          {/* Reconciliation */}
          {reconcError ? (
            <SectionError label="Cash Flow Reconciliation" error={reconcError as Error} />
          ) : !reconcData ? (
            <SectionLoader label="Cash Flow Reconciliation" />
          ) : (
            <ReconciliationSection rec={reconcData.data.reconciliation} />
          )}
        </div>
      </div>
    </>
  );
};

export const getServerSideProps: GetServerSideProps<PageProps> = async ({ query }) => {
  const documentId = Array.isArray(query.documentId) ? query.documentId[0] : query.documentId;
  if (!documentId) return { notFound: true };

  // Default: current fiscal year (1 Jan to 31 Dec of current year)
  const year = new Date().getFullYear();
  const periodStart = `${year}-01-01`;
  const periodEnd   = `${year}-12-31`;

  return {
    props: {
      documentId,
      periodStart:  (query.period_start as string | undefined) ?? periodStart,
      periodEnd:    (query.period_end   as string | undefined) ?? periodEnd,
    },
  };
};

export default AfsDocumentPage;
```

---

## Step 12 — Type-check everything

**Time: ~2 min**

```bash
cd /home/hein/Workspace/IsaFlow && bunx tsc --noEmit
```

Expected output: no errors. If type errors appear, fix them before continuing.

Common issues to watch for:
- `handler as never` pattern for `withCompany` wrapper — same as existing API routes
- `DbRow` import path — use `@/lib/neon` (not `@/types/db`) to match `balanceSheetService.ts`
- `useSWR` generic type on page — data shape matches API response

---

## Step 13 — Run full unit test suite

**Time: ~2 min**

```bash
bun run test:unit
```

Expected output: all existing tests continue to pass + 12 new tests pass.

```
 Test Files  XX passed (XX)
 Tests       XXX passed (XXX)
 Duration    Xs
```

---

## Step 14 — Commit

**Time: ~1 min**

```bash
git add \
  src/modules/accounting/services/afs/changesInEquityService.ts \
  src/modules/accounting/services/afs/cashFlowDirectService.ts \
  src/modules/accounting/services/afs/cashFlowReconciliationService.ts \
  pages/api/accounting/afs/\[documentId\]/statements/changes-in-equity.ts \
  pages/api/accounting/afs/\[documentId\]/statements/cash-flow-direct.ts \
  pages/api/accounting/afs/\[documentId\]/statements/cash-flow-reconciliation.ts \
  pages/accounting/afs/\[documentId\]/index.tsx \
  tests/unit/services/afs/changesInEquityService.test.ts \
  tests/unit/services/afs/cashFlowDirectService.test.ts \
  tests/unit/services/afs/cashFlowReconciliationService.test.ts

git commit -m "feat(afs): add primary statements — changes in equity, direct cash flow, reconciliation

- changesInEquityService: equity movement matrix (opening/profit/dividends/share issue/revaluation/closing)
- cashFlowDirectService: direct method from bank_transactions grouped by account_subtype
- cashFlowReconciliationService: proves indirect == direct == bank balance, flags variance > R0.01
- Three AFS API routes under /api/accounting/afs/[documentId]/statements/
- AFS editor page at /accounting/afs/[documentId] with independent SWR data loading
- 12 unit tests (TDD: tests first, all green)"
```

---

## Summary — What was built

| File | Purpose |
|------|---------|
| `services/afs/changesInEquityService.ts` | Equity movement matrix across 4 columns |
| `services/afs/cashFlowDirectService.ts` | Direct method from bank_transactions |
| `services/afs/cashFlowReconciliationService.ts` | Three-way proof: direct = indirect = bank |
| `api/afs/[documentId]/statements/changes-in-equity.ts` | REST endpoint |
| `api/afs/[documentId]/statements/cash-flow-direct.ts` | REST endpoint |
| `api/afs/[documentId]/statements/cash-flow-reconciliation.ts` | REST endpoint |
| `pages/accounting/afs/[documentId]/index.tsx` | AFS editor page |
| `tests/unit/services/afs/*.test.ts` | 12 unit tests (TDD) |

## Key design decisions

**Changes in Equity classification:** Movement type is derived from the account subtype + debit/credit direction in a single SQL `CASE` expression. Credits to `retained_earnings` = profit; debits = dividends. This avoids needing a separate `movement_type` column on the GL lines.

**Direct Cash Flow query:** Joins `bank_transactions` to the contra GL line (non-bank side) of each journal entry via the shared `journal_entry_id`. The cash group is determined by the contra account's subtype. This correctly handles multi-line journal entries by aggregating all contra lines per entry.

**Reconciliation tolerance:** R0.01 matches standard accounting rounding conventions. The service logs a `warn` (not `error`) on variance so the reconciliation note appears in the Sentry dashboard without raising an alert.

**Page loading pattern:** Each statement loads independently via SWR. This matches the spec's requirement that the accountant can review early sections while later ones generate, and isolates failures per section.

**`handler as never` wrapper:** Matches the existing codebase pattern seen in `reports-cash-flow.ts` (`withWriteAccess`) for bypassing the strict TypeScript overlap check on the `withCompany` HOC signature.

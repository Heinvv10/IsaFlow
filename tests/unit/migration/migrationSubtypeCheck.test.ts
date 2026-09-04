// RED phase — written before implementation
/**
 * Unit tests for the go-live "account subtype coverage" check.
 *
 * The check exists because `account_subtype` is optional on import and every
 * subtype except `bank` fails silently: `aggregateFigures` DEFAULTS a NULL
 * subtype rather than leaving the money unbanded. On Velocity that put
 * R82,727,277.95 of direct cost below operating expenses and reported a 96.6%
 * gross margin against a real -1.9%.
 *
 * These tests exercise the pure banding/formatting half. Mutating
 * `buildSubtypeCoverageResult` to return a fixed 'pass' must turn them red —
 * a check that cannot fail is the defect class this codebase keeps finding.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  buildSubtypeCoverageResult,
  formatRand,
  NO_DEFAULT_TYPES,
  type AccountMovementRow,
} from '@/modules/accounting/services/core/migrationSubtypeCheck';
import { DEFAULTED_WHEN_UNKNOWN } from '@/modules/accounting/services/gl/accountClassification';

type RowOverride = Partial<AccountMovementRow> & { balance: number | string };

/** Default gross to |net| — the ordinary case where a balance is real movement. */
const row = (over: RowOverride): AccountMovementRow => {
  const { balance, ...rest } = over;
  return {
    account_code: '5000',
    account_name: 'Expenses',
    account_type: 'expense',
    account_subtype: null,
    net: balance,
    gross: Math.abs(typeof balance === 'number' ? balance : parseFloat(balance)),
    ...rest,
  };
};

describe('buildSubtypeCoverageResult — when nothing is at risk', () => {
  it('passes when no account lacks a subtype', () => {
    const r = buildSubtypeCoverageResult([]);
    expect(r.status).toBe('pass');
    expect(r.check).toBe('Account Subtype Coverage');
  });

  it('passes when the only subtype-less accounts have no posted movement at all', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '1000', account_name: 'Assets', account_type: 'asset', balance: 0, gross: 0 }),
      row({ account_code: '1100', account_name: 'Current Assets', account_type: 'asset', balance: '0.00', gross: 0 }),
    ]);
    expect(r.status).toBe('pass');
  });

  it('passes when every account carries a subtype the classifier recognises', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_subtype: 'cost_of_sales', balance: 82727277.95 }),
      row({ account_code: '1110', account_type: 'asset', account_subtype: 'bank', balance: 500000 }),
      row({ account_code: '2100', account_type: 'liability', account_subtype: 'payable', balance: -900000 }),
    ]);
    expect(r.status).toBe('pass');
  });

  it('ignores sub-cent rounding dust', () => {
    expect(buildSubtypeCoverageResult([row({ balance: 0.004, gross: 0.004 })]).status).toBe('pass');
    expect(buildSubtypeCoverageResult([row({ balance: -0.004, gross: 0.004 })]).status).toBe('pass');
  });

  it('flags a balance of one cent', () => {
    expect(buildSubtypeCoverageResult([row({ balance: 0.01 })]).status).toBe('warn');
  });
});

describe('buildSubtypeCoverageResult — account types where nothing is defaulted', () => {
  // aggregateFigures bands an equity account on account_type alone — there is no
  // sub-split, so a missing subtype defaults nothing and costs nothing. Flagging
  // it would put a number on the screen that no report is actually using.
  it('passes when the only subtype-less account carrying value is equity', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '3100', account_name: "Owner's Contribution", account_type: 'equity', balance: -5000000 }),
    ]);
    expect(r.status).toBe('pass');
  });

  it('excludes equity from the count and the total when other types are affected', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '3100', account_type: 'equity', balance: -5000000 }),
      row({ account_code: '5000', account_type: 'expense', balance: 1000000 }),
    ]);
    expect(r.message).toContain('1 account');
    expect(r.message).toContain('R1,000,000.00');
    expect(r.message).not.toContain('R6,000,000.00');
    expect(r.detail).not.toContain('3100');
  });
});

describe('buildSubtypeCoverageResult — when value is unclassified', () => {
  it('warns rather than fails, so go-live is not blocked', () => {
    const r = buildSubtypeCoverageResult([row({ balance: 1000 })]);
    expect(r.status).toBe('warn');
  });

  it('counts only the accounts carrying value', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '5000', balance: 199836.49 }),
      row({ account_code: '1000', account_type: 'asset', balance: 0, gross: 0 }),
      row({ account_code: '4310', account_type: 'revenue', balance: -2876.63 }),
    ]);
    expect(r.message).toContain('2 account');
    expect(r.message).not.toContain('3 account');
  });

  it('totals the ABSOLUTE value, so a debit and a credit do not net to nothing', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '5000', balance: 1000 }),
      row({ account_code: '2215', account_type: 'liability', balance: -1000 }),
    ]);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('R2,000.00');
  });

  it('reports the total with thousands separators and two decimals', () => {
    const r = buildSubtypeCoverageResult([row({ balance: 273434822.14 })]);
    expect(r.message).toContain('R273,434,822.14');
  });

  it('accepts the numeric strings pg returns for NUMERIC columns', () => {
    const r = buildSubtypeCoverageResult([row({ balance: '82727277.95' })]);
    expect(r.message).toContain('R82,727,277.95');
  });

  it('says what a NULL expense subtype COSTS, not just that it found one', () => {
    const r = buildSubtypeCoverageResult([row({ account_type: 'expense', balance: 82727277.95 })]);
    expect(r.message).toMatch(/operating expense/i);
    expect(r.message).toMatch(/gross profit/i);
  });

  it('names the cost for asset, liability and revenue accounts too', () => {
    const asset = buildSubtypeCoverageResult([row({ account_type: 'asset', balance: 100 })]);
    expect(asset.message).toMatch(/current asset/i);

    const liability = buildSubtypeCoverageResult([row({ account_type: 'liability', balance: -100 })]);
    expect(liability.message).toMatch(/current liabilit/i);

    // Asserted on `message` alone, NOT on detail: detail interpolates the raw
    // account_type, so `/revenue/` would match the literal "(revenue)" even with
    // the consequence clause deleted.
    const revenue = buildSubtypeCoverageResult([row({ account_type: 'revenue', balance: -100 })]);
    expect(revenue.message).toMatch(/other income/i);
    expect(revenue.message).toMatch(/turnover/i);
  });

  it('reads as English — "an asset", not "a asset"', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_type: 'asset', balance: 100 }),
      row({ account_type: 'expense', balance: 100 }),
    ]);
    expect(r.message).toContain('an asset account');
    expect(r.message).toContain('an expense account');
    expect(r.message).not.toMatch(/\ba (asset|expense)\b/);
  });

  it('never emits a dangling consequence clause', () => {
    for (const t of ['asset', 'liability', 'revenue', 'expense', 'something_new']) {
      const r = buildSubtypeCoverageResult([row({ account_type: t, balance: 100 })]);
      expect(r.message).not.toContain('defaulted: .');
      expect(r.message).toContain(t);
    }
  });

  it('still reports an account_type it has no mapping for, rather than dropping it', () => {
    const r = buildSubtypeCoverageResult([row({ account_type: 'contra_asset', balance: 5000 })]);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('1 account');
    expect(r.message).toContain('R5,000.00');
    expect(r.message).toContain('contra_asset');
  });

  it('names the largest accounts in detail, biggest first', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '49784353', account_name: 'Casual wages', balance: 2327887.5 }),
      row({ account_code: '49784351', account_name: 'Direct Material', balance: 46923976.23 }),
      row({ account_code: '49784352', account_name: 'Sub-Contractors', balance: 31542856.94 }),
    ]);
    const detail = r.detail ?? '';
    expect(detail).toContain('49784351');
    expect(detail).toContain('Direct Material');
    expect(detail.indexOf('49784351')).toBeLessThan(detail.indexOf('49784352'));
    expect(detail.indexOf('49784352')).toBeLessThan(detail.indexOf('49784353'));
  });

  it('ranks by absolute value, so a large credit outranks a small debit', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: 'SMALL', balance: 5 }),
      row({ account_code: 'BIG', account_type: 'liability', balance: -2929402.12 }),
    ]);
    expect((r.detail ?? '').indexOf('BIG')).toBeLessThan((r.detail ?? '').indexOf('SMALL'));
  });

  it('does not name every account when there are many, but says how many are unnamed', () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      row({ account_code: `A${i}`, account_name: `Account ${i}`, balance: 1000 - i }),
    );
    const r = buildSubtypeCoverageResult(many);
    expect(r.message).toContain('51 account');
    expect(r.detail).toContain('A0');
    expect(r.detail).not.toContain('A50');
    expect(r.detail).toMatch(/46 (more|further)/i);
  });
});

// ── Unrecognised spellings (F1) ──────────────────────────────────────────────

describe('buildSubtypeCoverageResult — a subtype the classifier does not recognise', () => {
  // `IS NULL` was the original predicate and it is the wrong one: aggregateFigures
  // defaults on canonicalSubtype(...) === null, which is absent OR unrecognised.
  // Production carries 'other' on ISAFlow Demo's 2210 Long-term Loans, R3,049,137.84,
  // defaulted into CURRENT liabilities — the exact harm this check claims to catch.
  it("flags 'other', which production carries on a R3.05m long-term loan", () => {
    const r = buildSubtypeCoverageResult([
      row({
        account_code: '2210', account_name: 'Long-term Loans', account_type: 'liability',
        account_subtype: 'other', balance: 3049137.84,
      }),
    ]);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('R3,049,137.84');
    expect(r.detail).toContain('2210');
  });

  it("flags 'disposal_profit_loss', seeded on revenue across most tenants", () => {
    const r = buildSubtypeCoverageResult([
      row({ account_type: 'revenue', account_subtype: 'disposal_profit_loss', balance: -40000 }),
    ]);
    expect(r.status).toBe('warn');
  });

  it('flags the empty string and whitespace, which canonicalise to null', () => {
    expect(buildSubtypeCoverageResult([row({ account_subtype: '', balance: 1000 })]).status).toBe('warn');
    expect(buildSubtypeCoverageResult([row({ account_subtype: '   ', balance: 1000 })]).status).toBe('warn');
  });

  it('accepts the alias spellings the classifier does recognise', () => {
    for (const spelling of ['Cost of Sales', 'cost-of-sales', ' COST_OF_SALES ']) {
      expect(buildSubtypeCoverageResult([row({ account_subtype: spelling, balance: 1000 })]).status)
        .toBe('pass');
    }
  });

  it('does not claim in the pass message that every account HAS a subtype', () => {
    // The old wording ("Every account carrying value has an account_subtype") is
    // literally true and materially false on a chart full of 'other'.
    const r = buildSubtypeCoverageResult([]);
    expect(r.message).toMatch(/recognised/i);
  });
});

// ── The stated consequence (F2) ──────────────────────────────────────────────

describe('buildSubtypeCoverageResult — what the message asserts', () => {
  // SYS-7 Trade Receivables, R32.7m, NULL subtype: it defaults into CURRENT
  // assets, which is where a trade receivable belongs. currentAssets and
  // totalAssets are both correct; what is lost is the accountsReceivable memo.
  // Telling the operator working capital is overstated sends them hunting for
  // an error that is not there.
  it('does not assert that an unbanded asset overstates working capital', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: 'SYS-7', account_name: 'Trade Receivables', account_type: 'asset', balance: 32704547.38 }),
    ]);
    expect(r.message).not.toMatch(/overstating working capital/i);
    expect(r.message).toMatch(/receivable/i);
  });

  it('does not assert that an unbanded liability understates long-term debt', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: 'SYS-8', account_name: 'Trade Payables', account_type: 'liability', balance: -37703241.94 }),
    ]);
    expect(r.message).not.toMatch(/understating long-term debt/i);
    expect(r.message).toMatch(/accounts payable/i);
  });
});

// ── What the total means (F3) ────────────────────────────────────────────────

describe('buildSubtypeCoverageResult — the headline total', () => {
  it('breaks the total down by account type, so flows are not silently added to balances', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_type: 'expense', balance: 115984525.05 }),
      row({ account_code: 'L', account_type: 'liability', balance: -95547963.6 }),
    ]);
    expect(r.detail).toMatch(/expense 1 \(R115,984,525\.05\)/);
    expect(r.detail).toMatch(/liability 1 \(R95,547,963\.60\)/);
  });

  it('says the total is a magnitude, not a figure any report shows', () => {
    const r = buildSubtypeCoverageResult([row({ balance: 1000 })]);
    expect(r.detail).toMatch(/magnitude/i);
    expect(r.detail).toMatch(/not a figure any report shows/i);
  });
});

// ── Movement hidden by a nil balance (F4) ────────────────────────────────────

describe('buildSubtypeCoverageResult — movement that nets to nil', () => {
  // Velocity 1564412 "ABSA - PC" is a BANK account: 18 posted lines, no subtype,
  // zero balance. Absent from f.cash and from getBankAccountsStatus, and the
  // balance test alone cannot see it.
  it('reports a dormant bank account the balance test cannot see', () => {
    const r = buildSubtypeCoverageResult([
      row({
        account_code: '1564412', account_name: 'ABSA - PC', account_type: 'asset',
        balance: 0, gross: 26263.74,
      }),
    ]);
    expect(r.status).toBe('warn');
    expect(r.detail ?? r.message).toContain('1564412');
  });

  it('keeps dormant accounts OUT of the headline count and total', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '5000', balance: 1000000 }),
      row({ account_code: '1564412', account_type: 'asset', balance: 0, gross: 26263.74 }),
    ]);
    expect(r.message).toContain('1 account(s) carrying R1,000,000.00');
    expect(r.message).not.toContain('R1,026,263.74');
  });

  it('still passes when an account has no movement of any kind', () => {
    const r = buildSubtypeCoverageResult([row({ balance: 0, gross: 0 })]);
    expect(r.status).toBe('pass');
  });
});

// ── The mutations that survived the second review ────────────────────────────

describe('buildSubtypeCoverageResult — amounts are signed on NORMAL BALANCE', () => {
  // fetchAccountMovement returns SUM(debit - credit) for every type. Every
  // report signs liability/equity/revenue the other way. Printing Velocity's
  // SYS-8 Trade Payables as -R37,703,241.94 reads as a payables control in
  // debit, which is the opposite of what the books say.
  it('shows a liability with a credit balance as positive', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: 'SYS-8', account_name: 'Trade Payables', account_type: 'liability', balance: -37703241.94 }),
    ]);
    expect(r.detail).toContain('SYS-8 Trade Payables (liability) R37,703,241.94');
    expect(r.detail).not.toContain('-R37,703,241.94');
  });

  it('shows revenue earned as positive and an asset debit as positive', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '4310', account_name: 'Interest Received', account_type: 'revenue', balance: -2876.63 }),
      row({ account_code: 'SYS-7', account_name: 'Trade Receivables', account_type: 'asset', balance: 32704547.38 }),
    ]);
    expect(r.detail).toContain('4310 Interest Received (revenue) R2,876.63');
    expect(r.detail).toContain('SYS-7 Trade Receivables (asset) R32,704,547.38');
  });

  it('still shows a genuinely abnormal balance as negative', () => {
    // Velocity 1120 in debit is a real condition worth seeing, not a convention.
    const r = buildSubtypeCoverageResult([
      row({ account_code: '2110', account_name: 'Accounts Payable', account_type: 'liability', balance: 6900 }),
    ]);
    expect(r.detail).toContain('-R6,900.00');
  });

  it('keeps the total and the by-type breakdown absolute regardless of sign', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: 'A', account_type: 'liability', balance: -1000 }),
      row({ account_code: 'B', account_type: 'liability', balance: 1000 }),
    ]);
    expect(r.message).toContain('R2,000.00');
    expect(r.detail).toContain('liability 2 (R2,000.00)');
  });
});

describe('formatRand', () => {
  it('keeps the minus sign on a negative amount', () => {
    expect(formatRand(-1234.5)).toBe('-R1,234.50');
    expect(formatRand(1234.5)).toBe('R1,234.50');
  });

  it('groups thousands and always shows two decimals', () => {
    expect(formatRand(0)).toBe('R0.00');
    expect(formatRand(999)).toBe('R999.00');
    expect(formatRand(1000)).toBe('R1,000.00');
    expect(formatRand(273434822.14)).toBe('R273,434,822.14');
  });
});

describe('buildSubtypeCoverageResult — the dormant-only branch', () => {
  const dormant = (code: string, gross: number) =>
    row({ account_code: code, account_name: `Account ${code}`, account_type: 'asset', balance: 0, gross });

  it('does not report the same accounts twice as though they were additional', () => {
    const r = buildSubtypeCoverageResult([dormant('1564412', 26263.74), dormant('49784346', 120000)]);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('2 account(s)');
    // "Plus 2" on top of "2" reads as four accounts.
    expect(r.message).not.toMatch(/Plus 2/);
  });

  it('does not point at a list of balances that this branch never printed', () => {
    const r = buildSubtypeCoverageResult([dormant('1564412', 26263.74)]);
    expect(r.message).not.toContain('appears above');
  });

  it('reports GROSS movement for a dormant account, not its nil balance', () => {
    const r = buildSubtypeCoverageResult([dormant('1564412', 26263.74)]);
    expect(r.message).toContain('R26,263.74');
    expect(r.message).not.toContain('R0.00');
  });

  it('says the figure shown is movement rather than a balance', () => {
    const r = buildSubtypeCoverageResult([dormant('1564412', 26263.74)]);
    expect(r.message).toMatch(/gross movement, not a balance/i);
  });

  it('orders dormant accounts by movement, largest first', () => {
    const r = buildSubtypeCoverageResult([dormant('SMALL', 100), dormant('BIG', 120000)]);
    const text = r.message;
    expect(text.indexOf('BIG')).toBeLessThan(text.indexOf('SMALL'));
  });

  it('counts dormant accounts correctly alongside flagged ones', () => {
    const r = buildSubtypeCoverageResult([
      row({ account_code: '5000', balance: 1000000 }),
      dormant('1564412', 26263.74),
      dormant('49784346', 120000),
    ]);
    expect(r.detail).toContain('Plus 2 account(s)');
    expect(r.detail).toContain('R120,000.00');
    expect(r.detail).toContain('R26,263.74');
  });
});

describe('buildSubtypeCoverageResult — the materiality boundary', () => {
  it('treats exactly half a cent as material', () => {
    expect(buildSubtypeCoverageResult([row({ balance: 0.005 })]).status).toBe('warn');
  });

  it('treats anything below half a cent as dust', () => {
    expect(buildSubtypeCoverageResult([row({ balance: 0.0049, gross: 0.0049 })]).status).toBe('pass');
  });

  it('applies the same boundary to dormant gross movement', () => {
    const bare = row({ account_code: 'X', balance: 0, gross: 0.005 });
    expect(buildSubtypeCoverageResult([bare]).status).toBe('warn');
    expect(buildSubtypeCoverageResult([{ ...bare, gross: 0.0049 }]).status).toBe('pass');
  });
});

describe('NO_DEFAULT_TYPES', () => {
  // Declared in two files as complements, with a comment in each saying they
  // must not diverge. If equity ever gains a sub-split in aggregateFigures, the
  // check would silently stop reporting the type that just started defaulting.
  it('is exactly the complement of the classifier\'s DEFAULTED_WHEN_UNKNOWN', () => {
    const ALL_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
    const complement = ALL_TYPES.filter(t => !DEFAULTED_WHEN_UNKNOWN.has(t));
    expect([...NO_DEFAULT_TYPES].sort()).toEqual([...complement].sort());
  });
});

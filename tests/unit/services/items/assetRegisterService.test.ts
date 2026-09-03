/**
 * The asset register, and the gap between it and the ledger.
 *
 * The finding this was written against: Brightsphere's only asset is a QA test
 * computer, disposed in April, with accumulated_depreciation = 0.00 on the
 * register — while the GL carries R7,500 of accumulated depreciation against no
 * asset cost at all, a NEGATIVE net book value. The register said R15,000, the
 * ledger said −R7,500, and nothing in the API could show both at once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

import {
  getAssetRegister,
  getAssetGlReconciliation,
} from '@/modules/accounting/services/items/assetRegisterService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const HELD = {
  id: 'a1', asset_number: 'COMP-0002', name: 'Laptop', category: 'computers',
  status: 'assigned', purchase_date: '2025-06-01', purchase_price: 20000,
  accumulated_depreciation: 5000, current_book_value: 15000,
  disposal_date: null, disposal_amount: null,
};
const DISPOSED = {
  id: 'a2', asset_number: 'COMP-0001', name: 'QA Test Computer', category: 'computers',
  status: 'disposed', purchase_date: '2025-10-01', purchase_price: 15000,
  accumulated_depreciation: 0, current_book_value: 15000,
  disposal_date: '2026-04-12', disposal_amount: 8000,
};

/** Every account subtyped fixed_assets on these books is a loan account. */
const GL_ACCOUNTS = [
  { id: 'g1', account_code: '1230', account_name: 'Accumulated Depreciation',
    account_subtype: 'accumulated_depreciation', is_active: true, balance: -7500,
    posted_through: '2026-04-12T08:00:00.000Z' },
  { id: 'g2', account_code: '34550552', account_name: 'Loan Account - H10 Holdings (Pty) Ltd',
    account_subtype: 'fixed_assets', is_active: true, balance: -4847978.30,
    posted_through: '2026-03-01T08:00:00.000Z' },
];

function routeMock(over: { assets?: unknown[]; totals?: unknown[]; accounts?: unknown[] } = {}) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    if (q.includes('FROM gl_accounts')) return Promise.resolve(over.accounts ?? GL_ACCOUNTS);
    if (q.includes('COUNT(*)::INT AS universe_total')) {
      return Promise.resolve(over.totals ?? [{
        universe_total: 2, rows_total: 1,
        total_cost: 20000, total_depreciation: 5000, total_book_value: 15000,
      }]);
    }
    if (q.includes('FROM assets a')) return Promise.resolve(over.assets ?? [HELD, DISPOSED]);
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('getAssetRegister — a disposed asset is not carrying amount', () => {
  it('keeps an asset disposed before as_at out of the rows and out of the totals', async () => {
    routeMock();
    const page = await getAssetRegister(COMPANY, '2026-08-31', { limit: 50, offset: 0 });

    expect(page.rows.map((r) => r.assetNumber)).toEqual(['COMP-0002']);
    expect(page.totals.netBookValue).toBe(15000);
    // The register route filtered only on purchase_date, so a computer sold for
    // R8,000 in April still reported R15,000 of book value in August.
    expect(page.rows.find((r) => r.assetNumber === 'COMP-0001')).toBeUndefined();
  });

  it('returns the disposed asset separately rather than dropping it', async () => {
    routeMock();
    const page = await getAssetRegister(COMPANY, '2026-08-31', { limit: 50, offset: 0 });
    // "There is one asset and it was sold" and "there are no assets" are
    // different facts.
    expect(page.disposed.map((r) => r.assetNumber)).toEqual(['COMP-0001']);
    expect(page.disposed[0]!.disposalAmount).toBe(8000);
  });

  it('still counts a disposal that has not happened yet as held', async () => {
    routeMock();
    const page = await getAssetRegister(COMPANY, '2026-01-31', { limit: 50, offset: 0 });
    expect(page.rows.map((r) => r.assetNumber)).toContain('COMP-0001');
    expect(page.disposed).toEqual([]);
  });

  it('accounts for every asset: held plus disposed equals the universe', async () => {
    routeMock();
    const page = await getAssetRegister(COMPANY, '2026-08-31', { limit: 50, offset: 0 });
    expect(page.rows.length + page.disposed.length).toBe(page.universeTotal);
  });

  it('scopes both queries by company', async () => {
    routeMock();
    await getAssetRegister(COMPANY, '2026-08-31', { limit: 50, offset: 0 });
    expect(sqlCalls).toHaveLength(2);
    for (const c of sqlCalls) expect(c.values).toContain(COMPANY);
  });
});

describe('getAssetGlReconciliation — the register and the ledger disagree', () => {
  it('measures the gap between register NBV and GL NBV', async () => {
    routeMock();
    const rec = await getAssetGlReconciliation(COMPANY, '2026-08-31');

    expect(rec.registerNetBookValue).toBe(15000);
    // −4,847,978.30 of "fixed assets" plus −7,500 of accumulated depreciation.
    expect(rec.glNetBookValue).toBeCloseTo(-4855478.30, 2);
    expect(rec.difference).toBeCloseTo(4870478.30, 2);
  });

  it('lists the accounts it counted, so a misclassification is visible', async () => {
    routeMock();
    const rec = await getAssetGlReconciliation(COMPANY, '2026-08-31');
    // A single total would hide that the entire "fixed assets" subtype on these
    // books is loan accounts. Naming them is what makes it diagnosable.
    expect(rec.costAccounts.map((a) => a.accountName)).toEqual([
      'Loan Account - H10 Holdings (Pty) Ltd',
    ]);
    expect(rec.accumulatedDepreciationAccounts[0]!.balance).toBe(-7500);
  });

  it('selects the GL side by SUBTYPE, never by account name', async () => {
    routeMock();
    await getAssetGlReconciliation(COMPANY, '2026-08-31');
    const q = sqlCalls.find((c) => c.sql.includes('FROM gl_accounts'))!;
    expect(q.sql).toContain('account_subtype');
    // Choosing a bucket by name is what typed two default_expense accounts as
    // cost of sales and overstated gross profit by R562,428.
    expect(q.sql).not.toMatch(/account_name\s+(I?LIKE|=)/);
  });

  it('never filters the GL side on is_active', async () => {
    routeMock();
    await getAssetGlReconciliation(COMPANY, '2026-08-31');
    const q = sqlCalls.find((c) => c.sql.includes('FROM gl_accounts'))!;
    // A deactivated account with a live balance is still on the balance sheet.
    expect(q.sql).not.toMatch(/is_active\s*=/);
  });

  it('keeps the company and status predicates OUT of the outer join ON clause', async () => {
    routeMock();
    await getAssetGlReconciliation(COMPANY, '2026-08-31');
    const q = sqlCalls.find((c) => c.sql.includes('FROM gl_accounts'))!;
    // gl_accounts must be restricted in WHERE. A predicate on the OUTER side of
    // a LEFT JOIN's ON clause restricts nothing — kpiChartsService summed every
    // transaction in the company that way and the total still looked plausible.
    const where = q.sql.slice(q.sql.indexOf('WHERE ga.'));
    expect(where).toContain('ga.company_id');
    expect(where).toContain('ga.account_subtype');
  });

  it('reports posted_through as the latest ledger write consumed, never now()', async () => {
    routeMock();
    const rec = await getAssetGlReconciliation(COMPANY, '2026-08-31');
    expect(rec.postedThrough).toBe('2026-04-12T08:00:00.000Z');
  });
});

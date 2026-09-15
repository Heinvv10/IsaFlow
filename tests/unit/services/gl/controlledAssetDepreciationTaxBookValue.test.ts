/**
 * The controlled depreciation run must maintain `assets.tax_book_value`.
 *
 * Master kept the column current by calling `writeAssetTaxAccumulation`
 * (assetTaxAccumulation.ts) from `assetDepreciationPosting.ts`. Our side
 * replaced that caller with a wrapper over `controlledAssetDepreciation.ts`,
 * whose asset UPDATE sets `accumulated_depreciation`, `current_book_value` and
 * `tax_accumulated_depreciation` but not `tax_book_value` — leaving the module
 * with zero production importers and the column pinned at migration 244's
 * trigger default (`purchase_price`) for the whole life of every asset.
 *
 * The stale value is not merely cosmetic: the UPDATE's `RETURNING *` row is the
 * `after` image `recordCommittedChange` writes into the forensic change event,
 * so an asset that has been depreciated to nil is recorded there still standing
 * at cost.
 *
 * The test renders the statement the run would actually send to Postgres —
 * template fragments interleaved with their bound values — and reads the column
 * out of it. It is not a source-text grep: the value asserted is the one the
 * calculation produced, and reverting the UPDATE turns it red.
 */
import { describe, expect, it, vi } from 'vitest';

const CALC = {
  policyDep: '500.00', taxDep: '1000.00',
  policyClosing: '1500.00', taxClosing: '3000.00',
  policyCarrying: '10500.00', taxCarrying: '9000.00',
  policyRate: '5.00', annualDep: '6000.00', deferredTax: '-405.00',
};

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const INTENT = '44444444-4444-4444-8444-444444444444';

const statements: { text: string; values: unknown[] }[] = [];

/** The recording stand-in for `ctx.sql`; answers only the reads this path makes. */
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.raw.join('?');
  statements.push({ text, values });
  if (/FROM control_asset_depreciation_intents/.test(text)) {
    return Promise.resolve([{ requester_person_id: USER }]);
  }
  if (/UPDATE assets SET/.test(text)) return Promise.resolve([{ id: ASSET }]);
  return Promise.resolve([]);
}

const ctx = { sql: fakeSql, principal: { companyId: COMPANY, personId: USER } };

vi.mock('@/lib/neon', () => ({
  withSavepoint: (_name: string, fn: () => unknown) => fn(),
  sql: fakeSql,
}));
vi.mock('@/lib/auth/effectivePermissions', () => ({ assertEffectivePermission: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/controls/context', () => ({ requireControlTx: () => ctx }));
vi.mock('@/modules/accounting/services/controls/intentIdentity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadIntentReceipt: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService', () => ({
  executeControlledOperation: (
    _ctx: unknown, _ref: unknown, _approvalId: unknown,
    run: (permit: { accountingDate: string; operationId: string }) => unknown,
  ) => run({ accountingDate: '2026-03-31', operationId: 'operation-1' }),
}));
vi.mock('@/modules/accounting/services/controls/assetDepreciationOperationMaterializer', () => ({
  materializeAssetDepreciationOperation: vi.fn(async () => ({
    observedSources: [{
      facts: {
        company: { id: COMPANY },
        asset: { id: ASSET, asset_number: 'FA-0001' },
        accounts: [],
        period: { id: 'period-1', status: 'open' },
        ledgers: [],
        input: { cost: '12000.00', openingAccDep: '1000.00', taxOpeningAccDep: '2000.00' },
        calculation: CALC,
        plan: [],
      },
    }],
  })),
}));
vi.mock('@/modules/accounting/services/gl/postingPeriodGuard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lockdownBlock: vi.fn(() => null),
}));
vi.mock('@/modules/accounting/services/controls/operationVersions', () => ({
  readControlEntityVersion: vi.fn(async () => ({ version: 1 })),
}));
vi.mock('@/modules/accounting/services/controls/changeEventService', () => ({
  recordCommittedChange: vi.fn(async () => undefined),
}));

const { executeAssetDepreciation } = await import(
  '@/modules/accounting/services/gl/controlledAssetDepreciation'
);

/** The statement as Postgres would see it: fragments with their bound values put back. */
function render(statement: { text: string; values: unknown[] }): string {
  return statement.text.split('?').reduce(
    (acc, part, i) => acc + (i === 0 ? '' : String(statement.values[i - 1])) + part,
  );
}

describe('controlled asset depreciation asset cache', () => {
  it('writes every cached column the run recalculates, tax_book_value included', async () => {
    statements.length = 0;
    await executeAssetDepreciation(COMPANY, USER, INTENT);

    const update = statements.find((s) => /UPDATE assets SET/.test(s.text));
    expect(update, 'the run issued no asset UPDATE').toBeDefined();
    const rendered = render(update!);

    expect(rendered).toMatch(new RegExp(`accumulated_depreciation=${CALC.policyClosing}`));
    expect(rendered).toMatch(new RegExp(`current_book_value=${CALC.policyCarrying}`));
    expect(rendered).toMatch(new RegExp(`tax_accumulated_depreciation=${CALC.taxClosing}`));
    expect(rendered).toMatch(new RegExp(`tax_book_value=${CALC.taxCarrying}`));
  });
});

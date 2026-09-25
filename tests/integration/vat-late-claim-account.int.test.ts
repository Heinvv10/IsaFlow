/**
 * One late-claim clearing account per company, whichever writer runs first:
 * migration 701 gives one to every company with a chart, and a template seeded
 * afterwards (coa-seed) must not add a second system account with the subtype
 * — the resolver would then pick between them by heap order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { seedChartOfAccountsFromTemplate } from '@/modules/accounting/services/gl/chartOfAccountsImportService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { dropLateFixture, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let withAccount: LateFixture;
let without: Fixture;

const count = async (companyId: string) => Number(((await sql`
  SELECT COUNT(*)::INT AS n FROM gl_accounts
  WHERE company_id = ${companyId}::UUID AND account_subtype = 'vat_input_late_claim'`) as Row[])[0]!.n);

describeIfDb('late-claim clearing account: exactly one per company', () => {
  beforeAll(async () => {
    assertNotProductionDb('seeds charts');
    withAccount = await seedLateFixture('VLA', DATABASE_URL!);
    without = await seedFixture('VLA2', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    if (withAccount) await dropLateFixture(withAccount);
    if (without) await dropFixture(without);
  }, 120000);

  it.each(['isaflow_standard', 'xero_compatible', 'sage_compatible'] as const)(
    'a %s seed over a company that already has one adds none', async (t) => {
      await inTx(withAccount, () => seedChartOfAccountsFromTemplate(withAccount.companyId, t));
      expect(await count(withAccount.companyId)).toBe(1);
    });

  it('a template seed over a company without one adds exactly one', async () => {
    await inTx(without, () => seedChartOfAccountsFromTemplate(without.companyId, 'sage_compatible'));
    expect(await count(without.companyId)).toBe(1);
  });
});

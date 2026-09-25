/**
 * One late-claim clearing account per company, whichever writer runs first:
 * migration 701 gives one to every company with a chart, and a template seeded
 * afterwards (coa-seed) must not add a second system account with the subtype
 * — the resolver would then pick between them by heap order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { seedChartOfAccountsFromTemplate } from '@/modules/accounting/services/gl/chartOfAccountsImportService';
import { mergeAccounts } from '@/modules/accounting/services/gl/accountMergeService';
import { AccountMergeError } from '@/modules/accounting/services/gl/accountMergeGuards';
import { admitReclassification } from '@/modules/accounting/services/gl/reclassification/planGuards';
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

  it('the clearing account cannot be merged, in either direction (review C4)', async () => {
    const other = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active)
      VALUES (${withAccount.companyId}::UUID, '1160', ${`Prepayments ${withAccount.tag}`}, 'asset',
              'other_current_asset', 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
    for (const [src, tgt] of [[other, withAccount.clearingId], [withAccount.clearingId, other]] as const) {
      const err = await inTx(withAccount, () => mergeAccounts(withAccount.companyId, src, tgt, withAccount.userId))
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AccountMergeError);
      expect((err as AccountMergeError).code).toBe('late_claim_clearing_account');
    }
    const [m] = (await sql`SELECT COUNT(*)::INT AS n FROM gl_account_merges WHERE company_id = ${withAccount.companyId}::UUID`) as Row[];
    expect(m!.n).toBe(0);
  });

  it('nothing may be reclassified onto or off the clearing account', async () => {
    for (const [src, tgt] of [[withAccount.expenseId, withAccount.clearingId], [withAccount.clearingId, withAccount.expenseId]] as const) {
      const out = await inTx(withAccount, () => admitReclassification({
        companyId: withAccount.companyId, sourceAccountId: src, targetAccountId: tgt,
        from: null, to: null, postingDate: null, lockCandidateLines: false,
      } as never));
      expect(out).toMatchObject({ refused: expect.stringContaining('late claims') });
    }
  });
});

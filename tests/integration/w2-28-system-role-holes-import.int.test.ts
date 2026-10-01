// W2-28 round 5: the COA import's role map may not take an account from
// another role or give one account two roles, and every role writer's
// resolver-cache clear waits for its COMMIT. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { roleWriterFixture } from './w2-28-role-writers.helpers';
import { getSystemAccount, clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { importChartOfAccounts, type AccountImportRow } from '../../src/modules/accounting/services/core/migrationCoaService';
import { createSession } from '../../src/modules/accounting/services/core/migrationService';
import { mergeAccounts } from '../../src/modules/accounting/services/gl/accountMergeService';
import { reclassifyAccount } from '../../src/modules/accounting/services/gl/accountReclassifyService';
import { ensureOpeningBalanceEquityAccount } from '../../src/modules/accounting/services/gl/openingBalanceEquityService';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = roleWriterFixture('W228R5I');
const { CO, USER, ins, holders } = fx;
const row = (accountCode: string, accountType = 'asset') => ({ accountCode, accountName: `Imported ${accountCode}`,
  accountType, normalBalance: accountType === 'asset' || accountType === 'expense' ? 'debit' : 'credit' }) as AccountImportRow;
const importing = async (rows: AccountImportRow[], map: Record<string, string>) => {
  const session = await createSession(CO, 'sage', USER);
  return importChartOfAccounts(CO, session.id, rows, map as never);
};
const resolvedBank = async () => {
  try { return (await getSystemAccount('bank', CO)).accountCode; } catch (e) { return (e as Error).name; }
};
const names = async () => (await fx.query(
  'SELECT account_code, account_name FROM gl_accounts WHERE company_id = $1 ORDER BY account_code', [CO])).rows
  .map((r) => `${r.account_code}=${r.account_name}`);

describeIfDb('W2-28 the COA import role map, and after-commit cache clears', () => {
  beforeAll(fx.setup);
  beforeEach(async () => { await fx.wipe(); clearSystemAccountCache(CO); });
  afterAll(fx.teardown);

  it('refuses a re-import that maps a role onto the account holding another role, writing nothing', async () => {
    await ins(randomUUID(), '1110', 'asset', 'bank', true);
    await ins(randomUUID(), '1120', 'asset', 'receivable', true);
    const before = await names();
    const out = await importing([row('1110'), row('1120')], { bank: '1120' });
    expect({ imported: out.imported, error: out.errors[0]?.message, bank: await holders('bank'), ar: await holders('receivable'), names: await names() })
      .toEqual({ imported: 0, error: expect.stringContaining("1120 is classified 'receivable'"), bank: ['1110'], ar: ['1120'], names: before });
  });

  it('refuses a role map that names one account for two roles, writing nothing', async () => {
    const out = await importing([row('1110'), row('1120')], { bank: '1110', receivable: '1110' });
    expect({ imported: out.imported, error: out.errors[0]?.message, names: await names() })
      .toEqual({ imported: 0, error: expect.stringContaining('One account cannot hold two roles'), names: [] });
  });

  it('still moves a role onto an unclassified account, one classified other, the type default, or the holder itself', async () => {
    await ins(randomUUID(), '1110', 'asset', 'bank', true);
    await ins(randomUUID(), '1111', 'asset', null, false);
    await ins(randomUUID(), '1120', 'asset', 'other', false);
    await ins(randomUUID(), '4100', 'revenue', 'revenue', false);
    await ins(randomUUID(), '2110', 'liability', 'payable', true);
    const out = await importing([row('1111'), row('1120'), row('4100', 'revenue'), row('2110', 'liability')],
      { bank: '1111', receivable: '1120', default_revenue: '4100', payable: '2110' });
    expect({ errors: out.errors, bank: await holders('bank'), ar: await holders('receivable'),
      revenue: await holders('default_revenue'), payable: await holders('payable') })
      .toEqual({ errors: [], bank: ['1111'], ar: ['1120'], revenue: ['4100'], payable: ['2110'] });
  });

  /**
   * The bank holder is cached as 1110, then moved to 1115 behind the cache's
   * back. `writer` runs in a request: a read before its COMMIT must still see
   * the cached 1110 (nothing cleared early) and a read after must see 1115.
   */
  async function cacheAround(writer: () => Promise<unknown>) {
    const B1 = randomUUID(); const B2 = randomUUID();
    await ins(B1, '1110', 'asset', 'bank', true);
    await ins(B2, '1115', 'asset', 'bank', false);
    await resolvedBank();
    await fx.query('UPDATE gl_accounts SET is_system_account = (id = $2) WHERE company_id = $1 AND id IN ($2, $3)', [CO, B2, B1]);
    const tx = await fx.openTx();
    try {
      await tx.run(writer);
      const beforeCommit = await resolvedBank();
      await tx.commit();
      return { beforeCommit, afterCommit: await resolvedBank() };
    } finally { await tx.rollback(); }
  }
  const cleared = { beforeCommit: '1110', afterCommit: '1115' };

  it('an account merge clears the resolver cache after its request commits, not before', async () => {
    const S = randomUUID(); const T = randomUUID();
    await ins(S, '1310', 'asset', null, false);
    await ins(T, '1320', 'asset', null, false);
    expect(await cacheAround(() => mergeAccounts(CO, S, T, USER))).toEqual(cleared);
  });

  it('a reclassification clears the resolver cache after its request commits, not before', async () => {
    const A = randomUUID();
    await ins(A, '1310', 'asset', null, false);
    expect(await cacheAround(() => reclassifyAccount(CO, A, { accountSubtype: 'other_current_asset' }))).toEqual(cleared);
  });

  it('the Opening Balance Equity auto-create clears the resolver cache after its request commits, not before', async () => {
    expect(await cacheAround(() => ensureOpeningBalanceEquityAccount(CO))).toEqual(cleared);
  });
});

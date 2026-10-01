// W2-28 round 5: the COA import's role map may not take an account from
// another role or give one account two roles, and every role writer's
// resolver-cache clear waits for its COMMIT. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';

// Round 12 put a refusal in the user's own terms IN FRONT of the role post-condition for the two cases a
// user can cause. `lastLine.only` takes those two guards out, as a new writer that forgot them would be:
// the post-condition must still roll the write back.
const lastLine = vi.hoisted(() => ({ only: false }));
vi.mock('@/modules/accounting/services/core/migrationCoaRoleMap', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/accounting/services/core/migrationCoaRoleMap')>();
  return { ...actual, holderParentConflicts: (...args: Parameters<typeof actual.holderParentConflicts>) =>
    (lastLine.only ? Promise.resolve([]) : actual.holderParentConflicts(...args)) };
});
vi.mock('@/modules/accounting/services/gl/accountMergeRoleGuard', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/accounting/services/gl/accountMergeRoleGuard')>();
  return { ...actual, assertTargetMayTakeChildren: (...args: Parameters<typeof actual.assertTargetMayTakeChildren>) =>
    (lastLine.only ? Promise.resolve() : actual.assertTargetMayTakeChildren(...args)) };
});
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
  beforeEach(async () => { lastLine.only = false; await fx.wipe(); clearSystemAccountCache(CO); });
  afterAll(fx.teardown);

  it('refuses a re-import that maps a role onto the account holding another role, writing nothing', async () => {
    await ins(randomUUID(), '1110', 'asset', 'bank', true);
    await ins(randomUUID(), '1120', 'asset', 'receivable', true);
    const before = await names();
    const out = await importing([row('1110'), row('1120')], { bank: '1120' });
    expect({ imported: out.imported, error: out.errors[0]?.message, bank: await holders('bank'), ar: await holders('receivable'), names: await names() })
      .toEqual({ imported: 0, error: expect.stringContaining("1120 has the subtype 'receivable'"), bank: ['1110'], ar: ['1120'], names: before });
  });

  it('refuses a role map that names one account for two roles, writing nothing', async () => {
    const out = await importing([row('1110'), row('1120')], { bank: '1110', receivable: '1110' });
    expect({ imported: out.imported, error: out.errors[0]?.message, names: await names() })
      .toEqual({ imported: 0, error: expect.stringContaining('One account cannot hold two roles'), names: [] });
  });

  it('still moves a role onto an unclassified account, one classified other, or the holder itself', async () => {
    await ins(randomUUID(), '1110', 'asset', 'bank', true);
    await ins(randomUUID(), '1111', 'asset', null, false);
    await ins(randomUUID(), '1120', 'asset', 'other', false);
    await ins(randomUUID(), '2110', 'liability', 'payable', true);
    const out = await importing([row('1111'), row('1120'), row('2110', 'liability')],
      { bank: '1111', receivable: '1120', payable: '2110' });
    expect({ errors: out.errors, bank: await holders('bank'), ar: await holders('receivable'), payable: await holders('payable') })
      .toEqual({ errors: [], bank: ['1111'], ar: ['1120'], payable: ['2110'] });
  });

  it.each([
    ['an inactive account', async () => {
      await ins(randomUUID(), '2999', 'liability', null, false);
      await fx.query("UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND account_code = '2999'", [CO]);
      return { rows: [row('2999', 'liability')], message: '2999 for \'payable\' is inactive' };
    }],
    ['a header with sub-accounts', async () => {
      const header = randomUUID();
      await ins(header, '2999', 'liability', null, false);
      await ins(randomUUID(), '2998', 'liability', null, false, { parent: header });
      return { rows: [row('2999', 'liability')], message: '2999 is a header with sub-accounts' };
    }],
    ['an account classified as something else', async () => {
      await ins(randomUUID(), '2999', 'liability', 'other_current_liability', false);
      return { rows: [row('2999', 'liability')], message: "2999 has the subtype 'other_current_liability'" };
    }],
    ['a row the same import makes a header', async () => (
      { rows: [row('2999', 'liability'), { ...row('2998', 'liability'), parentCode: '2999' }], message: '2999 is a header with sub-accounts' })],
  ])('refuses a role map that puts a role on %s: the live holder keeps it and nothing is written', async (_what, arrange) => {
    await ins(randomUUID(), '2100', 'liability', 'payable', true);
    const { rows, message } = await arrange();
    const before = await names();
    const out = await importing(rows, { payable: '2999' });
    expect({ imported: out.imported, error: out.errors[0]?.message, payable: await holders('payable'), names: await names() })
      .toEqual({ imported: 0, error: expect.stringContaining(message), payable: ['2100'], names: before });
  });

  it('a role cannot go to an existing system account of the wrong type, whatever type the import row claims', async () => {
    await ins(randomUUID(), '1110', 'asset', 'bank', true);
    await ins(randomUUID(), '2999', 'liability', null, true);        // a system row the upsert will keep as a liability
    const before = await names();
    const out = await importing([row('2999', 'asset')], { bank: '2999' });
    expect({ imported: out.imported, error: out.errors[0]?.message, bank: await holders('bank'), names: await names() })
      .toEqual({ imported: 0, error: "Account for 'bank' must be of type 'asset' (got 'liability')", bank: ['1110'], names: before });
  });

  it('a re-import keeps a classification made by hand unless the row states another; an unclassified expense gets the default', async () => {
    await ins(randomUUID(), '5900', 'expense', 'cost_of_sales', false);
    await ins(randomUUID(), '5910', 'expense', 'operating_expense', false);
    await importing([row('5900', 'expense'), { ...row('5910', 'expense'), accountSubtype: 'cost_of_sales' }, row('5920', 'expense')], {});
    const subtypes = (await fx.query(
      "SELECT account_code AS code, account_subtype AS subtype FROM gl_accounts WHERE company_id = $1 ORDER BY 1", [CO])).rows;
    expect(subtypes).toEqual([{ code: '5900', subtype: 'cost_of_sales' }, { code: '5910', subtype: 'cost_of_sales' },
      { code: '5920', subtype: 'operating_expense' }]);
  });

  it('a role mapped to a row the import would skip (parent not found) refuses the whole map before any write', async () => {
    await ins(randomUUID(), '1110', 'asset', 'bank', true);
    const out = await importing([{ ...row('1500'), parentCode: '9999' }, row('1600')], { bank: '1500' });
    expect({ imported: out.imported, error: out.errors[0]?.message, bank: await holders('bank'), names: await names() }).toEqual({
      imported: 0, error: expect.stringContaining('1500 cannot take the bank role: its parent code 9999'),
      bank: ['1110'], names: ['1110=W228R5I 1110'] });
  });

  it('whatever the rows do, an import that leaves a role without exactly one usable holder is rolled back whole', async () => {
    const AR = randomUUID();
    await ins(randomUUID(), '1110', 'asset', 'bank', true);
    await ins(AR, '1120', 'asset', 'receivable', true);
    const before = await names();
    // Nothing in the map: an ordinary row asks for the receivable holder as its parent, making it a header.
    const refused = await importing([{ ...row('1121'), parentCode: '1120' }], {});
    expect({ imported: refused.imported, error: refused.errors[0]?.message, names: await names() })
      .toEqual({ imported: 0, error: expect.stringContaining('Account 1121 cannot go under 1120: Account 1120 holds the receivable role'), names: before });
    lastLine.only = true;                              // without that refusal: the post-condition, after the writes
    const out = await importing([{ ...row('1121'), parentCode: '1120' }], {});
    expect({ imported: out.imported, error: out.errors[0]?.message, names: await names() })
      .toEqual({ imported: 0, error: expect.stringContaining('would leave receivable without exactly one usable account'), names: before });
  });

  it('an import row over an existing system account keeps its type, classification, flag and active state, and says so', async () => {
    await ins(randomUUID(), '1110', 'asset', 'bank', true);
    await ins(randomUUID(), '1120', 'asset', 'receivable', true);
    await ins(randomUUID(), '1105', 'asset', 'bank', true);
    await fx.query("UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND account_code = '1105'", [CO]);
    await ins(randomUUID(), '1130', 'asset', 'other', false);
    const out = await importing([
      { ...row('1110'), accountSubtype: 'other_current_asset' },      // would empty the bank role
      row('1120', 'expense'),                                          // would re-type the receivable holder
      row('1105'),                                                     // a deactivated former holder
      { ...row('1130'), accountSubtype: 'other_current_asset' },       // not a system account: re-classified as before
    ], {});
    const state = (await fx.query(
      `SELECT account_code AS code, account_type AS type, account_subtype AS subtype, is_system_account AS system, is_active AS active
       FROM gl_accounts WHERE company_id = $1 ORDER BY 1`, [CO])).rows;
    const notes = out.errors.map((e) => e.message).filter((m) => m.includes('is a system account'));
    expect({ imported: out.imported, notes, state }).toEqual({
      imported: 4,
      notes: [expect.stringContaining('1110 is a system account'), expect.stringContaining('(asset / receivable) were kept')],
      state: [
        { code: '1105', type: 'asset', subtype: 'bank', system: true, active: false },
        { code: '1110', type: 'asset', subtype: 'bank', system: true, active: true },
        { code: '1120', type: 'asset', subtype: 'receivable', system: true, active: true },
        { code: '1130', type: 'asset', subtype: 'other_current_asset', system: false, active: true },
      ],
    });
    expect({ bank: await holders('bank'), ar: await holders('receivable') }).toEqual({ bank: ['1110'], ar: ['1120'] });
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

  it('a merge whose source has sub-accounts cannot land them under a role holder', async () => {
    const S = randomUUID(); const T = randomUUID();
    await ins(S, '1310', 'asset', null, false);
    await ins(randomUUID(), '1311', 'asset', null, false, { parent: S, level: 4 });
    await ins(T, '1120', 'asset', 'receivable', true);
    const attempt = async () => {
      const tx = await fx.openTx();
      const merged = await tx.run(() => mergeAccounts(CO, S, T, USER)).then(() => 'merged', (e: { code?: string }) => e.code);
      await tx.commit();                                              // the merge's own savepoint undid its writes
      const parents = (await fx.query('SELECT account_code FROM gl_accounts WHERE company_id = $1 AND parent_account_id = $2', [CO, T])).rows;
      return { merged, parents, ar: await holders('receivable') };
    };
    expect(await attempt()).toEqual({ merged: 'target_becomes_header', parents: [], ar: ['1120'] });   // refused before any write
    lastLine.only = true;                                             // without that guard: the post-condition, after the writes
    expect(await attempt()).toEqual({ merged: 'SYSTEM_ROLE_INVARIANT', parents: [], ar: ['1120'] });
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

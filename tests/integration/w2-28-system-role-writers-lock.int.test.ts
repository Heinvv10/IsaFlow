// W2-28 round 4: every other writer of a role holder takes the role-write lock
// before it reads, and the lock is bounded. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { makeGate, roleWriterFixture, sleep, type Gate } from './w2-28-role-writers.helpers';

let gate: Gate | null = null;
vi.mock('@/modules/accounting/services/gl/systemRoleCoverage', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/accounting/services/gl/systemRoleCoverage')>();
  return {
    ...actual,
    getSystemRoleCoverage: async (...args: Parameters<typeof actual.getSystemRoleCoverage>) => {
      const out = await actual.getSystemRoleCoverage(...args);
      if (gate) { const g = gate; gate = null; g.reached(); await g.release; }
      return out;
    },
  };
});
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import chartOfAccounts from '../../pages/api/accounting/chart-of-accounts';
import chartOfAccountsDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import { getSystemAccount, clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { deleteAccount, seedChartOfAccountsFromTemplate } from '../../src/modules/accounting/services/gl/chartOfAccountsService';
import { reclassifyAccount } from '../../src/modules/accounting/services/gl/accountReclassifyService';
import { executeMigration } from '../../src/modules/accounting/services/core/migrationExecuteService';
import { lockSystemRoleWrites } from '../../src/modules/accounting/services/gl/systemRoleWriteLock';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = roleWriterFixture('W228R4L');
const { CO, USER, ins, holders } = fx;
const save = (body: Record<string, unknown>) => fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', body);
const resolvedBank = async () => {
  try { return (await getSystemAccount('bank', CO)).accountCode; } catch (e) { return (e as Error).name; }
};

describeIfDb('W2-28 system role writers take the role-write lock', () => {
  const BANK = randomUUID(); const X = randomUUID();

  beforeAll(fx.setup);
  beforeEach(async () => { gate = null; await fx.wipe(); clearSystemAccountCache(CO); });
  afterAll(fx.teardown);

  /**
   * A save moving the bank role from 1110 to 1115 is stopped holding its locks;
   * `writer` then runs in its own request and the save is let go. Returns what
   * each answered and where the bank role ended up.
   */
  async function raceSaveWith(xSubtype: string | null, writer: () => Promise<string>) {
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', xSubtype, false);
    const g = makeGate(); gate = g.gate;
    const saving = save({ mappings: { primary_bank: X }, loaded: { primary_bank: BANK } });
    await g.reached;
    const writing = writer();
    await sleep(300);
    g.release();
    const res = await saving; const outcome = await writing;
    clearSystemAccountCache(CO);
    return { save: res.statusCode, outcome, bankHolders: await holders('bank'), resolved: await resolvedBank() };
  }
  /** A service call inside its own request transaction, answering its error message. */
  const inRequest = (fn: () => Promise<unknown>) => async () => {
    const tx = await fx.openTx();
    try { await tx.run(fn); return 'done'; } catch (e) { return (e as Error).message; } finally { await tx.commit(); }
  };
  const settled = (outcome: unknown) => ({ save: 200, outcome, bankHolders: ['1115'], resolved: '1115' });

  it('deleting the account a save is moving a role to waits for the save and is then refused', async () => {
    expect(await raceSaveWith(null, inRequest(() => deleteAccount(CO, X))))
      .toEqual(settled(expect.stringContaining('it is a system account')));
  });

  it('reclassifying the account a save is moving a role to waits for the save and is then refused', async () => {
    expect(await raceSaveWith(null, inRequest(() => reclassifyAccount(CO, X, { accountSubtype: 'other_current_asset' }))))
      .toEqual(settled(expect.stringContaining('Cannot change the subtype of system account 1115')));
  });

  it('the bank-accounts PUT deactivating the account a save is making primary waits for the save and answers 400', async () => {
    const put = async () => String((await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: X, isActive: false })).statusCode);
    expect(await raceSaveWith('bank', put)).toEqual(settled('400'));
  });

  /** `writer` adds a second bank holder in a request still open; a save started meanwhile must see it. */
  async function saveDuringOpenRequest(writer: () => Promise<unknown>) {
    await ins(BANK, '1190', 'asset', 'bank', true, { createdAt: '2024-01-01' });
    await ins(X, '1195', 'asset', null, false);
    const tx = await fx.openTx();
    try {
      await tx.run(writer);
      const saving = save({ mappings: { primary_bank: X }, loaded: { primary_bank: BANK } });
      await sleep(300);
      await tx.commit();
      return (await saving).statusCode;
    } finally { await tx.rollback(); }
  }

  it('a save started while a template seed is in flight waits for it and answers 409, not 200 over a holder it could not see', async () => {
    expect(await saveDuringOpenRequest(() => seedChartOfAccountsFromTemplate(CO, 'isaflow_standard'))).toBe(409);
    expect(await holders('bank')).toContain('1110');
  }, 20_000);

  it('a save started while a migration import is filling a system account\'s subtype waits for it and answers 409', async () => {
    await ins(randomUUID(), 'Z100', 'asset', null, true, { importedFrom: 'xero' });
    let imported = 0;
    const status = await saveDuringOpenRequest(async () => {
      imported = (await executeMigration(CO, USER, 'xero', [{ sourceCode: 'Z100', sourceName: 'Imported bank', sourceType: 'BANK',
        openingBalance: 0, mappedType: 'asset', mappedNormalBalance: 'debit', mappedSubtype: 'bank' }], [], [])).accountsImported;
    });
    expect({ imported, status, bankHolders: await holders('bank') }).toEqual({ imported: 1, status: 409, bankHolders: ['1190', 'Z100'] });
  }, 20_000);

  it('a writer that cannot get the role lock within 5s answers 503 to retry instead of waiting on the holder', async () => {
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
    const tx = await fx.openTx();
    try {
      await tx.run(() => lockSystemRoleWrites(CO));
      const saving = save({ mappings: { primary_bank: X }, loaded: { primary_bank: BANK } });
      const answered = await Promise.race([saving.then((s) => s.statusCode), sleep(9000).then(() => 'still waiting after 9s')]);
      await tx.rollback();
      await saving;
      expect({ answered, bankHolders: await holders('bank') }).toEqual({ answered: 503, bankHolders: ['1110'] });
    } finally { await tx.rollback(); }
  }, 30_000);

  it('the chart and bank-account routes answer 503 too, not a 400 that reads as "do not retry"', async () => {
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', 'bank', false);
    const tx = await fx.openTx();
    try {
      await tx.run(() => lockSystemRoleWrites(CO));
      const off = { id: X, isActive: false };
      const answers = await Promise.all([
        fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', off),
        fx.call(chartOfAccounts, 'PUT', '/api/accounting/chart-of-accounts', off),
        fx.call(chartOfAccountsDetail, 'PUT', '/api/accounting/chart-of-accounts-detail', off),
        fx.call(chartOfAccountsDetail, 'DELETE', '/api/accounting/chart-of-accounts-detail', { id: X }),
      ]);
      expect(answers.map((a) => a.statusCode)).toEqual([503, 503, 503, 503]);
    } finally { await tx.rollback(); }
    expect((await fx.query('SELECT is_active FROM gl_accounts WHERE id = $1', [X])).rows[0].is_active).toBe(true);
  }, 30_000);

  it('the 5s bound is for the role lock only: the caller\'s lock_timeout is back once it is granted', async () => {
    const tx = await fx.openTx();
    try {
      const after = await tx.run(async () => {
        await lockSystemRoleWrites(CO);
        return (await sql`SELECT current_setting('lock_timeout') AS v`) as { v: string }[];
      });
      expect(after[0]!.v).toBe('0');
    } finally { await tx.rollback(); }
  });
});

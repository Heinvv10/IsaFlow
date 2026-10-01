// W2-28 round 5: the sequential ways a role could still end up with no holder
// or two — rollback, a subtype clear, a re-seed — and the resolver cache after
// a seed or a migration import. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { makeGate, roleWriterFixture, sleep, type Gate } from './w2-28-role-writers.helpers';

// Stops rollbackMigration's per-account loop before its third account (its second delete).
let loopGate: Gate | null = null;
vi.mock('@/lib/neon', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/neon')>();
  return {
    ...actual,
    withSavepoint: async <T>(name: string, fn: () => Promise<T>) => {
      if (loopGate && name === 'mig_rb_2') { const g = loopGate; loopGate = null; g.reached(); await g.release; }
      return actual.withSavepoint(name, fn);
    },
  };
});
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import chartOfAccounts from '../../pages/api/accounting/chart-of-accounts';
import { getSystemAccount, clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { getSystemRoleCoverage } from '../../src/modules/accounting/services/gl/systemRoleCoverage';
import { isSystemAccountKey } from '../../src/modules/accounting/services/gl/systemAccountKeys';
import { seedChartOfAccountsFromTemplate } from '../../src/modules/accounting/services/gl/chartOfAccountsService';
import { getTemplateLines, type CoaTemplate } from '../../src/modules/accounting/services/gl/chartOfAccountsImportService';
import { reclassifyAccount } from '../../src/modules/accounting/services/gl/accountReclassifyService';
import { executeMigration, rollbackMigration } from '../../src/modules/accounting/services/core/migrationExecuteService';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = roleWriterFixture('W228R5');
const { CO, USER, ins, holders } = fx;
const resolvedBank = async () => {
  try { return (await getSystemAccount('bank', CO)).accountCode; } catch (e) { return (e as Error).name; }
};
const codes = async () => (await fx.query(
  'SELECT account_code FROM gl_accounts WHERE company_id = $1 ORDER BY account_code', [CO])).rows.map((r) => String(r.account_code));

describeIfDb('W2-28 a role is never emptied or doubled by a rollback, a subtype clear or a re-seed', () => {
  beforeAll(fx.setup);
  beforeEach(async () => { loopGate = null; await fx.wipe(); clearSystemAccountCache(CO); });
  afterAll(fx.teardown);

  it('a migration rollback keeps an imported account that now holds a role, and reports it as retained', async () => {
    await ins(randomUUID(), 'X100', 'asset', 'bank', true, { importedFrom: 'xero' });   // made primary bank after the import
    await ins(randomUUID(), 'X200', 'asset', null, false, { importedFrom: 'xero' });
    const tx = await fx.openTx();
    const out = await tx.run(() => rollbackMigration(CO, 'xero'));
    await tx.commit();
    expect({ out, codes: await codes(), bank: await holders('bank') })
      .toEqual({ out: { deleted: 1, retained: 1, retainedCodes: ['X100'] }, codes: ['X100'], bank: ['X100'] });
    // Untagged like any retained account, so a later rollback cannot take it either.
    expect((await fx.query('SELECT imported_from FROM gl_accounts WHERE company_id = $1', [CO])).rows[0].imported_from).toBeNull();
  });

  it('a rollback working through its per-account loop holds the role lock, so a save queues instead of deadlocking', async () => {
    const H = 'ffffffff-ffff-4fff-bfff-' + randomUUID().slice(-12);   // first by code, last by id; role-subtyped
    const L = '00000000-0000-4000-8000-' + randomUUID().slice(-12);   // second by code, first by id; the save's choice
    const K = randomUUID(); const BANK = '88888888-8888-4888-8888-' + randomUUID().slice(-12);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(randomUUID(), 'X050', 'asset', 'receivable', true, { importedFrom: 'xero' });   // a holder: the loop keeps it too
    await ins(H, 'X100', 'asset', 'bank', false, { importedFrom: 'xero' });
    await ins(L, 'X200', 'asset', null, false, { importedFrom: 'xero' });
    await ins(K, 'X300', 'asset', null, false, { importedFrom: 'xero' });
    await ins(randomUUID(), '1900', 'asset', null, false, { parent: K });   // blocks the bulk delete: the loop runs
    const g = makeGate(); loopGate = g.gate;
    const tx = await fx.openTx();
    const rolling = tx.run(() => rollbackMigration(CO, 'xero')).then((r) => `deleted ${r.deleted}, kept ${r.retainedCodes.join('+')}`, (e: { code?: string }) => `failed ${e.code}`);
    await g.reached;                                  // X100 deleted, X200 not yet
    const saving = fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts',
      { mappings: { primary_bank: L }, loaded: { primary_bank: BANK } });
    await sleep(300);
    g.release();
    const rollback = await rolling;
    await tx.commit();
    expect({ rollback, save: (await saving).statusCode, bank: await holders('bank'), ar: await holders('receivable') })
      .toEqual({ rollback: 'deleted 2, kept X050+X300', save: 400, bank: ['1110'], ar: ['X050'] });   // the chosen account is gone: refused, not 500
  }, 20_000);

  it('a system account\'s subtype cannot be cleared: the role would have no holder', async () => {
    const BANK = randomUUID();
    await ins(BANK, '1110', 'asset', 'bank', true);
    const tx = await fx.openTx();
    const service = await tx.run(() => reclassifyAccount(CO, BANK, { accountSubtype: null })).then(() => 'cleared', (e: Error) => e.message);
    await tx.commit();
    const put = await fx.call(chartOfAccounts, 'PUT', '/api/accounting/chart-of-accounts', { id: BANK, accountSubtype: '' });
    expect({ service, put: put.statusCode, bank: await holders('bank') })
      .toEqual({ service: expect.stringContaining('Cannot change the subtype of system account 1110'), put: 400, bank: ['1110'] });
  });

  it.each(['isaflow_standard', 'xero_compatible', 'sage_compatible'] as CoaTemplate[])(
    'seeding %s into a company that already holds every role adds no second holder', async (template) => {
      const roleLines = getTemplateLines(template).filter((l) => l.isSystem && isSystemAccountKey(l.subtype));
      const held: Record<string, string> = {};
      for (const [i, l] of roleLines.entries()) {
        held[l.subtype!] = `H${String(i).padStart(2, '0')}`;
        await ins(randomUUID(), held[l.subtype!]!, l.type, l.subtype!, true);
      }
      const tx = await fx.openTx();
      await tx.run(() => seedChartOfAccountsFromTemplate(CO, template));
      await tx.commit();
      const coverage = await getSystemRoleCoverage(CO);
      const now = Object.fromEntries(coverage.roles.filter((r) => held[r.key]).map((r) => [r.key, r.holder?.accountCode]));
      expect(roleLines.length).toBeGreaterThan(5);
      expect({ contested: coverage.contested.map((r) => r.key), now }).toEqual({ contested: [], now: held });
    });

  it('a template seed clears the resolver cache after its request commits', async () => {
    const tx = await fx.openTx();
    await tx.run(() => seedChartOfAccountsFromTemplate(CO, 'isaflow_standard'));
    const midRequest = await resolvedBank();          // a post before the COMMIT: no bank yet, and that is cached
    await tx.commit();
    expect({ midRequest, afterCommit: await resolvedBank() }).toEqual({ midRequest: 'MissingSystemAccountError', afterCommit: '1110' });
  });

  it('a migration re-import never fills a system account\'s subtype: it cannot make it a role holder', async () => {
    await ins(randomUUID(), '1190', 'asset', 'bank', true);
    await ins(randomUUID(), 'Z100', 'asset', null, true, { importedFrom: 'xero' });
    await ins(randomUUID(), 'Z200', 'asset', null, false, { importedFrom: 'xero' });
    const account = (sourceCode: string) => ({ sourceCode, sourceName: `Imported ${sourceCode}`, sourceType: 'BANK',
      openingBalance: 0, mappedType: 'asset' as const, mappedNormalBalance: 'debit' as const, mappedSubtype: 'bank' });
    const tx = await fx.openTx();
    const out = await tx.run(() => executeMigration(CO, USER, 'xero', [account('Z100'), account('Z200')], [], []));
    await tx.commit();
    const subtypes = (await fx.query(
      "SELECT account_code, account_subtype FROM gl_accounts WHERE company_id = $1 AND account_code LIKE 'Z%' ORDER BY 1", [CO])).rows;
    expect({ imported: out.accountsImported, bank: await holders('bank'), subtypes }).toEqual({ imported: 2, bank: ['1190'],
      subtypes: [{ account_code: 'Z100', account_subtype: null }, { account_code: 'Z200', account_subtype: 'bank' }] });
  });
});

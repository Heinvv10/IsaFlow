// W2-28 round 10: no chart writer waits unbounded on a row while it holds the
// company's role lock, and the COA import refuses mistyped row fields before any
// work. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { brkFixture, sleep, within } from './w2-28-brk593.helpers';
import coa from '../../pages/api/accounting/chart-of-accounts';
import coaDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import migrationExecute from '../../pages/api/accounting/migration-execute';
import migrationRollback from '../../pages/api/accounting/migration-rollback';
import coaSeed from '../../pages/api/accounting/coa-seed';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createSession } from '@/modules/accounting/services/core/migrationService';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = brkFixture('W228R10');
const { CO, USER, ins, holders } = fx;
const BANK = randomUUID(); const X = randomUUID(); const B2 = randomUUID(); const Y = randomUUID();

describeIfDb('W2-28 round 10', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); clearSystemAccountCache(CO);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
    await ins(B2, '1112', 'asset', 'bank', false);
    await ins(Y, '1116', 'asset', null, false);
  });
  afterAll(fx.teardown);

  it.each([
    ['a name edit (chart PUT)', () => fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, accountName: 'renamed' })],
    ['a name edit (detail PUT)', () => fx.call(coaDetail, 'PUT', '/api/accounting/chart-of-accounts-detail', { id: X, accountName: 'renamed' })],
    ['a code change (detail PATCH)', () => fx.call(coaDetail, 'PATCH', '/api/accounting/chart-of-accounts-detail', { id: X, accountCode: '1119' })],
    ['a deactivation (detail DELETE)', () => fx.call(coaDetail, 'DELETE', '/api/accounting/chart-of-accounts-detail', { id: X })],
    ['a parent change (chart PUT)', () => fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, parentAccountId: Y })],
  ])('%s that finds its row held by a slow request answers 503 in about 5s, and the role lock is free again for a save', async (_what, write) => {
    const holder = await fx.connect();              // a slow request that coded a document line to X: FOR SHARE until it ends
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR SHARE', [X]);
      const t0 = Date.now();
      const answered = await within(9000, write().then((r) => r.statusCode));
      const waitedMs = Date.now() - t0;
      // With the writer gone the role lock is free: another role writer of the company is not held up.
      const save = await within(3000, fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts',
        { mappings: { primary_bank: Y }, loaded: { primary_bank: BANK } }).then((r) => r.statusCode));
      expect({ answered, boundedNear5s: waitedMs >= 4500 && waitedMs < 8000, save, bank: await holders('bank') })
        .toEqual({ answered: 503, boundedNear5s: true, save: 200, bank: ['1116'] });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    const row = (await fx.query('SELECT account_code, account_name, is_active, parent_account_id FROM gl_accounts WHERE id = $1', [X])).rows[0];
    expect(row).toEqual({ account_code: '1115', account_name: 'W228R10 1115', is_active: true, parent_account_id: null });
  }, 30_000);

  it('creating an account under a parent whose row is held answers 503 in about 5s (the INSERT\'s key-share on the parent)', async () => {
    const holder = await fx.connect();              // e.g. a request holding the parent FOR UPDATE
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR UPDATE', [X]);
      const t0 = Date.now();
      const answered = await within(9000, fx.call(coa, 'POST', '/api/accounting/chart-of-accounts',
        { accountCode: '1118', accountName: 'Sub', accountType: 'asset', normalBalance: 'debit', parentAccountId: X }).then((r) => r.statusCode));
      expect({ answered, boundedNear5s: Date.now() - t0 >= 4500 }).toEqual({ answered: 503, boundedNear5s: true });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  }, 30_000);

  it('a bank-accounts PUT that finds its row held answers 503 in about 5s (a field edit and a grouping)', async () => {
    const holder = await fx.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR SHARE', [B2]);
      const t0 = Date.now();
      const answers = await within(9000, Promise.all([
        fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: B2, bankName: 'Nedbank' }),
      ]).then((a) => a.map((r) => r.statusCode)));
      await sleep(10);
      expect({ answers, boundedNear5s: Date.now() - t0 >= 4500 }).toEqual({ answers: [503], boundedNear5s: true });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  }, 30_000);

  it.each([
    ['the CoA import', async () => {
      const session = await createSession(CO, 'sage', USER);
      return () => fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts',
        { sessionId: session.id, accounts: [{ accountCode: '1115', accountName: 're-import', accountType: 'asset', normalBalance: 'debit' }], systemAccountMap: {} });
    }],
    ['the migration execute', async () => {
      await fx.query("UPDATE gl_accounts SET imported_from = 'xero' WHERE id = $1", [X]);
      return () => fx.call(migrationExecute, 'POST', '/api/accounting/migration-execute', { source: 'xero', customers: [], suppliers: [],
        accounts: [{ sourceCode: '1115', sourceName: 're-import', sourceType: 'BANK', openingBalance: 0, mappedType: 'asset', mappedNormalBalance: 'debit' }] });
    }],
    ['the migration rollback', async () => {
      await fx.query("UPDATE gl_accounts SET imported_from = 'xero' WHERE id = $1", [X]);
      return () => fx.call(migrationRollback, 'POST', '/api/accounting/migration-rollback', { source: 'xero' });
    }],
    ['the template seed', async () => {
      await fx.query("UPDATE gl_accounts SET account_code = '1130' WHERE id = $1", [X]);   // a template row with a parent: pass 2 updates it
      return () => fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' });
    }],
  ])('%s that finds a row held by a slow request answers 503 in about 5s instead of holding the role lock for as long as it runs', async (_what, arrange) => {
    const write = await arrange();                  // set the chart up BEFORE the row is held
    const holder = await fx.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR SHARE', [X]);
      const t0 = Date.now();
      const answered = await within(9000, write().then((r) => r.statusCode));
      expect({ answered, boundedNear5s: Date.now() - t0 >= 4500 }).toEqual({ answered: 503, boundedNear5s: true });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect((await fx.query('SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1', [CO])).rows[0].n).toBe(4);
  }, 30_000);

  it('a CoA import row whose fields are not text is refused 400 before any work', async () => {
    const session = await createSession(CO, 'sage', USER);
    const good = { accountCode: '1800', accountName: 'x', accountType: 'asset', normalBalance: 'debit' };
    const bad: Record<string, unknown>[] = [
      { ...good, accountType: ['asset'] }, { ...good, accountCode: 1800 }, { ...good, parentCode: 1500 },
      { ...good, accountName: { x: 1 } }, { ...good, accountSubtype: ['bank'] },
    ];
    const statuses = [];
    for (const row of bad) {
      statuses.push((await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts',
        { sessionId: session.id, accounts: [good, row], systemAccountMap: { bank: '1800' } })).statusCode);
    }
    const codes = (await fx.query('SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1', [CO])).rows[0].n;
    expect({ statuses, accounts: codes, bank: await holders('bank') }).toEqual({ statuses: [400, 400, 400, 400, 400], accounts: 4, bank: ['1110'] });
  });
});

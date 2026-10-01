// W2-28 round 11 (blind review of 38978241e): a reactivation passes the role's
// target rule; a role holder may have sub-accounts when it is an income-statement
// account, never when it is a balance-sheet one (Hein, 2026-10-01); the rollback's
// NULL flag; set_opening_balance takes the role lock before it posts; a holder
// renamed by a re-import is not served stale; the import's own header wording.
// Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { brkFixture, sleep, within } from './w2-28-brk593.helpers';
import { drainAfterCommit } from '@/lib/afterCommit';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { setOpeningBalanceTool } from '../../src/lib/mcp/tools/writeOpeningBalance';
import coa from '../../pages/api/accounting/chart-of-accounts';
import coaDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import migrationExecute from '../../pages/api/accounting/migration-execute';
import migrationRollback from '../../pages/api/accounting/migration-rollback';
import { clearSystemAccountCache, getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { mergeAccounts } from '@/modules/accounting/services/gl/accountMergeService';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = brkFixture('W228R11');
const { CO, USER, ins, holders } = fx;
const [BANK, AR, AP, REV, EXP, X, OLD, KID] = Array.from({ length: 8 }, () => randomUUID());
const put = (body: Record<string, unknown>) => fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', body);
const bankPut = (body: Record<string, unknown>) => fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', body);
const create = (code: string, type: string, sub: string | null, parent: string) => fx.call(coa, 'POST', '/api/accounting/chart-of-accounts',
  { accountCode: code, accountName: `child ${code}`, accountType: type, ...(sub ? { accountSubtype: sub } : {}),
    normalBalance: ['asset', 'expense'].includes(type) ? 'debit' : 'credit', parentAccountId: parent });
const message = (r: { body: Record<string, unknown> }) => String((r.body.error as { message?: string } | undefined)?.message ?? '');
const parentOf = async (code: string) => (await fx.query(`SELECT (SELECT p.account_code FROM gl_accounts p WHERE p.id = a.parent_account_id) AS parent
  FROM gl_accounts a WHERE company_id = $1 AND account_code = $2`, [CO, code])).rows[0]?.parent ?? null;
const resolve = (key: string) => getSystemAccount(key as never, CO).then((a) => a.accountCode, (e: Error) => e.name);
const importRows = async (accounts: Record<string, unknown>[], systemAccountMap: Record<string, string> = {}) => {
  const session = await createSession(CO, 'sage', USER);
  const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts, systemAccountMap });
  const data = r.body.data as { imported?: number; errors?: { message: string }[] } | undefined;
  return { status: r.statusCode, imported: data?.imported, errors: (data?.errors ?? []).map((e) => e.message) };
};

describeIfDb('W2-28 round 11', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); clearSystemAccountCache(CO);
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(AP, '2110', 'liability', 'payable', true);
    await ins(REV, '4100', 'revenue', 'default_revenue', true);
    await ins(EXP, '5100', 'expense', 'default_expense', true);
    await ins(X, '4150', 'revenue', 'revenue', false);
  });
  afterAll(fx.teardown);

  describe('item 8: reactivating a former holder into an empty role', () => {
    it('a former bank holder that has a sub-account is refused by the chart PUT and by the bank-accounts PUT; the role stays empty', async () => {
      await ins(OLD, '1110', 'asset', 'bank', true, { active: false });
      await ins(KID, '1111', 'asset', 'bank', false, { parent: OLD });
      const chart = await put({ id: OLD, isActive: true });
      const bank = await bankPut({ id: OLD, isActive: true });
      expect({ chart: chart.statusCode, bank: bank.statusCode, text: message(chart), sameText: message(bank) === message(chart), holders: await holders('bank') })
        .toEqual({ chart: 400, bank: 400, text: expect.stringMatching(/1110 has sub-accounts/), sameText: true, holders: [] });
    });

    it('a former holder of a type its role does not allow is refused (expense carrying receivable; liability carrying bank)', async () => {
      await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [AR]);
      await ins(OLD, '6190', 'expense', 'receivable', true, { active: false });
      await ins(KID, '2190', 'liability', 'bank', true, { active: false });
      const chart = await put({ id: OLD, isActive: true });
      const bank = await bankPut({ id: KID, isActive: true });
      expect({ chart: chart.statusCode, text: message(chart), bank: bank.statusCode, bankText: message(bank),
        receivable: await holders('receivable'), bankRole: await holders('bank') })
        .toEqual({ chart: 400, text: expect.stringMatching(/must be of type 'asset' \(got 'expense'\)/), bank: 400,
          bankText: expect.stringMatching(/must be of type 'asset' \(got 'liability'\)/), receivable: [], bankRole: [] });
    });

    it('a former holder that passes the rule is reactivated — also an income-statement one that has sub-accounts', async () => {
      await ins(OLD, '1110', 'asset', 'bank', true, { active: false });
      await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [REV]);
      await ins(KID, '4101', 'revenue', 'revenue', false, { parent: REV });
      const viaBank = await bankPut({ id: OLD, isActive: true });
      const revenue = await put({ id: REV, isActive: true });
      expect({ viaBank: viaBank.statusCode, revenue: revenue.statusCode, bank: await holders('bank'), rev: await holders('default_revenue') })
        .toEqual({ viaBank: 200, revenue: 200, bank: ['1110'], rev: ['4100'] });
    });
  });

  describe('item 9: sub-accounts under a role holder', () => {
    beforeEach(() => ins(BANK, '1110', 'asset', 'bank', true));

    it('are allowed under an income-statement holder (4100, 5100): created, moved, imported, merged — and the role still resolves to the holder', async () => {
      const made = [await create('4101', 'revenue', 'revenue', REV), await create('5101', 'expense', 'cost_of_sales', EXP)];
      const moved = await put({ id: X, parentAccountId: REV });
      const imported = await importRows([{ accountCode: '4105', accountName: 'Imported child', accountType: 'revenue', accountSubtype: 'revenue', normalBalance: 'credit', parentCode: '4100' }]);
      // A re-import that names the holder for the role it already holds, with a child under it in the same file.
      const reimported = await importRows([
        { accountCode: '4100', accountName: 'Sales', accountType: 'revenue', normalBalance: 'credit' },
        { accountCode: '4106', accountName: 'Sales - services', accountType: 'revenue', accountSubtype: 'revenue', normalBalance: 'credit', parentCode: '4100' },
      ], { default_revenue: '4100' });
      // A merge whose source has a child: the child moves under the target, here the revenue holder.
      await ins(OLD, '4160', 'revenue', 'revenue', false);
      await ins(KID, '4161', 'revenue', 'revenue', false, { parent: OLD });
      const tx = await fx.openTx(drainAfterCommit);
      const merged = await tx.run(() => mergeAccounts(CO, OLD, REV, USER)).then(() => 'merged', (e: Error) => e.message);
      await tx.commit();
      // A later writer is not failed because 4100 has sub-accounts.
      const later = await fx.call(coaDetail, 'DELETE', '/api/accounting/chart-of-accounts-detail', { id: X });
      expect({ made: made.map((r) => r.statusCode), moved: moved.statusCode, imported, reimported, merged, later: later.statusCode,
        parents: [await parentOf('4101'), await parentOf('5101'), await parentOf('4150'), await parentOf('4105'), await parentOf('4106'), await parentOf('4161')],
        revenue: await resolve('default_revenue'), expense: await resolve('default_expense') })
        .toEqual({ made: [200, 200], moved: 200, imported: { status: 200, imported: 1, errors: [] },
          reimported: { status: 200, imported: 2, errors: expect.any(Array) }, merged: 'merged', later: 200,
          parents: ['4100', '5100', '4100', '4100', '4100', '4100'], revenue: '4100', expense: '5100' });
    });

    it.each([
      ['the bank holder', BANK, '1110', 'bank', 'asset', '1119'],
      ['the receivable holder', AR, '1120', 'receivable', 'asset', '1129'],
      ['the payable holder', AP, '2110', 'payable', 'liability', '2119'],
    ])('are refused under %s (a balance-sheet role), and the refusal says why', async (_what, holder, code, role, type, childCode) => {
      const made = await create(childCode, type, null, holder);
      await ins(OLD, type === 'asset' ? '1190' : '2190', type, null, false);
      const moved = await put({ id: OLD, parentAccountId: holder });
      const imported = await importRows([{ accountCode: childCode, accountName: 'Imported child', accountType: type, normalBalance: type === 'asset' ? 'debit' : 'credit', parentCode: code }]);
      expect({ made: made.statusCode, text: message(made), moved: moved.statusCode, imported: imported.imported,
        children: (await fx.query('SELECT count(*)::int AS n FROM gl_accounts WHERE parent_account_id = $1', [holder])).rows[0].n, holder: await holders(role) })
        .toEqual({ made: 400, text: expect.stringMatching(new RegExp(`${code} holds the ${role} role.*balance-sheet`)), moved: 400, imported: 0, children: 0, holder: [code] });
    });
  });

  it('item 11: a rollback deletes an imported account whose system flag is NULL, as it does one whose flag is false', async () => {
    await ins(OLD, 'R100', 'asset', null, false, { importedFrom: 'xero' });
    await ins(KID, 'R200', 'asset', null, false, { importedFrom: 'xero' });
    await fx.query('UPDATE gl_accounts SET is_system_account = NULL WHERE id = $1', [OLD]);
    const r = await fx.call(migrationRollback, 'POST', '/api/accounting/migration-rollback', { source: 'xero' });
    const left = (await fx.query("SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_code IN ('R100', 'R200')", [CO])).rows;
    expect({ status: r.statusCode, data: r.body.data, left }).toEqual({ status: 200, data: expect.objectContaining({ deleted: 2, retained: 0 }), left: [] });
  });

  it('item 12: set_opening_balance with an explicit contra takes the role lock BEFORE it posts (no row of the chart is locked while it waits)', async () => {
    await ins(BANK, '1110', 'asset', 'bank', true);
    await fx.query('DELETE FROM fiscal_periods WHERE company_id = $1', [CO]);
    await fx.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, 'FY26 r11', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [CO]);
    await ins(OLD, '3900', 'equity', null, false);
    const registry = new McpRegistry();
    registry.register(setOpeningBalanceTool);
    const roleLock = await fx.connect(); const probe = await fx.connect();
    const tx = await fx.openTx(drainAfterCommit);
    try {
      await roleLock.query('BEGIN');
      await roleLock.query("SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))", [`default-accounts:${CO}`]);
      const calling = tx.run(() => registry.call('set_opening_balance',
        { bank_account_id: BANK, contra_account_id: OLD, as_at: '2026-03-01', amount: 100, idempotency_key: randomUUID() },
        { userId: USER, companyId: CO, scopes: ['write:journals', 'write:post', 'write:accounts'], tokenJti: 'w228r11', oauthAppId: null } as never))
        .then((r) => JSON.stringify(r), (e: Error & { code?: string }) => `thrown ${e.code}`);
      let waiting = false;
      for (let i = 0; i < 80 && !waiting; i++) {
        waiting = (await fx.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%pg_advisory_xact_lock%'")).rows[0].n > 0;
        if (!waiting) await sleep(50);
      }
      // A merge (role lock, then FOR UPDATE on its rows) is what would wait here: with the journal already
      // posted the tool holds a key-share on the bank row, and the two wait on each other.
      const bankRow = await probe.query('BEGIN').then(() => probe.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR UPDATE NOWAIT', [BANK]))
        .then(() => 'free', (e: { code?: string }) => `held (${e.code})`);
      await probe.query('ROLLBACK');
      expect({ waiting, bankRow, outcome: await within(8000, calling) })
        .toEqual({ waiting: true, bankRow: 'free', outcome: expect.stringContaining('retry in a moment') });
    } finally {
      await tx.rollback(); await roleLock.query('ROLLBACK'); roleLock.release(); probe.release();
      await fx.query('DELETE FROM fiscal_periods WHERE company_id = $1', [CO]);
    }
  }, 30_000);

  it('item 13: a holder renamed by a migration re-import is not served from the resolver cache afterwards', async () => {
    await ins(BANK, '1110', 'asset', 'bank', true, { importedFrom: 'xero' });
    const before = (await getSystemAccount('bank', CO)).accountName;
    const r = await fx.call(migrationExecute, 'POST', '/api/accounting/migration-execute', { source: 'xero', customers: [], suppliers: [],
      accounts: [{ sourceCode: '1110', sourceName: 'Renamed by re-import', sourceType: 'BANK', openingBalance: 0, mappedType: 'asset', mappedNormalBalance: 'debit' }] });
    expect({ status: r.statusCode, before, after: (await getSystemAccount('bank', CO)).accountName })
      .toEqual({ status: 200, before: 'W228R11 1110', after: 'Renamed by re-import' });
  });

  it('item 14: an import that maps a role onto a code the chart already uses for a header gets advice that applies to an import', async () => {
    await ins(OLD, '1000', 'asset', null, false, { level: 1 });
    await ins(BANK, '1110', 'asset', 'bank', true, { parent: OLD });
    const out = await importRows([{ accountCode: '1000', accountName: 'Bank', accountType: 'asset', normalBalance: 'debit' }], { bank: '1000' });
    expect(out).toEqual({ status: 200, imported: 0, errors: [expect.stringMatching(/1000 is a header with sub-accounts.*renumber/)] });
    expect(out.errors.join(' ')).not.toMatch(/choose one of its sub-accounts/);
  });
});

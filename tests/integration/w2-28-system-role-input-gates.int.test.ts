// W2-28 round 6 (security review): body values that slipped past the role
// guards by not being booleans, the seed route's missing write gate, the
// resolver cache inside a request that rolls back, what a save may store, and
// unexpected errors answered as a committing 400. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { roleWriterFixture, sleep } from './w2-28-role-writers.helpers';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import chartOfAccounts from '../../pages/api/accounting/chart-of-accounts';
import chartOfAccountsDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import coaSeed from '../../pages/api/accounting/coa-seed';
import { getSystemAccount, clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { updateAccount } from '../../src/modules/accounting/services/gl/chartOfAccountsService';
import { ensureOpeningBalanceEquityAccount } from '../../src/modules/accounting/services/gl/openingBalanceEquityService';
import { lockSystemRoleWrites } from '../../src/modules/accounting/services/gl/systemRoleWriteLock';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = roleWriterFixture('W228R6');
const { CO, ins, holders } = fx;
const BANK = randomUUID(); const OLD = randomUUID(); const X = randomUUID();
const DETAIL = '/api/accounting/chart-of-accounts-detail'; const CHART = '/api/accounting/chart-of-accounts';
const active = async () => (await fx.query(
  'SELECT account_code FROM gl_accounts WHERE company_id = $1 AND is_active ORDER BY 1', [CO])).rows.map((r) => String(r.account_code));

describeIfDb('W2-28 input gates on the role writers', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); clearSystemAccountCache(CO);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(OLD, '1105', 'asset', 'bank', true);                   // a former primary bank, deactivated
    await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [OLD]);
    await ins(X, '1115', 'asset', null, false);
  });
  afterAll(fx.teardown);

  it.each([['"true"', 'true'], ['1', 1], ['"false"', 'false'], ['0', 0], ['null', null], ['[]', []], ['{}', {}], ['[true]', [true]]])(
    'isActive: %s is refused 400 by both chart routes and the service: no holder is reactivated or switched off', async (_label, value) => {
      const target = value === 'true' || value === 1 ? OLD : BANK;   // a truthy value would reactivate, a falsy one deactivate
      const answers = [
        await fx.call(chartOfAccountsDetail, 'PUT', DETAIL, { id: target, isActive: value }),
        await fx.call(chartOfAccounts, 'PUT', CHART, { id: target, isActive: value }),
      ].map((a) => a.statusCode);
      const tx = await fx.openTx();
      const service = await tx.run(() => updateAccount(CO, target, { isActive: value as never })).then(() => 'written', (e: Error) => e.message);
      await tx.commit();
      expect({ answers, service, bank: await holders('bank'), active: await active() })
        .toEqual({ answers: [400, 400], service: expect.stringContaining('isActive must be true or false'), bank: ['1110'], active: ['1110', '1115'] });
    });

  it('a wrongly typed body is refused by the ROUTE, before the service does anything (400, not a 500 after a partial write)', async () => {
    const answers = [
      await fx.call(chartOfAccountsDetail, 'PUT', DETAIL, { id: X, displayOrder: 'first' }),
      // Without the route check the reclassification below is written, then updateAccount refuses: 500.
      await fx.call(chartOfAccounts, 'PUT', CHART, { id: X, accountSubtype: 'other', isActive: 'false' }),
      await fx.call(chartOfAccounts, 'PUT', CHART, { id: X, defaultVatCode: 'luxury' }),
    ].map((a) => a.statusCode);
    expect(answers).toEqual([400, 400, 400]);
  });

  it('an id that is not a string is refused 400 by both chart routes', async () => {
    const answers = [
      await fx.call(chartOfAccountsDetail, 'PUT', DETAIL, { id: [BANK], isActive: false }),
      await fx.call(chartOfAccountsDetail, 'DELETE', DETAIL, { id: [BANK] }),
      await fx.call(chartOfAccounts, 'PUT', CHART, { id: [BANK], isActive: false }),
    ].map((a) => a.statusCode);
    expect({ answers, bank: await holders('bank') }).toEqual({ answers: [400, 400, 400], bank: ['1110'] });
  });

  it('a viewer cannot seed a chart: 403 at once, without waiting for (or taking) the role lock', async () => {
    const tx = await fx.openTx();
    try {
      await tx.run(() => lockSystemRoleWrites(CO));                   // anyone taking the lock would wait 5s and answer 503
      const answered = await Promise.race([
        fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' }, 'viewer').then((s) => s.statusCode),
        sleep(2000).then(() => 'waiting on the lock'),
      ]);
      expect(answered).toBe(403);
    } finally { await tx.rollback(); }
    expect(await active()).toEqual(['1110', '1115']);
    const admin = await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' });
    expect({ admin: admin.statusCode, seeded: (await active()).length > 20 }).toEqual({ admin: 200, seeded: true });
  }, 20_000);

  it('a resolve inside a request that changed a role and then rolls back caches nothing', async () => {
    const tx = await fx.openTx();
    const inRequest = await tx.run(async () => {
      await ensureOpeningBalanceEquityAccount(CO);                     // creates 3300, queues the after-commit clear
      return (await getSystemAccount('opening_balance_equity', CO)).accountCode;
    });
    await tx.rollback();
    const after = await getSystemAccount('opening_balance_equity', CO).then((a) => a.accountCode, (e: Error) => e.name);
    expect({ inRequest, after }).toEqual({ inRequest: '3300', after: 'MissingSystemAccountError' });
  });

  it('a save stores only the page\'s own keys, each an account id or nothing: anything else is 400 and nothing is written', async () => {
    const save = (mappings: Record<string, unknown>) => fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings });
    const refused = [
      await save({ petty_cash: X, junk: 'x'.repeat(5000) }),
      await save({ petty_cash: { nested: true } }),
      await save({ rounding: 7 }),
      await save({ constructor: X }),
    ].map((a) => a.statusCode);
    const stored = async () => {
      const value = (await fx.query(
        "SELECT value FROM app_settings WHERE company_id = $1 AND key = 'accounting_default_accounts'", [CO])).rows[0]?.value ?? null;
      return typeof value === 'string' ? JSON.parse(value) : value;
    };
    expect({ refused, stored: await stored() }).toEqual({ refused: [400, 400, 400, 400], stored: null });
    expect((await save({ petty_cash: X, rounding: '', sales_discount: null })).statusCode).toBe(200);
    expect(await stored()).toEqual({ petty_cash: X, rounding: '', sales_discount: null });
  });

  it('an unexpected database error is a 500 (rolled back), not a 400 that commits', async () => {
    // Round 9: a malformed id is now refused 400 by the routes before any lock, so the driver error is
    // provoked with a name longer than account_name's varchar(100) instead. The DELETE catch's re-throw
    // is pinned by the role-lock-timeout 503 case in w2-28-system-role-writers-lock.int.test.ts.
    const tooLong = 'x'.repeat(101);
    const answers = [
      await fx.call(chartOfAccountsDetail, 'PUT', DETAIL, { id: X, accountName: tooLong }),
      await fx.call(chartOfAccounts, 'PUT', CHART, { id: X, accountName: tooLong }),
      await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: BANK, bankOpeningBalanceDate: 'not-a-date' }),
    ].map((a) => a.statusCode);
    expect(answers).toEqual([500, 500, 500]);
    // A service refusal is still a 400.
    expect((await fx.call(chartOfAccountsDetail, 'PUT', DETAIL, { id: BANK, isActive: false })).statusCode).toBe(400);
  });
});

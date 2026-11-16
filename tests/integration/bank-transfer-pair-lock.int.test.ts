/**
 * WP2 row 6: both legs of ONE bank-to-bank movement, allocated as transfers at the same time, posted two journals —
 * each leg's duplicate check read before the other committed. Writers of one account pair now queue on an advisory
 * lock (transferPairLock). The overlap is forced: a sleeping BEFORE INSERT trigger on the journal holds the first
 * writer inside its transaction (pair lock held, journal not committed) while the second starts.
 *
 * What the code does with the second leg: refused as a duplicate (DuplicateTransferError, "match the existing journal"),
 * its line left `imported`. The first leg's counterparty auto-link skips it (that line is held by its own request).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let c: DateFixture;
let token = '';
let bank2 = '';
let marker = '';

const line = async (account: string, amount: number, date: string) => String(((await sql`
  INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, import_batch_id, status)
  VALUES (${c.fx.companyId}::UUID, ${account}::UUID, ${date}::DATE, ${amount}, 'BTPL line', gen_random_uuid(), 'imported')
  RETURNING id`) as Row[])[0]!.id);
const transferJournals = async () => Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
  WHERE company_id = ${c.fx.companyId}::UUID AND source = 'auto_bank_transfer' AND status = 'posted'`) as Row[])[0]!.n);
const statusOf = async (id: string) => String(((await sql`SELECT status FROM bank_transactions WHERE id = ${id}::UUID`) as Row[])[0]!.status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Deadlocks this database has broken so far (pg_stat_database): a delta of 0 proves no 40P01 was ever raised. */
const deadlocks = async () => Number(((await sql`SELECT deadlocks FROM pg_stat_database
  WHERE datname = current_database()`) as Row[])[0]!.deadlocks);

/** Waits (bounded) until the first writer is asleep in the journal trigger; fails loudly if it never is. */
async function firstWriterAsleep(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = (await sql`SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND datname = current_database()
      AND application_name = ${marker} AND pid <> pg_backend_pid()`) as Row[];
    if (r.length > 0) return;
    await sleep(25);
  }
  throw new Error('the first writer never reached the sleeping journal trigger');
}

describeIfDb('bank-to-bank transfer: one journal per movement under concurrency', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('BTPL', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'btpl');
    bank2 = String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
      normal_balance, is_active) VALUES (${c.fx.companyId}::UUID, '1010', 'BTPL Savings', 'asset', 'bank', 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
    marker = `btpl_sleeper_${c.fx.companyId}`;
    await c.fx.pool.query(`CREATE FUNCTION btpl_sleep() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE prior text := current_setting('application_name');
      BEGIN
        IF NEW.company_id = '${c.fx.companyId}' AND NEW.description IN ('BTPL first', 'BTPL typed') THEN
          PERFORM set_config('application_name', '${marker}', false); PERFORM pg_sleep(2);
          PERFORM set_config('application_name', prior, false);
        END IF;
        RETURN NEW;
      END $$`);
    await c.fx.pool.query(`CREATE TRIGGER btpl_sleep_trg BEFORE INSERT ON gl_journal_entries
      FOR EACH ROW EXECUTE FUNCTION btpl_sleep()`);
  }, 60000);

  afterAll(async () => {
    try {
      await c.fx.pool.query('DROP TRIGGER IF EXISTS btpl_sleep_trg ON gl_journal_entries');
      await c.fx.pool.query('DROP FUNCTION IF EXISTS btpl_sleep()');
      await dropRouteUser(c.fx);
    } finally {
      await dropFixture(c.fx);
    }
  }, 60000);

  it('both legs allocated together: ONE journal; the second leg is refused as a duplicate and stays imported', async () => {
    const legA = await line(c.fx.bankAccountId, -321, '2025-04-10');
    const legB = await line(bank2, 321, '2025-04-10');
    const before = await transferJournals();
    const dl0 = await deadlocks();
    const first = inTx(c.fx, () => allocateTransaction(c.fx.companyId, legA, bank2, c.fx.userId, 'BTPL first', 'transfer'));
    const firstOutcome = first.then(() => 'ok', (e: Error) => e.message);
    await firstWriterAsleep();
    const second = inTx(c.fx, () => allocateTransaction(c.fx.companyId, legB, c.fx.bankAccountId, c.fx.userId, 'BTPL second', 'transfer'));
    const secondOutcome = await second.then(() => 'ok', (e: Error) => e.message);
    expect(await firstOutcome).toBe('ok');
    expect(secondOutcome).toMatch(/A matching transfer already exists/);
    // Not a deadlock the detector broke: the auto-link's NOWAIT skipped the held line instead of waiting on it.
    expect(await deadlocks() - dl0).toBe(0);
    expect(await transferJournals()).toBe(before + 1);
    expect(await statusOf(legA)).toBe('allocated');
    expect(await statusOf(legB)).toBe('imported');
  }, 60000);

  // The first leg's auto-link must SKIP the held counterparty line (55P03 from NOWAIT), not wait on it: a wait is a
  // deadlock (40P01) that the detector breaks a second later, which the outcome above cannot tell apart.
  it('the first leg\'s auto-link is skipped on a 55P03, never a deadlock', async () => {
    const warn = vi.spyOn(log, 'warn');
    try {
      const legA = await line(c.fx.bankAccountId, -654, '2025-06-10');
      const legB = await line(bank2, 654, '2025-06-10');
      const first = inTx(c.fx, () => allocateTransaction(c.fx.companyId, legA, bank2, c.fx.userId, 'BTPL first', 'transfer'));
      const firstOutcome = first.then(() => 'ok', (e: Error) => e.message);
      const dl0 = await deadlocks();
      await firstWriterAsleep();
      await inTx(c.fx, () => allocateTransaction(c.fx.companyId, legB, c.fx.bankAccountId, c.fx.userId, 'BTPL second', 'transfer'))
        .then(() => null, () => null);
      expect(await firstOutcome).toBe('ok');
      expect(await deadlocks() - dl0).toBe(0);
      const links = warn.mock.calls.filter((call) => String(call[0]).startsWith('Failed to auto-link counterparty transfer'));
      expect(links.map((call) => (call[1] as { error?: { code?: string } }).error?.code)).toEqual(['55P03']);
    } finally {
      warn.mockRestore();
    }
  }, 60000);

  it('a transfer typed on the Transfers page and a statement leg allocated together: ONE journal', async () => {
    const leg = await line(c.fx.bankAccountId, -432, '2025-05-10');
    const before = await transferJournals();
    const typed = callRoute(c.fx, token, bankTransfers, {
      fromAccountId: c.fx.bankAccountId, toAccountId: bank2, amount: 432, transferDate: '2025-05-10', reference: 'BTPL typed' });
    await firstWriterAsleep();
    const statement = inTx(c.fx, () => allocateTransaction(c.fx.companyId, leg, bank2, c.fx.userId, 'BTPL stmt', 'transfer'));
    const stmtOutcome = await statement.then(() => 'ok', (e: Error) => e.message);
    const typedOut = await typed;
    expect(typedOut.statusCode, JSON.stringify(typedOut.body)).toBe(200);
    expect(stmtOutcome).toMatch(/A matching transfer already exists/);
    expect(await transferJournals()).toBe(before + 1);
    expect(await statusOf(leg)).toBe('imported');
  }, 60000);
});

/**
 * DOCNUM: a receipt numbered before its journal, racing a journal numbered before its receipt, does not deadlock.
 *
 * The two orders are the app's own:
 *   - gateway receipt (`recordGatewayInvoiceReceipt`) and MCP contra: INSERT customer_payments / supplier_payments,
 *     then `confirmCustomerPayment` / `processSupplierPayment` numbers the journal;
 *   - bank allocation (`allocateTransaction`): `createJournalEntry` numbers the journal, then INSERT the receipt
 *     (`bankAllocationService`) or the supplier payment (`recordSupplierBankPayment`).
 * With a numbering lock per document type (858001..) beside the journal's (857) the pair deadlocked — the second
 * order holds the journal lock and wants the payment lock, the first the reverse — and Postgres killed one with
 * 40P01. Migration 858 gives these documents the journal's own key, so the second transaction queues instead.
 *
 * Each statement here is the raw INSERT those services issue, so the trigger is what is tested; the order is the
 * services' order. The database's deadlock counter (`pg_stat_database.deadlocks`) is read before and after. It is
 * database-wide: a run of a deliberate-deadlock test (d11-*) against the same fixture database at the same moment
 * would move it too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import {
  CASES, blockedBeforeSettling, dropScope, errText, insertDoc, insertJournal, nextNumber, pidOf, seedScope, settle,
  type Scope,
} from './helpers/docnumFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const YEAR = 2032;

let admin: Client, gateway: Client, bank: Client;
let gatewayPid = 0, bankPid = 0;
let scope: Scope | undefined;

async function deadlocks(): Promise<number> {
  await admin.query('SELECT pg_stat_clear_snapshot()');
  return Number((await admin.query(
    'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
}

/** Flushes both backends' pending statistics (a deadlock victim's count included) so `deadlocks()` can see them. */
async function flushStats(): Promise<void> {
  for (const c of [gateway, bank]) await c.query('SELECT pg_stat_force_next_flush()');
  await new Promise((resolve) => { setTimeout(resolve, 500); });
}

describeIfDb('DOCNUM: payment-then-journal against journal-then-payment, one company + year', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    [admin, gateway, bank] = [0, 1, 2].map(() => new Client({ connectionString: DATABASE_URL }));
    for (const c of [admin, gateway, bank]) await c.connect();
    gatewayPid = await pidOf(gateway);
    bankPid = await pidOf(bank);
    scope = await seedScope(admin, 'DOCNUM-ORDER');
  }, 60000);

  afterAll(async () => {
    try {
      if (scope) await dropScope(admin, scope);
    } finally {
      for (const c of [admin, gateway, bank]) await c?.end();
    }
  }, 60000);

  const shapes = CASES.filter((k) => ['customer_payments', 'supplier_payments'].includes(k.table));

  it.each(shapes)('$table: both commit with distinct numbers, no deadlock', async (k) => {
    const before = await deadlocks();
    await gateway.query('BEGIN');
    try {
      const paidA = await insertDoc(gateway, k, scope!, YEAR);
      const pBank = settle((async () => {
        await bank.query('BEGIN');
        try {
          const je = await insertJournal(bank, scope!, YEAR);
          const paid = await insertDoc(bank, k, scope!, YEAR);
          await bank.query('COMMIT');
          return `${je} ${paid}`;
        } catch (err) {
          await bank.query('ROLLBACK');
          throw err;
        }
      })());
      await blockedBeforeSettling(admin, gatewayPid, bankPid, pBank);
      const jeA = await settle(insertJournal(gateway, scope!, YEAR));
      await gateway.query(jeA.ok ? 'COMMIT' : 'ROLLBACK');
      const outB = await pBank;
      await flushStats();

      expect(jeA.ok, jeA.ok ? '' : `gateway-shape journal failed: ${errText(jeA.error)}`).toBe(true);
      expect(outB.ok, outB.ok ? '' : `bank-shape transaction failed: ${errText(outB.error)}`).toBe(true);
      const [jeB, paidB] = outB.ok ? outB.value.split(' ') : ['', ''];
      expect(paidB, `the bank-shape payment must not reuse ${paidA}`).toBe(nextNumber(paidA));
      expect(jeB).not.toBe(jeA.ok ? jeA.value : '');
      expect(await deadlocks() - before, 'pg_stat_database.deadlocks must not move').toBe(0);
    } finally {
      await gateway.query('ROLLBACK');
    }
  }, 60000);
});

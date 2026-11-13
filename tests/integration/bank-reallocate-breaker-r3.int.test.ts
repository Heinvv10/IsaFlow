/**
 * Breaker round 3 (d57a5d5197): the recorded journal-number cycle (R2-4) when the REALLOCATION wins and a real
 * bulk_allocate_bank_transactions call is the deadlock victim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { McpRegistry } from '@/lib/mcp/registry';
import { bulkAllocateBankTransactionsTool } from '@/lib/mcp/tools/writeBankBulkAllocate';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { settle, sleep, teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import {
  TOOL, apControlAndSubledger, lineRow, mcp, newBank, newSupplier, postedBill, reconciledLine, setupCompany, trialBalanceGap,
} from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;
const reg = new McpRegistry();
reg.register(bulkAllocateBankTransactionsTool);

const runOnce = <T>(fn: () => Promise<T>) => inTx(c.fx, fn);
async function plainLine(amount: number, date: string): Promise<string> {
  const bank = await newBank(c);
  return String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, ${date}::DATE, ${amount}, ${`R3 ${++c.seq}`},
      'imported') RETURNING id`) as Row[])[0]!.id);
}

describe('reallocate breaker round 3', () => {
  beforeAll(async () => { c = await setupCompany('RABR3'); }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  it('R3-1: the reallocation wins the number-lock cycle; the bulk call that loses leaves nothing half-written', async () => {
    const sup = await newSupplier(c);
    const bill = await postedBill(c, sup, '2026-05-01', 300);
    const s = await reconciledLine(c, { amount: -300, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const l2 = await plainLine(-10, '2026-06-11');
    const l3 = await plainLine(-300, '2026-06-12');
    const cl = await c.fx.pool.connect();
    let bulk: Awaited<ReturnType<typeof settle>> | null = null;
    let committed = false;
    await cl.query('BEGIN');
    try {
      // Make THIS side the victim: it detects the cycle first.
      await cl.query("SET LOCAL deadlock_timeout = '20ms'");
      await runOn(c.fx, cl, () => allocateTransaction(c.fx.companyId, l2, c.acct.expense!, c.fx.userId, undefined, 'account'));
      const rP = mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { supplier_id: sup },
        dry_run: false, idempotency_key: randomUUID() });
      await sleep(600);
      bulk = await settle(runOn(c.fx, cl, () => reg.call('bulk_allocate_bank_transactions', {
        allocations: [{ transaction_id: l3, alloc_type: 'supplier', entity_id: sup }], idempotency_key: randomUUID(),
      }, { userId: c.fx.userId, companyId: c.fx.companyId, scopes: ['write:bank-tx', 'write:post'], companyRole: 'owner',
        tokenJti: null, oauthAppId: null })));
      const commit = await settle(cl.query('COMMIT'));
      committed = commit.ok;
      const r = await rP;
      console.error('R3 bulk', JSON.stringify(bulk).slice(0, 900));
      console.error('R3 realloc', r.isError, r.text.slice(0, 300));
      expect(r.isError, r.text).toBe(false);
    } finally {
      if (!committed) await cl.query('ROLLBACK').catch(() => undefined);
      cl.release();
    }
    const l2Row = await lineRow(l2);
    const l3Row = await lineRow(l3);
    const l3Journals = (await sql`SELECT COUNT(*)::int AS n FROM supplier_payments WHERE company_id = ${c.fx.companyId}::UUID
      AND supplier_id = ${sup}::UUID AND status <> 'cancelled'`) as Row[];
    const billRow = ((await sql`SELECT amount_paid::float8 AS p FROM supplier_invoices WHERE id = ${bill}::UUID`) as Row[])[0]!;
    console.error('R3 state', JSON.stringify({ committed, l2: l2Row.status, l3: l3Row.status, livePayments: l3Journals[0]!.n, billPaid: billRow.p }));
    // Either the losing request rolled back whole (l2 imported) or kept l2 and refused l3 cleanly; never a half line.
    expect(['imported', 'allocated']).toContain(l3Row.status);
    if (l3Row.status === 'imported') expect(l3Row.je).toBeNull();
    expect(Number(billRow.p)).toBeLessThanOrEqual(300);
    const ap = await apControlAndSubledger(c);
    expect(ap.control).toBe(ap.subledger);
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
    expect(bulk && (bulk as { ok: boolean }).ok, 'bulk reports, does not crash').toBe(true);
  }, 120000);

  it('R3-2: a supplier REFUND re-pointed to the same supplier (fifo, an open bill exists) writes nothing', async () => {
    const sup = await newSupplier(c);
    await postedBill(c, sup, '2026-05-01', 999);
    const pay = await plainLine(-600, '2026-05-02'); // on-account credit the refund draws on
    await runOnce(() => allocateTransaction(c.fx.companyId, pay, null, c.fx.userId, undefined, 'supplier', sup, 'none',
      undefined, undefined, undefined, undefined, { autoApply: 'none' }));
    const s = await reconciledLine(c, { amount: 600, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'supplier', entity: sup });
    const n0 = Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.n);
    const r = await mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { supplier_id: sup },
      dry_run: false, idempotency_key: randomUUID() });
    const n1 = Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.n);
    expect({ err: r.isError, nothing: r.body?.nothing_changed ?? false, journalsWritten: n1 - n0 }, r.text)
      .toEqual({ err: false, nothing: true, journalsWritten: 0 });
  }, 120000);
});

/**
 * D8 round 11 (review rev-d8-c553cc0f8, finding 2): the MCP void locked the ROOT journal's bank line, then the lines
 * matched to the rest of the reversal chain, in a second pass. HTTP void and receipt cancel lock the root's and the
 * head's lines in ONE ascending-id pass (`lockMatchedLines`). With a line L1 on the root and L2 on the head and
 * L2.id < L1.id the two took the pair in opposite orders: 40P01. Every flow now takes its bank lines through one
 * helper, in id order.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { runOn } from './helpers/l1FifoFixture';
import {
  buildChain, confirmedReceipt, postedBill, postedInvoice, processedPayment, setup, sleep, teardown, type Ctx,
} from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
type Outcome = { ok: boolean; value?: unknown; error?: string; code?: string };

/** A committed request transaction; `onPause` runs once, after the first query matching `pauseOn`. */
async function run(fn: () => Promise<unknown>, pauseOn?: (t: string) => boolean, onPause?: () => Promise<void>): Promise<Outcome> {
  const cl: PoolClient = await c.fx.pool.connect();
  const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
  let fired = false;
  (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const out = await orig(...a);
    const t = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '';
    if (pauseOn && onPause && !fired && pauseOn(t)) { fired = true; await onPause(); }
    return out;
  };
  await orig('BEGIN');
  try {
    const v = await runOn(c.fx, cl, fn);
    await orig('COMMIT');
    return { ok: true, value: v };
  } catch (err) {
    await orig('ROLLBACK').catch(() => undefined);
    return { ok: false, error: `${(err as Error).name}: ${(err as Error).message}`, code: (err as { code?: string }).code };
  } finally {
    (cl as unknown as { query: unknown }).query = orig;
    cl.release();
  }
}

/** A statement line with a chosen id, matched to journal `je`'s bank leg. */
async function lineOn(je: string, id: string, amount: number): Promise<string> {
  const [leg] = (await sql`SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${je}::UUID AND gl_account_id = ${c.fx.bankAccountId}::UUID`) as Row[];
  await sql`
    INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
    VALUES (${id}::UUID, ${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-05-20', ${amount}, ${`D8R11-L ${++c.seq}`},
            'matched', ${String(leg!.id)}::UUID)`;
  return id;
}

const isBankLineLock = (t: string) => /FROM bank_transactions[\s\S]*FOR UPDATE/.test(t);

describe.skipIf(!process.env.DATABASE_URL)('D8 round 11: every flow takes a chain\'s bank lines in one id order', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 11 bank-line order');
    c = await setup('D8R11O');
  }, 120000);
  afterAll(async () => {
    if (c) await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await teardown(c);
  }, 120000);

  const sides = [
    { name: 'HTTP void vs MCP void_payment', kind: 'supplier' as const, amount: -400 },
    { name: 'receipt cancel vs MCP void_receipt', kind: 'customer' as const, amount: 500 },
  ];
  for (const s of sides) {
    for (const first of ['http', 'mcp'] as const) {
      it(`${s.name}: ${first} side holds its first bank line, head line id < root line id — no 40P01`, async () => {
        const doc = s.kind === 'supplier' ? await postedBill(c) : await postedInvoice(c);
        const pay = s.kind === 'supplier'
          ? await processedPayment(c, doc.id, Math.abs(s.amount)) : await confirmedReceipt(c, doc.id, s.amount);
        const head = (await buildChain(c, pay.je, 2))[2]!;
        const l1 = await lineOn(pay.je, `ffffffff${randomUUID().slice(8)}`, s.amount); // root, highest id
        const l2 = await lineOn(head, `00000000${randomUUID().slice(8)}`, s.amount); // head, lowest id
        const http = () => (s.kind === 'supplier'
          ? voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId)
          : cancelCustomerPayment(c.fx.companyId, pay.id, c.fx.userId));
        const mcp = () => voidPaymentDocument(c.fx.companyId, s.kind, pay.id, c.fx.userId);
        const [a, b] = first === 'http' ? [http, mcp] : [mcp, http];

        let other: Promise<Outcome> = Promise.resolve({ ok: false, error: 'never started' });
        const held = await run(a, isBankLineLock, async () => {
          other = run(b);
          await sleep(1500); // past deadlock_timeout (1 s): a cycle is detected while this side still holds its line
        });
        const waited = await other;
        expect(JSON.stringify([held, waited])).not.toMatch(/40P01|deadlock/);
        expect(held.ok, JSON.stringify(held)).toBe(true);
        // The waiter runs after the holder committed: done, or the plain "already cancelled" refusal (the HTTP
        // side's wording) — never a lock refusal.
        expect(waited.ok || /status: cancelled/.test(String(waited.error)), JSON.stringify(waited)).toBe(true);
        const table = s.kind === 'supplier' ? sql`SELECT status FROM supplier_payments WHERE id = ${pay.id}::UUID`
          : sql`SELECT status FROM customer_payments WHERE id = ${pay.id}::UUID`;
        expect(((await table) as Row[])[0]!.status).toBe('cancelled');
        const lines = (await sql`SELECT id, status FROM bank_transactions WHERE id = ANY(${[l1, l2]}::UUID[]) ORDER BY id`) as Row[];
        expect(lines.map((r) => r.status)).toEqual(['imported', 'imported']);
      }, 40000);
    }
  }
});

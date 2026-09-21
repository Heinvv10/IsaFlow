/**
 * L1 — the bulk tool's dry run against the batch it previews, on a real ledger.
 *
 * A preview that disagrees with the call it previews is worse than no preview
 * at all (`docs/mcp/CONTRACTS.md` §6), and this batch is exactly the shape that
 * breaks a naive one: three lines to ONE supplier, consuming one set of open
 * bills in turn. So the assertion is not "the plan looks right" — it is that
 * the dry run's own `applications` and `on_account`, line for line, equal what
 * the committed batch produced.
 *
 * The rollback half is here too: a batch that fails part-way must leave the
 * ledger exactly as it found it, including the payment documents and the
 * allocation rows the new FIFO default now creates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { bulkAllocateBankTransactionsTool } from '@/lib/mcp/tools/writeBankBulkAllocate';
import type { McpToolContext } from '@/lib/mcp/types';
import {
  billState, dropFixture, inTx, seedBankTx, seedBill, seedFixture, seedSupplier,
  type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

interface ReportedLine {
  transaction_id: string;
  applications?: { document_id: string; document_number: string; amount: number }[];
  on_account?: number;
  auto_apply?: string;
}

function body(res: { content: { text: string }[] }): {
  lines: ReportedLine[];
  preview_caveats?: string[];
  posted?: number;
} {
  return JSON.parse(res.content[0]!.text) as never;
}

/** What each line settled, keyed by transaction so the two runs can be compared. */
function byTransaction(lines: ReportedLine[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const l of lines) {
    out[l.transaction_id] = {
      applications: l.applications ?? null,
      on_account: l.on_account ?? null,
      auto_apply: l.auto_apply ?? null,
    };
  }
  return out;
}

function ctxFor(): McpToolContext {
  return {
    userId: fx.userId, companyId: fx.companyId, scopes: ['write:bank-tx'],
    tokenJti: null, oauthAppId: null,
  };
}

async function paymentCount(supplierId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM supplier_payments
    WHERE company_id = ${fx.companyId}::UUID AND supplier_id = ${supplierId}::UUID`) as Record<string, unknown>[];
  return Number(rows[0]!.n);
}

async function allocationCount(supplierId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE sp.company_id = ${fx.companyId}::UUID AND sp.supplier_id = ${supplierId}::UUID`) as Record<string, unknown>[];
  return Number(rows[0]!.n);
}

describeIfDb('L1 — the bulk dry run and the batch it previews', () => {
  beforeAll(async () => {
    fx = await seedFixture('L1B', DATABASE_URL!);
  }, 60000);

  afterAll(async () => {
    await dropFixture(fx);
  }, 60000);

  it('previews three lines to one supplier exactly as they post', async () => {
    const sup = await seedSupplier(fx, 'BULK');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'K1', date: '2026-06-01', total: 100 });
    const b2 = await seedBill(fx, { supplierId: sup, number: 'K2', date: '2026-06-02', total: 200 });
    const b3 = await seedBill(fx, { supplierId: sup, number: 'K3', date: '2026-06-03', total: 300 });
    const txs = [
      await seedBankTx(fx, { date: '2026-06-10', amount: -150, description: 'BULK-1' }),
      await seedBankTx(fx, { date: '2026-06-10', amount: -150, description: 'BULK-2' }),
      await seedBankTx(fx, { date: '2026-06-10', amount: -150, description: 'BULK-3' }),
    ];
    const allocations = txs.map((id) => ({
      transaction_id: id, alloc_type: 'supplier', entity_id: sup,
    }));

    const previewed = await inTx(fx, async () => body(await bulkAllocateBankTransactionsTool.handler(
      { allocations, dry_run: true, idempotency_key: randomUUID() }, ctxFor(),
    ) as never));

    // Nothing was written by the preview.
    expect(await paymentCount(sup)).toBe(0);
    expect(await billState(fx, b1)).toMatchObject({ amountPaid: 0 });

    const posted = await inTx(fx, async () => body(await bulkAllocateBankTransactionsTool.handler(
      { allocations, idempotency_key: randomUUID() }, ctxFor(),
    ) as never));

    expect(posted.posted).toBe(3);
    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(byTransaction(posted.lines)).toEqual(byTransaction(previewed.lines));

    // And the preview was right about the ledger, not merely self-consistent.
    expect(await billState(fx, b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await billState(fx, b2)).toMatchObject({ status: 'paid', amountPaid: 200 });
    expect(await billState(fx, b3)).toMatchObject({ status: 'partially_paid', amountPaid: 150 });
    expect(previewed.preview_caveats).toEqual([expect.stringContaining('fiscal period')]);
  }, 60000);

  it('counts what an invoice-named line spends before the FIFO line beside it', async () => {
    const sup = await seedSupplier(fx, 'BULKINV');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'M1', date: '2026-07-01', total: 100 });
    const b2 = await seedBill(fx, { supplierId: sup, number: 'M2', date: '2026-07-02', total: 200 });
    // The ids are PINNED, and in this order deliberately: the batch posts
    // sorted by transaction id, so the named line posting first is the case
    // where both lines succeed. The reverse order is a real hazard of the FIFO
    // default — the FIFO line takes the bill the named line was going to pay,
    // that line then refuses, and the batch rolls back whole (all-or-nothing,
    // loudly, nothing mis-posted). It is noted in bank/.claude.md.
    const named = await seedBankTx(fx, {
      date: '2026-07-10', amount: -100, description: 'NAMED',
      id: '0e000000-0000-4000-8000-000000000001',
    });
    const fifo = await seedBankTx(fx, {
      date: '2026-07-10', amount: -150, description: 'FIFO',
      id: '0e000000-0000-4000-8000-000000000002',
    });
    const allocations = [
      { transaction_id: named, alloc_type: 'supplier', entity_id: sup, invoice_id: b1 },
      { transaction_id: fifo, alloc_type: 'supplier', entity_id: sup },
    ];

    const previewed = await inTx(fx, async () => body(await bulkAllocateBankTransactionsTool.handler(
      { allocations, dry_run: true, idempotency_key: randomUUID() }, ctxFor(),
    ) as never));
    const posted = await inTx(fx, async () => body(await bulkAllocateBankTransactionsTool.handler(
      { allocations, idempotency_key: randomUUID() }, ctxFor(),
    ) as never));

    // The named line pays b1; the FIFO line beside it must therefore land on
    // b2, in the preview as much as in the ledger.
    expect(byTransaction(posted.lines)).toEqual(byTransaction(previewed.lines));
    expect(await billState(fx, b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await billState(fx, b2)).toMatchObject({ status: 'partially_paid', amountPaid: 150 });
  }, 60000);

  it('rolls back the WHOLE batch, documents and allocations included, on a bad line', async () => {
    const sup = await seedSupplier(fx, 'BULKZERO');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'Z1', date: '2026-08-01', total: 500 });
    // Pinned ids again: the GOOD line must post FIRST, or the batch fails
    // before it has written anything and the rollback proves nothing.
    const good = await seedBankTx(fx, {
      date: '2026-08-10', amount: -200, description: 'ZERO-GOOD',
      id: '0f000000-0000-4000-8000-000000000001',
    });
    // A zero-amount line: `createJournalEntry` refuses a line with neither a
    // debit nor a credit, which reaches the batch as a genuine fault rather
    // than a skip.
    const zero = await seedBankTx(fx, {
      date: '2026-08-10', amount: 0, description: 'ZERO-BAD',
      id: '0f000000-0000-4000-8000-000000000002',
    });

    await expect(inTx(fx, () => bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [
          { transaction_id: good, alloc_type: 'supplier', entity_id: sup },
          { transaction_id: zero, alloc_type: 'supplier', entity_id: sup },
        ],
        idempotency_key: randomUUID(),
      },
      ctxFor(),
    ))).rejects.toThrow(/line 1 .*non-zero debit or credit/);

    // ALL OR NOTHING, and the new FIFO default widens what "all" means: the
    // first line had already posted its journal, minted a supplier payment and
    // written an allocation row against Z1 before the second line failed.
    expect(await billState(fx, b1)).toMatchObject({
      status: 'approved', amountPaid: 0, paymentMatched: false,
    });
    expect(await allocationCount(sup)).toBe(0);
    expect(await paymentCount(sup)).toBe(0);
  }, 60000);
});

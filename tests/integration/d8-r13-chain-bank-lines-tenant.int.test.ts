/**
 * D8 round 13 (review rev-d8-00043b42d F1): `bank/chainBankLines.findChainBankLines` feeds HTTP void, receipt cancel,
 * batch reversal and the MCP void, which lock and free every line it returns — and nothing pinned its three
 * `company_id` filters (the root read, the walk's step, the bank-line read). Each forged cross-tenant shape below is
 * caught by exactly one of them; dropping any one turns its case RED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { findChainBankLines } from '@/modules/accounting/services/bank/chainBankLines';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { buildChain, postedBill, processedPayment, setup, teardown, type Ctx } from './d8-r4-helpers';

let a: Ctx;
let b: Ctx;
type Row = Record<string, unknown>;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

/** A statement line of company `owner`, matched to journal `je`'s first line (whichever company that journal is in). */
async function lineOf(owner: Ctx, je: string): Promise<string> {
  const leg = await one(sql`SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${je}::UUID ORDER BY id LIMIT 1`);
  const bt = await one(sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
    VALUES (${owner.fx.companyId}::UUID, ${owner.fx.bankAccountId}::UUID, '2026-05-20', -100, ${`D8R13 ${++owner.seq}`}, 'matched',
            ${String(leg.id)}::UUID) RETURNING id`);
  return String(bt.id);
}

/** A posted payment journal of `c`, reversed k times; its chain, root first. */
async function chainOf(c: Ctx, k: number): Promise<string[]> {
  const bill = await postedBill(c);
  return buildChain(c, (await processedPayment(c, bill.id, 100)).je, k);
}

describe.skipIf(!process.env.DATABASE_URL)('D8 round 13: the chain bank-line finder stays inside one company', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 13 chain finder tenancy');
    a = await setup('D8R13A');
    b = await setup('D8R13B');
  }, 180000);
  afterAll(async () => {
    for (const c of [a, b]) {
      if (c) await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    }
    await teardown(a);
    await teardown(b);
  }, 180000);

  it('the bank-line read: another company\'s line forged onto a journal of this chain is not found', async () => {
    const chain = await chainOf(a, 2);
    const own = await lineOf(a, chain[1]!);
    const foreign = await lineOf(b, chain[2]!); // company B's line, matched to A's head
    expect(await findChainBankLines(a.fx.companyId, chain[0]!)).toEqual([own]);
    expect(await findChainBankLines(b.fx.companyId, chain[0]!)).toEqual([]);
    expect(foreign).toBeTruthy();
  });

  it('the walk\'s step: another company\'s journal forged as a reversal in this chain is not walked into', async () => {
    const chain = await chainOf(a, 0);
    const [foreignJe] = await chainOf(b, 0);
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${chain[0]!}::UUID WHERE id = ${foreignJe!}::UUID`;
    const forged = await lineOf(a, foreignJe!); // A's own line, matched to B's journal hanging off A's root
    expect(await findChainBankLines(a.fx.companyId, chain[0]!)).not.toContain(forged);
  });

  it('the root read: another company\'s journal as the root returns nothing', async () => {
    const [foreignRoot] = await chainOf(b, 0);
    await lineOf(a, foreignRoot!); // A's line forged onto B's journal
    expect(await findChainBankLines(a.fx.companyId, foreignRoot!)).toEqual([]);
  });
});

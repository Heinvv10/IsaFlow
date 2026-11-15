/**
 * Audit row 8 — the purchase-order arm of bank-match-confirm.
 *
 * It posted the payment (DR AP / CR bank) and then wrote `purchase_orders.status = 'paid'`, a value
 * `purchase_orders_status_check` does not allow (draft/submitted/approved/partially_received/received/cancelled). So
 * every PO match died on a 23514 AFTER the journal was posted: a 500, rolled back, and no PO could ever be matched.
 * Nor did it check the amount: a R5 000 line could "pay" a R500 order.
 *
 * Now: the PO's own status is left alone, the line is tied to it through `bank_transactions.linked_po_id` (which the
 * Reverse and the auto-post undo already clear), and the line may not exceed what is still OUTSTANDING on the order —
 * its total less every other live line already linked to it — to the cent, refused before the first write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, refusalOf, type BankCompany } from './bank-controls-a.helpers';
import { confirmRoute, linkOf, plantBankLine, UNTOUCHED, writesOf } from './bank-match-targets.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let act: ReturnType<typeof actionRoute>;
let confirm: ReturnType<typeof confirmRoute>;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  act = actionRoute(tokens);
  confirm = confirmRoute(tokens);
});
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET linked_po_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM purchase_orders WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

async function plantPo(f: BankCompany, total: number, status = 'approved'): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO purchase_orders(id, company_id, po_number, supplier_id, status, subtotal, total)
     VALUES($1,$2,$3,$4,$5,$6,$6)`, [id, f.c, `PO-${id.slice(0, 8)}`, f.supplier, status, total]);
  return id;
}
const poStatus = async (id: string) => (await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [id])).rows[0].status as string;
const matchPo = (f: BankCompany, line: string, po: string) =>
  confirm(a, f.c, { bankTransactionId: line, candidateType: 'purchase_order', candidateId: po });

describe('confirming a statement line against a purchase order', () => {
  it('posts the payment, links the line to the PO and leaves the PO\'s own status valid', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const po = await plantPo(f, 500);
    const line = await plantBankLine(pool, f.c, f.bank, -500);
    const res = await matchPo(f, line, po);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await linkOf(pool, line)).toMatchObject({ status: 'allocated', po, type: 'supplier' });
    expect(await poStatus(po)).toBe('approved');
  });

  it('refuses a line larger than the order by one cent, before any write', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const po = await plantPo(f, 499.99);
    const line = await plantBankLine(pool, f.c, f.bank, -500);
    const before = await writesOf(pool, f);
    const res = refusalOf(await matchPo(f, line, po));
    expect({ status: res.status, line: await linkOf(pool, line), writes: await writesOf(pool, f) })
      .toEqual({ status: 400, line: UNTOUCHED, writes: before });
    expect(res.message).toMatch(/outstanding/i);
  });

  it('counts lines already linked to the order: a second payment may take only what is left', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const po = await plantPo(f, 500);
    const first = await plantBankLine(pool, f.c, f.bank, -300);
    expect((await matchPo(f, first, po)).state.statusCode).toBe(200);
    const tooBig = await plantBankLine(pool, f.c, f.bank, -200.01);
    expect({ status: refusalOf(await matchPo(f, tooBig, po)).status, line: await linkOf(pool, tooBig) })
      .toEqual({ status: 400, line: UNTOUCHED });
    const rest = await plantBankLine(pool, f.c, f.bank, -200);
    expect((await matchPo(f, rest, po)).state.statusCode).toBe(200);
    expect(await linkOf(pool, rest)).toMatchObject({ status: 'allocated', po });
  });

  it('a Reverse resets the line to a valid status, drops the link and frees the order for a re-match', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const po = await plantPo(f, 500);
    const line = await plantBankLine(pool, f.c, f.bank, -500);
    expect((await matchPo(f, line, po)).state.statusCode).toBe(200);
    const rev = await act(a, f.c, { action: 'reverse', bankTransactionId: line });
    expect(rev.state.statusCode, JSON.stringify(rev.state.body)).toBe(200);
    expect(await linkOf(pool, line)).toEqual(UNTOUCHED);
    expect(await poStatus(po)).toBe('approved');
    const again = await plantBankLine(pool, f.c, f.bank, -500);
    expect((await matchPo(f, again, po)).state.statusCode).toBe(200);
  });

  it.each(['draft', 'submitted', 'cancelled'])('refuses a %s order, before any write', async (status) => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const po = await plantPo(f, 500, status);
    const line = await plantBankLine(pool, f.c, f.bank, -500);
    const before = await writesOf(pool, f);
    expect({ status: refusalOf(await matchPo(f, line, po)).status, line: await linkOf(pool, line), writes: await writesOf(pool, f) })
      .toEqual({ status: 400, line: UNTOUCHED, writes: before });
  });

  it('answers another company\'s order 404, nothing written', async () => {
    const f = await bankCompany(pool, [[a, 'admin']], companies);
    const other = await bankCompany(pool, [[a, 'admin']], companies);
    const po = await plantPo(other, 500);
    const line = await plantBankLine(pool, f.c, f.bank, -500);
    expect({ status: refusalOf(await matchPo(f, line, po)).status, line: await linkOf(pool, line) })
      .toEqual({ status: 404, line: UNTOUCHED });
  });
});

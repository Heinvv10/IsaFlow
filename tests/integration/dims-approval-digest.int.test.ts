/**
 * Migration 873: an approval vouches for the CC1 / CC2 / BU a document posts.
 *
 * Migration 870 gave customer invoice lines, bill lines and credit notes (a
 * note's header is its one line) cc1_id / cc2_id / bu_id, and they reach the
 * revenue / expense leg. Until 873 the approval digest did not hash them, so a
 * document could be retagged after approval and still post on that approval.
 * Every dimension column moves the digest; a retag after approval stales it at
 * the database backstop; an untouched document still clears.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantBill } from './r035-approval.helpers';
import { plantNote } from './r035-pr3.helpers';
import { cleanupPr4, invoiceCompany, plantInvoice } from './r035-pr4.helpers';
import { approvedFor, cleanupDims, digestOf, plantDims, type Dims, type GatedType } from './dims-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let other = '';

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  other = await createUser(pool, tokens);
});
afterAll(async () => {
  await cleanupDims(pool, companies);
  await pool.query('DELETE FROM credit_notes WHERE company_id = ANY($1)', [companies]);
  await cleanupPr4(pool, companies, [owner, other]);
});

const company = () => invoiceCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);

/** `table` holds the dimensions on row `lineId`; `header` is the row whose status the backstop judges. */
interface Doc { type: GatedType; id: string; header: string; table: string; lineId: string }

/** One draft of `type` in `c`. */
async function plant(c: string, type: GatedType): Promise<Doc> {
  if (type === 'customer_invoice') {
    const inv = await plantInvoice(pool, c, owner);
    const line = (await pool.query("SELECT id FROM customer_invoice_items WHERE invoice_id = $1 AND description = 'Line A'", [inv.id])).rows[0].id;
    return { type, id: inv.id, header: 'customer_invoices', table: 'customer_invoice_items', lineId: line };
  }
  if (type === 'supplier_invoice') {
    const bill = await plantBill(pool, c, owner);
    const line = (await pool.query("SELECT id FROM supplier_invoice_items WHERE supplier_invoice_id = $1 AND description = 'Line A'", [bill.id])).rows[0].id;
    return { type, id: bill.id, header: 'supplier_invoices', table: 'supplier_invoice_items', lineId: line };
  }
  const note = await plantNote(pool, c, owner, type === 'customer_credit_note' ? 'customer' : 'supplier');
  return { type, id: note.id, header: 'credit_notes', table: 'credit_notes', lineId: note.id };
}

const setDim = (doc: Doc, column: string, value: string | null) =>
  pool.query(`UPDATE ${doc.table} SET ${column} = $2 WHERE id = $1`, [doc.lineId, value]);

const TYPES: GatedType[] = ['customer_invoice', 'supplier_invoice', 'customer_credit_note', 'supplier_credit_note'];
const COLUMNS = ['cc1_id', 'cc2_id', 'bu_id'] as const;
const valueFor = (d: Dims, column: (typeof COLUMNS)[number], second = false) =>
  ({ cc1_id: second ? d.fno2 : d.fno1, cc2_id: second ? d.proj2 : d.proj1, bu_id: second ? d.bu2 : d.bu1 })[column];

describe.each(TYPES)('the %s digest', (type) => {
  it('moves with each of cc1_id, cc2_id and bu_id, set and retagged, and comes back with the value', async () => {
    const c = await company();
    const dims = await plantDims(pool, c);
    const doc = await plant(c, type);
    const base = await digestOf(pool, c, type, doc.id);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    for (const column of COLUMNS) {
      await setDim(doc, column, valueFor(dims, column));
      const tagged = await digestOf(pool, c, type, doc.id);
      expect(tagged, `${column} set`).not.toBe(base);
      await setDim(doc, column, valueFor(dims, column, true));
      expect(await digestOf(pool, c, type, doc.id), `${column} retagged`).not.toBe(tagged);
      await setDim(doc, column, null);
      expect(await digestOf(pool, c, type, doc.id), `${column} cleared`).toBe(base);
    }
  });

  it('does not confuse one dimension slot for another', async () => {
    const c = await company();
    const dims = await plantDims(pool, c);
    const doc = await plant(c, type);
    // The same cost centre in CC1 or CC2 is a different posting.
    await setDim(doc, 'cc1_id', dims.proj1);
    const asCc1 = await digestOf(pool, c, type, doc.id);
    await setDim(doc, 'cc1_id', null);
    await setDim(doc, 'cc2_id', dims.proj1);
    expect(await digestOf(pool, c, type, doc.id)).not.toBe(asCc1);
  });

  it('a retag after approval stales it at the backstop; the untouched document still posts', async () => {
    const c = await company();
    const dims = await plantDims(pool, c);
    for (const column of COLUMNS) {
      const doc = await plant(c, type);
      await setDim(doc, column, valueFor(dims, column));
      await approvedFor(pool, c, type, doc.id, other, owner);
      await setDim(doc, column, valueFor(dims, column, true));
      await expect(pool.query(`UPDATE ${doc.header} SET status = 'approved' WHERE id = $1`, [doc.id]), column)
        .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
      // Put the approved tag back: identical content clears again.
      await setDim(doc, column, valueFor(dims, column));
      await pool.query(`UPDATE ${doc.header} SET status = 'approved' WHERE id = $1`, [doc.id]);
      expect((await pool.query(`SELECT status FROM ${doc.header} WHERE id = $1`, [doc.id])).rows[0].status, column).toBe('approved');
    }
  });
});

const LINE_TABLES = [
  { type: 'customer_invoice', table: 'customer_invoice_items', fk: 'invoice_id',
    cols: 'description,quantity,unit_price,amount,tax_rate,currency_code', vals: "'Same',1,1,1,15,'ZAR'" },
  { type: 'supplier_invoice', table: 'supplier_invoice_items', fk: 'supplier_invoice_id',
    cols: 'description,quantity,unit_price,tax_rate,tax_amount,line_total', vals: "'Same',1,1,15,0.15,1" },
] as const;

describe.each(LINE_TABLES)('the $table array', ({ type, table, fk, cols, vals }) => {
  it.each(COLUMNS)('orders lines by %s too: re-inserted lines differing only there keep the digest (Q9)', async (column) => {
    const c = await company();
    const d = await plantDims(pool, c);
    const id = type === 'customer_invoice' ? (await plantInvoice(pool, c, owner)).id : (await plantBill(pool, c, owner)).id;
    const [v1, v2] = [valueFor(d, column), valueFor(d, column, true)];
    const reinsert = async (a: string, b: string) => {
      await pool.query(`DELETE FROM ${table} WHERE ${fk} = $1`, [id]);
      // One statement: both rows share created_at, so the order falls to content.
      await pool.query(`INSERT INTO ${table}(${fk},${cols},${column}) VALUES($1,${vals},$2),($1,${vals},$3)`, [id, a, b]);
    };
    await reinsert(v1, v2);
    const base = await digestOf(pool, c, type, id);
    // New ids every round: with the column out of ORDER BY the order falls to id, a coin toss per round.
    for (let round = 0; round < 8; round++) {
      await (round % 2 ? reinsert(v2, v1) : reinsert(v1, v2));
      expect(await digestOf(pool, c, type, id), `round ${round}`).toBe(base);
    }
  });
});

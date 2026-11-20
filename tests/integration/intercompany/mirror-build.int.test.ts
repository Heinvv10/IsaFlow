/**
 * Intercompany P2, the database's payload builder (`intercompany_build_payload`, migration 1013) against its reference
 * (tests/helpers/mirrorReference.ts, the parser's rules in TypeScript): for a few hundred invoices of every shape (several VAT rates on one
 * invoice, headers that are the rate on the sum, per line or off by the cents a ledger leaves, discounted lines, tens of lines) the database's payload is the reference's, and the receiver's parser reads every one. A document the parser would refuse
 * (a negative line, a header that is not its lines) is not built: 'unmirrorable', never a message the receiver cannot read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { parseMirrorPayload } from '../../../src/modules/accounting/services/intercompany/mirrorPayload';
import { buildCreditNotePayload, buildInvoicePayload, type InvoiceSource } from '../../helpers/mirrorReference';
import { co, mirrorCleanup, mirrorSetup, party, U } from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);

let seed = 20261119;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

interface Line { description: string; quantity: number; unitPrice: number; amount: number; taxRate: number }

/** A random invoice: its lines, and the header VAT the way an app (or an import) leaves it. */
function randomInvoice(): { lines: Line[]; taxCents: number } {
  const n = 1 + Math.floor(rnd() * (rnd() < 0.1 ? 40 : 6));
  const rates = [15, 0, 15, 7.5, 14];
  const mixed = rnd() < 0.4;
  const headerRate = pick(rates);
  const lines: Line[] = Array.from({ length: n }, (_, i) => {
    const cents = rnd() < 0.3 ? 1 + Math.floor(rnd() * 5) : 1 + Math.floor(rnd() * 2_000_000);
    const shape = rnd();
    // a plain line (1 x price), a multiplied line, a discounted line (amount below quantity x price)
    const quantity = shape < 0.5 ? 1 : shape < 0.7 ? 1 + Math.floor(rnd() * 5) : 1;
    const amount = (shape < 0.5 ? cents : quantity * cents) / 100;
    const unitPrice = shape < 0.85 ? cents / 100 : (cents + 1000) / 100;
    return { description: ` Line ${i + 1} `, quantity, unitPrice, amount, taxRate: mixed ? pick(rates) : headerRate };
  });
  const mode = pick(['aggregate', 'perline']);
  const taxCents = mode === 'aggregate'
    ? Math.round(lines.reduce((s, l) => s + Math.round(l.amount * 100) * l.taxRate / 100, 0))
    : lines.reduce((s, l) => s + Math.round(Math.round(l.amount * 100) * l.taxRate / 100 + 1e-9), 0);
  // a header BELOW the lines' (whole-rand lines at 15% have no fractional cent, so one cent less per line is within the parser's bound): the downward spread
  if (rnd() < 0.15) {
    const whole = Array.from({ length: n }, (_, i): Line => ({ description: `W${i}`, quantity: 1, unitPrice: 100 * (1 + Math.floor(rnd() * 90)), amount: 0, taxRate: 15 }));
    whole.forEach((l) => { l.amount = l.unitPrice; });
    const exact = whole.reduce((s, l) => s + Math.round(l.amount * 15), 0);
    return { lines: whole, taxCents: exact - Math.floor(rnd() * n) };
  }
  // one in twelve has a header VAT the lines cannot explain (an edited or imported header): the parser refuses those, and so must the builder
  const off = rnd() < 1 / 12 ? (rnd() < 0.5 ? -1 : 1) * (20 + Math.floor(rnd() * 200)) : 0;
  return { lines, taxCents: Math.max(0, taxCents + off) };
}

async function plant(lines: Line[], taxCents: number): Promise<{ id: string; source: InvoiceSource }> {
  const id = crypto.randomUUID();
  const sub = lines.reduce((s, l) => s + Math.round(l.amount * 100), 0);
  const number = `ICB-${id.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO customer_invoices(id, company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
       currency_code, exchange_rate, status, notes, created_by)
     VALUES ($1, $2, $3, $4, $4, '2026-09-01', '2026-10-01', $5, 15, $6, $7, 'ZAR', 1, 'approved', '  note  ', $8)`,
    [id, co.A, number, party.aCustomer, sub / 100, taxCents / 100, (sub + taxCents) / 100, U.ab]);
  for (const l of lines) {
    await pool.query(
      `INSERT INTO customer_invoice_items(invoice_id, description, quantity, unit_price, amount, tax_rate, currency_code) VALUES ($1, $2, $3, $4, $5, $6, 'ZAR')`,
      [id, l.description, l.quantity, l.unitPrice, l.amount, l.taxRate]);
  }
  const name = String((await pool.query('SELECT name FROM companies WHERE id = $1', [co.A])).rows[0].name);
  return {
    id,
    source: {
      number, date: '2026-09-01', dueDate: '2026-10-01', currency: 'ZAR', subtotal: sub / 100, taxAmount: taxCents / 100, total: (sub + taxCents) / 100,
      notes: '  note  ', sender: { name: name.trim(), vatNumber: null }, lines: lines.map((l) => ({ ...l })), pdf: null,
    },
  };
}

async function plantInvoiceRow(): Promise<{ id: string; number: string }> {
  const { id, source } = await plant([{ description: 'Credited', quantity: 1, unitPrice: 100, amount: 100, taxRate: 15 }], 1500);
  return { id, number: source.number };
}
const build = async (id: string) =>
  (await pool.query("SELECT payload, problem FROM public.intercompany_build_payload('invoice', $1, $2)", [id, co.A])).rows[0] as { payload: unknown; problem: string | null };
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('the database builds the reference\'s payload, and the receiver reads it', () => {
  it('300 random invoices: equal to the reference where the parser reads the reference, unmirrorable where it does not', async () => {
    let built = 0;
    let refused = 0;
    for (let t = 0; t < 300; t++) {
      const { lines, taxCents } = randomInvoice();
      const { id, source } = await plant(lines, taxCents);
      const reference = json(buildInvoicePayload(source));
      const readable = parseMirrorPayload(reference, 'invoice', co.A).ok;
      const got = await build(id);
      if (readable) {
        expect(got.problem, JSON.stringify({ lines, taxCents })).toBeNull();
        expect(json(got.payload)).toEqual(reference);
        expect(parseMirrorPayload(json(got.payload), 'invoice', co.A).ok).toBe(true);
        built += 1;
      } else {
        expect(got.problem, JSON.stringify({ lines, taxCents })).toMatch(/^unmirrorable/);
        refused += 1;
      }
    }
    // the generator makes both kinds, so neither arm of the comparison is vacuous
    expect(built).toBeGreaterThan(200);
    expect(refused).toBeGreaterThan(0);
  }, 180000);

  it('60 random customer CREDIT NOTES: equal to the reference (reason trimmed and cut, a NULL or lower-case currency, the credited invoice\'s number), and the receiver reads each', async () => {
    const credited = await plantInvoiceRow();
    const reasons: Array<string | null> = [null, '', '   ', '  Returned router  ', 'x'.repeat(1500), 'Ünïcödé ✓ '.repeat(30), 'a\n\tb'];
    const name = String((await pool.query('SELECT name FROM companies WHERE id = $1', [co.A])).rows[0].name).trim();
    for (let t = 0; t < 60; t++) {
      const subtotal = (1 + Math.floor(rnd() * 5_000_000)) / 100;
      const tax = Math.round(subtotal * pick([0, 15, 15, 14]) ) / 100;
      const reason = pick(reasons);
      const currency = pick<string | null>([null, 'ZAR', 'zar']);
      const withInvoice = rnd() < 0.5;
      const id = crypto.randomUUID();
      const number = `ICBCN-${id.slice(0, 8)}`;
      await pool.query(
        `INSERT INTO credit_notes(id, company_id, credit_note_number, type, client_id, customer_invoice_id, credit_date, reason, subtotal, tax_rate, tax_amount, total_amount, currency, status, created_by)
         VALUES ($1, $2, $3, 'customer', $4, $5, '2026-09-05', $6, $7, 15, $8, $9, $10, 'draft', $11)`,
        [id, co.A, number, party.aCustomer, withInvoice ? credited.id : null, reason, subtotal, tax, subtotal + tax, currency, U.ab]);
      await pool.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [id]);
      const reference = json(buildCreditNotePayload({
        number, date: '2026-09-05', currency: (currency ?? 'ZAR').trim().toUpperCase(), subtotal, taxAmount: tax, total: subtotal + tax, taxRate: 15, reason,
        creditsInvoiceNumber: withInvoice ? credited.number : null, sender: { name, vatNumber: null },
      }));
      const got = (await pool.query("SELECT payload, problem FROM public.intercompany_build_payload('credit_note', $1, $2)", [id, co.A])).rows[0] as { payload: unknown; problem: string | null };
      expect(got.problem, JSON.stringify({ subtotal, tax, reason, currency })).toBeNull();
      expect(json(got.payload)).toEqual(reference);
      expect(parseMirrorPayload(json(got.payload), 'credit_note', co.A).ok).toBe(true);
    }
  }, 120000);

  it('the 12 x R10.10 invoice at 15% (header R18.18, lines R1.51 / R1.52 by largest remainder) builds and parses', async () => {
    const { id } = await plant(Array.from({ length: 12 }, (_, i) => ({ description: `L${i}`, quantity: 1, unitPrice: 10.1, amount: 10.1, taxRate: 15 })), 1818);
    const got = await build(id);
    expect(got.problem).toBeNull();
    const lines = (json(got.payload) as { lines: Array<{ taxAmount: number }> }).lines;
    expect(lines.reduce((s, l) => s + Math.round(l.taxAmount * 100), 0)).toBe(1818);
    expect(lines.every((l) => l.taxAmount === 1.51 || l.taxAmount === 1.52)).toBe(true);
  });

  it.each([
    ['a negative line at a zero rate', [{ description: 'x', quantity: 1, unitPrice: -1, amount: -1, taxRate: 0 }, { description: 'y', quantity: 1, unitPrice: 5, amount: 5, taxRate: 0 }], 0, /negative/],
    ['a negative line', [{ description: 'x', quantity: 1, unitPrice: -1, amount: -1, taxRate: 15 }, { description: 'y', quantity: 1, unitPrice: 5, amount: 5, taxRate: 15 }], 60, /negative/],
    ['a VAT the rate does not give, on two lines', [{ description: 'x', quantity: 1, unitPrice: 100, amount: 100, taxRate: 15 }, { description: 'y', quantity: 1, unitPrice: 100, amount: 100, taxRate: 15 }], 1, /not its amount at its rate|do not add up/],
  ])('%s is not built (unmirrorable), so the receiver is never sent what it cannot read', async (_name, lines, taxCents, why) => {
    const { id } = await plant(lines, taxCents);
    const got = await build(id);
    expect(got.payload).toBeNull();
    expect(got.problem).toMatch(/^unmirrorable/);
    expect(got.problem).toMatch(why);
  });

  it('a SINGLE-line invoice carries its header VAT whatever the line\'s rate says (a Sage import: R10 000 at a stored 15% with VAT R333.33), and the receiver reads it', async () => {
    const { id } = await plant([{ description: 'Imported line', quantity: 1, unitPrice: 10000, amount: 10000, taxRate: 15 }], 33333);
    const got = await build(id);
    expect(got.problem).toBeNull();
    const p = json(got.payload) as { taxAmount: number; lines: Array<{ taxAmount: number }> };
    expect([p.taxAmount, p.lines[0]!.taxAmount]).toEqual([333.33, 333.33]);
    expect(parseMirrorPayload(p, 'invoice', co.A).ok).toBe(true);
    // ... but not with TWO lines: each is held within a cent of its rate
    const two = await plant([{ description: 'a', quantity: 1, unitPrice: 5000, amount: 5000, taxRate: 15 }, { description: 'b', quantity: 1, unitPrice: 5000, amount: 5000, taxRate: 15 }], 33333);
    expect((await build(two.id)).problem).toMatch(/^unmirrorable/);
  });

  it('a header that is not its lines (a subtotal edited after the lines) is not built', async () => {
    const { id } = await plant([{ description: 'x', quantity: 1, unitPrice: 100, amount: 100, taxRate: 15 }], 1500);
    await pool.query('UPDATE customer_invoices SET subtotal = 90, total_amount = 105 WHERE id = $1', [id]);
    expect((await build(id)).problem).toMatch(/line totals do not add up to the subtotal/);
  });
});

/**
 * Intercompany P2, a sender cannot send what is not its document (migration 1013, the messages guard). The breaker's attack: A, a real
 * tenant with a write role, inserts a message into its own outbox whose payload says R1 999 999 for an invoice that is a R1 150 DRAFT,
 * under another company's name and VAT number, and B's auto-accept worker would have drafted it. Now the database refuses a document message
 * unless its source is APPROVED and its number, date, currency, subtotal, VAT, total, line amounts, sender name and VAT number are the
 * sender's books' (the sender's own name is cut at the parser's 200 characters; its VAT number at 50).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { buildInvoicePayload } from '../../../src/modules/accounting/services/intercompany/mirrorPayload';
import { readInvoiceSource } from '../../../src/modules/accounting/services/intercompany/outboxRead';
import { asAppUser, outcome } from './intercompany.helpers';
import { asService, clearMirrorRows, co, connect, mirrorCleanup, mirrorSetup, plantArInvoice, U } from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => { await clearMirrorRows(pool); conn = await connect(pool, { autoAccept: true }); });

const INSERT = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                VALUES ($1, $2, $3, 'invoice', 'customer_invoice', $4, $5::jsonb)`;
/** An APPROVED invoice of A (planted, so no message exists yet) and the payload the sender's own service builds for it. */
async function approved() {
  const inv = await plantArInvoice(pool, { status: 'approved' });
  const src = await asService(pool, U.a, co.A, () => readInvoiceSource(co.A, inv.id));
  return { inv, payload: JSON.parse(JSON.stringify(buildInvoicePayload(src!))) as Record<string, unknown> };
}
const send = (doc: string, payload: unknown) => asAppUser(pool, U.a, co.A, (q) => outcome(q, INSERT, [conn, co.A, co.B, doc, JSON.stringify(payload)]));
const REFUSED = (what: RegExp) => expect.stringMatching(new RegExp(`^23514: a document message carries its source document: ${what.source}`));
const messages = async () => Number((await pool.query('SELECT count(*) AS n FROM intercompany_messages WHERE from_company_id = $1', [co.A])).rows[0].n);

describe('the document\'s own payload goes through', () => {
  it('what the sender\'s service builds for its approved invoice is accepted by the database', async () => {
    const { inv, payload } = await approved();
    expect(await send(inv.id, payload)).toBe('ok');
  });
});

describe('the breaker\'s forgery, and each way of it', () => {
  it('amounts that are not the document\'s, under another company\'s name and VAT number, for a DRAFT invoice: refused, nothing sent, nothing for the worker', async () => {
    const draft = await plantArInvoice(pool); // R1 150, never approved
    const forged = { version: 1, kind: 'invoice', number: 'FORGED-1', date: '2026-09-01', dueDate: null, currency: 'ZAR', subtotal: 1000000, taxAmount: 999999, total: 1999999,
      senderName: 'Somebody Else (Pty) Ltd', senderVatNumber: '4999999999', notes: null, pdf: null, creditsInvoiceNumber: null, groupTransactionId: null,
      lines: [{ description: 'x', quantity: 1, unitPrice: 1000000, taxRate: 0, taxAmount: 999999, lineTotal: 1000000 }] };
    expect(await send(draft.id, forged)).toEqual(REFUSED(/the source invoice is not approved/));
    expect(await messages()).toBe(0);
    expect(await runAutoAccept()).toMatchObject({ considered: 0 });
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1', [co.B])).rows[0].n)).toBe(0);
  });

  it.each([
    ['a different total', (p: Record<string, unknown>) => ({ ...p, total: 9999 }), /the total is not the document/],
    ['a different subtotal', (p: Record<string, unknown>) => ({ ...p, subtotal: 1 }), /the subtotal is not the document/],
    ['a different VAT', (p: Record<string, unknown>) => ({ ...p, taxAmount: 1 }), /the VAT is not the document/],
    ['a different number', (p: Record<string, unknown>) => ({ ...p, number: 'OTHER-1' }), /the number is not the document/],
    ['a different date', (p: Record<string, unknown>) => ({ ...p, date: '2026-01-01' }), /the date is not the document/],
    ['a different currency', (p: Record<string, unknown>) => ({ ...p, currency: 'USD' }), /the currency is not the document/],
    ['another company\'s name', (p: Record<string, unknown>) => ({ ...p, senderName: 'Somebody Else (Pty) Ltd' }), /the sender name is not the company/],
    ['another VAT number', (p: Record<string, unknown>) => ({ ...p, senderVatNumber: '4999999999' }), /the sender VAT number is not the company/],
    ['an extra line', (p: Record<string, unknown>) => ({ ...p, lines: [...(p.lines as unknown[]), (p.lines as unknown[])[0]] }), /the lines are not the document/],
    ['no lines', (p: Record<string, unknown>) => ({ ...p, lines: [] }), /the lines are not the document/],
    ['line amounts moved (same count, same sum)', (p: Record<string, unknown>) => ({ ...p, lines: (p.lines as Array<Record<string, unknown>>).map((l, i) => ({ ...l, lineTotal: i === 0 ? 500 : 500, unitPrice: 500, quantity: 1 })) }), /the lines are not the document/],
    ['a number where text belongs', (p: Record<string, unknown>) => ({ ...p, number: 5 }), /the number is not the document/],
    ['a text total', (p: Record<string, unknown>) => ({ ...p, total: '1150' }), /the total is not the document/],
    ['no lines array', (p: Record<string, unknown>) => ({ ...p, lines: 'x' }), /the payload has no lines/],
  ])('%s: refused, nothing sent', async (_name, tamper, why) => {
    const { inv, payload } = await approved();
    expect(await send(inv.id, tamper(payload))).toEqual(REFUSED(why));
    expect(await messages()).toBe(0);
  });

  it('an invoice that is cancelled, or one of another company, is not a source', async () => {
    const { inv, payload } = await approved();
    await pool.query("UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1", [inv.id]);
    expect(await send(inv.id, payload)).toEqual(REFUSED(/the source invoice is not approved/));
  });

  it('a long company name is carried cut at 200 characters, and the database expects the same cut', async () => {
    await pool.query('UPDATE companies SET name = $2, vat_number = $3 WHERE id = $1', [co.A, `${'N'.repeat(300)}`, `${'4'.repeat(60)}`]);
    try {
      const { inv, payload } = await approved();
      expect(String(payload.senderName)).toHaveLength(200);
      expect(String(payload.senderVatNumber)).toHaveLength(50);
      expect(await send(inv.id, payload)).toBe('ok');
    } finally {
      await pool.query("UPDATE companies SET name = 'IC A restored', vat_number = NULL WHERE id = $1", [co.A]);
    }
  });
});

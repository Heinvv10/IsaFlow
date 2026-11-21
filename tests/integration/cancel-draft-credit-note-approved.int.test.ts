/**
 * cancel_credit_note on an APPROVED note (the draft cancel's sibling suite, split from cancel-draft-credit-note.int.test.ts for the
 * 300-line cap): the cancel is unchanged: the journal is reversed, the invoice's credit given back, and a stale "Cancel draft" click on a
 * note approved meanwhile is refused with nothing written. Also: the draft cancel runs as app_user under forced RLS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDraftCancelService';
import { CreditNoteDeleteRefusal } from '@/modules/accounting/services/ar/creditNoteDeleteService';
import { inTx, runOn, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { DATABASE_URL, KEY, auditRows, cancel, ctxFor, journalCount, row, seedNote, setupWorld, teardownWorld, text } from './helpers/cancelDraftCreditNoteKit';

let fx: Fixture;

describe.skipIf(!DATABASE_URL)('cancel_credit_note on an approved note — over a real database', () => {
  beforeAll(async () => { ({ fx } = await setupWorld()); }, 120000);
  afterAll(teardownWorld, 120000);

  it('runs as app_user under forced RLS: grants and policies allow the draft cancel', async () => {
    const id = await seedNote();
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}::UUID, 'owner') ON CONFLICT DO NOTHING`;
    const c: PoolClient = await fx.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [fx.companyId]);
      const r = await runOn(fx, c, () => cancelCreditNoteTool.handler({ credit_note_id: id, ...KEY }, ctxFor(fx)));
      expect(text(r)).toContain('"status":"cancelled"');
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect((await row(id))!.status).toBe('cancelled');
  }, 30000);

describe('an APPROVED note: the cancel is unchanged', () => {
  async function approvedNote(inv: string): Promise<string> {
    const created = await inTx(fx, () => createCreditNote(fx.companyId, {
      type: 'customer', clientId: fx.customerId, creditDate: '2026-03-01', subtotal: 100, taxRate: 15, customerInvoiceId: inv,
    }, fx.userId));
    await inTx(fx, () => approveCreditNote(fx.companyId, created.id, fx.userId, { autoApply: 'linked' }));
    return created.id;
  }

  it('reverses the journal, gives the invoice credit back and stamps the cancel', async () => {
    const inv = await seedInvoice(fx, { number: 'A1', date: '2026-03-01', total: 300 });
    const id = await approvedNote(inv);
    const posted = (await row(id))!;
    expect(posted.gl_journal_entry_id).toBeTruthy();
    expect(['approved', 'partially_applied', 'applied']).toContain(posted.status);
    const before = await journalCount();

    const r = await cancel(id, { reason: 'wrong customer' });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ id, status: 'cancelled', total_amount: 115 });
    expect(Object.keys(JSON.parse(text(r)))).toEqual(['id', 'credit_note_number', 'status', 'total_amount', 'reversal_date_roll']);
    expect(await row(id)).toMatchObject({ status: 'cancelled', cancelled_by: fx.userId, cancel_reason: 'wrong customer', gl_journal_entry_id: posted.gl_journal_entry_id });
    expect(await journalCount()).toBe(before + 1);
    const reversal = (await sql`SELECT 1 FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${posted.gl_journal_entry_id}::UUID`) as unknown[];
    expect(reversal).toHaveLength(1);
    const i = ((await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as { amount_paid: string }[])[0]!;
    expect(Number(i.amount_paid)).toBe(0);
  });

  it('a "Cancel draft" clicked AFTER the note was approved is refused: nothing is reversed, written or un-applied', async () => {
    const inv = await seedInvoice(fx, { number: 'A3', date: '2026-03-01', total: 300 });
    const id = await approvedNote(inv); // the page loaded this note as a draft; someone approved it before the click
    const posted = (await row(id))!;
    const journals = await journalCount();
    const paid = Number(((await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as { amount_paid: string }[])[0]!.amount_paid);
    expect(paid).toBeGreaterThan(0);

    const err = await inTx(fx, () => cancelDraftCreditNote(fx.companyId, id, fx.userId, 'stale page')).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CreditNoteDeleteRefusal);
    expect((err as CreditNoteDeleteRefusal).code).toBe('NOT_DRAFT');
    expect(await row(id)).toMatchObject({ status: posted.status, cancelled_by: null, cancelled_at: null, gl_journal_entry_id: posted.gl_journal_entry_id });
    expect(await journalCount()).toBe(journals);
    expect(Number(((await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as { amount_paid: string }[])[0]!.amount_paid)).toBe(paid);
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('its dry run rolls everything back: still approved, invoice credit intact, no journal added', async () => {
    const inv = await seedInvoice(fx, { number: 'A2', date: '2026-03-01', total: 300 });
    const id = await approvedNote(inv);
    const posted = (await row(id))!;
    const before = await journalCount();
    const paidBefore = Number(((await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as { amount_paid: string }[])[0]!.amount_paid);
    expect(paidBefore).toBeGreaterThan(0);

    const dry = await cancel(id, { dry_run: true });
    expect(dry.wroteNothing).toBe(true);
    expect(JSON.parse(text(dry))).toMatchObject({ dry_run: true, would_cancel: { id, status: 'cancelled' } });
    expect(await row(id)).toMatchObject({ status: posted.status, cancelled_at: null });
    expect(await journalCount()).toBe(before);
    expect(Number(((await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as { amount_paid: string }[])[0]!.amount_paid)).toBe(paidBefore);
  });
});
});

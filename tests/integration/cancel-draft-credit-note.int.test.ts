/**
 * cancel_credit_note on a DRAFT against a real database: the note is set to cancelled with NO journal and no
 * allocation change, keeps its number, and carries who/when/why exactly as the approved-note cancel stamps them. The
 * refusals (corrupt draft, dispute, pending approval) leave the row a draft; the row lock is taken and the status
 * re-read under it (an approval that wins the lock is refused, an approval behind the cancel finds it cancelled); the
 * dry run runs every guard and changes nothing. Also pins that an APPROVED note's cancel is unchanged (journal
 * reversed, invoice credit given back) and runs the draft cancel as app_user under forced RLS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import { deleteDraftCreditNoteTool } from '@/lib/mcp/tools/writeDeleteDraftCreditNote';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { cancelDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDraftCancelService';
import { McpRegistry } from '@/lib/mcp/registry';
import { CreditNoteDeleteRefusal } from '@/modules/accounting/services/ar/creditNoteDeleteService';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, runOn, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { backendPid, waitUntilBlocked } from './helpers/lockWait';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
const KEY = { idempotency_key: 'k-int' };
const ctxFor = (f: Fixture) => ({ companyId: f.companyId, userId: f.userId, tokenJti: 'jti', companyRole: 'owner', scopes: ['write:invoices', 'write:post'], oauthAppId: null }) as unknown as McpToolContext;
const cancel = (id: string, extra: Record<string, unknown> = {}, f: Fixture = fx) =>
  inTx(f, () => cancelCreditNoteTool.handler({ credit_note_id: id, ...KEY, ...extra }, ctxFor(f)));
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

let seq = 0;
async function seedNote(over: {
  type?: 'customer' | 'supplier'; number?: string; status?: string; journal?: boolean; applied?: number; invoice?: string; bill?: string; f?: Fixture;
} = {}): Promise<string> {
  const f = over.f ?? fx;
  const type = over.type ?? 'customer';
  let je: string | null = null;
  if (over.journal) {
    je = ((await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at)
      VALUES (${f.companyId}::UUID, ${`JE-${++seq}-${f.tag}`}, '2026-03-01'::DATE, 'CN', 'posted', ${f.userId}::UUID,
              (SELECT id FROM fiscal_periods WHERE company_id = ${f.companyId}::UUID LIMIT 1), NOW())
      RETURNING id`) as { id: string }[])[0]!.id;
  }
  return ((await sql`
    INSERT INTO credit_notes (company_id, type, client_id, supplier_id, customer_invoice_id, supplier_invoice_id, credit_note_number,
      credit_date, subtotal, tax_rate, tax_amount, total_amount, applied_amount, status, created_by, gl_journal_entry_id, reason)
    VALUES (${f.companyId}::UUID, ${type}, ${type === 'customer' ? f.customerId : null}::UUID, ${type === 'supplier' ? f.supplierId : null}::UUID,
      ${over.invoice ?? null}::UUID, ${over.bill ?? null}::UUID, ${over.number ?? `CN-2026-${80000 + ++seq}`}, '2026-03-01'::DATE, 100, 15, 15, 115,
      ${over.applied ?? 0}, ${over.status ?? 'draft'}, ${f.userId}::UUID, ${je}::UUID, 'int test')
    RETURNING id`) as { id: string }[])[0]!.id;
}

interface Row { status: string; credit_note_number: string; cancelled_by: string | null; cancelled_at: Date | null; cancel_reason: string | null; applied_amount: string; gl_journal_entry_id: string | null }
async function row(id: string): Promise<Row | null> {
  return ((await sql`SELECT status, credit_note_number, cancelled_by, cancelled_at, cancel_reason, applied_amount, gl_journal_entry_id
    FROM credit_notes WHERE id = ${id}::UUID`) as Row[])[0] ?? null;
}
async function journalCount(f: Fixture = fx): Promise<number> {
  return Number(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${f.companyId}::UUID`) as { n: string }[])[0]!.n);
}
async function allocCount(id: string): Promise<number> {
  return Number(((await sql`SELECT COUNT(*) AS n FROM credit_note_allocations WHERE credit_note_id = ${id}::UUID`) as { n: string }[])[0]!.n);
}

async function auditRows(id: string) {
  return (await sql`SELECT user_id, action, entity_type, changes FROM audit_log WHERE entity_id = ${id}::UUID`) as
    { user_id: string; action: string; entity_type: string; changes: { fields: { field: string; old: string | null; new: string | null; label: string }[]; metadata: Record<string, string> } }[];
}

describeIfDb('cancel_credit_note on a draft — over a real database', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and cancels credit notes.');
    fx = await seedFixture('CDC', DATABASE_URL!);
    other = await seedFixture('CDX', DATABASE_URL!);
    // audit_log.user_id references users: the fixture's actor needs a row, as every real caller has one.
    for (const f of [fx, other]) {
      await sql`INSERT INTO users (id, email, role, is_active) VALUES (${f.userId}, ${`${f.userId}@test.local`}, 'viewer', true)`;
    }
    await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '4000', ${`Revenue ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      await sql`DELETE FROM approval_requests WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM customer_invoice_disputes WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM credit_note_allocations WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM credit_notes WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM mcp_tool_calls WHERE company_id = ${f.companyId}::UUID`;
      await dropFixture(f);
      await sql`DELETE FROM users WHERE id = ${f.userId}`;
    }
  }, 120000);

  it('cancels a customer draft: status cancelled, who/when/why stamped, number kept, NO journal, no allocation', async () => {
    const id = await seedNote({ type: 'customer', number: 'CN-2026-70001' });
    const before = await journalCount();
    const r = await cancel(id, { reason: 'duplicate' });
    expect(r.isError).toBeFalsy();
    expect(r.wroteNothing).toBeUndefined();
    expect(JSON.parse(text(r))).toMatchObject({ id, credit_note_number: 'CN-2026-70001', status: 'cancelled', journal_reversed: false, reversal_date_roll: null });
    const after = (await row(id))!;
    expect(after).toMatchObject({ status: 'cancelled', credit_note_number: 'CN-2026-70001', cancelled_by: fx.userId, cancel_reason: 'duplicate', gl_journal_entry_id: null });
    expect(Number(after.applied_amount)).toBe(0);
    expect(after.cancelled_at).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - after.cancelled_at!.getTime())).toBeLessThan(60_000);
    expect(await journalCount()).toBe(before);
    expect(await allocCount(id)).toBe(0);
  });

  it('a draft numbered from the supplier return sequence cancels and keeps its number; the delete still refuses and points here', async () => {
    const id = await seedNote({ type: 'supplier', number: 'RTN0000042' });
    const del = await inTx(fx, () => deleteDraftCreditNoteTool.handler({ credit_note_id: id, ...KEY }, ctxFor(fx)));
    expect(del.isError).toBe(true);
    expect(text(del)).toContain('cancel it with cancel_credit_note');
    expect((await row(id))!.status).toBe('draft');

    const r = await cancel(id);
    expect(r.isError).toBeFalsy();
    expect(await row(id)).toMatchObject({ status: 'cancelled', credit_note_number: 'RTN0000042', cancelled_by: fx.userId, cancel_reason: null });
  });

  it('leaves a linked bill and a linked invoice untouched', async () => {
    const bill = await seedBill(fx, { number: 'B1', date: '2026-03-01', total: 230 });
    const inv = await seedInvoice(fx, { number: 'I1', date: '2026-03-01', total: 230 });
    expect((await cancel(await seedNote({ type: 'supplier', bill }))).isError).toBeFalsy();
    expect((await cancel(await seedNote({ type: 'customer', invoice: inv }))).isError).toBeFalsy();
    const b = ((await sql`SELECT status, amount_paid FROM supplier_invoices WHERE id = ${bill}::UUID`) as { status: string; amount_paid: string }[])[0]!;
    const i = ((await sql`SELECT status, amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as { status: string; amount_paid: string }[])[0]!;
    expect({ b: [b.status, Number(b.amount_paid)], i: [i.status, Number(i.amount_paid)] }).toEqual({ b: ['approved', 0], i: ['sent', 0] });
  });

  it('the route\'s draft-only service (cancel_draft) cancels the draft with no journal and the person\'s audit row', async () => {
    const id = await seedNote({ type: 'supplier' });
    const before = await journalCount();
    const out = await inTx(fx, () => cancelDraftCreditNote(fx.companyId, id, fx.userId, 'ui'));
    expect(out.status).toBe('cancelled');
    expect(await row(id)).toMatchObject({ status: 'cancelled', cancelled_by: fx.userId, cancel_reason: 'ui' });
    expect(await journalCount()).toBe(before);
    expect((await auditRows(id))[0]!.changes.metadata).toEqual({ source: 'cancel_draft_credit_note' });
  });

  it('the generic cancelCreditNote (credit-notes-action `cancel`, supplier PATCH `reverse`) still refuses a draft and writes nothing', async () => {
    const id = await seedNote({ type: 'supplier' });
    const before = await journalCount();
    await expect(inTx(fx, () => cancelCreditNote(fx.companyId, id, fx.userId, 'x'))).rejects.toThrow('Cannot cancel credit note with status: draft');
    expect(await row(id)).toMatchObject({ status: 'draft', cancelled_by: null, cancelled_at: null });
    expect(await journalCount()).toBe(before);
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('an MCP cancel leaves an audit row naming the agent and token; a dry run or a refusal leaves none', async () => {
    const id = await seedNote({ type: 'customer' });
    await cancel(id, { dry_run: true });
    const corrupt = await seedNote({ journal: true });
    await cancel(corrupt);
    expect(await auditRows(id)).toHaveLength(0);
    expect(await auditRows(corrupt)).toHaveLength(0);
    await cancel(id, { reason: 'dup' });
    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: fx.userId, action: 'update', entity_type: 'credit_note' });
    expect(rows[0]!.changes.fields).toEqual([
      { field: 'status', old: 'draft', new: 'cancelled', label: 'status' },
      { field: 'cancel_reason', old: null, new: 'dup', label: 'cancel_reason' },
    ]);
    expect(rows[0]!.changes.metadata).toEqual({ source: 'mcp:cancel_credit_note:v1', actor_type: 'agent', actor_token_jti: 'jti' });
  });

  it('a second cancel is refused: a cancelled note stays cancelled', async () => {
    const id = await seedNote();
    await cancel(id);
    const again = await cancel(id);
    expect(again.isError).toBe(true);
    expect(text(again)).toContain('status: cancelled');
  });

  it('a "draft" with a GL journal is corrupt state: refused (the delete\'s text), kept a draft, no stamps', async () => {
    const id = await seedNote({ journal: true });
    const r = await cancel(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('is a draft but carries a ledger journal');
    expect(text(r)).toContain('it was not cancelled:');
    expect(await row(id)).toMatchObject({ status: 'draft', cancelled_by: null, cancelled_at: null });
  });

  it('a "draft" with applied_amount is corrupt state: refused and kept', async () => {
    const id = await seedNote({ applied: 10 });
    const r = await cancel(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('already has credit applied or allocated');
    expect((await row(id))!.status).toBe('draft');
  });

  it('a "draft" with an allocation row is corrupt state: refused, kept, the row survives', async () => {
    const inv = await seedInvoice(fx, { number: 'I2', date: '2026-03-01', total: 230 });
    const id = await seedNote({ invoice: inv });
    await sql`INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
      VALUES (${fx.companyId}::UUID, ${id}::UUID, ${inv}::UUID, 10)`;
    const r = await cancel(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('credit applied or allocated');
    expect((await row(id))!.status).toBe('draft');
    expect(await allocCount(id)).toBe(1);
  });

  it('a note a dispute points at is refused and kept', async () => {
    const inv = await seedInvoice(fx, { number: 'I3', date: '2026-03-01', total: 230 });
    const id = await seedNote({ invoice: inv });
    await sql`INSERT INTO customer_invoice_disputes (company_id, customer_invoice_id, reason, raised_by, status, credit_note_id, disputed_amount)
      VALUES (${fx.companyId}::UUID, ${inv}::UUID, 'x', 'int', 'resolved', ${id}::UUID, 115)`;
    const r = await cancel(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('dispute');
    expect((await row(id))!.status).toBe('draft');
  });

  it('a pending approval request refuses the cancel; a decided one does not', async () => {
    const id = await seedNote({ type: 'supplier' });
    await sql`INSERT INTO approval_requests (document_type, document_id, status, requested_by, company_id)
      VALUES ('supplier_credit_note', ${id}::UUID, 'pending', ${fx.userId}::UUID, ${fx.companyId}::UUID)`;
    const r = await cancel(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('pending approval request');
    expect((await row(id))!.status).toBe('draft');
    await sql`UPDATE approval_requests SET status = 'rejected' WHERE document_id = ${id}::UUID`;
    expect((await cancel(id)).isError).toBeFalsy();
    expect((await row(id))!.status).toBe('cancelled');
  });

  it('another company\'s id reads exactly like a missing one, and the row survives as a draft', async () => {
    const id = await seedNote({ f: other });
    const foreign = await cancel(id);
    const missing = await cancel('00000000-0000-4000-8000-0000000000ff');
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toBe('Not found');
    expect(text(foreign)).toBe(text(missing));
    expect((await row(id))!.status).toBe('draft');
  });

  it('dry_run runs every guard, keeps the key free, and changes nothing', async () => {
    const id = await seedNote();
    const before = await journalCount();
    const dry = await cancel(id, { dry_run: true, reason: 'x' });
    expect(dry.wroteNothing).toBe(true);
    expect(JSON.parse(text(dry))).toMatchObject({ dry_run: true, would_cancel: { status: 'cancelled', journal_reversed: false } });
    expect(await row(id)).toMatchObject({ status: 'draft', cancelled_by: null, cancelled_at: null, cancel_reason: null });
    expect(await journalCount()).toBe(before);

    for (const [corrupt, needle] of [[await seedNote({ journal: true }), 'ledger journal'], [await seedNote({ applied: 5 }), 'applied or allocated']] as const) {
      const dryRefused = await cancel(corrupt, { dry_run: true });
      const liveRefused = await cancel(corrupt);
      expect(dryRefused.isError).toBe(true);
      expect(text(dryRefused)).toContain(needle);
      expect(text(dryRefused)).toBe(text(liveRefused));
      expect(dryRefused.wroteNothing).toBeUndefined();
    }
    expect((await cancel(id)).isError).toBeFalsy();
    expect((await row(id))!.status).toBe('cancelled');
  });

  it('an approval committed while the cancel waits for the row is refused, not cancelled as a draft', async () => {
    const id = await seedNote();
    const approver = await fx.pool.connect();
    const canceller = await fx.pool.connect();
    try {
      await approver.query('BEGIN');
      await approver.query('SELECT id FROM credit_notes WHERE id = $1 FOR UPDATE', [id]);
      await approver.query(`UPDATE credit_notes SET status = 'approved' WHERE id = $1`, [id]);

      await canceller.query('BEGIN');
      const pid = await backendPid(canceller);
      const pending = runOn(fx, canceller, () => cancelCreditNoteTool.handler({ credit_note_id: id, ...KEY }, ctxFor(fx)));
      await waitUntilBlocked(fx.pool, pid);
      await approver.query('COMMIT');

      const r = await pending;
      await canceller.query('COMMIT');
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('approved');
      expect((await row(id))!.status).toBe('approved');
    } finally {
      await approver.query('ROLLBACK').catch(() => undefined);
      await canceller.query('ROLLBACK').catch(() => undefined);
      approver.release();
      canceller.release();
    }
  }, 30000);

  it('a real approveCreditNote that waits behind the cancel finds it cancelled and posts nothing', async () => {
    const id = await seedNote({ type: 'customer' });
    const before = await journalCount();
    const canceller = await fx.pool.connect();
    const approver = await fx.pool.connect();
    try {
      await canceller.query('BEGIN');
      const done = await runOn(fx, canceller, () => cancelCreditNoteTool.handler({ credit_note_id: id, ...KEY }, ctxFor(fx)));
      expect(done.isError).toBeFalsy();

      await approver.query('BEGIN');
      const pid = await backendPid(approver);
      const pending = runOn(fx, approver, () => approveCreditNote(fx.companyId, id, fx.userId));
      const settled = pending.then(() => 'approved', (e: Error) => e.message);
      await waitUntilBlocked(fx.pool, pid);
      await canceller.query('COMMIT');

      expect(await settled).toMatch(/status: cancelled/);
      await approver.query('ROLLBACK');
      expect((await row(id))!.status).toBe('cancelled');
      expect(await journalCount()).toBe(before);
    } finally {
      await canceller.query('ROLLBACK').catch(() => undefined);
      await approver.query('ROLLBACK').catch(() => undefined);
      canceller.release();
      approver.release();
    }
  }, 30000);

  it('a peer holding the row past the lock budget gets the retry error, and the note stays a draft', async () => {
    const id = await seedNote();
    const holder = await fx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM credit_notes WHERE id = $1 FOR UPDATE', [id]);
      await expect(cancel(id)).rejects.toThrow(/being processed by another request/);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect((await row(id))!.status).toBe('draft');
  }, 30000);

  it('through the REAL registry: a dry run frees the idempotency key, the live call with the same key then cancels', async () => {
    const id = await seedNote({ type: 'customer' });
    const registry = new McpRegistry();
    registry.register(cancelCreditNoteTool);
    const key = `reg-${id}`;
    const call = (extra: Record<string, unknown>) =>
      inTx(fx, () => registry.call('cancel_credit_note', { credit_note_id: id, idempotency_key: key, ...extra }, ctxFor(fx)));

    const dry = await call({ dry_run: true });
    expect(dry.isError).toBeFalsy();
    expect(JSON.parse(text(dry))).toMatchObject({ dry_run: true, would_cancel: { status: 'cancelled' } });
    expect((await row(id))!.status).toBe('draft');

    const live = await call({});
    expect(live.isError).toBeFalsy();
    expect(JSON.parse(text(live))).toMatchObject({ id, status: 'cancelled', journal_reversed: false });
    expect(JSON.parse(text(live))).not.toHaveProperty('dry_run'); // not the dry run's reply served back as a replay
    expect(await row(id)).toMatchObject({ status: 'cancelled', cancelled_by: fx.userId });
    const logged = (await sql`SELECT status, idempotency_key FROM mcp_tool_calls WHERE company_id = ${fx.companyId}::UUID AND tool = 'cancel_credit_note'
      AND args_hash IS NOT NULL ORDER BY created_at`) as { status: string; idempotency_key: string | null }[];
    expect(logged.filter((r) => r.idempotency_key === key)).toHaveLength(1); // only the live call holds the key
  });

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

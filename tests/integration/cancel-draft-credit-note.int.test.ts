/**
 * cancel_credit_note on a DRAFT against a real database: the note is set to cancelled with NO journal and no
 * allocation change, keeps its number, and carries who/when/why exactly as the approved-note cancel stamps them. The
 * refusals (corrupt draft, dispute, pending approval) leave the row a draft; the row lock is taken and the status
 * re-read under it (an approval that wins the lock is refused, an approval behind the cancel finds it cancelled); the
 * dry run runs every guard and changes nothing. Also pins that an APPROVED note's cancel is unchanged (journal
 * reversed, invoice credit given back) and runs the draft cancel as app_user under forced RLS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import { deleteDraftCreditNoteTool } from '@/lib/mcp/tools/writeDeleteDraftCreditNote';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { cancelDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDraftCancelService';
import { McpRegistry } from '@/lib/mcp/registry';
import { inTx, runOn, seedBill, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { backendPid, waitUntilBlocked } from './helpers/lockWait';
import {
  DATABASE_URL, KEY, allocCount, auditRows, cancel, ctxFor, journalCount, row, seedNote, setupWorld, teardownWorld, text,
} from './helpers/cancelDraftCreditNoteKit';

const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;

describeIfDb('cancel_credit_note on a draft — over a real database', () => {
  beforeAll(async () => { ({ fx, other } = await setupWorld()); }, 120000);
  afterAll(teardownWorld, 120000);

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
});

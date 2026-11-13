/**
 * delete_draft_credit_note against a real database: the row lock and the status re-read inside it (a concurrent
 * approve either blocks the delete or finds the note gone), the dependent rows (cascades, the detached attachments,
 * the refusals for a dispute / pending approval / corrupt "draft"), tenant fencing, the dry run's parity, and the
 * delete running as app_user under forced RLS. Also the census of everything that references credit_notes: a new
 * referencing table fails here until the delete decides what to do with it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { deleteDraftCreditNoteTool } from '@/lib/mcp/tools/writeDeleteDraftCreditNote';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, runOn, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { backendPid, waitUntilBlocked } from './helpers/lockWait';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
const KEY = { idempotency_key: 'k-int' };
const ctxFor = (f: Fixture, companyRole = 'owner') => ({ companyId: f.companyId, userId: f.userId, tokenJti: 'jti', companyRole }) as unknown as McpToolContext;
const del = (id: string, extra: Record<string, unknown> = {}, f: Fixture = fx) =>
  inTx(f, () => deleteDraftCreditNoteTool.handler({ credit_note_id: id, ...KEY, ...extra }, ctxFor(f)));
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
      credit_date, subtotal, tax_rate, tax_amount, total_amount, applied_amount, status, created_by, gl_journal_entry_id, reason, external_ref)
    VALUES (${f.companyId}::UUID, ${type}, ${type === 'customer' ? f.customerId : null}::UUID, ${type === 'supplier' ? f.supplierId : null}::UUID,
      ${over.invoice ?? null}::UUID, ${over.bill ?? null}::UUID, ${over.number ?? `CN-2026-${90000 + ++seq}`}, '2026-03-01'::DATE, 100, 15, 15, 115,
      ${over.applied ?? 0}, ${over.status ?? 'draft'}, ${f.userId}::UUID, ${je}::UUID, 'int test', 'EXT-1')
    RETURNING id`) as { id: string }[])[0]!.id;
}

async function exists(id: string): Promise<boolean> {
  return ((await sql`SELECT 1 FROM credit_notes WHERE id = ${id}::UUID`) as unknown[]).length === 1;
}
async function statusOf(id: string): Promise<string | null> {
  const r = (await sql`SELECT status FROM credit_notes WHERE id = ${id}::UUID`) as { status: string }[];
  return r[0]?.status ?? null;
}
async function journalCount(): Promise<number> {
  return Number(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as { n: string }[])[0]!.n);
}
async function auditRows(id: string) {
  return (await sql`SELECT user_id, action, entity_type, entity_ref, changes FROM audit_log WHERE entity_id = ${id}::UUID`) as
    { user_id: string; action: string; entity_type: string; entity_ref: string; changes: { fields: { field: string; old: string | null }[]; metadata: Record<string, string> } }[];
}
async function attach(id: string): Promise<string> {
  return ((await sql`
    INSERT INTO procurement_documents (entity_type, entity_id, document_name, uploaded_by)
    VALUES ('credit_note', ${id}::UUID, 'scan.pdf', 'int') RETURNING id`) as { id: string }[])[0]!.id;
}

describeIfDb('delete_draft_credit_note — over a real database', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and deletes credit notes.');
    fx = await seedFixture('DDC', DATABASE_URL!);
    other = await seedFixture('DDX', DATABASE_URL!);
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
      await sql`DELETE FROM procurement_documents WHERE entity_id IN (SELECT id FROM credit_notes WHERE company_id = ${f.companyId}::UUID)`;
      await sql`DELETE FROM credit_note_allocations WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM credit_notes WHERE company_id = ${f.companyId}::UUID`;
      await dropFixture(f);
      await sql`DELETE FROM users WHERE id = ${f.userId}`;
    }
  }, 120000);

  it('deletes a customer draft: the row is gone, no journal is written, the reply carries the values to re-create it', async () => {
    const id = await seedNote({ type: 'customer' });
    const before = await journalCount();
    const r = await del(id);
    expect(r.isError).toBeFalsy();
    expect(await exists(id)).toBe(false);
    expect(await journalCount()).toBe(before);
    const body = JSON.parse(text(r));
    expect(body).toMatchObject({ deleted: true, restorable: false });
    expect(body.deleted_note).toMatchObject({ credit_note_id: id, type: 'customer', total_amount: 115, credit_date: '2026-03-01', external_ref: 'EXT-1', client_id: fx.customerId });
  });

  it('writes an audit_log delete row with the note\'s values in the same transaction; none for a dry run or a refusal', async () => {
    const id = await seedNote({ type: 'customer' });
    await del(id, { dry_run: true });
    expect(await auditRows(id)).toHaveLength(0);
    const approved = await seedNote({ status: 'approved', journal: true });
    await del(approved);
    expect(await auditRows(approved)).toHaveLength(0);

    await del(id);
    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: fx.userId, action: 'delete', entity_type: 'credit_note' });
    const f = Object.fromEntries(rows[0]!.changes.fields.map((x) => [x.field, x.old]));
    expect(f).toMatchObject({ credit_note_number: rows[0]!.entity_ref, total_amount: '115', client_id: fx.customerId, external_ref: 'EXT-1', status: 'draft' });
    expect(rows[0]!.changes.metadata.source).toBe('mcp:delete_draft_credit_note');
  });

  it('a delete whose transaction rolls back leaves neither the note nor an audit row', async () => {
    const id = await seedNote({ type: 'customer' });
    const c = await fx.pool.connect();
    try {
      await c.query('BEGIN');
      await runOn(fx, c, () => deleteDraftCreditNoteTool.handler({ credit_note_id: id, ...KEY }, ctxFor(fx)));
      await c.query('ROLLBACK');
    } finally { c.release(); }
    expect(await exists(id)).toBe(true);
    expect(await auditRows(id)).toHaveLength(0);
  });

  it('a draft numbered from the supplier return sequence is refused, kept and not audited', async () => {
    const id = await seedNote({ type: 'supplier', number: 'RTN0000042' });
    const r = await del(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('supplier return sequence');
    expect(await exists(id)).toBe(true);
    expect(await auditRows(id)).toHaveLength(0);
    expect(text(await del(id, { dry_run: true }))).toBe(text(r));
  });

  it('a manager is refused before any read: the draft survives, dry run and live', async () => {
    const id = await seedNote({ type: 'customer' });
    for (const extra of [{}, { dry_run: true }]) {
      const r = await inTx(fx, () => deleteDraftCreditNoteTool.handler({ credit_note_id: id, ...KEY, ...extra }, ctxFor(fx, 'manager')));
      expect(text(r)).toBe('Only an owner or admin can delete a draft credit note.');
    }
    expect(await exists(id)).toBe(true);
  });

  it('deletes a supplier draft linked to a bill and leaves the bill untouched', async () => {
    const bill = await seedBill(fx, { number: 'B1', date: '2026-03-01', total: 230 });
    const id = await seedNote({ type: 'supplier', bill });
    expect((await del(id)).isError).toBeFalsy();
    expect(await exists(id)).toBe(false);
    const b = ((await sql`SELECT status, amount_paid FROM supplier_invoices WHERE id = ${bill}::UUID`) as { status: string; amount_paid: string }[])[0]!;
    expect({ status: b.status, paid: Number(b.amount_paid) }).toEqual({ status: 'approved', paid: 0 });
  });

  it('leaves a customer invoice linked to the draft untouched', async () => {
    const inv = await seedInvoice(fx, { number: 'I1', date: '2026-03-01', total: 230 });
    const id = await seedNote({ type: 'customer', invoice: inv });
    expect((await del(id)).isError).toBeFalsy();
    const i = ((await sql`SELECT status, amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as { status: string; amount_paid: string }[])[0]!;
    expect({ status: i.status, paid: Number(i.amount_paid) }).toEqual({ status: 'sent', paid: 0 });
  });

  it.each(['approved', 'partially_applied', 'applied'])('%s is refused with a pointer to cancel_credit_note and survives', async (status) => {
    const id = await seedNote({ status, journal: true, applied: status === 'approved' ? 0 : 10 });
    const r = await del(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('cancel_credit_note');
    expect(await statusOf(id)).toBe(status);
  });

  it('a cancelled note is refused and survives', async () => {
    const id = await seedNote({ status: 'cancelled' });
    const r = await del(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('already cancelled');
    expect(await exists(id)).toBe(true);
  });

  it('a "draft" with a GL journal is corrupt state: refused and kept', async () => {
    const id = await seedNote({ status: 'draft', journal: true });
    const r = await del(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('ledger journal');
    expect(await exists(id)).toBe(true);
  });

  it('a "draft" with an allocation row is corrupt state: refused, and the cascade never runs', async () => {
    const inv = await seedInvoice(fx, { number: 'I2', date: '2026-03-01', total: 230 });
    const id = await seedNote({ type: 'customer', invoice: inv });
    await sql`INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
      VALUES (${fx.companyId}::UUID, ${id}::UUID, ${inv}::UUID, 10)`;
    const r = await del(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('credit applied or allocated');
    expect(await exists(id)).toBe(true);
    expect(((await sql`SELECT 1 FROM credit_note_allocations WHERE credit_note_id = ${id}::UUID`) as unknown[]).length).toBe(1);
  });

  it('a note a dispute points at is refused and kept', async () => {
    const inv = await seedInvoice(fx, { number: 'I3', date: '2026-03-01', total: 230 });
    const id = await seedNote({ type: 'customer', invoice: inv });
    await sql`INSERT INTO customer_invoice_disputes (company_id, customer_invoice_id, reason, raised_by, status, credit_note_id, disputed_amount)
      VALUES (${fx.companyId}::UUID, ${inv}::UUID, 'x', 'int', 'resolved', ${id}::UUID, 115)`;
    const r = await del(id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('dispute');
    expect(await exists(id)).toBe(true);
  });

  it('a pending approval request refuses the delete; a decided one stays behind as history', async () => {
    const id = await seedNote({ type: 'supplier' });
    await sql`INSERT INTO approval_requests (document_type, document_id, status, requested_by, company_id)
      VALUES ('supplier_credit_note', ${id}::UUID, 'pending', ${fx.userId}::UUID, ${fx.companyId}::UUID)`;
    expect(text(await del(id))).toContain('pending approval request');
    expect(await exists(id)).toBe(true);
    await sql`UPDATE approval_requests SET status = 'rejected' WHERE document_id = ${id}::UUID`;
    expect((await del(id)).isError).toBeFalsy();
    expect(((await sql`SELECT 1 FROM approval_requests WHERE document_id = ${id}::UUID`) as unknown[]).length).toBe(1);
  });

  it('detaches the attachments (is_active = false, file row kept) in the same delete', async () => {
    const id = await seedNote({ type: 'customer' });
    const doc = await attach(id);
    const r = await del(id);
    expect(JSON.parse(text(r)).deleted_note.attachments_detached).toBe(1);
    const d = ((await sql`SELECT is_active FROM procurement_documents WHERE id = ${doc}::UUID`) as { is_active: boolean }[])[0]!;
    expect(d.is_active).toBe(false);
  });

  it('another company\'s id reads exactly like a missing one, and the row survives', async () => {
    const id = await seedNote({ f: other });
    const foreign = await del(id);
    const missing = await del('00000000-0000-4000-8000-0000000000ff');
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toBe('Not found');
    expect(text(foreign)).toBe(text(missing));
    expect(await exists(id)).toBe(true);
  });

  it('dry_run runs every guard, keeps the key free, and changes nothing (row, attachments)', async () => {
    const id = await seedNote({ type: 'customer' });
    const doc = await attach(id);
    const dry = await del(id, { dry_run: true });
    expect(dry.wroteNothing).toBe(true);
    expect(JSON.parse(text(dry))).toMatchObject({ dry_run: true, restorable: false });
    expect(await exists(id)).toBe(true);
    expect(((await sql`SELECT is_active FROM procurement_documents WHERE id = ${doc}::UUID`) as { is_active: boolean }[])[0]!.is_active).toBe(true);

    const approved = await seedNote({ status: 'approved', journal: true });
    const dryRefused = await del(approved, { dry_run: true });
    const liveRefused = await del(approved);
    expect(dryRefused.isError).toBe(true);
    expect(text(dryRefused)).toBe(text(liveRefused));

    expect((await del(id)).isError).toBeFalsy();
    expect(await exists(id)).toBe(false);
  });

  it('an approval committed while the delete waits for the row is refused, not deleted', async () => {
    const id = await seedNote({ type: 'customer' });
    const approver = await fx.pool.connect();
    const deleter = await fx.pool.connect();
    try {
      await approver.query('BEGIN');
      await approver.query(`SELECT id FROM credit_notes WHERE id = $1 FOR UPDATE`, [id]);
      await approver.query(`UPDATE credit_notes SET status = 'approved' WHERE id = $1`, [id]);

      await deleter.query('BEGIN');
      const pid = await backendPid(deleter);
      const pending = runOn(fx, deleter, () => deleteDraftCreditNoteTool.handler({ credit_note_id: id, ...KEY }, ctxFor(fx)));
      await waitUntilBlocked(fx.pool, pid);
      await approver.query('COMMIT');

      const r = await pending;
      await deleter.query('COMMIT');
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('approved');
      expect(await statusOf(id)).toBe('approved');
    } finally {
      await approver.query('ROLLBACK').catch(() => undefined);
      await deleter.query('ROLLBACK').catch(() => undefined);
      approver.release();
      deleter.release();
    }
  }, 30000);

  it('a real approveCreditNote that waits behind the delete finds the note gone and posts nothing', async () => {
    const id = await seedNote({ type: 'customer' });
    const before = await journalCount();
    const deleter = await fx.pool.connect();
    const approver = await fx.pool.connect();
    try {
      await deleter.query('BEGIN');
      const done = await runOn(fx, deleter, () => deleteDraftCreditNoteTool.handler({ credit_note_id: id, ...KEY }, ctxFor(fx)));
      expect(done.isError).toBeFalsy();

      await approver.query('BEGIN');
      const pid = await backendPid(approver);
      const pending = runOn(fx, approver, () => approveCreditNote(fx.companyId, id, fx.userId));
      const settled = pending.then(() => 'approved', (e: Error) => e.message);
      await waitUntilBlocked(fx.pool, pid);
      await deleter.query('COMMIT');

      expect(await settled).toMatch(/not found/i);
      await approver.query('ROLLBACK');
      expect(await exists(id)).toBe(false);
      expect(await journalCount()).toBe(before);
    } finally {
      await deleter.query('ROLLBACK').catch(() => undefined);
      await approver.query('ROLLBACK').catch(() => undefined);
      deleter.release();
      approver.release();
    }
  }, 30000);

  it('a peer holding the row past the lock budget gets the retry error, and the note survives', async () => {
    const id = await seedNote({ type: 'customer' });
    const holder = await fx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM credit_notes WHERE id = $1 FOR UPDATE', [id]);
      await expect(del(id)).rejects.toThrow(/being processed by another request/);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await statusOf(id)).toBe('draft');
  }, 30000);

  it('runs as app_user under forced RLS: grants and policies allow the delete and the detach', async () => {
    const id = await seedNote({ type: 'customer' });
    const doc = await attach(id);
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}::UUID, 'owner')
      ON CONFLICT DO NOTHING`;
    const c: PoolClient = await fx.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [fx.companyId]);
      const r = await runOn(fx, c, () => deleteDraftCreditNoteTool.handler({ credit_note_id: id, ...KEY }, ctxFor(fx)));
      expect(text(r)).toContain('"deleted":true');
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(await exists(id)).toBe(false);
    expect(((await sql`SELECT is_active FROM procurement_documents WHERE id = ${doc}::UUID`) as { is_active: boolean }[])[0]!.is_active).toBe(false);
  }, 30000);

  it('census: the only tables that reference a credit note are the ones the delete accounts for', async () => {
    const fks = (await sql`
      SELECT DISTINCT conrelid::regclass::TEXT AS t, confdeltype AS d FROM pg_constraint
      WHERE confrelid = 'public.credit_notes'::regclass AND contype = 'f' ORDER BY 1`) as { t: string; d: string }[];
    // All CASCADE ('c'): a draft owns none of them, and the delete refuses if one exists.
    expect(fks).toEqual([
      { t: 'credit_note_allocations', d: 'c' },
      { t: 'credit_note_expense_allocations', d: 'c' },
      { t: 'credit_note_revenue_allocations', d: 'c' },
    ]);
    const cols = (await sql`
      SELECT table_name AS t FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'credit_note_id' ORDER BY 1`) as { t: string }[];
    expect(cols.map((r) => r.t)).toEqual([
      'credit_note_allocations', 'credit_note_expense_allocations', 'credit_note_revenue_allocations',
      'customer_invoice_disputes', // no FK: the delete refuses a note a dispute names
    ]);
  });
});

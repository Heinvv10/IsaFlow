/**
 * The draft cancel against an approval request raised at the same moment, on real concurrent request transactions
 * (app_user, forced RLS). The cancel reads "any pending request?" under the note's row lock; raising a request takes
 * the note FOR SHARE (`approvalDocuments.raiseOnce`), so the two serialise whichever starts first:
 *   - cancel in flight, raise arrives: the raise waits, then finds the note cancelled and is refused (no request row);
 *   - raise in flight, cancel arrives: the cancel waits, then sees the pending request and is refused (still a draft).
 * Never both: a cancelled note with a pending request. Run for EVERY credit-note approval type the raise locks
 * (`approvalDocuments.CREDIT_NOTE_TYPES`): a type dropped from that set loses the lock and the refusal. Fixture route:
 * isaflow_schema_fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requestApproval } from '@/modules/accounting/services/gl/approvalDocuments';
import { ApprovalDocumentNotDraftError } from '@/modules/accounting/services/gl/approvalDocumentErrors';
import { cancelDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDraftCancelService';
import { CreditNoteDeleteRefusal } from '@/modules/accounting/services/ar/creditNoteDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { waitUntilBlocked } from './helpers/lockWait';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;
let customer: string;

/** The approval types a credit note is raised under, and the kind of note each one resolves against. */
const TYPES = [
  { type: 'supplier_credit_note', note: 'supplier' },
  { type: 'customer_credit_note', note: 'customer' },
  { type: 'credit_note', note: 'customer' }, // the legacy type: resolves any note, the fixture row is a customer note
] as const;
type CnType = (typeof TYPES)[number];

beforeAll(async () => {
  f = await seedBillFixture(pool, 'cn-cancel-race');
  for (const t of TYPES) {
    await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
                      VALUES (gen_random_uuid(),$1,$2,$3,'amount','any',0,'owner',true)`, [f.co, `cn any ${t.type}`, t.type]);
  }
  customer = String((await pool.query("INSERT INTO customers (company_id, name) VALUES ($1, 'cn race customer') RETURNING id", [f.co])).rows[0].id);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM approval_requests WHERE company_id = $1', [f.co]);
    await pool.query("DELETE FROM approval_rules WHERE document_type <> 'pay_run' AND company_id = $1", [f.co]);
    await pool.query('DELETE FROM credit_notes WHERE company_id = $1', [f.co]);
    await pool.query('DELETE FROM customers WHERE company_id = $1', [f.co]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

let n = 0;
async function draft(kind: CnType['note']): Promise<string> {
  return String((await pool.query(
    `INSERT INTO credit_notes (company_id, type, supplier_id, client_id, credit_note_number, credit_date, subtotal, tax_rate, tax_amount, total_amount, status, created_by)
     VALUES ($1, $2, $3, $4, $5, '2026-06-15', 100, 15, 15, 115, 'draft', $6) RETURNING id`,
    [f.co, kind, kind === 'supplier' ? f.supplier : null, kind === 'customer' ? customer : null, `CN-2026-${60000 + ++n}`, f.owner])).rows[0].id);
}
const statusOf = async (id: string) => String((await pool.query('SELECT status FROM credit_notes WHERE id = $1', [id])).rows[0].status);
const requestsFor = async (id: string) => Number((await pool.query('SELECT COUNT(*) AS n FROM approval_requests WHERE document_id = $1', [id])).rows[0].n);

describe.each(TYPES)('a draft cancel and an approval request raised together ($type)', ({ type, note }) => {
  it('cancel in flight: the raise waits, then is refused as not a draft, and no request row exists', async () => {
    const id = await draft(note);
    const tCancel = await openRequest(pool, f, f.owner);
    const tRaise = await openRequest(pool, f, f.manager);
    try {
      await tCancel.run(() => cancelDraftCreditNote(f.co, id, f.owner)); // holds the row, uncommitted
      const raising = tRaise.run(() => requestApproval(f.co, { documentType: type, documentId: id, requestedBy: f.manager }))
        .then(() => 'raised', (e: unknown) => e);
      await waitUntilBlocked(pool, tRaise.pid);
      await tCancel.commit();
      const out = await raising;
      expect(out).toBeInstanceOf(ApprovalDocumentNotDraftError);
      expect((out as Error).message).toContain('is cancelled, not a draft');
      await tRaise.rollback();
      expect({ status: await statusOf(id), requests: await requestsFor(id) }).toEqual({ status: 'cancelled', requests: 0 });
    } finally { await tCancel.rollback(); await tRaise.rollback(); }
  }, 30_000);

  it('raise in flight: the cancel waits, then is refused for the pending request, and the note stays a draft', async () => {
    const id = await draft(note);
    const tRaise = await openRequest(pool, f, f.manager);
    const tCancel = await openRequest(pool, f, f.owner);
    try {
      await tRaise.run(() => requestApproval(f.co, { documentType: type, documentId: id, requestedBy: f.manager }));
      const cancelling = tCancel.run(() => cancelDraftCreditNote(f.co, id, f.owner)).then(() => 'cancelled', (e: unknown) => e);
      await waitUntilBlocked(pool, tCancel.pid);
      await tRaise.commit();
      const out = await cancelling;
      expect(out).toBeInstanceOf(CreditNoteDeleteRefusal);
      expect((out as CreditNoteDeleteRefusal).code).toBe('APPROVAL_PENDING');
      await tCancel.rollback();
      expect({ status: await statusOf(id), requests: await requestsFor(id) }).toEqual({ status: 'draft', requests: 1 });
    } finally { await tRaise.rollback(); await tCancel.rollback(); }
  }, 30_000);

  it('a request on a note that is not a draft is refused before any row (approved)', async () => {
    const id = await draft(note);
    await pool.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [id]);
    const t = await openRequest(pool, f, f.manager);
    try {
      await expect(t.run(() => requestApproval(f.co, { documentType: type, documentId: id, requestedBy: f.manager })))
        .rejects.toBeInstanceOf(ApprovalDocumentNotDraftError);
    } finally { await t.rollback(); }
    expect(await requestsFor(id)).toBe(0);
  }, 30_000);

  it('a re-raise on a note approved behind a still-pending request is a refusal; the old request is left exactly as it was', async () => {
    const id = await draft(note);
    const first = await openRequest(pool, f, f.manager);
    try {
      await first.run(() => requestApproval(f.co, { documentType: type, documentId: id, requestedBy: f.manager }));
      await first.commit();
    } finally { await first.rollback(); }
    const snapshot = async () => (await pool.query('SELECT to_jsonb(a) AS row FROM approval_requests a WHERE document_id = $1', [id])).rows.map((r) => r.row);
    const before = await snapshot();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ status: 'pending' });

    // Approved behind the request (enforcement is off for these rules, so nothing stops the status move).
    await pool.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [id]);

    const again = await openRequest(pool, f, f.manager);
    try {
      const err = await again.run(() => requestApproval(f.co, { documentType: type, documentId: id, requestedBy: f.manager })).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalDocumentNotDraftError);
      expect((err as ApprovalDocumentNotDraftError).code).toBe('DOCUMENT_NOT_DRAFT');
      expect((err as Error).message).toContain('is approved, not a draft');
    } finally { await again.rollback(); }
    expect(await snapshot()).toEqual(before); // not re-bound, not duplicated, not touched
  }, 30_000);

  it('a request on a draft still raises normally', async () => {
    const id = await draft(note);
    const t = await openRequest(pool, f, f.manager);
    try {
      const r = await t.run(() => requestApproval(f.co, { documentType: type, documentId: id, requestedBy: f.manager }));
      expect(r.status).toBe('pending');
      await t.commit();
    } finally { await t.rollback(); }
    expect(await requestsFor(id)).toBe(1);
  }, 30_000);
});

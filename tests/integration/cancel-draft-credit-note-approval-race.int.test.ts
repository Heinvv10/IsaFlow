/**
 * The draft cancel against an approval request raised at the same moment, on real concurrent request transactions
 * (app_user, forced RLS). The cancel reads "any pending request?" under the note's row lock; raising a request takes
 * the note FOR SHARE (`approvalDocuments.raiseOnce`), so the two serialise whichever starts first:
 *   - cancel in flight, raise arrives: the raise waits, then finds the note cancelled and is refused (no request row);
 *   - raise in flight, cancel arrives: the cancel waits, then sees the pending request and is refused (still a draft).
 * Never both: a cancelled note with a pending request. Fixture route: isaflow_schema_fixture.
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

beforeAll(async () => {
  f = await seedBillFixture(pool, 'cn-cancel-race');
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
                    VALUES (gen_random_uuid(),$1,'cn any','supplier_credit_note','amount','any',0,'owner',true)`, [f.co]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM approval_requests WHERE company_id = $1', [f.co]);
    await pool.query("DELETE FROM approval_rules WHERE document_type <> 'pay_run' AND company_id = $1", [f.co]);
    await pool.query('DELETE FROM credit_notes WHERE company_id = $1', [f.co]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

let n = 0;
async function draft(): Promise<string> {
  return String((await pool.query(
    `INSERT INTO credit_notes (company_id, type, supplier_id, credit_note_number, credit_date, subtotal, tax_rate, tax_amount, total_amount, status, created_by)
     VALUES ($1, 'supplier', $2, $3, '2026-06-15', 100, 15, 15, 115, 'draft', $4) RETURNING id`,
    [f.co, f.supplier, `CN-2026-${60000 + ++n}`, f.owner])).rows[0].id);
}
const statusOf = async (id: string) => String((await pool.query('SELECT status FROM credit_notes WHERE id = $1', [id])).rows[0].status);
const requestsFor = async (id: string) => Number((await pool.query('SELECT COUNT(*) AS n FROM approval_requests WHERE document_id = $1', [id])).rows[0].n);

describe('a draft cancel and an approval request raised together', () => {
  it('cancel in flight: the raise waits, then is refused as not a draft, and no request row exists', async () => {
    const id = await draft();
    const tCancel = await openRequest(pool, f, f.owner);
    const tRaise = await openRequest(pool, f, f.manager);
    try {
      await tCancel.run(() => cancelDraftCreditNote(f.co, id, f.owner)); // holds the row, uncommitted
      const raising = tRaise.run(() => requestApproval(f.co, { documentType: 'supplier_credit_note', documentId: id, requestedBy: f.manager }))
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
    const id = await draft();
    const tRaise = await openRequest(pool, f, f.manager);
    const tCancel = await openRequest(pool, f, f.owner);
    try {
      await tRaise.run(() => requestApproval(f.co, { documentType: 'supplier_credit_note', documentId: id, requestedBy: f.manager }));
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
    const id = await draft();
    await pool.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [id]);
    const t = await openRequest(pool, f, f.manager);
    try {
      await expect(t.run(() => requestApproval(f.co, { documentType: 'supplier_credit_note', documentId: id, requestedBy: f.manager })))
        .rejects.toBeInstanceOf(ApprovalDocumentNotDraftError);
    } finally { await t.rollback(); }
    expect(await requestsFor(id)).toBe(0);
  }, 30_000);

  it('a request on a draft still raises normally', async () => {
    const id = await draft();
    const t = await openRequest(pool, f, f.manager);
    try {
      const r = await t.run(() => requestApproval(f.co, { documentType: 'supplier_credit_note', documentId: id, requestedBy: f.manager }));
      expect(r.status).toBe('pending');
      await t.commit();
    } finally { await t.rollback(); }
    expect(await requestsFor(id)).toBe(1);
  }, 30_000);
});

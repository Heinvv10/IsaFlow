/**
 * Migration 923, separation of duties (Hein, 2026-10-23): whoever changes what the payment digest now covers is an
 * AUTHOR of the payments it changes, and may not approve them — as for a payee's bank details (R-035 PR5).
 *   - a payee rename the digest sees (updateSupplier): the renamer joins the payee's bank_details_setters and the
 *     authors of every draft / approved payment and batch paying them; a change of case or outer spaces stamps nothing;
 *   - an edit of the paying account's number or branch code (bank-accounts PUT): the editor joins the authors of every
 *     draft / approved batch and single payment paying from it; an edit of another column stamps nothing.
 * Judged by outcome: the approval decision through the real route, and the authors the gate reads. Disposable DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { authorsOf, cleanupPr5, enforcePay, inRequest, payCompany, plantBatch, plantBill, plantPayment, plantSupplier } from './r035-pr5.helpers';
import { digestKit } from './ap-batch-approved-digest.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const { r, fixture, approve } = digestKit(pool, u, tokens, companies);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => { submitEftBatch.mockReset(); });
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

const AUTHOR_REFUSED = 'SELF_APPROVAL_FORBIDDEN';
const rename = (c: string, supplierId: string, name: string) =>
  inRequest(pool, u.b, c, () => updateSupplier(c, supplierId, { name }, u.b));
const putAccount = (c: string, body: Record<string, unknown>) =>
  callRoute(bankAccounts, tokens[u.b]!, c, 'PUT', body, '/api/accounting/bank-accounts');
const payingAccountOf = async (batchId: string) => (await pool.query(
  'SELECT bank_account_id FROM supplier_payment_batches WHERE id = $1', [batchId])).rows[0].bank_account_id as string;
const setters = async (supplierId: string) => (await pool.query(
  'SELECT COALESCE(bank_details_setters::TEXT[], $2) AS s FROM suppliers WHERE id = $1', [supplierId, '{}'])).rows[0].s as string[];
const accountSetters = async (accountId: string) => (await pool.query(
  'SELECT COALESCE(bank_details_setters::TEXT[], $2) AS s FROM gl_accounts WHERE id = $1', [accountId, '{}'])).rows[0].s as string[];
/** An enforced company's draft batch, and its paying account. */
async function enforcedBatch() {
  const { c, b } = await fixture(true);
  return { c, b, bank: await payingAccountOf(b.id) };
}
/** u.a raises a request for the document's current content; u.b decides it. */
async function bDecides(c: string, type: 'payment_batch' | 'supplier_payment', id: string) {
  const raised = await r.raise(u.a, c, type, id);
  expect(raised.state.statusCode, JSON.stringify(raised.state.body)).toBe(200);
  return r.decide(pool, u.b, c, dataOf<{ id: string }>(raised).id);
}

describe('a payee rename makes the renamer an author', () => {
  it('control: the approver who changed the payee bank account may not approve it', async () => {
    const { c, b, supplierId } = await fixture(true);
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    await inRequest(pool, u.b, c, () => updateSupplier(c, supplierId, { bankAccountNumber: '62000007777' }, u.b));
    const res = await bDecides(c, 'payment_batch', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(403);
    expect(reasonOf(res)).toBe(AUTHOR_REFUSED);
  });

  it('the approver who renamed the payee may not approve the renamed batch', async () => {
    const { c, b, supplierId } = await fixture(true);
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    await rename(c, supplierId, 'MALLORY HOLDINGS');
    expect(await authorsOf(pool, c, 'payment_batch', b.id)).toContain(u.b);
    expect(await setters(supplierId)).toContain(u.b);
    const res = await bDecides(c, 'payment_batch', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(403);
    expect(reasonOf(res)).toBe(AUTHOR_REFUSED);
  });

  it('a change of case only stamps nothing: not an author, not a setter', async () => {
    const { c, b, supplierId } = await fixture(true);
    const { rows: [s] } = await pool.query('SELECT name FROM suppliers WHERE id = $1', [supplierId]);
    await rename(c, supplierId, String(s.name).toUpperCase());
    expect(await authorsOf(pool, c, 'payment_batch', b.id)).not.toContain(u.b);
    expect(await setters(supplierId)).not.toContain(u.b);
  });
});

describe('a paying-account edit makes the editor an author of what pays from it', () => {
  it('the approver who edited the account number or branch code may not approve the batch', async () => {
    for (const field of ['bankAccountNumber', 'bankBranchCode'] as const) {
      const { c, b } = await fixture(true);
      await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
      const put = await putAccount(c, { id: await payingAccountOf(b.id), [field]: field === 'bankAccountNumber' ? '40000009999' : '198765' });
      expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
      expect(await authorsOf(pool, c, 'payment_batch', b.id)).toContain(u.b);
      const res = await bDecides(c, 'payment_batch', b.id);
      expect(res.state.statusCode, `${field}: ${JSON.stringify(res.state.body)}`).toBe(403);
      expect(reasonOf(res)).toBe(AUTHOR_REFUSED);
    }
  });

  it('a single payment from the account: its editor may not approve it', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    await enforcePay(pool, c, 'supplier_payment', u.b);
    const p = await plantPayment(pool, c, u.a, bank);
    expect((await putAccount(c, { id: bank, bankAccountNumber: '40000009999' })).state.statusCode).toBe(200);
    expect(await authorsOf(pool, c, 'supplier_payment', p.id)).toContain(u.b);
    const res = await bDecides(c, 'supplier_payment', p.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(403);
    expect(reasonOf(res)).toBe(AUTHOR_REFUSED);
  });

  it('the same number re-sent, or another column, stamps nothing', async () => {
    const { c, b } = await fixture();
    const account = await payingAccountOf(b.id);
    expect((await putAccount(c, { id: account, bankAccountNumber: '40000000001', bankName: 'Renamed Bank' })).state.statusCode).toBe(200);
    expect(await authorsOf(pool, c, 'payment_batch', b.id)).not.toContain(u.b);
    expect(await accountSetters(account)).toEqual([]);
  });

  it('a processed batch, and a batch created after the edit, count the editor as an author (the account\'s setters)', async () => {
    const { c, b, bank } = await enforcedBatch();
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    await approve(c, b.id);
    expect((await r.batch(u.a, c, 'process', b.id)).state.statusCode).toBe(200);
    expect((await putAccount(c, { id: bank, bankAccountNumber: '40000009999' })).state.statusCode).toBe(200);
    const processed = await bDecides(c, 'payment_batch', b.id); // the re-approval the file now needs
    expect(processed.state.statusCode, JSON.stringify(processed.state.body)).toBe(403);
    expect(reasonOf(processed)).toBe(AUTHOR_REFUSED);
    const later = await plantBatch(pool, c, u.a, bank);
    expect(await authorsOf(pool, c, 'payment_batch', later.id)).toContain(u.b);
    const fresh = await bDecides(c, 'payment_batch', later.id);
    expect(fresh.state.statusCode, JSON.stringify(fresh.state.body)).toBe(403);
    expect(reasonOf(fresh)).toBe(AUTHOR_REFUSED);
  });

  it('a new number restarts the account\'s setters at its editor; a branch code appends', async () => {
    const { c, b } = await fixture();
    const account = await payingAccountOf(b.id);
    await callRoute(bankAccounts, tokens[u.a]!, c, 'PUT', { id: account, bankBranchCode: '198765' }, '/api/accounting/bank-accounts');
    expect(await accountSetters(account)).toEqual([u.a]);
    await putAccount(c, { id: account, bankBranchCode: '250655' });
    expect([...await accountSetters(account)].sort()).toEqual([u.a, u.b].sort());
    await putAccount(c, { id: account, bankAccountNumber: '40000009999' });
    expect(await accountSetters(account)).toEqual([u.b]);
    expect(await authorsOf(pool, c, 'payment_batch', b.id)).toContain(u.a); // stamped on what was in flight: kept
  });
});

describe('lock order between a payee edit and a paying-account edit', () => {
  it('a payee edit stamps its single payments in id order, as the account edit locks them (no 40P01 crossing)', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    const supplierId = await plantSupplier(pool, c);
    const tail = crypto.randomUUID().slice(-12);
    const [high, low] = [`ffffffff-ffff-4fff-bfff-${tail}`, `00000000-0000-4000-8000-${tail}`];
    for (const id of [high, low]) { // inserted high first: a scan meets it first
      const bill = await plantBill(pool, c, supplierId, u.a);
      await pool.query(
        `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,status,created_by)
         VALUES($1,$2,$3,DATE '2026-09-01',10,'eft',$4,'draft',$5)`, [id, c, supplierId, bank, u.a]);
      await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,10)', [id, bill]);
    }
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      await held.query('SELECT id FROM supplier_payments WHERE id = $1 FOR UPDATE', [low]);
      const holder = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const edit = inRequest(pool, u.b, c, () => updateSupplier(c, supplierId, { bankAccountNumber: '62000007777' }, u.b));
      let blocked = false;
      for (let i = 0; i < 500 && !blocked; i += 1) {
        blocked = !!(await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holder])).rowCount;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      // Waiting on the LOW row, the edit holds no lock on the high one.
      const highFree = await pool.query('SELECT id FROM supplier_payments WHERE id = $1 FOR UPDATE NOWAIT', [high])
        .then(() => true, (e: { code?: string }) => { if (e.code === '55P03') return false; throw e; });
      await held.query('COMMIT');
      await edit;
      expect(highFree).toBe(true);
    } finally {
      held.release(true);
    }
  });

  it('a Bank Accounts save that re-sends the same number and branch waits for no batch', async () => {
    const { c, b } = await fixture();
    const account = await payingAccountOf(b.id);
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      await held.query('SELECT id FROM supplier_payment_batches WHERE id = $1 FOR UPDATE', [b.id]);
      const put = await putAccount(c, { id: account, bankAccountNumber: '40000000001', bankBranchCode: '250655', description: 'x' });
      expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200); // not a 503 lock timeout
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
  });
});

/**
 * R-035 PR2: approval enforcement on SUPPLIER INVOICES, through the real routes.
 *
 * With enforcement on for (company, supplier_invoice) and an active rule
 * matching the bill, approving the bill (which posts its journal and puts it in
 * the AP population) is refused 409 until an APPROVED request exists for the
 * bill's CURRENT content, at a rank the strictest rule today demands, decided
 * at or after enforcement was (last) switched on. Design §4 PR2 tests 1–7, 10.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, enableFxDocuments, plantBill, plantRule, reasonOf } from './r035-approval.helpers';
import { billState, cleanupPr2, dataOf, enforce, postableCompany, routes } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', c: '', m: '' };
const r = routes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

/** A (admin) books and requests; B and C (owners) approve; M is a manager. */
const company = () => postableCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'owner'], [u.m, 'manager']], companies);

async function gated(opts: { rule?: string; enforced?: boolean } = {}) {
  const c = await company();
  await plantRule(pool, c, opts.rule ?? 'owner');
  if (opts.enforced !== false) await enforce(pool, c, u.b);
  const bill = await plantBill(pool, c, u.a);
  return { c, bill };
}

async function approvedBy(approver: string, c: string, billId: string, requester = u.a): Promise<string> {
  const raised = await r.raise(requester, c, billId);
  expect(raised.state.statusCode).toBe(200);
  const requestId = dataOf<{ id: string }>(raised).id;
  const decided = await r.decide(pool, approver, c, requestId);
  expect(decided.state.statusCode, JSON.stringify(decided.state.body)).toBe(200);
  return requestId;
}

describe('enabling supplier-invoice enforcement', () => {
  it('the enforcement API now switches supplier_invoice on', async () => {
    const c = await company();
    const res = await callRoute(approvalEnforcement, tokens[u.b]!, c, 'POST',
      { documentType: 'supplier_invoice', enabled: true }, '/api/accounting/approval-enforcement');
    expect(res.state.statusCode).toBe(200);
    const { rows } = await pool.query('SELECT document_type FROM approval_enforcement WHERE company_id = $1', [c]);
    expect(rows.map((x) => x.document_type)).toEqual(['supplier_invoice']);
  });
});

describe('approve is gated (design test 1, 2, 5)', () => {
  it('refuses 409 APPROVAL_REQUIRED with nothing requested: still a draft, no journal', async () => {
    const { c, bill } = await gated();
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(await billState(pool, bill.id)).toEqual({ status: 'draft', gl_journal_entry_id: null, journals: 0 });
  });

  it('refuses 409 APPROVAL_PENDING while the request awaits a decision', async () => {
    const { c, bill } = await gated();
    expect((await r.raise(u.a, c, bill.id)).state.statusCode).toBe(200);
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_PENDING');
    expect((await billState(pool, bill.id)).journals).toBe(0);
  });

  it('A requests, B approves the request, A posts: 200 with the journal', async () => {
    const { c, bill } = await gated();
    await approvedBy(u.b, c, bill.id);
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const state = await billState(pool, bill.id);
    expect(state.status).toBe('approved');
    expect(state.gl_journal_entry_id).not.toBeNull();
    expect(state.journals).toBe(1);
  });

  it('enforcement off: posts as it always did, rule or no rule', async () => {
    const { c, bill } = await gated({ enforced: false });
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode).toBe(200);
    expect((await billState(pool, bill.id)).status).toBe('approved');
  });
});

describe('the approval binds to content, rank and enforcement epoch', () => {
  it('an edit through the detail PUT after approval is 409 STALE; reverting it clears (test 3, Q9)', async () => {
    const { c, bill } = await gated();
    await approvedBy(u.b, c, bill.id);
    expect((await r.editBill(u.a, c, { id: bill.id, invoiceDate: '2026-09-02' })).state.statusCode).toBe(200);
    const stale = await r.approveBill(u.a, c, bill.id);
    expect(stale.state.statusCode).toBe(409);
    expect(reasonOf(stale)).toBe('APPROVAL_STALE');
    expect((await r.editBill(u.a, c, { id: bill.id, invoiceDate: '2026-09-01' })).state.statusCode).toBe(200);
    expect((await r.approveBill(u.a, c, bill.id)).state.statusCode).toBe(200);
  });

  it('a manager-level approval does not clear once an owner rule governs (test 4, the ratchet)', async () => {
    const { c, bill } = await gated({ rule: 'manager' });
    await approvedBy(u.b, c, bill.id);
    await plantRule(pool, c, 'owner', { name: 'late owner rule' });
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect((await billState(pool, bill.id)).journals).toBe(0);
  });

  it('an approved row with a NULL digest never clears (test 7)', async () => {
    const { c, bill } = await gated();
    await pool.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role, decided_by, decided_at)
       VALUES($1,'supplier_invoice',$2,'approved',$3,'owner',$4,now())`, [c, bill.id, u.a, u.b]);
    expect((await r.approveBill(u.a, c, bill.id)).state.statusCode).toBe(409);
  });

  it('a USD bill under the ZAR threshold in its own currency is still gated (test 10)', async () => {
    const c = await company();
    await enableFxDocuments(pool, c); // FX PR0
    await plantRule(pool, c, 'owner', { operator: 'greater_than', value: 50000 });
    await enforce(pool, c, u.b);
    const bill = await plantBill(pool, c, u.a, { total: 1150, functionalTotal: 92500, currencyCode: 'USD', exchangeRate: 80.43 });
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  });

  it('an approval decided BEFORE enforcement was (re-)enabled does not clear (PR2-must 2)', async () => {
    const { c, bill } = await gated({ enforced: false });
    await approvedBy(u.b, c, bill.id);
    await enforce(pool, c, u.b, new Date(Date.now() + 1000).toISOString());
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  });

  it('an approval decided after enforcement was enabled clears', async () => {
    const { c, bill } = await gated({ enforced: false });
    await enforce(pool, c, u.b, new Date(Date.now() - 60_000).toISOString());
    await approvedBy(u.b, c, bill.id);
    expect((await r.approveBill(u.a, c, bill.id)).state.statusCode).toBe(200);
  });
});

describe('tenant isolation (test 6)', () => {
  async function asAppUser<T>(userId: string, companyId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: 'authenticated' })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it("a forged approved row in company B carrying A's bill id does not clear A's bill", async () => {
    const { c, bill } = await gated();
    const other = await company();
    await enforce(pool, other, u.b); // B enforces too: only company_id can keep its row off A's bill
    const digest = (await pool.query("SELECT approval_document_digest($1,'supplier_invoice',$2) AS d", [c, bill.id])).rows[0].d;
    await asAppUser(u.b, other, (client) => client.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
         decided_by, decided_at, document_digest)
       VALUES($1,'supplier_invoice',$2,'approved',$3,'owner',$4,now(), $5)`,
      [other, bill.id, u.a, u.b, digest]));
    const res = await r.approveBill(u.a, c, bill.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  });

  it("company B's enforcement does not enforce on company A", async () => {
    const { c, bill } = await gated({ enforced: false });
    const other = await company();
    await enforce(pool, other, u.b);
    expect((await r.approveBill(u.a, c, bill.id)).state.statusCode).toBe(200);
  });
});

describe('bulk approve (test 8, first bullet)', () => {
  it('the gated row fails with the reason; its cleared sibling posts', async () => {
    const { c, bill } = await gated();
    const cleared = await plantBill(pool, c, u.a);
    await approvedBy(u.b, c, cleared.id);
    const res = await r.bulk(u.a, c, 'approve', [bill.id, cleared.id]);
    expect(res.state.statusCode).toBe(200);
    const body = dataOf<{ succeeded: number; results: { invoiceId: string; ok: boolean; error?: string; reason?: string }[] }>(res);
    expect(body.succeeded).toBe(1);
    const failed = body.results.find((x) => x.invoiceId === bill.id)!;
    expect(failed).toMatchObject({ ok: false, reason: 'APPROVAL_REQUIRED' });
    expect(failed.error).toMatch(/needs owner approval/);
    expect((await billState(pool, bill.id)).journals).toBe(0);
    expect((await billState(pool, cleared.id)).status).toBe('approved');
  });
});

describe('K-043 still holds (test 9)', () => {
  it('the requester may not approve their own request while another owner could', async () => {
    const { c, bill } = await gated();
    const raised = await r.raise(u.b, c, bill.id);
    const decided = await r.decide(pool, u.b, c, dataOf<{ id: string }>(raised).id);
    expect(decided.state.statusCode).toBe(403);
    expect(reasonOf(decided)).toBe('SELF_APPROVAL_FORBIDDEN');
  });
});

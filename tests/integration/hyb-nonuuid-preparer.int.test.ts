/**
 * Wave 6 HYb, adversarial review of #1564 (M + L), adopted from the reviewer's repro. Real routes (withAuth, app_user,
 * JWT claims) on the disposable fixture.
 *
 * After 999w prepared_by is TEXT, but approval_requests' actors and approval_document_authors are still uuid (wave 7).
 * Without a guard a non-UUID admin N could recalculate a run with a pending approval request, become its preparer, and
 * leave every approve, reject, withdraw and re-raise of that request failing with 22P02 (a 500 that also leaked N's
 * id). The ruling (option a): N is refused as the preparer of a run R-035 governs, with a typed 409 and nothing written.
 * Separately, a reject or a withdrawal never computes the document's authors (approvalAuthority#assertMayDecide), so a
 * request whose authors cannot be computed can still be closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { createVATAdjustment } from '@/modules/accounting/services/reports/vatAdjustmentService';
import { submitVATReturn } from '@/modules/accounting/services/reports/vatSubmissionService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

let r: Awaited<ReturnType<typeof rig>>;
const N = `sage-import-bot-hyb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  r = await rig('hyb-preparer');
  await r.setup();
  await r.employee(30000);
  await r.pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [N, `${N}@example.invalid`]);
  await r.pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [r.company, N]);
  r.tokens[N] = await r.mint(N); // teardown deletes every user it holds a token for
}, 60000);
afterAll(async () => {
  await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
  // The VAT201 the VAT-return case finalised: its versions are immutable and its lock is referenced, so they go with the
  // triggers off, in one transaction on this disposable fixture.
  const c = await r.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    // An ENABLE ALWAYS trigger fires under replica too: switched off for this transaction, as VR's own fixture does.
    await c.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
    for (const t of ['vat_returns', 'tax_return_versions', 'sars_submissions', 'vat_gate_overrides', 'vat_period_locks']) {
      await c.query(`DELETE FROM ${t} WHERE company_id = $1`, [r.company]);
    }
    await c.query('ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable');
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  await r.teardown();
}, 60000);

const ar = (user: string, body: unknown) => r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined, { user, body });
const header = async (id: string) =>
  (await r.pool.query('SELECT prepared_by::text AS p, approval_revision::text AS v FROM payroll_run_headers WHERE id = $1', [id])).rows[0];
const status = async (requestId: string) =>
  (await r.pool.query('SELECT status FROM approval_requests WHERE id = $1', [requestId])).rows[0]?.status;
const SCOPES = ['read:payroll', 'write:payroll', 'write:post', 'read:accounting', 'write:accounting'];
/** calculate_pay_run through the real registry, as `user` (the company's admin role). */
async function mcpCalculate(user: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const ctx = { userId: user, companyId: r.company, scopes: SCOPES, tokenJti: null, oauthAppId: null, companyRole: 'admin' };
  const res = await withAlsTransaction({ userId: user, companyId: r.company },
    () => mcpRegistry.call('calculate_pay_run', { idempotency_key: `hyb-${crypto.randomUUID()}`, ...args }, ctx as never)) as
    { isError?: boolean; content: Array<{ text: string }> };
  return { isError: res.isError === true, text: res.content?.[0]?.text ?? '' };
}
async function raisedRun(month: number): Promise<{ id: string; req: { id: string; documentDigest: string } }> {
  const id = String((await r.api.createRun(month)).body.data!.id);
  expect((await r.api.calculate(id)).statusCode).toBe(200);
  const raised = await ar(r.admin, { action: 'request', documentType: 'pay_run', documentId: id });
  expect(raised.statusCode).toBe(200);
  return { id, req: raised.body.data as { id: string; documentDigest: string } };
}

describe('HYb: a non-UUID preparer and a pay run under R-035 approval', () => {
  it('N recalculating a run with a pending request is refused with 409 PREPARER_ID_NOT_SUPPORTED; nothing changes and the request is approved', async () => {
    const { id, req } = await raisedRun(6);
    const before = await header(id);

    const nCalc = await r.api.calculate(id, { user: N });
    expect(nCalc.statusCode).toBe(409);
    const body = JSON.stringify(nCalc.body);
    expect(body).toContain('PREPARER_ID_NOT_SUPPORTED');
    expect(body).toContain("This account can't prepare pay runs that need approval yet.");
    expect(body).not.toContain(N);
    expect(await header(id)).toEqual(before);
    expect(before.p).toBe(r.admin);

    const approved = await ar(r.approver, { action: 'approve', requestId: req.id, expectedDigest: req.documentDigest });
    expect(approved.statusCode).toBe(200);
    expect(await status(req.id)).toBe('approved');
  }, 180000);

  it('case A: N calculating a fresh run is refused the same way, and the header is untouched', async () => {
    const id = String((await r.api.createRun(9)).body.data!.id);
    const before = await header(id);
    const nCalc = await r.api.calculate(id, { user: N });
    expect(nCalc.statusCode).toBe(409);
    expect(JSON.stringify(nCalc.body)).toContain('PREPARER_ID_NOT_SUPPORTED');
    expect(await header(id)).toEqual(before);
    expect((await r.pool.query('SELECT status FROM payroll_run_headers WHERE id = $1', [id])).rows[0].status).toBe('draft');
  }, 180000);

  it('case B: after N is refused, the pending request can be withdrawn by its requester and raised again', async () => {
    const { id, req } = await raisedRun(10);
    expect((await r.api.calculate(id, { user: N })).statusCode).toBe(409);
    expect(await status(req.id)).toBe('pending');
    const withdrawn = await ar(r.admin, { action: 'reject', requestId: req.id });
    expect(withdrawn.statusCode, JSON.stringify(withdrawn.body)).toBe(200);
    const again = await ar(r.admin, { action: 'request', documentType: 'pay_run', documentId: id });
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
  }, 180000);

  it('the MCP calculate_pay_run path refuses N too, live and dry run, and writes nothing', async () => {
    const { id } = await raisedRun(11);
    const before = await header(id);
    for (const args of [{ run_id: id }, { run_id: id, dry_run: true }]) {
      const out = await mcpCalculate(N, args);
      expect(out.isError, out.text).toBe(true);
      expect(out.text).toContain("This account can't prepare pay runs that need approval yet.");
      expect(out.text).not.toContain(N);
    }
    expect(await header(id)).toEqual(before);
    expect((await mcpCalculate(r.admin, { run_id: id })).isError).toBe(false);
  }, 180000);

  it("a non-UUID user's VAT adjustment records that user's own id, not a stand-in", async () => {
    const adj = await withAlsTransaction({ userId: N, companyId: r.company }, () => createVATAdjustment(r.company, {
      adjustmentDate: '2026-03-15', adjustmentType: 'output', amount: 10, reason: 'hyb L1',
    } as never, N));
    const row = (await r.pool.query('SELECT created_by FROM vat_adjustments WHERE id = $1 AND company_id = $2', [adj.id, r.company])).rows[0];
    expect(row.created_by).toBe(N);
    await r.pool.query('DELETE FROM vat_adjustments WHERE company_id = $1', [r.company]);
  }, 60000);

  it("a non-UUID user's VAT return records that user's own id as submitted_by, not a stand-in", async () => {
    // A nil period (no documents): no journal is posted, only the vat_returns row. The accounts it resolves first.
    await r.pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account)
       VALUES ($1,'2201','HYb VAT output','liability','credit',1,'vat_output',true),
              ($1,'2202','HYb VAT input','asset','debit',1,'vat_input',true),
              ($1,'2130','HYb accrued','liability','credit',1,null,false)
       ON CONFLICT DO NOTHING`, [r.company]);
    clearSystemAccountCache(r.company); // the payroll cases above cached this company's roles
    // Since VR (999g) a settlement needs a finalised VAT201 for exactly the period; the admin finalises it.
    const finaliseVat201: Route = (req, res) => {
      (req as unknown as { query: Record<string, unknown> }).query = { form: 'vat201' };
      return (finalise as unknown as Route)(req, res);
    };
    const fin = await r.call(finaliseVat201, 'POST', '/api/accounting/sars/returns/vat201/finalise', undefined, {
      body: { periodStart: '2024-02-01', periodEnd: '2024-03-31', force: true, overrideReason: 'HYb integration fixture' },
    });
    expect(fin.statusCode, JSON.stringify(fin.body)).toBe(200);
    const vr = await withAlsTransaction({ userId: N, companyId: r.company }, () =>
      submitVATReturn(r.company, { periodStart: '2024-02-01', periodEnd: '2024-03-31' } as never, N));
    const row = (await r.pool.query('SELECT submitted_by FROM vat_returns WHERE id = $1 AND company_id = $2', [vr.id, r.company])).rows[0];
    await r.pool.query('DELETE FROM vat_returns WHERE company_id = $1', [r.company]);
    expect(row.submitted_by).toBe(N);
  }, 60000);

  // A request whose authors cannot be computed (a non-UUID preparer: unreachable through the routes now, so written
  // directly) can still be closed: neither a reject nor a withdrawal reads the authors.
  it('such a request can still be rejected by the approver', async () => {
    const first = await raisedRun(7);
    await r.pool.query('UPDATE payroll_run_headers SET prepared_by = $1 WHERE id = $2', [N, first.id]);
    const rejected = await ar(r.approver, { action: 'reject', requestId: first.req.id });
    expect(rejected.statusCode, JSON.stringify(rejected.body)).toBe(200);
    expect(await status(first.req.id)).toBe('rejected');
  }, 180000);

  it('such a request can still be withdrawn by its requester', async () => {
    const second = await raisedRun(8);
    await r.pool.query('UPDATE payroll_run_headers SET prepared_by = $1 WHERE id = $2', [N, second.id]);
    const withdrawn = await ar(r.admin, { action: 'reject', requestId: second.req.id });
    expect(withdrawn.statusCode, JSON.stringify(withdrawn.body)).toBe(200);
    expect(await status(second.req.id)).toBe('rejected');
  }, 180000);
});

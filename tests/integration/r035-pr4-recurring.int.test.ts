/**
 * R-035 PR4: the unattended customer-invoice creators. Nobody decides at the
 * moment they run, so neither may REFUSE a gated invoice — a refusal used to
 * roll the generated invoice back and leave the schedule where it was, so the
 * template stalled on every run. Each leaves the invoice a DRAFT, raises the
 * approval request itself as the person who ran it, advances the schedule and
 * reports the invoice held for approval.
 *
 *  - recurring invoices, "Run all due": a batch of gated and ungated templates
 *    posts the ungated invoices, holds the gated ones (drafts with a pending
 *    request, listed in held_for_approval), advances EVERY schedule and rolls
 *    nothing back; the single-template run and the 'generate' action say the
 *    same about one invoice.
 *  - recurring-transaction autoPost: draft + request, posted:false.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import recurringRun from '../../pages/api/accounting/recurring-invoices-run';
import recurringAction from '../../pages/api/accounting/recurring-invoices-action';
import recurringExecute from '../../pages/api/accounting/recurring-transactions-execute';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany, invoiceState } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

/** A (admin) runs; B (owner) approves. An owner rule over R1 000 — the R1 150 templates are gated, the R575 ones not. */
async function fixture(opts: { enforced?: boolean } = {}): Promise<{ c: string; customer: string }> {
  const c = await invoiceCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 1000 });
  if (opts.enforced !== false) await enforceInvoices(pool, c, u.b);
  const customer = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 recurring')", [customer, c]);
  return { c, customer };
}

/** A monthly template due three days ago: R1 150 (gated) or R575 (not). */
async function template(c: string, customer: string, gated: boolean): Promise<string> {
  const id = crypto.randomUUID();
  const net = gated ? 1000 : 500;
  await pool.query(
    `INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,
       subtotal,tax_rate,tax_amount,total_amount,created_by,status)
     VALUES($1,$2,$3,$4,'monthly',CURRENT_DATE - INTERVAL '3 days','R035 retainer',$5::jsonb,$6,15,$7,$8,$9,'active')`,
    [id, c, `R035 ${gated ? 'gated' : 'small'} ${id.slice(0, 6)}`, customer,
      JSON.stringify([{ description: 'Retainer', quantity: 1, unitPrice: net }]), net, net * 0.15, net * 1.15, u.a]);
  return id;
}

const schedule = async (id: string) => (await pool.query(
  'SELECT next_run_date > CURRENT_DATE AS advanced, run_count FROM recurring_invoices WHERE id = $1', [id])).rows[0] as
  { advanced: boolean; run_count: number };
const pending = async (invoiceId: string) => (await pool.query(
  "SELECT requested_by FROM approval_requests WHERE document_id = $1 AND status = 'pending'", [invoiceId])).rows;
const run = (c: string, body: Record<string, unknown>) => callRoute(recurringRun, tokens[u.a]!, c, 'POST', body,
  '/api/accounting/recurring-invoices-run');

interface RunResult { generated: number; invoice_ids: string[]; held_for_approval: string[]; errors: string[] }

describe('recurring invoices', () => {
  it('Run all due: ungated templates post, gated ones are held as drafts with a request, every schedule advances', async () => {
    const { c, customer } = await fixture();
    const gatedA = await template(c, customer, true);
    const small = await template(c, customer, false);
    const gatedB = await template(c, customer, true);
    const res = await run(c, {});
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const result = dataOf<RunResult>(res);
    expect(result.errors).toEqual([]);
    expect(result.generated).toBe(3);
    expect(result.invoice_ids).toHaveLength(3);
    expect(result.held_for_approval).toHaveLength(2);
    for (const id of [gatedA, small, gatedB]) expect(await schedule(id), id).toEqual({ advanced: true, run_count: 1 });

    for (const invoiceId of result.invoice_ids) {
      const state = await invoiceState(pool, invoiceId);
      if (result.held_for_approval.includes(invoiceId)) {
        expect(state).toMatchObject({ status: 'draft', gl_journal_entry_id: null, journals: 0 });
        expect(await pending(invoiceId)).toEqual([{ requested_by: u.a }]);
      } else {
        expect(state).toMatchObject({ status: 'approved', journals: 1 });
        expect(await pending(invoiceId)).toEqual([]);
      }
    }
  });

  it('a single-template run reports its invoice held; a second run is refused as not due (the schedule moved)', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, true);
    const result = dataOf<RunResult>(await run(c, { recurring_invoice_id: id }));
    expect(result.generated).toBe(1);
    expect(result.held_for_approval).toEqual(result.invoice_ids);
    expect((await invoiceState(pool, result.invoice_ids[0]!)).status).toBe('draft');
    const again = dataOf<RunResult>(await run(c, { recurring_invoice_id: id }));
    expect(again.generated).toBe(0);
    expect(again.errors[0]).toMatch(/not due/);
  });

  it("the 'generate' action answers heldForApproval for a gated template, and nothing for an ungated one", async () => {
    const { c, customer } = await fixture();
    const generate = (id: string) => callRoute(recurringAction, tokens[u.a]!, c, 'POST', { action: 'generate', id },
      '/api/accounting/recurring-invoices-action');
    const held = dataOf<{ invoiceId: string; heldForApproval?: boolean }>(await generate(await template(c, customer, true)));
    expect(held.heldForApproval).toBe(true);
    expect((await invoiceState(pool, held.invoiceId)).status).toBe('draft');
    const posted = dataOf<{ invoiceId: string; heldForApproval?: boolean }>(await generate(await template(c, customer, false)));
    expect(posted.heldForApproval).toBeUndefined();
    expect((await invoiceState(pool, posted.invoiceId)).journals).toBe(1);
  });

  it('the runner is the requester and the creator, so cannot approve the held invoice while another owner can', async () => {
    const c = await invoiceCompany(pool, [[u.a, 'owner'], [u.b, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 1000 });
    await enforceInvoices(pool, c, u.b);
    const customer = crypto.randomUUID();
    await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 SoD')", [customer, c]);
    const result = dataOf<RunResult>(await run(c, { recurring_invoice_id: await template(c, customer, true) }));
    const invoiceId = result.held_for_approval[0]!;
    const { rows: [req] } = await pool.query(
      "SELECT id, requested_by, document_digest FROM approval_requests WHERE document_id = $1 AND status = 'pending'", [invoiceId]);
    expect(req.requested_by).toBe(u.a);
    const decide = (user: string) => callRoute(approvalRequests, tokens[user]!, c, 'POST',
      { action: 'approve', requestId: req.id, expectedDigest: req.document_digest }, '/api/accounting/approval-requests');
    expect((await decide(u.a)).state.statusCode).toBe(403);
    expect((await decide(u.b)).state.statusCode).toBe(200);
  });

  it('enforcement off: every template posts as before and nothing is held', async () => {
    const { c, customer } = await fixture({ enforced: false });
    await template(c, customer, true);
    const result = dataOf<RunResult>(await run(c, {}));
    expect(result.held_for_approval).toEqual([]);
    expect((await invoiceState(pool, result.invoice_ids[0]!)).journals).toBe(1);
  });
});

describe('recurring-transaction autoPost', () => {
  it('leaves a gated invoice a draft with a pending request raised by the runner, reports posted:false, advances', async () => {
    const { c, customer } = await fixture();
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,next_run_date,auto_post,created_by)
       VALUES($1,$2,'R035 AR auto-post','customer_invoice',$3,'monthly',CURRENT_DATE,true,$4)`,
      [id, c, JSON.stringify({ clientId: customer, subtotal: 1000, vatAmount: 150, totalAmount: 1150,
        lines: [{ description: 'Retainer', quantity: 1, unitPrice: 1000, taxRate: 15, lineTotal: 1000 }] }), u.a]);
    const res = await callRoute(recurringExecute, tokens[u.a]!, c, 'POST', { templateId: id }, '/api/accounting/recurring-transactions-execute');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const result = dataOf<{ entityId: string; posted: boolean }>(res);
    expect(result.posted).toBe(false);
    expect(await invoiceState(pool, result.entityId)).toMatchObject({ status: 'draft', journals: 0 });
    expect(await pending(result.entityId)).toEqual([{ requested_by: u.a }]);
    const { rows: [t] } = await pool.query(
      'SELECT next_run_date > CURRENT_DATE AS advanced FROM recurring_transaction_templates WHERE id = $1', [id]);
    expect(t.advanced).toBe(true);
  });
});

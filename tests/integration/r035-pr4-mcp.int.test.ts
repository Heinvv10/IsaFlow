/**
 * R-035 PR4, decision Q6: an agent may neither raise nor decide an approval,
 * so the MCP customer-invoice tools refuse or skip a gated invoice — from a
 * READ, before anything is written.
 *
 *  - finalize_invoice answers a tool error carrying the gate's reason; nothing
 *    posts and the idempotency key stays free for the call that succeeds once
 *    a person has had it approved.
 *  - bulk_finalize_invoices skips the gated invoice with an
 *    `approval_required: …` reason (the dry run already says so) and posts its
 *    ungated sibling in the same call.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { finalizeInvoiceTool } from '../../src/lib/mcp/tools/writeInvoices';
import { bulkFinalizeInvoicesTool } from '../../src/lib/mcp/tools/writeBulkFinalizeInvoices';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany, invoiceRoutes, invoiceState, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = invoiceRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

async function asUser<T>(userId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId, companyId, claims: { sub: userId } } as never, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const registry = new McpRegistry();
registry.register(finalizeInvoiceTool);
registry.register(bulkFinalizeInvoicesTool);
const mcp = (c: string, name: string, args: Record<string, unknown>) => asUser(u.a, c, () => registry.call(name, args,
  { userId: u.a, companyId: c, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: 'r035-pr4', oauthAppId: null }));
const text = (res: { content: { text: string }[] }) => res.content[0]!.text;
const requestsFor = async (id: string) => Number((await pool.query(
  'SELECT count(*)::INT AS n FROM approval_requests WHERE document_id = $1', [id])).rows[0].n);

/** A (admin) books; B (owner) approves. An owner rule over R1 000, enforced. */
async function fixture() {
  const c = await invoiceCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 1000 });
  await enforceInvoices(pool, c, u.b);
  return { c, inv: await plantInvoice(pool, c, u.a) };
}

describe('finalize_invoice', () => {
  it('refuses a gated invoice before writing, and leaves its idempotency key free', async () => {
    const { c, inv } = await fixture();
    const key = `r035-pr4-${inv.id}`;
    const refused = await mcp(c, 'finalize_invoice', { invoice_id: inv.id, idempotency_key: key });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/Customer invoice CI-\S+ needs owner approval/);
    expect(text(refused)).toMatch(/cannot raise or decide approvals/);
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null, journals: 0 });
    expect(await requestsFor(inv.id)).toBe(0);

    await r.approvedBy(pool, u.a, u.b, c, inv.id);
    const posted = await mcp(c, 'finalize_invoice', { invoice_id: inv.id, idempotency_key: key });
    expect(posted.isError, text(posted)).toBeFalsy();
    expect((await invoiceState(pool, inv.id)).journals).toBe(1);
  });

  it('a not-found invoice is still reported as before', async () => {
    const { c } = await fixture();
    const res = await mcp(c, 'finalize_invoice', { invoice_id: crypto.randomUUID(), idempotency_key: `r035-pr4-nf-${c}` });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not found/i);
  });
});

describe('bulk_finalize_invoices', () => {
  it('skips the gated invoice (approval_required) and posts its ungated sibling', async () => {
    const { c, inv } = await fixture();
    const small = await plantInvoice(pool, c, u.a, { subtotal: 500, tax: 75, total: 575 });
    const ids = [inv.id, small.id];
    const preview = await mcp(c, 'bulk_finalize_invoices', { invoice_ids: ids, dry_run: true, idempotency_key: `r035-pr4-dry-${inv.id}` });
    expect(JSON.parse(text(preview))).toMatchObject({
      would_post_ids: [small.id],
      skipped: [expect.objectContaining({ document_id: inv.id, reason: expect.stringMatching(/^approval_required: Customer invoice/) })],
    });
    const res = await mcp(c, 'bulk_finalize_invoices', { invoice_ids: ids, idempotency_key: `r035-pr4-bulk-${inv.id}` });
    expect(res.isError, text(res)).toBeFalsy();
    const body = JSON.parse(text(res)) as { posted: number; skipped: { document_id: string; reason: string }[] };
    expect(body.posted).toBe(1);
    expect(body.skipped).toEqual([expect.objectContaining({ document_id: inv.id, reason: expect.stringMatching(/^approval_required/) })]);
    expect((await invoiceState(pool, inv.id)).journals).toBe(0);
    expect((await invoiceState(pool, small.id)).journals).toBe(1);
    expect(await requestsFor(inv.id)).toBe(0);
  });

  it('a batch whose every invoice is gated is refused before writing', async () => {
    const { c, inv } = await fixture();
    const res = await mcp(c, 'bulk_finalize_invoices', { invoice_ids: [inv.id], idempotency_key: `r035-pr4-none-${inv.id}` });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/approval_required/);
    expect((await invoiceState(pool, inv.id)).journals).toBe(0);
  });
});

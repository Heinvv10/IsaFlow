/**
 * Credit-note MCP tools, end to end against a real database.
 *
 * These paths cannot be proven with a mocked sql tag. Two defects here lived
 * entirely in what reached Postgres and were invisible to the unit suite:
 * `Number(supplierId)` sent NaN to a UUID column, and cancelCreditNote wrote
 * cancelled_by / cancelled_at / cancel_reason, which migration 202 never
 * created (added in 526). The second is the reason the cancel round trip below
 * is asserted rather than assumed: the failing UPDATE was the LAST statement in
 * cancelCreditNote, so the journal reversal and the invoice un-apply had
 * already committed by the time it threw.
 *
 * Requires a company whose chart of accounts carries the six system-account
 * subtypes a credit note posts through. When that fixture is absent the tests
 * mark themselves SKIPPED via the test context rather than returning early —
 * an early `return` reports as a PASS, which is exactly how a suite like this
 * rots into a green light that proves nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { listCreditNotesTool, getCreditNoteTool } from '@/lib/mcp/tools/creditNotes';
import { createCreditNoteTool, approveCreditNoteTool, cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '00000000-0000-0000-0000-000000000aa1';
const OTHER   = '00000000-0000-0000-0000-000000000aa2';
const USER    = '00000000-0000-0000-e2e0-000000000001';
let supplier: string; let customer: string; let otherCustomer: string; let invoice: string;

const ctx = (companyId = COMPANY): McpToolContext =>
  ({ userId: USER, companyId, scopes: ['write:invoices', 'write:post'], tokenJti: 'jti', oauthAppId: null }) as McpToolContext;
const J = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

const REQUIRED_SUBTYPES = [
  'default_revenue', 'receivable', 'vat_output',
  'payable', 'default_expense', 'vat_input',
];

let ready = false;

beforeAll(async () => {
  const seeded = await sql`
    SELECT COUNT(DISTINCT account_subtype) AS n FROM gl_accounts
    WHERE company_id = ${COMPANY}::UUID AND account_subtype = ANY(${REQUIRED_SUBTYPES})
  ` as { n: string }[];
  ready = Number(seeded[0]!.n) === REQUIRED_SUBTYPES.length;
  if (!ready) return;

  supplier = (await sql`INSERT INTO suppliers (name, company_id) VALUES ('E2E Supplier', ${COMPANY}::UUID) RETURNING id` as {id:string}[])[0]!.id;
  customer = (await sql`INSERT INTO customers (name, company_id) VALUES ('E2E Customer', ${COMPANY}::UUID) RETURNING id` as {id:string}[])[0]!.id;
  otherCustomer = (await sql`INSERT INTO customers (name, company_id) VALUES ('E2E Other', ${OTHER}::UUID) RETURNING id` as {id:string}[])[0]!.id;
  invoice = (await sql`INSERT INTO customer_invoices (company_id, client_id, customer_id, created_by, invoice_number, invoice_date, total_amount, amount_paid, status, subtotal)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${USER}::UUID, 'E2E-INV-1', '2026-06-01', 1150, 0, 'approved', 1000) RETURNING id` as {id:string}[])[0]!.id;
});

afterAll(async () => {
  if (!ready) return;
  // Scoped teardown ONLY — these are shared demo companies, not throwaway ones.
  await sql`DELETE FROM credit_notes WHERE client_id = ${customer}::UUID OR supplier_id = ${supplier}::UUID`;
  await sql`DELETE FROM customer_invoices WHERE id = ${invoice}::UUID`;
  await sql`DELETE FROM customers WHERE id IN (${customer}::UUID, ${otherCustomer}::UUID)`;
  await sql`DELETE FROM suppliers WHERE id = ${supplier}::UUID`;
});

describe('credit note MCP tools — real round trip', () => {
  it('refuses a customer from another tenant', async (t) => {
    if (!ready) t.skip();
    const r = await createCreditNoteTool.handler(
      { type: 'customer', client_id: otherCustomer, credit_date: '2026-06-30', subtotal: 100, idempotency_key: 'k' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found');
  });

  it('refuses an invoice belonging to a different customer', async (t) => {
    if (!ready) t.skip();
    const r = await createCreditNoteTool.handler(
      { type: 'customer', client_id: otherCustomer, customer_invoice_id: invoice, credit_date: '2026-06-30', subtotal: 100, idempotency_key: 'k' }, ctx(OTHER));
    expect(r.isError).toBe(true);
  });

  it('supplier note: create -> approve -> cancel, stamping the ledger', async (t) => {
    if (!ready) t.skip();
    const created = J(await createCreditNoteTool.handler(
      { type: 'supplier', supplier_id: supplier, credit_date: '2026-06-30', subtotal: 200, idempotency_key: 'k1' }, ctx()));
    expect(created.status).toBe('draft');
    expect(created.total_amount).toBeCloseTo(230, 2);

    const approved = J(await approveCreditNoteTool.handler({ credit_note_id: created.id, idempotency_key: 'k2' }, ctx()));
    expect(approved.status).toBe('approved');
    expect(approved.gl_journal_entry_id).toBeTruthy();

    const je = await sql`SELECT posting_agent, status FROM gl_journal_entries WHERE id = ${approved.gl_journal_entry_id}::UUID` as {posting_agent:string;status:string}[];
    expect(je[0]!.posting_agent).toBe('mcp:approve_credit_note:v1');
    expect(je[0]!.status).toBe('posted');

    const bal = await sql`SELECT SUM(debit) d, SUM(credit) c FROM gl_journal_lines WHERE journal_entry_id = ${approved.gl_journal_entry_id}::UUID` as {d:string;c:string}[];
    expect(Number(bal[0]!.d)).toBeCloseTo(Number(bal[0]!.c), 2);

    const dbl = await approveCreditNoteTool.handler({ credit_note_id: created.id, idempotency_key: 'k3' }, ctx());
    expect(dbl.isError).toBe(true);

    const cancelled = J(await cancelCreditNoteTool.handler({ credit_note_id: created.id, reason: 'e2e', idempotency_key: 'k4' }, ctx()));
    expect(cancelled.status).toBe('cancelled');

    // Migration 526: without these columns the UPDATE throws AFTER the journal
    // reversal has already committed, stranding a reversed ledger under a note
    // still marked approved.
    const row = await sql`
      SELECT cancelled_by, cancelled_at, cancel_reason FROM credit_notes WHERE id = ${created.id}::UUID
    ` as { cancelled_by: string; cancelled_at: Date; cancel_reason: string }[];
    expect(row[0]!.cancelled_by).toBe(USER);
    expect(row[0]!.cancelled_at).toBeTruthy();
    expect(row[0]!.cancel_reason).toBe('e2e');

    // The reversal is stamped too, or agent-cancelled ledger movement is
    // invisible to list_agent_postings.
    const rev = await sql`
      SELECT posting_agent FROM gl_journal_entries
      WHERE reversal_of_id = ${approved.gl_journal_entry_id}::UUID
    ` as { posting_agent: string }[];
    expect(rev[0]?.posting_agent).toBe('mcp:cancel_credit_note:v1');
  });

  it('linked customer note auto-applies and un-applies on cancel', async (t) => {
    if (!ready) t.skip();
    const created = J(await createCreditNoteTool.handler(
      { type: 'customer', client_id: customer, customer_invoice_id: invoice, credit_date: '2026-06-30', subtotal: 100, idempotency_key: 'k5' }, ctx()));
    const approved = J(await approveCreditNoteTool.handler({ credit_note_id: created.id, idempotency_key: 'k6' }, ctx()));
    expect(approved.status).toBe('applied');
    expect(approved.applied_to_invoice_id).toBe(invoice);

    let inv = await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${invoice}::UUID` as {amount_paid:string}[];
    expect(Number(inv[0]!.amount_paid)).toBeCloseTo(115, 2);

    await cancelCreditNoteTool.handler({ credit_note_id: created.id, idempotency_key: 'k7' }, ctx());
    inv = await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${invoice}::UUID` as {amount_paid:string}[];
    expect(Number(inv[0]!.amount_paid)).toBeCloseTo(0, 2);
  });

  it('reads are tenant-scoped', async (t) => {
    if (!ready) t.skip();
    const created = J(await createCreditNoteTool.handler(
      { type: 'customer', client_id: customer, credit_date: '2026-06-30', subtotal: 10, idempotency_key: 'k8' }, ctx()));

    const mine = J(await listCreditNotesTool.handler({ limit: 200 }, ctx()));
    expect(mine.credit_notes.map((c: { id: string }) => c.id)).toContain(created.id);

    // The same id must be invisible to the other tenant, through both surfaces.
    const theirs = J(await listCreditNotesTool.handler({ limit: 200 }, ctx(OTHER)));
    expect(theirs.credit_notes.map((c: { id: string }) => c.id)).not.toContain(created.id);
    const cross = await getCreditNoteTool.handler({ credit_note_id: created.id }, ctx(OTHER));
    expect(cross.isError).toBe(true);
    expect(cross.content[0]!.text).toBe('Not found');
  });
});

/**
 * Credit-note MCP tools, end to end against a real database.
 *
 * These paths cannot be proven with a mocked sql tag. Two defects here lived
 * entirely in what reached Postgres and were invisible to the unit suite:
 * `Number(supplierId)` sent NaN to a UUID column, and cancelCreditNote wrote
 * cancelled_by / cancelled_at / cancel_reason, which migration 202 never
 * created (added in 528). The second is the reason the cancel round trip below
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
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { listCreditNotesTool, getCreditNoteTool } from '@/lib/mcp/tools/creditNotes';
import { createCreditNoteTool, approveCreditNoteTool, cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '00000000-0000-0000-0000-000000000aa1';
const OTHER   = '00000000-0000-0000-0000-000000000aa2';
const USER    = '00000000-0000-0000-e2e0-000000000001';
let supplier: string; let customer: string; let otherCustomer: string; let invoice: string;
/** A SECOND customer inside COMPANY — needed to reach the counterparty branch. */
let siblingCustomer: string;

// Unique per run. customer_invoices has a (company_id, invoice_number) unique
// constraint, so a fixed number turns any teardown failure into a permanently
// red suite on a shared database — the failure mode this file already hit.
const TAG = `CNMCP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const ctx = (companyId = COMPANY): McpToolContext =>
  ({ userId: USER, companyId, scopes: ['write:invoices', 'write:post'], tokenJti: 'jti', oauthAppId: null }) as McpToolContext;
const J = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

let pool: Pool;

/**
 * Run one tool call the way a request runs it: inside a single transaction on
 * an ALS-bound client. This is not decoration — approve/cancel take a
 * `FOR UPDATE` row lock that REFUSES to run outside a request transaction,
 * because outside one the lock would release the instant the SELECT returned
 * and serialise nothing. Each call gets its own transaction, as each HTTP
 * request would.
 */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(
      { client, userId: USER, companyId: COMPANY, claims: {} } as never,
      fn,
    );
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const REQUIRED_SUBTYPES = [
  'default_revenue', 'receivable', 'vat_output',
  'payable', 'default_expense', 'vat_input',
];

let ready = false;

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  // customers.company_id FKs to companies, so a database lacking either demo
  // company kills beforeAll rather than skipping cleanly.
  for (const [id, name] of [[COMPANY, 'CN MCP Test A'], [OTHER, 'CN MCP Test B']] as const) {
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${id}::UUID, ${name}, 'CNMCP-TEST', NOW())
      ON CONFLICT (id) DO NOTHING
    `;
  }
  const seeded = await sql`
    SELECT COUNT(DISTINCT account_subtype) AS n FROM gl_accounts
    WHERE company_id = ${COMPANY}::UUID AND account_subtype = ANY(${REQUIRED_SUBTYPES})
  ` as { n: string }[];
  ready = Number(seeded[0]!.n) === REQUIRED_SUBTYPES.length;
  if (!ready) return;

  supplier = (await sql`INSERT INTO suppliers (name, company_id) VALUES (${'E2E Supplier ' + TAG}, ${COMPANY}::UUID) RETURNING id` as {id:string}[])[0]!.id;
  customer = (await sql`INSERT INTO customers (name, company_id) VALUES (${'E2E Customer ' + TAG}, ${COMPANY}::UUID) RETURNING id` as {id:string}[])[0]!.id;
  otherCustomer = (await sql`INSERT INTO customers (name, company_id) VALUES (${'E2E Other ' + TAG}, ${OTHER}::UUID) RETURNING id` as {id:string}[])[0]!.id;
  siblingCustomer = (await sql`INSERT INTO customers (name, company_id) VALUES (${'E2E Sibling ' + TAG}, ${COMPANY}::UUID) RETURNING id` as {id:string}[])[0]!.id;
  invoice = (await sql`INSERT INTO customer_invoices (company_id, client_id, customer_id, created_by, invoice_number, invoice_date, total_amount, amount_paid, status, subtotal)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${USER}::UUID, ${TAG}, '2026-06-01', 1150, 0, 'approved', 1000) RETURNING id` as {id:string}[])[0]!.id;
});

afterAll(async () => {
  if (!ready) { await pool?.end(); return; }
  // Teardown must not stop at the first failure. A test that leaves an
  // unexpected row makes one of these DELETEs throw, and an aborted afterAll
  // then abandons everything after it — which is how a failed run left three
  // customers and an invoice behind in a shared demo company. Each step is
  // reported and skipped rather than fatal; TAG keeps a leftover from breaking
  // the next run either way.
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[creditNoteMcpTools] teardown step "${what}" failed:`, err);
    }
  };
  // Scoped teardown ONLY — these are shared demo companies, not throwaway ones.
  //
  // The journals have to go FIRST and by id: approve posts one and cancel posts
  // its reversal, and neither is reachable from credit_notes once the note row
  // is gone. An earlier version deleted only the notes and left both behind,
  // silently accumulating posted entries in a demo company's ledger on every
  // run. Reversals reference their original through reversal_of_id, so they are
  // deleted before the entries they point at.
  const jeIds = (await sql`
    SELECT gl_journal_entry_id AS id FROM credit_notes
    WHERE (client_id = ${customer}::UUID OR supplier_id = ${supplier}::UUID)
      AND gl_journal_entry_id IS NOT NULL
  ` as { id: string }[]).map((r) => r.id);

  // credit_notes.gl_journal_entry_id is a FK onto the entries below, so the
  // notes go FIRST or the journal delete is refused.
  await step('credit_notes', () => sql`DELETE FROM credit_notes WHERE client_id = ${customer}::UUID OR supplier_id = ${supplier}::UUID`);

  if (jeIds.length > 0) {
    const all = (await sql`
      SELECT id FROM gl_journal_entries
      WHERE id = ANY(${jeIds}::UUID[]) OR reversal_of_id = ANY(${jeIds}::UUID[])
    ` as { id: string }[]).map((r) => r.id);
    await sql`DELETE FROM gl_journal_lines WHERE journal_entry_id = ANY(${all}::UUID[])`;
    // Reversals reference their original through reversal_of_id, so they are
    // deleted before the entries they point at.
    await sql`DELETE FROM gl_journal_entries WHERE reversal_of_id = ANY(${jeIds}::UUID[])`;
    await sql`DELETE FROM gl_journal_entries WHERE id = ANY(${jeIds}::UUID[])`;
  }

  await step('customer_invoices', () => sql`DELETE FROM customer_invoices WHERE id = ${invoice}::UUID`);
  await step('customers', () => sql`DELETE FROM customers WHERE id IN (${customer}::UUID, ${otherCustomer}::UUID, ${siblingCustomer}::UUID)`);
  await step('suppliers', () => sql`DELETE FROM suppliers WHERE id = ${supplier}::UUID`);
  await pool.end();
});

describe('credit note MCP tools — real round trip', () => {
  it('refuses a customer from another tenant', async (t) => {
    if (!ready) t.skip();
    const r = await inTx(() => createCreditNoteTool.handler(
      { type: 'customer', client_id: otherCustomer, credit_date: '2026-06-30', subtotal: 100, idempotency_key: 'k' }, ctx()));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found');
  });

  /**
   * The counterparty branch, reached for real.
   *
   * The previous version of this test passed ctx(OTHER), so the CUSTOMER
   * lookup failed on the tenant branch and the invoice-owner comparison was
   * never executed — deleting that comparison left the test green, which made
   * the headline fence of this change untested. Both ids below are legitimately
   * visible to the calling company; only their relationship is wrong.
   */
  it('refuses an invoice belonging to a different customer IN THE SAME company', async (t) => {
    if (!ready) t.skip();
    const r = await inTx(() => createCreditNoteTool.handler(
      {
        type: 'customer',
        client_id: siblingCustomer,      // exists in COMPANY
        customer_invoice_id: invoice,    // exists in COMPANY, but belongs to `customer`
        credit_date: '2026-06-30', subtotal: 100, idempotency_key: 'k',
      }, ctx()));
    expect(r.isError).toBe(true);
    // The exact message matters: a generic 'Not found' here would mean the
    // tenant branch answered and the counterparty check never ran.
    expect(r.content[0]!.text).toContain('different customer');
  });

  it('refuses an invoice from another tenant with the generic miss text', async (t) => {
    if (!ready) t.skip();
    const r = await inTx(() => createCreditNoteTool.handler(
      { type: 'customer', client_id: otherCustomer, customer_invoice_id: invoice, credit_date: '2026-06-30', subtotal: 100, idempotency_key: 'k' }, ctx(OTHER)));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found');
  });

  it('supplier note: create -> approve -> cancel, stamping the ledger', async (t) => {
    if (!ready) t.skip();
    const created = J(await inTx(() => createCreditNoteTool.handler(
      { type: 'supplier', supplier_id: supplier, credit_date: '2026-06-30', subtotal: 200, idempotency_key: 'k1' }, ctx())));
    expect(created.status).toBe('draft');
    expect(created.total_amount).toBeCloseTo(230, 2);

    const approved = J(await inTx(() => approveCreditNoteTool.handler({ credit_note_id: created.id, idempotency_key: 'k2' }, ctx())));
    expect(approved.status).toBe('approved');
    expect(approved.gl_journal_entry_id).toBeTruthy();

    const je = await sql`SELECT posting_agent, status FROM gl_journal_entries WHERE id = ${approved.gl_journal_entry_id}::UUID` as {posting_agent:string;status:string}[];
    expect(je[0]!.posting_agent).toBe('mcp:approve_credit_note:v1');
    expect(je[0]!.status).toBe('posted');

    const bal = await sql`SELECT SUM(debit) d, SUM(credit) c FROM gl_journal_lines WHERE journal_entry_id = ${approved.gl_journal_entry_id}::UUID` as {d:string;c:string}[];
    expect(Number(bal[0]!.d)).toBeCloseTo(Number(bal[0]!.c), 2);

    const dbl = await inTx(() => approveCreditNoteTool.handler({ credit_note_id: created.id, idempotency_key: 'k3' }, ctx()));
    expect(dbl.isError).toBe(true);

    const cancelled = J(await inTx(() => cancelCreditNoteTool.handler({ credit_note_id: created.id, reason: 'e2e', idempotency_key: 'k4' }, ctx())));
    expect(cancelled.status).toBe('cancelled');

    // Migration 528: without these columns the UPDATE throws AFTER the journal
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
    const created = J(await inTx(() => createCreditNoteTool.handler(
      { type: 'customer', client_id: customer, customer_invoice_id: invoice, credit_date: '2026-06-30', subtotal: 100, idempotency_key: 'k5' }, ctx())));
    const approved = J(await inTx(() => approveCreditNoteTool.handler({ credit_note_id: created.id, idempotency_key: 'k6' }, ctx())));
    expect(approved.status).toBe('applied');
    expect(approved.applied_to_invoice_id).toBe(invoice);

    let inv = await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${invoice}::UUID` as {amount_paid:string}[];
    expect(Number(inv[0]!.amount_paid)).toBeCloseTo(115, 2);

    await inTx(() => cancelCreditNoteTool.handler({ credit_note_id: created.id, idempotency_key: 'k7' }, ctx()));
    inv = await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${invoice}::UUID` as {amount_paid:string}[];
    expect(Number(inv[0]!.amount_paid)).toBeCloseTo(0, 2);
  });

  it('reads are tenant-scoped', async (t) => {
    if (!ready) t.skip();
    const created = J(await inTx(() => createCreditNoteTool.handler(
      { type: 'customer', client_id: customer, credit_date: '2026-06-30', subtotal: 10, idempotency_key: 'k8' }, ctx())));

    const mine = J(await inTx(() => listCreditNotesTool.handler({ limit: 200 }, ctx())));
    expect(mine.credit_notes.map((c: { id: string }) => c.id)).toContain(created.id);

    // The same id must be invisible to the other tenant, through both surfaces.
    const theirs = J(await inTx(() => listCreditNotesTool.handler({ limit: 200 }, ctx(OTHER))));
    expect(theirs.credit_notes.map((c: { id: string }) => c.id)).not.toContain(created.id);
    const cross = await inTx(() => getCreditNoteTool.handler({ credit_note_id: created.id }, ctx(OTHER)));
    expect(cross.isError).toBe(true);
    expect(cross.content[0]!.text).toBe('Not found');
  });
});

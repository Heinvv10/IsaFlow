/**
 * #1701 review round 5, against a real database:
 * - H1: auto_apply_unapplied's back-fill adds to a note's EXISTING application (addToExisting). The gate now judges the
 *   increment against the invoice's CURRENT capacity, which counts that row: typed Y 100 + 15; unlinked U 200 + 30;
 *   MCP apply U -> Y 60; linked L 40 + 6.00 approved, not applied (Y: 55 outstanding, 9 left to credit); the back-fill
 *   adds 9 to U's row (69), never 55 (115: 161 credited on 115).
 * - M2: the back-fill's dry run plans exactly what the live run writes (the same capped planner).
 * - L2: approve's FIFO walk takes what fits to a partly fitting typed invoice and the rest to the next.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import creditNotesRoute from '../../pages/api/accounting/credit-notes';
import creditNotesAction from '../../pages/api/accounting/credit-notes-action';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { approveCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteApplyToInvoice';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { untypeLines } from './helpers/lineVatFixture';
import { applyCreditNoteTool } from '@/lib/mcp/tools/writeApplyCreditNote';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import type { McpToolContext } from '@/lib/mcp/types';
import { callRoute, createUser } from './r035-approval.helpers';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
let pool: Pool;
const tokens: Record<string, string> = {};
let user = '';

type Res = Awaited<ReturnType<typeof callRoute>>;
const J = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const data = <T>(r: Res) => (r.state.body as { data: T }).data;
const errorOf = (r: Res) => (r.state.body as { error?: { message?: string; details?: { code?: string } } }).error;
const post = (route: Parameters<typeof callRoute>[0], url: string, body: Record<string, unknown>) =>
  callRoute(route, tokens[user]!, f.fx.companyId, 'POST', body, url);
const state = (invoiceId: string) => inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, invoiceId));
const apply = async (creditNoteId: string, invoiceId: string) => {
  const r = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'apply', creditNoteId, invoiceId });
  expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
};
const linkOf = async (id: string) => ((await sql`SELECT customer_invoice_id FROM credit_notes WHERE id = ${id}::UUID`) as { customer_invoice_id: string | null }[])[0]!.customer_invoice_id;
/** A linked note on a typed invoice with nothing left is refused at create (no VAT given), nothing written. */
const refusedOn = async (invoiceId: string, date: string) => {
  const before = await counts();
  const r = await post(creditNotesRoute, '/api/accounting/credit-notes', { type: 'customer', clientId: f.fx.customerId, customerInvoiceId: invoiceId, creditDate: date, subtotal: 100 });
  expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(400);
  expect(errorOf(r)?.details?.code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
  expect(await counts()).toEqual(before);
};
const counts = async () => ((await sql`
  SELECT (SELECT COUNT(*)::INT FROM credit_notes WHERE company_id = ${f.fx.companyId}::UUID) AS notes,
         (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID) AS journals,
         (SELECT COUNT(*)::INT FROM credit_note_revenue_allocations WHERE company_id = ${f.fx.companyId}::UUID) AS takes`) as Record<string, number>[])[0]!;
const ctx = (): McpToolContext => ({ companyId: f.fx.companyId, userId: f.fx.userId, tokenJti: 'jti', scopes: ['write:invoices', 'write:post'],
  companyRole: 'owner', oauthAppId: null }) as unknown as McpToolContext;
type Line = { description: string; quantity: number; unitPrice: number; vatType: string };
const typedInvoice = async (date: string, unitPrice = 100, items?: Line[], clientId?: string) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: clientId ?? f.fx.customerId, invoiceDate: date,
    items: (items ?? [{ description: 'Standard', quantity: 1, unitPrice, vatType: 'standard' }]) as never,
  }))).id;
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
};
/** A legacy (untyped) invoice for customer `c`, 100 at 15%: 115. */
const legacyInvoiceFor = async (c: string, date: string) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: c, invoiceDate: date, taxRate: 15, items: [{ description: 'Legacy', quantity: 1, unitPrice: 100 }],
  }))).id;
  await untypeLines(id);
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
};
/** A legacy (untyped) invoice, 100 at 15%: 115. */
const legacyInvoice = async (date: string) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: date, taxRate: 15, items: [{ description: 'Legacy', quantity: 1, unitPrice: 100 }],
  }))).id;
  await untypeLines(id);
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
};
/** A note at 15% (unlinked unless `linkedTo`), approved with nothing applied. */
const approvedNote = async (date: string, subtotal: number, linkedTo?: string, opts: { taxRate?: number; clientId?: string; fifo?: boolean } = {}) => {
  const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: opts.clientId ?? f.fx.customerId, creditDate: date, subtotal,
    ...(linkedTo ? { customerInvoiceId: linkedTo } : { taxRate: opts.taxRate ?? 15 }),
  }, f.fx.userId));
  await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId, { autoApply: opts.fifo ? 'fifo' : 'none' }));
  return cn;
};

describeIfDisposable('per-line VAT writers, review round 5', () => {
  beforeAll(async () => {
    f = await seedLineRevenue(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    user = await createUser(pool, tokens);
    await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, $3)', [f.fx.companyId, user, 'owner']);
  }, 60_000);
  afterAll(async () => {
    if (!f) return;
    for (const c of [f.fx.companyId, f.other.companyId]) {
      await sql`DELETE FROM credit_note_revenue_allocations WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM audit_log WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM mcp_tool_calls WHERE company_id = ${c}::UUID`;
    }
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [user]);
    await dropLineRevenue(f);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
    await pool.end();
  });
  const customer = async (name: string) => (await pool.query(`INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [f.fx.companyId, `${name} ${f.fx.tag}`])).rows[0].id as string;
  const rowsOf = async (noteId: string) => sql`
    SELECT invoice_id, amount_allocated::FLOAT8 AS amount FROM credit_note_allocations WHERE credit_note_id = ${noteId}::UUID ORDER BY invoice_id`;

  it('H1 + M2: the back-fill adds only what is left (9) to an existing application, and its dry run plans exactly that', async () => {
    const c = await customer('H1');
    const y = await typedInvoice('2026-11-11', 100, undefined, c);
    const u = await approvedNote('2026-11-11', 200, undefined, { clientId: c });          // 200 + 30
    const first = J(await inTx(f.fx, () => applyCreditNoteTool.handler({ credit_note_id: u.id, invoice_id: y, amount: 60, idempotency_key: crypto.randomUUID() }, ctx())));
    expect(first.amount_applied).toBe(60);
    const l = await approvedNote('2026-11-12', 40, y, { clientId: c });                     // linked, not applied
    expect(l.taxAmount).toBe(6);
    // Y: 55 outstanding; left to credit 100 - 40 + 15 - 6 = 69, less U's 60 applied = 9.
    expect(await state(y)).toEqual({ remainingNet: 7.83, remainingVat: 1.17 });

    const req = { companyId: f.fx.companyId, subledger: 'ar' as const, entityId: c, userId: f.fx.userId };
    const dry = await inTx(f.fx, () => autoApplyUnapplied({ ...req, dryRun: true }));
    const live = await inTx(f.fx, () => autoApplyUnapplied({ ...req, dryRun: false }));
    const lines = (p: typeof dry) => p.applications.map((a) => [a.payment_id, a.lines.map((x) => [x.document_id, x.amount])]);
    expect(lines(live)).toEqual(lines(dry));
    expect(lines(live)).toEqual([[u.id, [[y, 9]]], [l.id, [[y, 46]]]]);
    expect(await rowsOf(u.id)).toEqual([{ invoice_id: y, amount: 69 }]);
    expect(await sql`SELECT amount_paid::FLOAT8 AS paid FROM customer_invoices WHERE id = ${y}::UUID`).toEqual([{ paid: 115 }]);
    expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
  });

  it('M2: with a second open invoice the dry run caps the typed one and spills the rest exactly as the live run does', async () => {
    const c = await customer('M2');
    const y = await typedInvoice('2026-11-13', 100, undefined, c);
    await approvedNote('2026-11-13', 50, y, { clientId: c });                              // 57.50 left, 115 outstanding
    const z = await legacyInvoiceFor(c, '2026-11-14');
    const u = await approvedNote('2026-11-15', 100, undefined, { clientId: c });          // 115
    const req = { companyId: f.fx.companyId, subledger: 'ar' as const, entityId: c, userId: f.fx.userId };
    const dry = await inTx(f.fx, () => autoApplyUnapplied({ ...req, dryRun: true }));
    const uLines = (p: typeof dry) => p.applications.filter((a) => a.payment_id === u.id).map((a) => a.lines.map((x) => [x.document_id, x.amount]));
    expect(uLines(dry)).toEqual([[[y, 57.5], [z, 57.5]]]);
    const live = await inTx(f.fx, () => autoApplyUnapplied({ ...req, dryRun: false }));
    expect(uLines(live)).toEqual(uLines(dry));
  });

  it('L2: approve\'s FIFO walk takes what fits (57.50) to a partly fitting typed invoice, the rest to the next', async () => {
    const c = await customer('L2');
    const y = await typedInvoice('2026-11-16', 100, undefined, c);
    await approvedNote('2026-11-16', 50, y, { clientId: c });
    const z = await legacyInvoiceFor(c, '2026-11-17');
    const u = await approvedNote('2026-11-18', 100, undefined, { clientId: c, fifo: true });
    expect(await rowsOf(u.id)).toEqual([{ invoice_id: y, amount: 57.5 }, { invoice_id: z, amount: 57.5 }].sort((a, b) => a.invoice_id.localeCompare(b.invoice_id)));
    expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
  });
});

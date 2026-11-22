/**
 * Shared kit of cancel-draft-credit-note.int.test.ts and cancel-draft-credit-note-approved.int.test.ts (split for the 300-line cap):
 * two fixture companies (the second one for a cross-company case), a note seeder and the row / count readers.
 */
import { sql } from '@/lib/neon';
import { cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, seedFixtureMember, type Fixture } from './l1FifoFixture';

export const DATABASE_URL = process.env.DATABASE_URL;
/** The two fixture companies, set by setupWorld. */
export const w = { fx: undefined as unknown as Fixture, other: undefined as unknown as Fixture };

export async function setupWorld(): Promise<{ fx: Fixture; other: Fixture }> {
  assertNotProductionDb('This test creates and cancels credit notes.');
  w.fx = await seedFixture('CDC', DATABASE_URL!);
  w.other = await seedFixture('CDX', DATABASE_URL!);
  // audit_log.user_id references users: the fixture's actor needs a row, as every real caller has one.
  for (const f of [w.fx, w.other]) {
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${f.userId}, ${`${f.userId}@test.local`}, 'viewer', true)`;
    await seedFixtureMember(f); // an owner: the non-draft cancel asks Approve from company_users (#1656)
  }
  await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
    VALUES (${w.fx.companyId}::UUID, '4000', ${`Revenue ${w.fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
  return w;
}

export async function teardownWorld(): Promise<void> {
  for (const f of [w.fx, w.other]) {
    await sql`DELETE FROM approval_requests WHERE company_id = ${f.companyId}::UUID`;
    await sql`DELETE FROM customer_invoice_disputes WHERE company_id = ${f.companyId}::UUID`;
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${f.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${f.companyId}::UUID`;
    await sql`DELETE FROM mcp_tool_calls WHERE company_id = ${f.companyId}::UUID`;
    await sql`DELETE FROM company_users WHERE company_id = ${f.companyId}::UUID`;
    await dropFixture(f);
    await sql`DELETE FROM users WHERE id = ${f.userId}`;
  }
}

export const KEY = { idempotency_key: 'k-int' };
export const ctxFor = (f: Fixture) => ({ companyId: f.companyId, userId: f.userId, tokenJti: 'jti', companyRole: 'owner', scopes: ['write:invoices', 'write:post'], oauthAppId: null }) as unknown as McpToolContext;
export const cancel = (id: string, extra: Record<string, unknown> = {}, f: Fixture = w.fx) =>
  inTx(f, () => cancelCreditNoteTool.handler({ credit_note_id: id, ...KEY, ...extra }, ctxFor(f)));
export const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

let seq = 0;
export async function seedNote(over: {
  type?: 'customer' | 'supplier'; number?: string; status?: string; journal?: boolean; applied?: number; invoice?: string; bill?: string; f?: Fixture;
} = {}): Promise<string> {
  const f = over.f ?? w.fx;
  const type = over.type ?? 'customer';
  let je: string | null = null;
  if (over.journal) {
    je = ((await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at)
      VALUES (${f.companyId}::UUID, ${`JE-${++seq}-${f.tag}`}, '2026-03-01'::DATE, 'CN', 'posted', ${f.userId}::UUID,
              (SELECT id FROM fiscal_periods WHERE company_id = ${f.companyId}::UUID LIMIT 1), NOW())
      RETURNING id`) as { id: string }[])[0]!.id;
  }
  return ((await sql`
    INSERT INTO credit_notes (company_id, type, client_id, supplier_id, customer_invoice_id, supplier_invoice_id, credit_note_number,
      credit_date, subtotal, tax_rate, tax_amount, total_amount, applied_amount, status, created_by, gl_journal_entry_id, reason)
    VALUES (${f.companyId}::UUID, ${type}, ${type === 'customer' ? f.customerId : null}::UUID, ${type === 'supplier' ? f.supplierId : null}::UUID,
      ${over.invoice ?? null}::UUID, ${over.bill ?? null}::UUID, ${over.number ?? `CN-2026-${80000 + ++seq}`}, '2026-03-01'::DATE, 100, 15, 15, 115,
      ${over.applied ?? 0}, ${over.status ?? 'draft'}, ${f.userId}::UUID, ${je}::UUID, 'int test')
    RETURNING id`) as { id: string }[])[0]!.id;
}

export interface Row { status: string; credit_note_number: string; cancelled_by: string | null; cancelled_at: Date | null; cancel_reason: string | null; applied_amount: string; gl_journal_entry_id: string | null }
export async function row(id: string): Promise<Row | null> {
  return ((await sql`SELECT status, credit_note_number, cancelled_by, cancelled_at, cancel_reason, applied_amount, gl_journal_entry_id
    FROM credit_notes WHERE id = ${id}::UUID`) as Row[])[0] ?? null;
}
export async function journalCount(f: Fixture = w.fx): Promise<number> {
  return Number(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${f.companyId}::UUID`) as { n: string }[])[0]!.n);
}
export async function allocCount(id: string): Promise<number> {
  return Number(((await sql`SELECT COUNT(*) AS n FROM credit_note_allocations WHERE credit_note_id = ${id}::UUID`) as { n: string }[])[0]!.n);
}

export async function auditRows(id: string) {
  return (await sql`SELECT user_id, action, entity_type, changes FROM audit_log WHERE entity_id = ${id}::UUID`) as
    { user_id: string; action: string; entity_type: string; changes: { fields: { field: string; old: string | null; new: string | null; label: string }[]; metadata: Record<string, string> } }[];
}


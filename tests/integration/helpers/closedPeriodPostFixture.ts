/**
 * Fixture for closed-period-post-refusal.int.test.ts: a fresh company whose one
 * fiscal period (all of 2026) is put into a given state, the four draft
 * documents a posting path starts from, and what a refusal must leave behind.
 *
 * Built on l1FifoFixture (company, parties, chart, one open 2026 period).
 */
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { seedFixture, seedBill, seedInvoice, dropFixture, type Fixture } from './l1FifoFixture';
import { seedPostedNote } from './creditNoteJournalFixture';

/** What the period covering the documents' date is. `no_period`: no fiscal_periods row covers it at all. */
export type PeriodState = 'open' | 'closed' | 'locked' | 'closing' | 'no_period';

/** Every document is dated here, inside the fixture's one 2026 period. */
export const DOC_DATE = '2026-03-15';

export async function seedWorld(state: PeriodState, databaseUrl: string): Promise<Fixture> {
  const fx = await seedFixture('CPP', databaseUrl);
  try {
    return await buildWorld(fx, state);
  } catch (e) {
    // A half-built world must not leak its company or pool; a cleanup failure must not replace the real error.
    await dropWorld(fx).catch((cleanup: unknown) => { throw new Error(`world build failed and cleanup failed too: ${String(cleanup)}`, { cause: e }); });
    throw e;
  }
}

async function buildWorld(fx: Fixture, state: PeriodState): Promise<Fixture> {
  // The revenue account a customer invoice / note posts to (the shared fixture has none).
  await sql`
    INSERT INTO gl_accounts
      (company_id, account_code, account_name, account_type, account_subtype,
       normal_balance, is_active, is_system_account)
    VALUES (${fx.companyId}::UUID, '4000', ${`Revenue ${fx.tag}`}, 'revenue', 'default_revenue',
            'credit', true, true)`;
  if (state === 'no_period') {
    // The periods AND their year: the trigger that links a period to its year created one when seedFixture inserted the period.
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM fiscal_years WHERE company_id = ${fx.companyId}::UUID`;
  } else if (state !== 'open') {
    await sql`UPDATE fiscal_periods SET status = ${state} WHERE company_id = ${fx.companyId}::UUID`;
  }
  return fx;
}

/**
 * One request transaction on its own connection, committed EVEN WHEN `fn` throws.
 * withAuth COMMITs every answer below 500, and the routes answer a refusal 400,
 * so a refusal that had already written something would persist it. `inTx` in
 * l1FifoFixture rolls back on error, which would hide exactly that.
 */
export async function commitingTx<T>(fx: Fixture, fn: () => Promise<T>): Promise<T> {
  const c = await fx.pool.connect();
  await c.query('BEGIN');
  let failure: unknown = null;
  try {
    return await als.run({ client: c, userId: fx.userId, companyId: fx.companyId, claims: {} } as never, fn);
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    // On an aborted transaction Postgres rolls back and answers ROLLBACK: then a zero-count assertion would prove nothing.
    // The call's own error stays the one reported; a not-committed note is raised only when the call itself passed.
    try {
      const ended = await c.query('COMMIT');
      if (ended.command !== 'COMMIT' && failure === null) {
        throw new Error(`the request transaction did not commit (${ended.command}); a refusal from a failed statement cannot prove "writes nothing"`);
      }
    } finally {
      c.release();
    }
  }
}

/** `${error class}: ${message}`, or null when the call resolved. */
export async function refusalOf(p: Promise<unknown>): Promise<string | null> {
  const err = await p.then(() => null, (e: unknown) => e);
  if (err === null) return null;
  return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
}

export interface LedgerCounts { journals: number; lines: number }

/** Everything the company's ledger holds (a fresh company, so any row is this document's). */
export async function ledgerCounts(fx: Fixture): Promise<LedgerCounts> {
  const c = fx.companyId;
  const j = (await sql`SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${c}::UUID`) as { n: number }[];
  const l = (await sql`SELECT COUNT(*)::INT AS n FROM gl_journal_lines WHERE company_id = ${c}::UUID`) as { n: number }[];
  return { journals: j[0]!.n, lines: l[0]!.n };
}

export interface DocState { status: string; journalId: string | null }

type StateRow = { status: string; gl_journal_entry_id: string | null };
const asState = (rows: unknown): DocState => {
  const r = (rows as StateRow[])[0]!;
  return { status: r.status, journalId: r.gl_journal_entry_id };
};

export async function invoiceState(fx: Fixture, id: string): Promise<DocState> {
  return asState(await sql`SELECT status, gl_journal_entry_id FROM customer_invoices
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`);
}
export async function billState(fx: Fixture, id: string): Promise<DocState> {
  return asState(await sql`SELECT status, gl_journal_entry_id FROM supplier_invoices
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`);
}
export async function noteState(fx: Fixture, id: string): Promise<DocState> {
  return asState(await sql`SELECT status, gl_journal_entry_id FROM credit_notes
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`);
}

export const seedDraftInvoice = (fx: Fixture, status = 'draft') =>
  seedInvoice(fx, { number: 'INV', date: DOC_DATE, total: 100, status });

export async function seedDraftBill(fx: Fixture): Promise<string> {
  const id = await seedBill(fx, { number: 'BILL', date: DOC_DATE, total: 100, status: 'draft' });
  const expense = (await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'default_expense'`) as { id: string }[];
  await sql`
    INSERT INTO supplier_invoice_items
      (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, 'Line', 1, 100, 0, 0, 100, ${expense[0]!.id}::UUID)`;
  return id;
}

/** A draft credit note with no journal, as the 'post' / approve action finds it. */
export function seedDraftNote(fx: Fixture, side: 'customer' | 'supplier'): Promise<string> {
  return seedPostedNote(fx, { side, number: 'CN', total: 100, posted: null, status: 'draft' }).then(async (id) => {
    await sql`UPDATE credit_notes SET credit_date = ${DOC_DATE}::DATE WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`;
    return id;
  });
}

/** Removes what the posting paths wrote beyond l1FifoFixture's own cleanup (notes and lines name journals and parties). */
export async function dropWorld(fx: Fixture): Promise<void> {
  const c = fx.companyId;
  await sql`DELETE FROM credit_note_allocations WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
    SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
  await dropFixture(fx);
}

/** Each journal of the company: its status, whether it balances, and the status of the period it sits in. */
export async function journalsOf(fx: Fixture): Promise<{ status: string; balanced: boolean; periodStatus: string | null }[]> {
  const r = (await sql`
    SELECT e.status, SUM(l.debit) = SUM(l.credit) AND SUM(l.debit) > 0 AS balanced, p.status AS period_status
    FROM gl_journal_entries e
    JOIN gl_journal_lines l ON l.journal_entry_id = e.id
    LEFT JOIN fiscal_periods p ON p.id = e.fiscal_period_id
    WHERE e.company_id = ${fx.companyId}::UUID
    GROUP BY e.id, e.status, p.status ORDER BY e.entry_number`) as { status: string; balanced: boolean; period_status: string | null }[];
  return r.map((x) => ({ status: x.status, balanced: x.balanced, periodStatus: x.period_status }));
}

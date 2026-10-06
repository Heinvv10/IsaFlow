/**
 * Ledger-date window (sec-numrace S4): the window (utils/journalDateWindow) enforced once at the funnel —
 * createJournalEntry refuses an entry date outside 1900-01-01..2199-12-31 before the journal writes anything
 * (gl/journalDateGuard) — and on bank-transfers, which INSERTs its journal itself.
 *
 *   - the manual journal route: 400 with the window's wording, nothing written;
 *   - MCP create_draft_journal: the caller-safe refusal, nothing written;
 *   - `preWrite`: a refusal raised after the request wrote is NOT answered 4xx (withAuth would COMMIT that write) —
 *     respondIfJournalDateRefused declines it, leaving the 500 that rolls it back;
 *   - bank-transfers: a transferDate outside the window is a 422 before anything runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import journalEntries from '../../pages/api/accounting/journal-entries';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import customerInvoiceDetail from '../../pages/api/accounting/customer-invoices-detail';
import claimPost from '../../pages/api/accounting/expense-claims/[id]/post';
import { createDraftJournalTool } from '@/lib/mcp/tools/writeJournals';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { respondIfJournalDateRefused } from '@/lib/apiJournalDate';
import { isJournalDateRefused } from '@/modules/accounting/utils/journalDateWindow';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { response } from './mfa-impersonation-postgres.helpers';
import { dropFixture, inTx, seedBankTx, seedInvoice } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, toolCtx, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: DateFixture;
let token = '';

const lines = () => [
  { glAccountId: c.expense, debit: 10, credit: 0, description: 'NRJD' },
  { glAccountId: c.fx.bankAccountId, debit: 0, credit: 10, description: 'NRJD' },
];
const journals = async (tag: string) => Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
  WHERE company_id = ${c.fx.companyId}::UUID AND description = ${tag}`) as { n: number }[])[0]!.n);

async function refusalOf(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); } catch (err) { return err; }
  return null;
}

describeIfDb('NUMRACE r3 (S4): createJournalEntry refuses a date outside 1900..2199', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('NUMRACE-JD', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'numrace-jd');
  }, 60000);

  afterAll(async () => {
    await dropRouteUser(c.fx);
    await dropFixture(c.fx);
  }, 60000);

  it('the manual journal route: 0001-06-01 is a 400 naming the window, nothing written', async () => {
    const out = await callRoute(c.fx, token, journalEntries, {
      entryDate: '0001-06-01', description: 'NRJD route', lines: lines(),
    });
    process.stdout.write(`JD-route ${JSON.stringify(out)}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(await journals('NRJD route')).toBe(0);
  }, 60000);

  it('MCP create_draft_journal dated 2200-01-01: the caller-safe refusal, nothing written', async () => {
    const out = await inTx(c.fx, () => createDraftJournalTool.handler({
      date: '2200-01-01', memo: 'NRJD mcp', idempotency_key: `nrjd-${crypto.randomUUID()}`,
      lines: [
        { account_id: c.expense, debit: 10, credit: 0 },
        { account_id: c.fx.bankAccountId, debit: 0, credit: 10 },
      ],
    }, toolCtx(c)));
    process.stdout.write(`JD-mcp ${JSON.stringify(out)}\n`);
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(await journals('NRJD mcp')).toBe(0);
  }, 60000);

  it('preWrite: refused before any write → a route 400; refused after one → declined (the 500 rolls it back)', async () => {
    const clean = await refusalOf(() => inTx(c.fx, () => createJournalEntry(c.fx.companyId,
      { entryDate: '100000-01-01', description: 'NRJD clean', lines: lines() }, c.fx.userId)));
    const dirty = await refusalOf(() => inTx(c.fx, async () => {
      await seedBankTx(c.fx, { date: '2025-06-01', amount: -1, description: 'NRJD earlier write' });
      return createJournalEntry(c.fx.companyId,
        { entryDate: '0001-06-01', description: 'NRJD dirty', lines: lines() }, c.fx.userId);
    }));
    const cleanRes = response();
    const dirtyRes = response();
    const answered = [respondIfJournalDateRefused(cleanRes.res as never, clean),
      respondIfJournalDateRefused(dirtyRes.res as never, dirty)];
    process.stdout.write(`JD-prewrite ${JSON.stringify({ clean: String(clean), dirty: String(dirty), answered })}\n`);
    expect(isJournalDateRefused(clean) && clean.preWrite).toBe(true);
    expect(isJournalDateRefused(dirty) && !dirty.preWrite).toBe(true);
    expect(answered).toEqual([true, false]);
    expect(cleanRes.state.statusCode).toBe(400);
    expect(await journals('NRJD clean') + await journals('NRJD dirty')).toBe(0);
  }, 60000);

  it('bank-transfers (INSERTs its own journal): transferDate 0001-06-01 is a 422 before anything runs', async () => {
    const out = await callRoute(c.fx, token, bankTransfers, {
      fromAccountId: c.fx.bankAccountId, toAccountId: c.expense, amount: 10, transferDate: '0001-06-01',
    });
    process.stdout.write(`JD-txf ${JSON.stringify(out)}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(422);
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
  }, 60000);

  // brk-numrace F2: approve checks the invoice's date before its row lock and status UPDATE — nothing written yet.
  it('brk F2 (W5): approving a draft customer invoice dated 2205-01-01 is a 400, nothing written', async () => {
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account)
      SELECT ${c.fx.companyId}::UUID, '4000', ${`Revenue ${c.fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true
      WHERE NOT EXISTS (SELECT 1 FROM gl_accounts WHERE company_id = ${c.fx.companyId}::UUID
        AND account_subtype = 'default_revenue')`;
    const id = await seedInvoice(c.fx, { number: 'NRJD-W5', date: '2205-01-01', total: 100, status: 'draft' });
    await sql`INSERT INTO customer_invoice_items (invoice_id, description, unit_price, quantity, amount, tax_rate)
      VALUES (${id}::UUID, 'nrjd', 100, 1, 100, 0)`;
    const out = await callRoute(c.fx, token, customerInvoiceDetail, { id, action: 'approve' });
    const inv = (await sql`SELECT status, gl_journal_entry_id FROM customer_invoices WHERE id = ${id}::UUID`) as
      { status: string; gl_journal_entry_id: string | null }[];
    process.stdout.write(`JD-W5 ${JSON.stringify({ status: out.statusCode, body: out.body, inv })}\n`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(inv[0]).toEqual({ status: 'draft', gl_journal_entry_id: null });
  }, 60000);

  it('brk F2: posting an approved expense claim dated 2205-01-01 is a 400, the claim untouched', async () => {
    const emp = ((await sql`INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
      VALUES (${c.fx.companyId}::UUID, ${`NRJD-${c.fx.tag}`.slice(0, 20)}, 'Nr', 'Jd', '2025-01-01') RETURNING id`) as
      { id: string }[])[0]!.id;
    const claim = ((await sql`INSERT INTO expense_claims (company_id, employee_id, claim_number, claim_date, status)
      VALUES (${c.fx.companyId}::UUID, ${emp}::UUID, 'CL-NRJD-1', '2205-01-01', 'approved') RETURNING id`) as
      { id: string }[])[0]!.id;
    await sql`INSERT INTO expense_claim_lines (claim_id, company_id, line_date, description, amount, vat_amount, vat_code,
        gl_account_id) VALUES (${claim}::UUID, ${c.fx.companyId}::UUID, '2205-01-01', 'nrjd', 100, 0, 'none', ${c.expense}::UUID)`;
    const liability = ((await sql`SELECT id FROM gl_accounts WHERE company_id = ${c.fx.companyId}::UUID
      AND account_type = 'liability' ORDER BY account_code LIMIT 1`) as { id: string }[])[0]!.id;
    try {
      const out = await callRoute(c.fx, token, claimPost, { reimbursementAccountId: liability }, { id: claim });
      const st = (await sql`SELECT status, posted_je_id FROM expense_claims WHERE id = ${claim}::UUID`) as
        { status: string; posted_je_id: string | null }[];
      process.stdout.write(`JD-claim ${JSON.stringify({ status: out.statusCode, body: out.body, st })}\n`);
      expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
      expect(JSON.stringify(out.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
      expect(st[0]).toEqual({ status: 'approved', posted_je_id: null });
    } finally {
      await sql`DELETE FROM expense_claim_lines WHERE claim_id = ${claim}::UUID`;
      await sql`DELETE FROM expense_claims WHERE id = ${claim}::UUID`;
      await sql`DELETE FROM payroll_employees WHERE id = ${emp}::UUID`;
    }
  }, 60000);

  // blind LOW: an empty transferDate is absent (today), as on base — never a window refusal.
  it("bank-transfers transferDate '': not refused by the window (empty = today, as on base)", async () => {
    const out = await callRoute(c.fx, token, bankTransfers, {
      fromAccountId: c.fx.bankAccountId, toAccountId: c.expense, amount: 10, transferDate: '',
    });
    process.stdout.write(`JD-txf-empty ${JSON.stringify(out)}\n`);
    expect(out.statusCode).not.toBe(422);
    expect(JSON.stringify(out.body)).not.toMatch(/1900-01-01/);
  }, 60000);
});

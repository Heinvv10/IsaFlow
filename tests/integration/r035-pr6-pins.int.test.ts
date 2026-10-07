/**
 * R-035 PR6: what the manual-journal gate does NOT govern (Hein, 2026-10-06,
 * decision 2), pinned under enforcement with a rule that matches EVERY journal
 * (owner, any amount) — so anything gated would be refused here.
 *
 *  - opening balances post (decision 2; the route writes source 'manual', so
 *    nothing may key the gate on `source`);
 *  - a system journal of a document posts: a customer invoice approved through
 *    its own route (customer_invoice enforcement off) and a supplier invoice;
 *  - the reversal of a posted manual journal posts, unmarked — not in decision
 *    2 (a follow-up for Hein), and reversing writes no status onto the
 *    original, so the backstop never judges it.
 * bank-transfers (a raw 'posted' insert, also not in decision 2) and the
 * system posters that insert headers directly are pinned by the census
 * (manualJournalApprovalCensus.test.ts): they write no marker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import openingBalances from '../../pages/api/accounting/opening-balances';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill, plantRule } from './r035-approval.helpers';
import { routes as billRoutes } from './r035-pr2.helpers';
import { invoiceCompany, invoiceRoutes, invoiceState, plantInvoice } from './r035-pr4.helpers';
import { cleanupPr6, enforceJournals, journalRoutes, journalState, plantJournal, type JournalCompany } from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = journalRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr6(pool, companies, Object.values(u)));

/** A company that can post invoices and bills, with every journal governed by an owner rule, enforced. */
async function everyJournalGated(): Promise<JournalCompany> {
  const c = await invoiceCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  const tag = c.slice(0, 6);
  const ids: string[] = [];
  for (const [code, type, normal, subtype] of [['EA', 'expense', 'debit', 'default_expense'], ['VI', 'asset', 'debit', 'vat_input'],
    ['AP', 'liability', 'credit', 'payable'], ['BK', 'asset', 'debit', 'bank'], ['EQ', 'equity', 'credit', null]] as const) {
    const { rows } = await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype,level)
       VALUES ($1,$2,$3,$4,$5,true,true,$6,3) RETURNING id`, [c, `${code}${tag}`, `R035 ${code}`, type, normal, subtype]);
    ids.push(String(rows[0].id));
  }
  await plantRule(pool, c, 'owner', { documentType: 'manual_journal', operator: 'any' });
  await enforceJournals(pool, c, u.b);
  return { c, expA: ids[0]!, expB: ids[4]!, bank: ids[3]! };
}

describe('not gated by manual-journal approval', () => {
  it('a plain manual draft IS gated here (the control for the pins below)', async () => {
    const f = await everyJournalGated();
    const id = await plantJournal(pool, f, u.a, { amount: 1 });
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(409);
  });

  it('opening balances post (source manual)', async () => {
    const f = await everyJournalGated();
    const res = await callRoute(openingBalances, tokens[u.a]!, f.c, 'POST',
      { balances: [{ accountId: f.bank, debit: 500, credit: 0 }, { accountId: f.expB, debit: 0, credit: 500 }] },
      '/api/accounting/opening-balances');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { rows } = await pool.query(
      "SELECT status, source, approval_document_type FROM gl_journal_entries WHERE company_id = $1 AND reference = 'opening_balance'", [f.c]);
    expect(rows).toEqual([{ status: 'posted', source: 'manual', approval_document_type: null }]);
  });

  it("a document's system journal posts: a customer invoice and a supplier invoice approved through their routes", async () => {
    const f = await everyJournalGated();
    const inv = await plantInvoice(pool, f.c, u.a);
    expect((await invoiceRoutes(tokens).approve(u.a, f.c, inv.id)).state.statusCode).toBe(200);
    expect(await invoiceState(pool, inv.id)).toMatchObject({ status: 'approved', journals: 1 });
    const bill = await plantBill(pool, f.c, u.a);
    expect((await billRoutes(tokens).approveBill(u.a, f.c, bill.id)).state.statusCode).toBe(200);
  });

  it('the reversal of a posted manual journal posts, unmarked', async () => {
    const f = await everyJournalGated();
    const id = await plantJournal(pool, f, u.a);
    await r.approvedBy(pool, u.a, u.b, f.c, id);
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(200);
    const res = await r.reverse(u.a, f.c, id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { rows } = await pool.query(
      'SELECT status, approval_document_type FROM gl_journal_entries WHERE reversal_of_id = $1', [id]);
    expect(rows).toEqual([{ status: 'posted', approval_document_type: null }]);
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
  });
});

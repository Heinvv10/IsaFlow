/** Shared by the mirror ledger suites: the group's elimination chart, a second supplier, an asset account, a 2027 period for B, and the calls every case makes. */
import { expect } from 'vitest';
import type { Pool } from 'pg';
import { approveSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '../../../src/modules/accounting/services/gl/journalEntryService';
import { cancelCustomerInvoice } from '../../../src/modules/accounting/services/ar/customerInvoiceCancelService';
import { autoGenerateEliminations } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { asAppUser, withoutTrigger } from './intercompany.helpers';
import { asService, clearMirrorRows, co, connect, eliminationCleanup, eliminationSetup, inbox, mirrorCleanup, mirrorSetup, sentInvoice, U } from './mirror.helpers';

export function makeLedger(pool: Pool) {
  const extra = { supplier: crypto.randomUUID(), asset: crypto.randomUUID() };
  const rows = async () => (await pool.query('SELECT * FROM intercompany_transactions WHERE group_id = $1 ORDER BY created_at', [co.G])).rows;
  const groupRow = async () => (await rows())[0];
  const adjustments = async () => (await pool.query('SELECT id, status, reversed_at, reversed_reason FROM consolidation_adjustments WHERE group_id = $1 ORDER BY created_at', [co.G])).rows as
    Array<{ id: string; status: string; reversed_at: Date | null; reversed_reason: string | null }>;
  const eliminate = () => autoGenerateEliminations(co.G, '2026-01-01', '2026-12-31');
  const approveBill = (bill: string, user = U.b) => asService(pool, user, co.B, () => approveSupplierInvoice(co.B, bill, user));
  const cancelSender = (inv: string) => asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, inv, U.a));
  /** The sender's cancel in the LEDGER only (no hook, no service): the approval journal reversed by a direct reversal, the link cleared, the status cancelled. */
  const senderReverse = (inv: string) => asService(pool, U.a, co.A, async (q) => {
    const je = (await q.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [inv])).rows[0].je as string;
    await reverseJournalEntry(co.A, je, U.a);
    await q.query("UPDATE customer_invoices SET status = 'cancelled', gl_journal_entry_id = NULL WHERE id = $1", [inv]);
  });
  const sync = (user: string, company: string, bill: string) =>
    asAppUser(pool, user, company, async (q) => (await q.query("SELECT public.intercompany_sync_group_row('supplier_invoice', $1) AS s", [bill])).rows[0].s as string | null, true);
  /** A sent invoice, accepted by B: its message, the sender's invoice and B's draft bill. */
  async function accepted(over: Parameters<typeof sentInvoice>[1] = {}) {
    const sent = await sentInvoice(pool, over);
    const res = await inbox.accept(U.b, co.B, sent.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const bill = (await pool.query('SELECT target_doc_id FROM intercompany_messages WHERE id = $1', [sent.id])).rows[0].target_doc_id as string;
    return { ...sent, bill };
  }
  /** The group row back to a row never matched (planted: only the definer writes these columns), so the next sync judges the bill afresh. */
  const unbind = () => withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
    `UPDATE intercompany_transactions SET match_status = 'unmatched', matched_at = NULL, matched_by = NULL, target_journal_entry_id = NULL,
            first_target_journal_entry_id = NULL, variance_reason = NULL, variance_amount = 0 WHERE group_id = $1`, [co.G]));
  /** Twelve monthly periods of `year` for `company` (the single yearly period the fixtures start with hides month-end cut-off). */
  async function monthly(company: string, year: number) {
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1 AND fiscal_year = $2', [company, year]);
    for (let m = 1; m <= 12; m++) {
      const start = `${year}-${String(m).padStart(2, '0')}-01`;
      await pool.query(
        `INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
         VALUES ($1, $2, $3, $4, $5::date, ($5::date + interval '1 month' - interval '1 day')::date, 'open')`, [company, `IC${year}-${m}`, m, year, start]);
    }
  }
  const setup = async () => {
    await mirrorSetup(pool);
    await eliminationSetup(pool);
    await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3)', [extra.supplier, co.B, 'IC B other supplier']);
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active)
       VALUES ($1, $2, $3, 'IC B fixed asset', 'asset', 'debit', true)`, [extra.asset, co.B, `ICFA${co.B.slice(0, 5)}`]);
    await pool.query(
      `INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
       VALUES ($1, 'IC 2027', 1, 2027, '2027-01-01', '2027-12-31', 'open')`, [co.B]);
  };
  const cleanup = async () => {
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', [co.B]);
    await eliminationCleanup(pool);
    await mirrorCleanup(pool);
  };
  const reset = async () => {
    await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', [co.B]);
    await clearMirrorRows(pool);
    await connect(pool);
  };
  return { extra, rows, groupRow, adjustments, eliminate, approveBill, cancelSender, senderReverse, sync, accepted, unbind, monthly, setup, cleanup, reset };
}

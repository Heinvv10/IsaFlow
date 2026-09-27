// R-127 review MEDIUM — the reversal chokepoint. Once a provisional has become
// a bill's payment, two journals hold the settlement up: the provisional (the
// bank credit and, reclassed, nothing else) and the reclass (the payment's
// journal). Reversing either alone breaks it — the provisional leaves the reclass
// debiting AP with no cash behind it; the reclass puts the bill's expense and VAT
// back twice (the void refusal's reason). Both are refused in
// reverseJournalEntry, before any write, so every caller inherits it: the
// journal-entries-action route, MCP reverse_journal_entry, the auto-post undo
// (which must skip that line cleanly) — and reverse_bank_allocation on the
// provisional's own bank line, which reverses no journal at all and used to
// just set the line back to 'imported', leaving the cash re-allocatable.
import { describe, expect, it } from 'vitest';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { reverseJournalEntryTool } from '@/lib/mcp/tools/writeJournalReverse';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  btState, callRoute, company, companySnapshot, inTx, jeState, paymentsFor, pool, seedDoc, seedInvoice,
  seedProvisional, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();

async function settled(total: number) {
  const doc = await seedDoc();
  const { je, bt } = await seedProvisional({ totalAmount: total, evidencedBy: doc });
  const invoiceId = await seedInvoice({ documentId: doc, totalAmount: total });
  await inTx(() => approveSupplierInvoice(company, invoiceId, user));
  const [payment] = await paymentsFor(bt, invoiceId);
  return { je, bt, invoiceId, reclassJe: payment!.gl_journal_entry_id! };
}

const reverseViaRoute = (id: string) => callRoute(
  journalEntriesAction, '/api/accounting/journal-entries-action', { id, action: 'reverse' });

describe('R-127: the journals holding a settlement up cannot be reversed on their own', () => {
  it('journal-entries-action refuses to reverse the provisional (400, nothing written)', async () => {
    const s = await settled(801.10);
    const before = await companySnapshot(s.invoiceId);
    const res = await reverseViaRoute(s.je);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/settle/i);
    expect(await companySnapshot(s.invoiceId)).toEqual(before);
  });

  it('journal-entries-action refuses to reverse the settlement\'s reclass (400, nothing written)', async () => {
    const s = await settled(802.20);
    const before = await companySnapshot(s.invoiceId);
    const res = await reverseViaRoute(s.reclassJe);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/settle/i);
    expect(await companySnapshot(s.invoiceId)).toEqual(before);
  });

  it('MCP reverse_journal_entry raises a coded refusal the registry answers with its message', async () => {
    const s = await settled(803.30);
    const ctx = { companyId: company, userId: user, scopes: ['write:journals', 'write:post'], tokenJti: null, oauthAppId: null };
    // The handler does not catch (a mid-write failure must reach the registry's
    // savepoint); the registry answers a refusal-coded throw with its own message.
    const err = await inTx(() => reverseJournalEntryTool.handler(
      { journal_entry_id: s.je, idempotency_key: crypto.randomUUID() }, ctx as never)).then(() => null, (e: unknown) => e);
    expect(isRefusalCoded(err)).toBe(true);
    expect((err as Error).message).toMatch(/settle/i);
    expect((await jeState(s.je)).reversed_at).toBeNull();
  });

  it('the auto-post undo skips the settled provisional\'s line as failed and keeps the run open', async () => {
    const s = await settled(804.40);
    const run = (await pool.query(
      `INSERT INTO bank_auto_post_runs(company_id,source,min_confidence,amount_cap,posted_count,created_by)
       VALUES($1,'import',0.7,100000,1,$2) RETURNING id`, [company, user])).rows[0].id as string;
    await pool.query('UPDATE bank_transactions SET auto_post_run_id=$2 WHERE id=$1', [s.bt, run]);

    const result = await inTx(() => undoRun(company, run, user));
    expect(result.reversed).toBe(0);
    expect(result.skippedBy.failed).toBe(1);
    expect((await jeState(s.je)).reversed_at).toBeNull();
    expect((await pool.query('SELECT undone_at FROM bank_auto_post_runs WHERE id=$1', [run])).rows[0].undone_at).toBeNull();
  });

  it('reverse_bank_allocation on the provisional\'s own bank line is refused, the line stays matched', async () => {
    const s = await settled(805.50);
    const before = await companySnapshot(s.invoiceId);
    await expect(inTx(() => reverseReconciledTransaction(company, s.bt, user))).rejects.toThrow(/settle/i);
    expect((await btState(s.bt)).status).toBe('matched');
    expect(await companySnapshot(s.invoiceId)).toEqual(before);
  });
});

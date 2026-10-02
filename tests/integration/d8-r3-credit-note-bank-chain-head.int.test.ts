/**
 * D8 round 3: the last two flows that took a document's journal out of the
 * ledger by its stamp — credit-note cancel (service and MCP preview) and the
 * bank allocation reversal — now take it out at its reversal-chain HEAD
 * (shared/journalChainHead), like the five in round 2.
 *
 * After O <- R <- R2 the ledger carries O again through R2 while O stays
 * stamped `reversed_at`; reversing O again threw "already reversed", so the
 * note could not be cancelled and the bank line could not be freed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let ar = '';
let expense = '';

async function net(accountId: string): Promise<number> {
  const [r] = (await sql`
    SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS n
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${fx.companyId}::UUID AND e.company_id = ${fx.companyId}::UUID
      AND e.status = 'posted' AND l.gl_account_id = ${accountId}::UUID`) as Row[];
  return Math.round(Number(r!.n) * 100) / 100;
}

const reverse = async (id: string) => (await inTx(fx, () => reverseJournalEntry(fx.companyId, id, fx.userId))).id;
const contras = async (id: string) => ((await sql`
  SELECT id FROM gl_journal_entries
  WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${id}::UUID AND status = 'posted'`) as Row[]).length;
const noteStatus = async (id: string) => String(((await sql`
  SELECT status FROM credit_notes WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Row[])[0]!.status);

/** An approved customer credit note of R1 150 (no invoice link); its id and journal. */
async function approvedNote(): Promise<{ id: string; journal: string }> {
  return inTx(fx, async () => {
    const cn = await createCreditNote(fx.companyId,
      { type: 'customer', clientId: fx.customerId, creditDate: '2026-05-10', subtotal: 1000, taxRate: 15 }, fx.userId);
    const approved = await approveCreditNote(fx.companyId, cn.id, fx.userId);
    return { id: cn.id, journal: approved.glJournalEntryId! };
  });
}

const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, scopes: ['write:invoices', 'write:post'], tokenJti: null, oauthAppId: null });

describeIfDb('D8 round 3: credit-note cancel and bank reversal take a re-reversed journal out at its head', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts, reverses and cancels journals.');
    fx = await seedFixture('D8R3', DATABASE_URL!);
    const acct = async (sub: string) => String(((await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${sub}`) as Row[])[0]!.id);
    ar = await acct('receivable');
    expense = await acct('default_expense');
    await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${fx.companyId}::UUID)`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('credit-note cancel reverses the head of a re-reversed journal, so the credit leaves AR', async () => {
    const note = await approvedNote();
    const head = await reverse(await reverse(note.journal));
    const before = await net(ar);

    await inTx(fx, () => cancelCreditNote(fx.companyId, note.id, fx.userId));

    expect(await net(ar)).toBeCloseTo(before + 1150, 2);
    expect(await contras(head)).toBe(1);
    expect(await noteStatus(note.id)).toBe('cancelled');
  });

  it('credit-note cancel with the chain already out reverses nothing and still cancels', async () => {
    const note = await approvedNote();
    await reverse(note.journal);
    const before = await net(ar);

    await inTx(fx, () => cancelCreditNote(fx.companyId, note.id, fx.userId));

    expect(await net(ar)).toBeCloseTo(before, 2);
    expect(await noteStatus(note.id)).toBe('cancelled');
  });

  it('MCP cancel_credit_note refuses a forged reversal loop from a read, writing nothing', async () => {
    const note = await approvedNote();
    const r = await reverse(note.journal);
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${r}::UUID WHERE id = ${note.journal}::UUID AND company_id = ${fx.companyId}::UUID`;
    const before = await net(ar);

    const out = await inTx(fx, () => cancelCreditNoteTool.handler(
      { credit_note_id: note.id, idempotency_key: crypto.randomUUID() }, ctx() as never));

    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toMatch(/loops back on itself/);
    expect(await noteStatus(note.id)).not.toBe('cancelled');
    expect(await net(ar)).toBeCloseTo(before, 2);
  });

  it('bank reversal of a re-reversed allocation journal reverses its head and frees the line', async () => {
    const tx = await seedBankTx(fx, { date: '2026-05-12', amount: -230, description: 'D8R3 SHOP' });
    await inTx(fx, () => allocateTransaction(fx.companyId, tx, expense, fx.userId, undefined, 'account', undefined, undefined));
    const [m] = (await sql`
      SELECT l.journal_entry_id AS j FROM bank_transactions bt JOIN gl_journal_lines l ON l.id = bt.matched_journal_line_id
      WHERE bt.id = ${tx}::UUID AND bt.company_id = ${fx.companyId}::UUID`) as Row[];
    const head = await reverse(await reverse(String(m!.j)));
    const before = await net(fx.bankAccountId);

    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));

    expect(await net(fx.bankAccountId)).toBeCloseTo(before + 230, 2);
    expect(await contras(head)).toBe(1);
    const [line] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID`) as Row[];
    expect(line!.status).toBe('imported');
  });
});

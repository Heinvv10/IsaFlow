/**
 * The breaker's bypasses of the VAT201 pre-filing controls (review round 1),
 * each now asserting the CORRECT behaviour — every one was 5/5 green as an
 * attack before the fixes.
 *
 *   B1  claim → reverse → reverse the reversal reinstates the claim: the chain
 *       nets on its root, and a net claim needs the root's support.
 *   B2  one captured document supporting two claims: the document's VAT is
 *       measured against every claim that names it.
 *   B3  an issued invoice whose journal was reversed files R0 output VAT: it is
 *       unposted invoice VAT, blocking.
 *   B4  a R0.01 output leg switched the coded-base rule off: the input
 *       over-claim is measured on the input side whatever else the journal has.
 *   B5  a provisional bank-first journal (bank_transactions.provisional_je_id)
 *       is bank support — listed, not blocking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { getLedgerVAT201 } from '@/modules/accounting/services/reports/vat201LedgerFields';
import { evaluateVat201Filability } from '@/modules/accounting/services/reports/vat201LedgerFields';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import type { GLEntrySource, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx, seedInvoice } from './helpers/l1FifoFixture';
import { dropLateFixture, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;
const acct: Record<string, string> = {};

async function post(date: string, source: GLEntrySource, lines: JournalLineInput[], sourceDocumentId?: string) {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: date, description: `break ${source}`, source, lines, ...(sourceDocumentId ? { sourceDocumentId } : {}),
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}
const claim = (vat: number) => [
  { glAccountId: fx.expenseId, debit: r(vat / 0.15), credit: 0, description: 'cost', vatType: 'standard' as const },
  { glAccountId: fx.vatInputId, debit: vat, credit: 0, description: 'VAT', vatType: 'standard' as const },
  { glAccountId: fx.bankAccountId, debit: 0, credit: r(vat / 0.15 + vat), description: 'paid' },
];
function r(n: number) { return Math.round(n * 100) / 100; }
const report = (s: string, e: string) => inTx(fx, () => getVatExceptions(fx.companyId, s, e));
const ledger = (s: string, e: string) => inTx(fx, () => getLedgerVAT201(fx.companyId, s, e));

describeIfDb('VAT pre-filing controls hold against the breaker', () => {
  beforeAll(async () => {
    assertNotProductionDb('breaker');
    fx = await seedLateFixture('BRK', DATABASE_URL!);
    for (const sub of ['receivable', 'vat_output']) {
      acct[sub] = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${sub} LIMIT 1`) as Row[])[0]!.id);
    }
    acct.sales = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'sales', 'credit', true) RETURNING id`) as Row[])[0]!.id);
  }, 240000);

  afterAll(async () => {
    if (!fx) return;
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropLateFixture(fx);
  }, 120000);

  it('B1: reversing the reversal re-instates the claim — a no_document claim is listed but does not block (Hein, 2026-09-26)', async () => {
    const S = '2026-09-01', E = '2026-10-31';
    const j1 = await post('2026-09-10', 'manual', claim(150));
    const r1 = await inTx(fx, () => reverseJournalEntry(fx.companyId, j1, fx.userId));
    await inTx(fx, () => reverseJournalEntry(fx.companyId, String(r1.reversalEntry?.id ?? (r1 as unknown as { id: string }).id), fx.userId));
    const rep = await report(S, E);
    const l = await ledger(S, E);
    expect(l.field10_totalInputVAT).toBe(150);          // R150 claimed and filed ...
    // `no_document` (no link at all) means only a record is missing, not that
    // the figures are wrong — it lists under inputVatWithoutTaxInvoice, not
    // unsupportedInputVat, and does not block.
    expect(rep.unsupportedInputVat).toEqual([]);
    expect(rep.inputVatWithoutTaxInvoice.map((u) => [u.journalEntryId, u.reason, u.claimedVat])).toEqual([[j1, 'no_document', 150]]);
    expect(evaluateEfilingGate(rep).allowed).toBe(true);
  });

  it('B2: one captured document cannot support two claims — now refused at the WRITE side, before B2 can even happen', async () => {
    // VAT-gaps batch item 1 (documentJournalClaimGuard) closes this exploit
    // one layer earlier than the report-level catch this test used to pin:
    // createJournalEntry now refuses a second live claim on the same document
    // before it writes anything, so field10/the report never see a double claim.
    const S = '2026-11-01', E = '2026-12-31';
    const doc = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, extracted_data, status)
      VALUES (${doc}::UUID, ${fx.companyId}::UUID, 'slip.jpg', 'image/jpeg', ${JSON.stringify({ vatAmount: 30, totalAmount: 230 })}::JSONB, 'processed')`;
    await post('2026-11-05', 'auto_expense_receipt', claim(30), doc);
    const before = await sql`SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID` as Row[];
    // What POST /api/accounting/journal-entries used to allow: source 'manual', any owned captured doc.
    await expect(post('2026-11-06', 'manual', claim(30), doc)).rejects.toThrow(/already referenced by a posted/);
    const after = await sql`SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID` as Row[];
    expect(after[0]!.n).toBe(before[0]!.n);               // refused before any write
    const rep = await report(S, E);
    const l = await ledger(S, E);
    expect(l.field10_totalInputVAT).toBe(30);             // only the first claim ever posted
    expect(rep.unsupportedInputVat).toEqual([]);          // the receipt is its own support
    expect(evaluateEfilingGate(rep).allowed).toBe(true);
  });

  it('B3: an issued invoice whose journal is reversed is unposted invoice VAT, blocking', async () => {
    const S = '2027-01-01', E = '2027-02-28';
    const inv = await seedInvoice(fx, { number: 'BRK-INV', date: '2027-01-05', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150 WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    const je = await post('2027-01-05', 'auto_invoice', [
      { glAccountId: acct.receivable!, debit: 1150, credit: 0, description: 'AR' },
      { glAccountId: acct.sales!, debit: 0, credit: 1000, description: 'sale', vatType: 'standard' },
      { glAccountId: acct.vat_output!, debit: 0, credit: 150, description: 'VAT', vatType: 'standard' },
    ]);
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    const before = await ledger(S, E);
    // POST /api/accounting/journal-entries-action {action:'reverse'} — no linked-document guard.
    await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId));
    const rep = await report(S, E);
    const l = await ledger(S, E);
    const [st] = (await sql`SELECT status, deleted_at FROM customer_invoices WHERE id = ${inv}::UUID`) as Row[];
    expect(before.field5_outputVAT).toBe(150);
    expect(st!.status).toBe('sent');                     // still an issued tax invoice
    expect(l.field5_outputVAT).toBe(0);                  // R0 output VAT in the ledger ...
    expect(rep.unpostedInvoiceVat.map((u) => [u.invoiceId, u.reason, u.vat])).toEqual([[inv, 'journal_reversed', 150]]);
    expect(rep.invoiceGlMismatches).toEqual([]);          // counted once, not also as a mismatch
    expect(evaluateEfilingGate(rep).allowed).toBe(false);
  });

  async function codedClaim(S: string, withCent: boolean) {
    const doc = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, extracted_data, status)
      VALUES (${doc}::UUID, ${fx.companyId}::UUID, 'inv.pdf', 'application/pdf', ${JSON.stringify({ vatAmount: 1500, totalAmount: 11500 })}::JSONB, 'processed')`;
    const lines: JournalLineInput[] = [
      { glAccountId: fx.expenseId, debit: 1000, credit: 0, description: 'taxed', vatType: 'standard' },
      { glAccountId: fx.expenseId, debit: 9000, credit: 0, description: 'zero-rated', vatType: 'zero_rated' },
      { glAccountId: fx.vatInputId, debit: 1500, credit: 0, description: 'VAT', vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: withCent ? 11499.99 : 11500, description: 'paid' },
    ];
    if (withCent) lines.push({ glAccountId: acct.vat_output!, debit: 0, credit: 0.01, description: 'x', vatType: 'standard' });
    await post(S.replace(/-01$/, '-10'), 'manual', lines, doc);
  }

  it('B4: a 1c output leg no longer hides a R1 350 over-claim', async () => {
    await codedClaim('2027-03-01', false);
    await codedClaim('2027-05-01', true);
    const a = await ledger('2027-03-01', '2027-04-30');
    const b = await ledger('2027-05-01', '2027-06-30');
    const ra = await report('2027-03-01', '2027-04-30');
    const rb = await report('2027-05-01', '2027-06-30');
    // 1350 shown in full — a single taxed input-VAT line's R0.005 rounding allowance (item 9) does not survive cent-rounding.
    expect(a.rateCheck.inputVariance).toBe(1350);               // control: over-claim measured
    expect(b.rateCheck.inputVariance).toBe(1350);               // + 1c output leg: still measured
    expect(evaluateVat201Filability(a).filable).toBe(false);
    expect(evaluateVat201Filability(b).filable).toBe(false);
    expect(ra.totalExceptions).toBe(rb.totalExceptions);
  });

  it('B5: a provisional bank posting (provisional_je_id) is bank support: listed, not blocking', async () => {
    const S = '2027-07-01', E = '2027-08-31';
    const tx = await seedBankTx(fx, { date: '2027-07-10', amount: -115, description: 'card spend' });
    // What provisionalPostingService writes: auto_bank_recon journal + bt.provisional_je_id.
    const je = await post('2027-07-10', 'auto_bank_recon', [
      { glAccountId: fx.expenseId, debit: 100, credit: 0, description: 'x', vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, description: 'VAT', vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 115, description: 'x' },
    ]);
    await sql`UPDATE bank_transactions SET status = 'provisional', provisional_je_id = ${je}::UUID WHERE id = ${tx}::UUID AND company_id = ${fx.companyId}::UUID`;
    const rep = await report(S, E);
    expect(rep.unsupportedInputVat).toEqual([]);
    expect(rep.inputVatWithoutTaxInvoice.map((l) => [l.journalEntryId, l.supportKind, l.reason])).toEqual([[je, 'bank', 'no_tax_invoice']]);
    expect(evaluateEfilingGate(rep).allowed).toBe(true);
    await sql`UPDATE bank_transactions SET provisional_je_id = NULL WHERE id = ${tx}::UUID`;
  });
});

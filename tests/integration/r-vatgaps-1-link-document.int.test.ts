/**
 * VAT-gaps batch item 1: linking a captured document to a posted journal
 * against a real ledger (gl/journalDocumentLinkService, migration 706).
 *
 * Covers: an unlinked journal's `no_document` row is non-blocking (Hein,
 * 2026-09-26); linking clears it from inputVatWithoutTaxInvoice; the claim
 * is still judged against the document's VAT (a smaller document can't
 * support a bigger claim — `amount_mismatch`, still blocking); another
 * company's document is refused; a document already used (via
 * source_document_id OR another active link) is refused.
 *
 * Breaker fix (round 2, Hein 2026-09-26): UNLINKING a document that WAS
 * evidencing a claim, with no other support, BLOCKS as `document_unlinked`
 * (`unsupportedInputVat`) — never falls back to the warning `no_document`,
 * which is reserved for a journal that never had a document link at all.
 * It clears by linking a document again (the normal document checks apply)
 * or by an owner/admin override (`assertVatGateClear`).
 *
 * Item 2 (bank attachment): an invoice attached to the bank line behind a
 * bank-only-supported journal moves it off "no tax invoice on file"
 * entirely; detaching returns it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import {
  linkDocumentToJournal, unlinkDocumentFromJournal, JournalDocumentLinkRefusal,
} from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { findInputVatSupport } from '@/modules/accounting/services/reports/vatInputSupport';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import { assertVatGateClear, VatGateBlockedError } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;

let fx: Fixture;
let otherFx: Fixture;
let vatInputAcc: string;
let expenseAcc: string;

const PERIOD_START = '2026-07-01';
const PERIOD_END = '2026-08-31';

async function account(fixture: Fixture, code: string, name: string, subtype: string): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
    VALUES (${fixture.companyId}::UUID, ${code}, ${`${name} ${fixture.tag}`}, 'asset', ${subtype}, 'debit', true)
    RETURNING id`) as Row[])[0]!.id);
}

async function captureDoc(fixture: Fixture, vatAmount: number): Promise<string> {
  return String(((await sql`
    INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, extracted_data)
    VALUES (${fixture.companyId}::UUID, 'invoice.pdf', 'application/pdf', 'reviewed', 'supplier_invoice', ${JSON.stringify({ vatAmount })}::JSONB)
    RETURNING id`) as Row[])[0]!.id);
}

async function manualVatJournal(amount: number): Promise<string> {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: '2026-07-10', description: 'manual VAT claim', source: 'manual',
      lines: [
        { glAccountId: vatInputAcc, debit: amount, credit: 0 },
        { glAccountId: expenseAcc, debit: 0, credit: amount },
      ],
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}

describeIfDb('VAT-gaps item 1: link a document to a posted journal', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals and links captured documents.');
    fx = await seedFixture('LINKDOC', DATABASE_URL!);
    otherFx = await seedFixture('LINKDOCOTHER', DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`${fx.tag}@test.local`}, 'admin', true)`;
    vatInputAcc = await account(fx, '1500', 'VAT Input', 'vat_input');
    expenseAcc = await account(fx, '7900', 'Expense', 'operating_expense');
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM gl_journal_document_links WHERE company_id = ${fx.companyId}::UUID OR company_id = ${otherFx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${fx.companyId}::UUID OR company_id = ${otherFx.companyId}::UUID`;
    await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
    await dropFixture(fx);
    await dropFixture(otherFx);
  }, 120000);

  it('a bare manual VAT journal with no link is listed as no_document, NOT blocking (Hein, 2026-09-26)', async () => {
    const je = await manualVatJournal(30);
    const support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    expect(support.unsupported.some((u) => u.journalEntryId === je)).toBe(false);
    expect(support.withoutTaxInvoice.find((u) => u.journalEntryId === je)?.reason).toBe('no_document');
  });

  it('linking a matching document clears it from inputVatWithoutTaxInvoice', async () => {
    const je = await manualVatJournal(30);
    const doc = await captureDoc(fx, 30);
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, je, doc, fx.userId, 'Invoice attached'));

    const support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    expect(support.unsupported.some((u) => u.journalEntryId === je)).toBe(false);
    expect(support.withoutTaxInvoice.some((u) => u.journalEntryId === je)).toBe(false);
  });

  it('the claim is still judged against the document VAT — a R30 document cannot support R60', async () => {
    const je = await manualVatJournal(60);
    const doc = await captureDoc(fx, 30);
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, je, doc, fx.userId, 'Invoice attached'));

    const support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    const line = support.unsupported.find((u) => u.journalEntryId === je);
    expect(line).toBeTruthy();
    expect(line?.reason).toBe('amount_mismatch');
  });

  it('refuses another company\'s document', async () => {
    const je = await manualVatJournal(30);
    const foreignDoc = await captureDoc(otherFx, 30);
    await expect(inTx(fx, () => linkDocumentToJournal(fx.companyId, je, foreignDoc, fx.userId, 'x')))
      .rejects.toBeInstanceOf(JournalDocumentLinkRefusal);
  });

  it('refuses a document already used by another journal (already linked)', async () => {
    const je1 = await manualVatJournal(30);
    const je2 = await manualVatJournal(30);
    const doc = await captureDoc(fx, 30);
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, je1, doc, fx.userId, 'first'));
    await expect(inTx(fx, () => linkDocumentToJournal(fx.companyId, je2, doc, fx.userId, 'second')))
      .rejects.toBeInstanceOf(JournalDocumentLinkRefusal);
  });

  it('refuses a document already backing a posted journal via source_document_id', async () => {
    const doc = await captureDoc(fx, 30);
    const jeWithSource = await inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, {
        entryDate: '2026-07-10', description: 'from capture', source: 'manual',
        sourceDocumentId: doc,
        lines: [
          { glAccountId: vatInputAcc, debit: 30, credit: 0 },
          { glAccountId: expenseAcc, debit: 0, credit: 30 },
        ],
      }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
      return je.id;
    });
    void jeWithSource;
    const je2 = await manualVatJournal(30);
    await expect(inTx(fx, () => linkDocumentToJournal(fx.companyId, je2, doc, fx.userId, 'reuse')))
      .rejects.toBeInstanceOf(JournalDocumentLinkRefusal);
  });

  // Item 5 (VAT-gaps review): users.id is VARCHAR(255), not uuid — linked_by/
  // unlinked_by must be TEXT (migration 707) and bound as plain text, or an
  // actor id that is not UUID-shaped (a Sage import bot, a legacy account)
  // fails to link at all.
  it('links and unlinks as a user whose id is a non-UUID string', async () => {
    const botUserId = `sage-import-bot-${fx.tag}`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${botUserId}, ${`${botUserId}@test.local`}, 'admin', true)`;
    try {
      const je = await manualVatJournal(30);
      const doc = await captureDoc(fx, 30);
      const link = await inTx(fx, () => linkDocumentToJournal(fx.companyId, je, doc, botUserId, 'Sage import'));
      expect(link.linkedBy).toBe(botUserId);
      await inTx(fx, () => unlinkDocumentFromJournal(fx.companyId, je, doc, botUserId, 'wrong document'));
    } finally {
      await sql`DELETE FROM audit_log WHERE user_id = ${botUserId}`;
      await sql`DELETE FROM users WHERE id = ${botUserId}`;
    }
  });

  it('breaker fix: unlinking a matching document BLOCKS as document_unlinked, and the gate refuses without override', async () => {
    const je = await manualVatJournal(30);
    const doc = await captureDoc(fx, 30);
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, je, doc, fx.userId, 'Invoice attached'));
    let support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    expect(support.unsupported.some((u) => u.journalEntryId === je)).toBe(false);
    expect(support.withoutTaxInvoice.some((u) => u.journalEntryId === je)).toBe(false);

    await inTx(fx, () => unlinkDocumentFromJournal(fx.companyId, je, doc, fx.userId, 'wrong document'));
    support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    expect(support.withoutTaxInvoice.some((u) => u.journalEntryId === je)).toBe(false);
    expect(support.unsupported.find((u) => u.journalEntryId === je)?.reason).toBe('document_unlinked');

    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD_START, PERIOD_END));
    expect(evaluateEfilingGate(r).allowed).toBe(false);
    await expect(
      inTx(fx, () => assertVatGateClear(fx.companyId, PERIOD_START, PERIOD_END, 'vat_period_lock', null, { userId: fx.userId, role: 'owner' }, undefined)),
    ).rejects.toBeInstanceOf(VatGateBlockedError);
    await expect(
      inTx(fx, () => assertVatGateClear(fx.companyId, PERIOD_START, PERIOD_END, 'sars_submission', null, { userId: fx.userId, role: 'owner' }, undefined)),
    ).rejects.toBeInstanceOf(VatGateBlockedError);
    // An owner/admin override still proceeds.
    const overridden = await inTx(fx, () => assertVatGateClear(
      fx.companyId, PERIOD_START, PERIOD_END, 'vat_period_lock', null, { userId: fx.userId, role: 'owner' }, 'reviewed manually',
    ));
    expect(overridden.overridden).toBe(true);
    await sql`DELETE FROM vat_gate_overrides WHERE company_id = ${fx.companyId}::UUID`;
  });

  it('breaker fix: linking an over-claiming document BLOCKS; unlinking it still blocks (document_unlinked)', async () => {
    const je = await manualVatJournal(60);
    const doc = await captureDoc(fx, 30);
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, je, doc, fx.userId, 'Invoice attached'));
    let support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    expect(support.unsupported.find((u) => u.journalEntryId === je)?.reason).toBe('amount_mismatch');

    await inTx(fx, () => unlinkDocumentFromJournal(fx.companyId, je, doc, fx.userId, 'wrong document'));
    support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    expect(support.unsupported.find((u) => u.journalEntryId === je)?.reason).toBe('document_unlinked');
  });

  it('breaker fix: relinking the RIGHT document clears document_unlinked — the normal document check applies', async () => {
    const je = await manualVatJournal(30);
    const doc = await captureDoc(fx, 30);
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, je, doc, fx.userId, 'Invoice attached'));
    await inTx(fx, () => unlinkDocumentFromJournal(fx.companyId, je, doc, fx.userId, 'wrong document'));
    let support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    expect(support.unsupported.find((u) => u.journalEntryId === je)?.reason).toBe('document_unlinked');

    const doc2 = await captureDoc(fx, 30);
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, je, doc2, fx.userId, 'correct invoice'));
    support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    expect(support.unsupported.some((u) => u.journalEntryId === je)).toBe(false);
    expect(support.withoutTaxInvoice.some((u) => u.journalEntryId === je)).toBe(false);
  });

  it('a journal that NEVER had a document link still warns as no_document, not document_unlinked', async () => {
    const je = await manualVatJournal(30);
    const support = await inTx(fx, () => findInputVatSupport(fx.companyId, PERIOD_START, PERIOD_END));
    expect(support.unsupported.some((u) => u.journalEntryId === je)).toBe(false);
    expect(support.withoutTaxInvoice.find((u) => u.journalEntryId === je)?.reason).toBe('no_document');
  });
});

describeIfDb('VAT-gaps item 2: an invoice attached to the bank line', () => {
  let bankFx: Fixture;
  let bankExpenseAcc: string;

  beforeAll(async () => {
    assertNotProductionDb('This test allocates a bank line and attaches a file to it.');
    bankFx = await seedFixture('BANKATTACH', DATABASE_URL!);
    bankExpenseAcc = await account(bankFx, '7900', 'Expense', 'operating_expense');
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN
      (SELECT id FROM bank_transactions WHERE company_id = ${bankFx.companyId}::UUID)`;
    await sql`DELETE FROM bank_transactions WHERE company_id = ${bankFx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${bankFx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${bankFx.companyId}::UUID`;
    await dropFixture(bankFx);
  }, 120000);

  async function allocateAndFindJournal(): Promise<{ txId: string; journalId: string }> {
    const txId = await seedBankTx(bankFx, { date: '2026-07-16', amount: -115, description: 'bank-only VAT' });
    await inTx(bankFx, () => allocateTransaction(bankFx.companyId, txId, bankExpenseAcc, bankFx.userId, 'alloc', 'account', undefined, 'standard'));
    const [r] = (await sql`
      SELECT jl.journal_entry_id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
      WHERE bt.id = ${txId}::UUID AND bt.company_id = ${bankFx.companyId}::UUID`) as Row[];
    return { txId, journalId: String(r!.journal_entry_id) };
  }

  it('bank-only support lists "no tax invoice on file"; an attachment clears it; detaching returns it', async () => {
    const { txId, journalId } = await allocateAndFindJournal();

    let support = await inTx(bankFx, () => findInputVatSupport(bankFx.companyId, PERIOD_START, PERIOD_END));
    expect(support.withoutTaxInvoice.some((l) => l.journalEntryId === journalId)).toBe(true);
    expect(support.unsupported.some((l) => l.journalEntryId === journalId)).toBe(false);

    const [{ id: attachmentId }] = (await sql`
      INSERT INTO bank_transaction_attachments (bank_transaction_id, file_name, file_url)
      VALUES (${txId}::UUID, 'slip.pdf', 'https://example.test/slip.pdf')
      RETURNING id`) as Row[];

    support = await inTx(bankFx, () => findInputVatSupport(bankFx.companyId, PERIOD_START, PERIOD_END));
    expect(support.withoutTaxInvoice.some((l) => l.journalEntryId === journalId)).toBe(false);
    expect(support.unsupported.some((l) => l.journalEntryId === journalId)).toBe(false);

    await sql`DELETE FROM bank_transaction_attachments WHERE id = ${attachmentId}::UUID`;
    support = await inTx(bankFx, () => findInputVatSupport(bankFx.companyId, PERIOD_START, PERIOD_END));
    expect(support.withoutTaxInvoice.some((l) => l.journalEntryId === journalId)).toBe(true);
  });
});

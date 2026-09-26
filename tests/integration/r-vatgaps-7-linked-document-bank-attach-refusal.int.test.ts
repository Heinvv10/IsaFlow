/**
 * Item 7: one document, one claim, on the REVERSE direction of the
 * write-side guard. `documentJournalClaimGuard.assertDocumentNotAlreadyPosted`
 * already refuses a document backed by another posted, unreversed journal
 * via `source_document_id` OR an ACTIVE `gl_journal_document_links` row
 * (migration 706). This pins that the two evidence-attach paths actually
 * CALL it for the link case, not merely the source_document_id case:
 *
 *   - `provisionalEvidenceAttach.attachDocumentToProvisional` (manual attach,
 *     POST /api/accounting/provisional/[jeId]/attach)
 *   - `evidenceAttachmentService.attachEvidenceToProvisional` (automatic
 *     fuzzy-match attach off a captured receipt/invoice)
 *
 * Must go RED if either call to `assertDocumentNotAlreadyPosted` is removed —
 * the mutation is exercised by hand below rather than by construction (the
 * guard call is a single line in each service).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { linkDocumentToJournal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import type { GLEntrySource, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let expenseAcc: string;

async function post(source: GLEntrySource, lines: JournalLineInput[]) {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: '2028-06-01', description: `r-vatgaps-7 ${source}`, source, lines,
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}

/** A bank-first provisional journal (needs_evidence=true, posted) and its bank line. */
async function seedProvisional(amount = 500): Promise<{ je: string; bt: string }> {
  const je = randomUUID();
  const bt = randomUUID();
  await sql`
    INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, source,
      status, created_by, posting_agent, needs_evidence)
    VALUES (${je}::UUID, ${fx.companyId}::UUID, ${`R7-${je.slice(0, 8)}`}, '2028-06-02',
      'r-vatgaps-7 provisional', 'auto_bank_recon', 'draft', ${fx.userId}::UUID, 'ai-provisional:v1', true)`;
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${expenseAcc}::UUID, ${amount}, 0, 'r-vatgaps-7'),
           (${fx.companyId}::UUID, ${je}::UUID, ${fx.bankAccountId}::UUID, 0, ${amount}, 'r-vatgaps-7')`;
  await sql`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW(), posted_by = ${fx.userId}::UUID WHERE id = ${je}::UUID`;
  await sql`
    INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status, provisional_je_id)
    VALUES (${bt}::UUID, ${fx.companyId}::UUID, ${fx.bankAccountId}::UUID, '2028-06-02', ${-amount}, 'R-VATGAPS-7', 'provisional', ${je}::UUID)`;
  return { je, bt };
}

describeIfDb('one document, one claim: the bank evidence-attach paths refuse an already-linked document', () => {
  beforeAll(async () => {
    assertNotProductionDb('r-vatgaps-7');
    fx = await seedFixture('RVG7', DATABASE_URL!);
    expenseAcc = String(((await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'default_expense' LIMIT 1
    `) as Row[])[0]!.id);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`rvg7-${fx.userId}@isaflow.test`}, 'admin', true)`;
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_document_links WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM bank_transactions WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
  }, 120000);

  it('refuses the MANUAL attach (attachDocumentToProvisional) when the document is already an active link on another posted journal', async () => {
    const doc = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, extracted_data, status)
      VALUES (${doc}::UUID, ${fx.companyId}::UUID, 'r7-manual.pdf', 'application/pdf', '{}'::JSONB, 'processed')`;

    const original = await post('manual', [
      { glAccountId: expenseAcc, debit: 200, credit: 0, description: 'r-vatgaps-7 original' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 200, description: 'r-vatgaps-7 original' },
    ]);
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, original, doc, fx.userId, 'evidence for original'));

    const { je: provisionalJe, bt } = await seedProvisional();

    const result = await inTx(fx, () => attachDocumentToProvisional(fx.companyId, provisionalJe, doc));

    expect(result).toMatchObject({ kind: 'refused' });
    if (result.kind === 'refused') expect(result.message).toMatch(/already linked/i);

    const [je] = (await sql`SELECT needs_evidence, source_document_id FROM gl_journal_entries WHERE id = ${provisionalJe}::UUID`) as Row[];
    expect(je!.needs_evidence).toBe(true);
    expect(je!.source_document_id).toBeNull();
    const [line] = (await sql`SELECT status FROM bank_transactions WHERE id = ${bt}::UUID`) as Row[];
    expect(line!.status).toBe('provisional');
  });

  it('refuses the AUTOMATIC fuzzy-match attach (attachEvidenceToProvisional) for the same reason, writing nothing', async () => {
    const doc = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, extracted_data, status)
      VALUES (${doc}::UUID, ${fx.companyId}::UUID, 'r7-auto.pdf', 'application/pdf', '{}'::JSONB, 'processed')`;

    const original = await post('manual', [
      { glAccountId: expenseAcc, debit: 300, credit: 0, description: 'r-vatgaps-7 original 2' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 300, description: 'r-vatgaps-7 original 2' },
    ]);
    await inTx(fx, () => linkDocumentToJournal(fx.companyId, original, doc, fx.userId, 'evidence for original 2'));

    const { je: provisionalJe, bt } = await seedProvisional(750);

    const out = await inTx(fx, () => attachEvidenceToProvisional(
      fx.companyId, doc, null, 750, '2028-06-02',
    ));

    expect(out).toEqual({ attachedJeId: null, bankTxId: null });
    const [je] = (await sql`SELECT needs_evidence, source_document_id FROM gl_journal_entries WHERE id = ${provisionalJe}::UUID`) as Row[];
    expect(je!.needs_evidence).toBe(true);
    expect(je!.source_document_id).toBeNull();
    const [line] = (await sql`SELECT status FROM bank_transactions WHERE id = ${bt}::UUID`) as Row[];
    expect(line!.status).toBe('provisional');
  });
});

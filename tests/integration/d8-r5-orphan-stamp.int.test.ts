/**
 * D8 round 5: a journal STAMPED reversed with no posted contra is a broken
 * chain. The guards that BLOCK while a journal stands read it as standing (the
 * ledger carries it); the three that PERMIT an action on the journal itself —
 * document link, automatic and manual evidence attach — must keep refusing it,
 * as `reversed_at IS NULL` did (shared/journalInForceAsAt,
 * journalStandsUnbrokenFragment). The manual attach is pinned at route level by
 * r107-provisional-attach-claim; these are the other two, and the service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { linkDocumentToJournal, JournalDocumentLinkRefusal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;

/** A posted provisional (needs_evidence) with its bank line, then STAMPED reversed — no contra exists. */
async function stampedProvisional(): Promise<string> {
  const [expense] = (await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'default_expense'`) as Row[];
  const draft = await inTx(fx, () => createJournalEntry(fx.companyId, {
    entryDate: '2026-05-10', description: `D8R5 ${++seq}`, source: 'manual',
    lines: [{ glAccountId: String(expense!.id), debit: 100, credit: 0 }, { glAccountId: fx.bankAccountId, debit: 0, credit: 100 }],
  }, fx.userId));
  await sql`UPDATE gl_journal_entries SET needs_evidence = true WHERE id = ${draft.id}::UUID`;
  await inTx(fx, () => postJournalEntry(fx.companyId, draft.id, fx.userId));
  await sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
      provisional_je_id, predicted_supplier_id)
    VALUES (${fx.companyId}::UUID, ${fx.bankAccountId}::UUID, '2026-05-10', -100, ${`D8R5 PROV ${seq} ${fx.tag}`},
      'provisional', ${draft.id}::UUID, ${fx.supplierId}::UUID)`;
  await sql`UPDATE gl_journal_entries SET reversed_at = NOW(), reversed_by = ${fx.userId} WHERE id = ${draft.id}::UUID`;
  return draft.id;
}

const document = async () => String(((await sql`
  INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
  VALUES (${fx.companyId}::UUID, ${`d8r5-${++seq}.pdf`}, 'application/pdf', 'reviewed', 'supplier_invoice')
  RETURNING id`) as Row[])[0]!.id);

describeIfDb('D8 round 5: a stamped journal with no contra is still refused where the action is on the journal', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals and stamps them reversed.');
    fx = await seedFixture('D8R5', DATABASE_URL!);
  }, 120000);
  afterAll(async () => {
    if (!fx) return;
    await sql`UPDATE bank_transactions SET provisional_je_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('refuses a document link, the automatic evidence attach and the manual one', async () => {
    const je = await stampedProvisional();

    await expect(inTx(fx, async () => linkDocumentToJournal(fx.companyId, je, await document(), fx.userId, 'D8 round 5')))
      .rejects.toThrow(JournalDocumentLinkRefusal);
    expect(await inTx(fx, async () => attachEvidenceToProvisional(fx.companyId, await document(), fx.supplierId, 100, '2026-05-10')))
      .toEqual({ attachedJeId: null, bankTxId: null });
    expect(await inTx(fx, async () => attachDocumentToProvisional(fx.companyId, je, await document())))
      .toEqual({ kind: 'refused', message: 'Journal entry has been reversed' });
    const [row] = (await sql`
      SELECT needs_evidence, source_document_id FROM gl_journal_entries WHERE id = ${je}::UUID`) as Row[];
    expect(row).toEqual({ needs_evidence: true, source_document_id: null });
  });
});

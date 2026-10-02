/**
 * D8 item 4: write guards that ask "does a STANDING journal still carry this?"
 * by a key only the ORIGINAL row holds (source_document_id, source_record_id,
 * entry_number, a Sage reference). reverseJournalEntry copies none of those
 * onto its contra, so after X <- R <- R2 the ledger carries X again through R2
 * while `X.reversed_at` stays set — and a one-link `reversed_at IS NULL` read
 * the document, bill, month or Sage group as free. Each case reverses a
 * journal and then its reversal through the product (an ordinary, permitted
 * operation) and asks the guard again; shared/journalInForceAsAt decides.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { DocumentAlreadyPostedRefusal } from '@/modules/accounting/services/gl/documentJournalClaimGuard';
import { listLinkableDocuments } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import {
  releaseCapturedDocumentPostingClaim, releaseUnpostedCaptureClaim,
} from '@/modules/accounting/services/capture/capturePostingClaimRelease';
import { alreadyPosted } from '@/modules/accounting/services/items/depreciationRunQueries';
import { postAssetDepreciationToGL } from '@/modules/accounting/services/gl/assetDepreciationPosting';
import { decideLedgerRelink } from '@/modules/accounting/services/core/sageLedgerRelinkGuard';
import { planSupplierInvoiceCancel } from '@/modules/accounting/services/ap/supplierInvoiceCancelPlan';
import {
  refuseIfJournalNamesBill, SupplierInvoiceDraftUpdateRefusal,
} from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdateGuards';
import { linkDocumentToJournal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { findReclassCandidates } from '@/modules/accounting/services/gl/reclassification/candidates';
import { targetPriorSources } from '@/modules/accounting/services/gl/reclassification/warnings';
import { fmtDate } from '@/lib/fmtDate';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let expense = '';
let seq = 0;

const lines = () => [
  { glAccountId: expense, debit: 100, credit: 0 },
  { glAccountId: fx.bankAccountId, debit: 0, credit: 100 },
];

/** A posted journal; `patch` is applied to the DRAFT, before it posts. */
async function postedJournal(
  opts: { source?: string; sourceDocumentId?: string; patch?: (id: string) => Promise<unknown> } = {},
): Promise<string> {
  const entry = await inTx(fx, () => createJournalEntry(fx.companyId, {
    entryDate: '2026-05-10', description: `D8 ${++seq}`, source: opts.source ?? 'manual',
    ...(opts.sourceDocumentId ? { sourceDocumentId: opts.sourceDocumentId } : {}), lines: lines(),
  }, fx.userId));
  if (opts.patch) await opts.patch(entry.id);
  await inTx(fx, () => postJournalEntry(fx.companyId, entry.id, fx.userId));
  return entry.id;
}

/** X <- R <- R2: the ledger carries X again, and X.reversed_at is still set. */
async function reverseTwice(id: string): Promise<void> {
  const r = await inTx(fx, () => reverseJournalEntry(fx.companyId, id, fx.userId));
  await inTx(fx, () => reverseJournalEntry(fx.companyId, r.id, fx.userId));
  const [x] = (await sql`SELECT reversed_at FROM gl_journal_entries WHERE id = ${id}::UUID`) as Row[];
  expect(x!.reversed_at).not.toBeNull();
}

async function document(): Promise<string> {
  return String(((await sql`
    INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
    VALUES (${fx.companyId}::UUID, ${`d8-${++seq}.pdf`}, 'application/pdf', 'reviewed', 'supplier_invoice')
    RETURNING id`) as Row[])[0]!.id);
}

const claim = (docId: string) => sql`
  UPDATE captured_documents SET posted_at = NOW() WHERE id = ${docId}::UUID AND company_id = ${fx.companyId}::UUID`;

/**
 * A DRAFT receipt journal on the slip. releaseUnpostedCaptureClaim
 * deletes such drafts once it judges nothing live, so the draft surviving is
 * what pins ITS liveness check — its return value alone is masked by the inner
 * release, which re-checks.
 */
async function draftOn(docId: string): Promise<string> {
  const [d] = (await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source,
      source_document_id, created_by)
    VALUES (${fx.companyId}::UUID, ${`JE-D8D-${++seq}-${fx.tag}`.slice(0, 50)}, '2026-05-12', 'D8 draft',
      'draft', 'auto_expense_receipt', ${docId}::UUID, ${fx.userId}::UUID)
    RETURNING id`) as Row[];
  return String(d!.id);
}

const exists = async (id: string) => ((await sql`
  SELECT 1 FROM gl_journal_entries WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Row[]).length === 1;

describeIfDb('D8: a re-reversed journal still carries what it carried', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts and reverses journals.');
    fx = await seedFixture('D8RR', DATABASE_URL!);
    expense = String(((await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'default_expense'`) as Row[])[0]!.id);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM assets WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM reclassification_batch_lines WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM reclassification_batches WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_document_links WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE bank_transactions SET provisional_je_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
  }, 120000);

  it('documentJournalClaimGuard: refuses a second journal on a document its re-reversed journal still carries', async () => {
    const doc = await document();
    await reverseTwice(await postedJournal({ sourceDocumentId: doc }));
    await expect(inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: '2026-05-11', description: 'D8 second use', source: 'manual', sourceDocumentId: doc, lines: lines(),
    }, fx.userId))).rejects.toThrow(DocumentAlreadyPostedRefusal);
    // ...and does not offer it as linkable either.
    expect((await inTx(fx, () => listLinkableDocuments(fx.companyId))).map((d) => d.id)).not.toContain(doc);
  });

  it('capture claim release: keeps the claim while a re-reversed receipt journal carries the slip', async () => {
    const doc = await document();
    await reverseTwice(await postedJournal({ source: 'auto_expense_receipt', sourceDocumentId: doc }));
    await claim(doc);
    expect(await inTx(fx, () => releaseCapturedDocumentPostingClaim(fx.companyId, doc))).toBe(false);
    // After the plain release: a draft receipt journal blocks that one by itself.
    const draft = await draftOn(doc);
    expect(await inTx(fx, () => releaseUnpostedCaptureClaim(fx.companyId, doc))).toBe(false);
    expect(await exists(draft)).toBe(true);
  });

  it('capture claim release: keeps the claim while a re-reversed EVIDENCED journal carries the slip', async () => {
    const doc = await document();
    await reverseTwice(await postedJournal({
      sourceDocumentId: doc,
      patch: (id) => sql`UPDATE gl_journal_entries SET evidenced_at = NOW() WHERE id = ${id}::UUID`,
    }));
    await claim(doc);
    expect(await inTx(fx, () => releaseCapturedDocumentPostingClaim(fx.companyId, doc))).toBe(false);
    // After the plain release: a draft receipt journal blocks that one by itself.
    const draft = await draftOn(doc);
    expect(await inTx(fx, () => releaseUnpostedCaptureClaim(fx.companyId, doc))).toBe(false);
    expect(await exists(draft)).toBe(true);
  });

  it('depreciation: a re-reversed DEP entry is already posted, to the run and to the legacy single-asset post', async () => {
    const [asset] = (await sql`
      INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years)
      VALUES (${fx.companyId}::UUID, ${`D8A${fx.tag.slice(-6)}`}, 'D8 asset', '2026-01-01', 1200, 5)
      RETURNING id, asset_number`) as Row[];
    const number = `DEP-${String(asset!.asset_number)}-${fmtDate(new Date()).slice(0, 7)}`;
    const dep = await postedJournal({
      patch: (id) => sql`UPDATE gl_journal_entries SET entry_number = ${number} WHERE id = ${id}::UUID`,
    });
    await reverseTwice(dep);
    expect(await inTx(fx, () => alreadyPosted(fx.companyId, [number]))).toEqual(new Set([number]));
    expect(await inTx(fx, () => postAssetDepreciationToGL(fx.companyId, String(asset!.id), 20, fx.userId))).toBe(dep);
  });

  it('Sage relink: a group whose re-reversed journal still carries it relinks, it does not post again', async () => {
    const ref = `D8-SAGE-${fx.tag}`;
    const x = await postedJournal({
      patch: (id) => sql`UPDATE gl_journal_entries SET reference = ${ref}, posting_agent = 'import:sage' WHERE id = ${id}::UUID`,
    });
    await reverseTwice(x);
    const active = [
      { gl_account_id: expense, debit: 100, credit: 0 },
      { gl_account_id: fx.bankAccountId, debit: 0, credit: 100 },
    ];
    expect(await inTx(fx, () => decideLedgerRelink(fx.companyId, ref, '2026-05-10', active)))
      .toEqual({ kind: 'relink', entryId: x });
  });

  it('reclassification: a line moved by a re-reversed reclass journal is already reclassified', async () => {
    const x = await postedJournal();
    const [line] = (await sql`
      SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${x}::UUID AND gl_account_id = ${expense}::UUID`) as Row[];
    const [target] = (await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '6100', ${`D8 target ${fx.tag}`}, 'expense', 'operating_expense', 'debit', true)
      RETURNING id`) as Row[];
    const rj = await inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: '2026-05-10', description: 'D8 reclass', source: 'manual', lines: [
        { glAccountId: String(target!.id), debit: 100, credit: 0 },
        { glAccountId: expense, debit: 0, credit: 100 },
      ],
    }, fx.userId));
    await inTx(fx, () => postJournalEntry(fx.companyId, rj.id, fx.userId));
    const [batch] = (await sql`
      INSERT INTO reclassification_batches (company_id, created_by, tool, source_account_id, target_account_id, line_count)
      VALUES (${fx.companyId}::UUID, ${fx.userId}, 'd8-test', ${expense}::UUID, ${String(target!.id)}::UUID, 1)
      RETURNING id`) as Row[];
    await sql`
      INSERT INTO reclassification_batch_lines (company_id, batch_id, source_line_id, journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${String(batch!.id)}::UUID, ${String(line!.id)}::UUID, ${rj.id}::UUID)`;
    await reverseTwice(rj.id);

    const rows = await inTx(fx, () => findReclassCandidates(fx.companyId,
      { sourceAccountId: expense, from: null, to: null, limit: 500 }));
    expect(rows.find((r) => r.line_id === String(line!.id))?.already_reclassified).toBe(true);
    // ...and the target still counts the source as a prior one.
    expect(await inTx(fx, () => targetPriorSources(fx.companyId, String(target!.id), fx.bankAccountId))).toBe(1);
  });

  it('draft-bill edit: refuses while a re-reversed journal sourced from the bill still stands (D8 round 4, L-1)', async () => {
    const bill = await seedBill(fx, { number: `D8E${++seq}`, date: '2026-05-10', total: 100, status: 'draft' });
    await reverseTwice(await postedJournal({
      patch: (id) => sql`UPDATE gl_journal_entries SET source_record_id = ${bill}::UUID WHERE id = ${id}::UUID`,
    }));
    await expect(inTx(fx, () => refuseIfJournalNamesBill(fx.companyId, bill, 'D8E', false)))
      .rejects.toThrow(SupplierInvoiceDraftUpdateRefusal);
  });

  it('document link: a re-reversed journal still takes a document link (D8 round 4, L-3)', async () => {
    // The link is audit-logged, and audit_log.user_id references users.
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`d8-${fx.userId}@isaflow.test`}, 'admin', true)
              ON CONFLICT (id) DO NOTHING`;
    const doc = await document();
    const x = await postedJournal();
    await reverseTwice(x);
    const link = await inTx(fx, () => linkDocumentToJournal(fx.companyId, x, doc, fx.userId, 'D8 round 4'));
    expect(link.journalEntryId).toBe(x);
  });

  it('evidence attach: a re-reversed provisional still needing evidence is evidenced (D8 round 4, L-3)', async () => {
    const doc = await document();
    const x = await postedJournal({
      patch: (id) => sql`UPDATE gl_journal_entries SET needs_evidence = true WHERE id = ${id}::UUID`,
    });
    await sql`
      INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
        provisional_je_id, predicted_supplier_id)
      VALUES (${fx.companyId}::UUID, ${fx.bankAccountId}::UUID, '2026-05-10', -100, ${`D8 PROV ${fx.tag}`},
        'provisional', ${x}::UUID, ${fx.supplierId}::UUID)`;
    await reverseTwice(x);
    const out = await inTx(fx, () => attachEvidenceToProvisional(fx.companyId, doc, fx.supplierId, 100, '2026-05-10'));
    expect(out.attachedJeId).toBe(x);
  });

  it('bill cancel: refuses while a re-reversed journal sourced from the bill still stands', async () => {
    const bill = await seedBill(fx, { number: `D8B${++seq}`, date: '2026-05-10', total: 100, status: 'approved' });
    const other = await postedJournal({
      patch: (id) => sql`UPDATE gl_journal_entries SET source_record_id = ${bill}::UUID WHERE id = ${id}::UUID`,
    });
    await reverseTwice(other);
    const [{ entry_number: number }] = (await sql`
      SELECT entry_number FROM gl_journal_entries WHERE id = ${other}::UUID`) as { entry_number: string }[];
    await expect(inTx(fx, () => planSupplierInvoiceCancel(fx.companyId, bill)))
      .rejects.toThrow(new RegExp(`other posted journal\\(s\\) sourced from it.*${number}`));
  });

  it('bill cancel: refuses a journal-less captured bill whose document a re-reversed journal still carries', async () => {
    const doc = await document();
    await reverseTwice(await postedJournal({ sourceDocumentId: doc }));
    const bill = await seedBill(fx, { number: `D8C${++seq}`, date: '2026-05-10', total: 100, status: 'approved' });
    await sql`UPDATE supplier_invoices SET source_document_id = ${doc}::UUID WHERE id = ${bill}::UUID`;
    await expect(inTx(fx, () => planSupplierInvoiceCancel(fx.companyId, bill)))
      .rejects.toThrow(/captured document already carries/);
  });
});

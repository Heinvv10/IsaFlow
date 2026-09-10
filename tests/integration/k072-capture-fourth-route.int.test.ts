// The FOURTH posting route, and the way back out of the fence.
//
// Rounds 5 and 6 each hardened the routes they had found and each left one
// alive. `ai-invoice-pipeline` was the fourth: no lock, no claim, no read of
// `posted_at` at all — so `receipt-to-journal` followed by this endpoint on one
// R1 150 receipt produced a posted GL journal claiming R150 of input tax AND an
// auto-approved supplier invoice carrying tax_amount 150.00, R300 in front of
// the VAT201 from a slip that says R150. The partial unique index behind the
// application claim does not reach it: that index is on `gl_journal_entries`
// and this route writes `supplier_invoices`.
//
// The other half is the undo. `posted_at` was stamped by four routes and
// cleared by nothing, so `document-capture-action`'s refusal — "Reverse the
// journal or invoice first" — named a remedy that did not exist: reversing left
// the stamp exactly where it was and the document stayed refused for good.
// `releaseCapturedDocumentPostingClaim` hands it back once nothing the document
// produced is still live, which is why migration 672's index carries
// `reversed_at IS NULL` — otherwise the re-post the release permits would 23505
// against the row it had just reversed.
//
// Every case is a UI-shaped SEQUENCE asserting the ledger outcome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import pipelineRoute from '../../pages/api/accounting/ai-invoice-pipeline';
import receiptRoute from '../../pages/api/accounting/receipt-to-journal';
import jeActionRoute from '../../pages/api/accounting/journal-entries-action';
import siActionRoute from '../../pages/api/accounting/supplier-invoices-action';
import actionRoute from '../../pages/api/accounting/document-capture-action';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const vatInput = crypto.randomUUID();
const defaultExpense = crypto.randomUUID();
const payables = crypto.randomUUID();
const supplier = crypto.randomUUID();

const journalThenPipelineDoc = crypto.randomUUID();
const pipelineTwiceDoc = crypto.randomUUID();
const rejectedPipelineDoc = crypto.randomUUID();
const reversedJournalDoc = crypto.randomUUID();
const cancelledInvoiceDoc = crypto.randomUUID();
const bothRoutesDoc = crypto.randomUUID();
const twoLiveRowsDoc = crypto.randomUUID();
const creditNoteDoc = crypto.randomUUID();
const ambiguousTotalDoc = crypto.randomUUID();
const fallbackDoc = crypto.randomUUID();
const documents = [
  journalThenPipelineDoc, pipelineTwiceDoc, rejectedPipelineDoc,
  reversedJournalDoc, cancelledInvoiceDoc, bothRoutesDoc, twoLiveRowsDoc, creditNoteDoc,
  ambiguousTotalDoc, fallbackDoc,
];

const today = new Date().toISOString().slice(0, 10);
let token = '';

// Every document gets its OWN amount. `findDuplicate` matches supplier + total
// + date, so seeding six identical R1 150 slips would make the SECOND route
// call answer 409 as a duplicate and prove nothing about the fence.
const AMOUNTS: Record<string, number> = {};

const extracted = (reference: string, total: number) => ({
  documentType: 'invoice', vendorName: 'Waltons Stationery', date: today,
  referenceNumber: reference, currency: 'ZAR',
  subtotal: Math.round((total / 1.15) * 100) / 100,
  vatAmount: Math.round((total - total / 1.15) * 100) / 100,
  vatRate: 15, totalAmount: total,
  lineItems: [{
    description: 'Copy paper', quantity: 1,
    unitPrice: Math.round((total / 1.15) * 100) / 100,
    total: Math.round((total / 1.15) * 100) / 100,
  }],
  // The text the auto-post gate re-reads — without it nothing posts unattended —
  // under the purchase title the gate requires (K-072 round 20).
  rawText: `TAX INVOICE\nSub Total ${(Math.round((total / 1.15) * 100) / 100).toFixed(2)}\n`
    + `VAT ${(Math.round((total - total / 1.15) * 100) / 100).toFixed(2)}\nTotal ${total.toFixed(2)}`,
  confidence: 0.9, warnings: [], extractionMethod: 'vlm',
});

/** The input tax the slip itself states — every assertion below reads it back. */
const statedVat = (documentId: string) => {
  const total = AMOUNTS[documentId]!;
  return Math.round((total - total / 1.15) * 100) / 100;
};

async function seedDoc(id: string, total: number): Promise<void> {
  AMOUNTS[id] = total;
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','invoice',$4::jsonb,'pending')`,
    [id, company, `k072r7-${id}.pdf`, JSON.stringify(extracted(`INV-${id.slice(0, 8)}`, total))],
  );
}

// `ai-invoice-pipeline` is behind `checkAiRateLimit`, whose IP key is a
// PERSISTENT counter: the helper's fixed 127.0.0.79 is shared with every other
// integration file and every previous run, so at ~10 pipeline calls a run the
// second run of the day answered 429 and the file failed for a reason that has
// nothing to do with the fence. One address per run keeps the counter the
// file's own.
const clientIp = `127.1.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

function call(route: (req: never, res: never) => Promise<unknown> | unknown,
  url: string, body: Record<string, unknown>, targetId?: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST', targetId);
  (req.socket as { remoteAddress: string }).remoteAddress = clientIp;
  req.url = url;
  req.body = body;
  const result = response();
  return Promise.resolve(route(req as never, result.res as never)).then(() => result);
}

const pipeline = (documentId: string) =>
  call(pipelineRoute, '/api/accounting/ai-invoice-pipeline', { documentId });
const receiptToJournal = (documentId: string) =>
  call(receiptRoute, '/api/accounting/receipt-to-journal', { documentId });
const reverseJournal = (id: string) =>
  call(jeActionRoute, '/api/accounting/journal-entries-action', { id, action: 'reverse' });
const cancelInvoice = (invoiceId: string) =>
  call(siActionRoute, '/api/accounting/supplier-invoices-action', { action: 'cancel', invoiceId });
const documentAction = (id: string, action: string) =>
  call(actionRoute, '/api/accounting/document-capture-action', { id, action });

function errorMessage(result: { state: { body: unknown } }): string {
  return (result.state.body as { error: { message: string } }).error.message;
}

/**
 * Every rand of input tax the document has LIVE in front of the VAT201, both
 * ways: unreversed capture journals plus uncancelled supplier invoices.
 *
 * The reversal contra carries no `source_document_id` of its own — nothing
 * stamps one on it — so netting it in is not available here; the predicate has
 * to drop the reversed original instead. Same two predicates as
 * `releaseCapturedDocumentPostingClaim`, deliberately: what the release counts
 * as a live claim and what the VAT201 counts as claimed must be one thing.
 */
async function inputTaxClaimed(documentId: string): Promise<number> {
  const journal = Number((await pool.query(
    `SELECT COALESCE(SUM(jl.debit - jl.credit),0)::numeric AS dr
     FROM gl_journal_lines jl
     JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
     WHERE je.company_id=$1 AND je.source_document_id=$2 AND jl.gl_account_id=$3
       AND je.reversed_at IS NULL`,
    [company, documentId, vatInput],
  )).rows[0].dr);
  const invoice = Number((await pool.query(
    `SELECT COALESCE(SUM(tax_amount),0)::numeric AS tx FROM supplier_invoices
     WHERE company_id=$1 AND source_document_id=$2 AND status <> 'cancelled'`,
    [company, documentId],
  )).rows[0].tx);
  return Math.round((journal + invoice) * 100) / 100;
}

async function invoiceIds(documentId: string): Promise<string[]> {
  return (await pool.query(
    'SELECT id FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2 ORDER BY created_at',
    [company, documentId],
  )).rows.map((r) => String(r.id));
}

/** The statuses of the supplier invoices a document produced — 'approved' is unattended. */
async function invoiceStatuses(documentId: string): Promise<string[]> {
  return (await pool.query(
    'SELECT status FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2 ORDER BY created_at',
    [company, documentId],
  )).rows.map((r) => String(r.status));
}

/** Reclassify a seeded document as a credit note, its figures printed positive. */
async function markCreditNote(documentId: string): Promise<void> {
  await pool.query(
    `UPDATE captured_documents
        SET extracted_data = jsonb_set(extracted_data, '{documentType}', '"credit_note"')
      WHERE id=$1 AND company_id=$2`,
    [documentId, company],
  );
}

/** Reprint the document's text as a mixed basket whose VAT analysis is below the tender. */
async function markAmbiguousTotals(documentId: string): Promise<void> {
  const text = 'Waltons Stationery\nTAX INVOICE\nTOTAL 1150.00\nCASH 1200.00\nCHANGE 50.00\n'
    + 'VAT ANALYSIS\nSub Total 870.00\nVAT 15% 130.50\nTotal 1000.50';
  await pool.query(
    `UPDATE captured_documents
        SET extracted_data = jsonb_set(extracted_data, '{rawText}', to_jsonb($3::text))
      WHERE id=$1 AND company_id=$2`,
    [documentId, company, text],
  );
}

async function journalIds(documentId: string): Promise<string[]> {
  return (await pool.query(
    `SELECT id FROM gl_journal_entries
      WHERE company_id=$1 AND source_document_id=$2 AND source='auto_expense_receipt'
      ORDER BY created_at`,
    [company, documentId],
  )).rows.map((r) => String(r.id));
}

async function postedAt(documentId: string): Promise<Date | null> {
  return (await pool.query('SELECT posted_at FROM captured_documents WHERE id=$1', [documentId]))
    .rows[0]?.posted_at ?? null;
}

async function purge(): Promise<void> {
  await pool.query(
    `DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN
       (SELECT id FROM supplier_invoices WHERE company_id=$1)`, [company]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM captured_documents WHERE id=ANY($1::uuid[])', [documents]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])',
    [[bank, vatInput, defaultExpense, payables]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K072R7 owner']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_system_account,is_active)
     VALUES($1,$5,'K072RB','K072R7 Bank','asset','bank','debit',true,true),
           ($2,$5,'1140','K072R7 VAT Input','asset','vat_input','debit',true,true),
           ($3,$5,'K072RDE','K072R7 Default expense','expense','default_expense','debit',true,true),
           ($4,$5,'2100','K072R7 Accounts Payable','liability','accounts_payable','credit',true,true)`,
    [bank, vatInput, defaultExpense, payables, company],
  );
  await pool.query('INSERT INTO suppliers(id,company_id,name,is_active) VALUES($1,$2,$3,true)',
    [supplier, company, 'Waltons Stationery']);
  clearSystemAccountCache(company);

  for (const [index, id] of documents.entries()) await seedDoc(id, 1150 + index * 100);

  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await purge();
  } finally {
    clearSystemAccountCache();
    await pool.end();
  }
}, 60_000);

describe('K-072 r7 HIGH-1 ai-invoice-pipeline is inside the fence', () => {
  it('refuses the pipeline on a receipt already turned into a journal', async () => {
    expect((await receiptToJournal(journalThenPipelineDoc)).state.statusCode).toBe(200);

    const second = await pipeline(journalThenPipelineDoc);
    expect(second.state.statusCode).toBe(400);
    expect(errorMessage(second)).toContain('already posted');

    // The measurement that matters. Unfenced this was R300: R150 on the journal
    // and R150 again on an auto-approved supplier invoice, one R1 150 slip.
    expect(await invoiceIds(journalThenPipelineDoc)).toHaveLength(0);
    expect(await inputTaxClaimed(journalThenPipelineDoc)).toBe(statedVat(journalThenPipelineDoc));
  });

  it('posts the pipeline once and refuses its own retry', async () => {
    expect((await pipeline(pipelineTwiceDoc)).state.statusCode).toBe(200);

    const again = await pipeline(pipelineTwiceDoc);
    expect(again.state.statusCode).toBe(400);
    expect(errorMessage(again)).toContain('already posted');

    expect(await invoiceIds(pipelineTwiceDoc)).toHaveLength(1);
    expect(await inputTaxClaimed(pipelineTwiceDoc)).toBe(statedVat(pipelineTwiceDoc));
  });

  it('refuses the pipeline on a document an operator rejected', async () => {
    expect((await documentAction(rejectedPipelineDoc, 'reject')).state.statusCode).toBe(200);

    const refused = await pipeline(rejectedPipelineDoc);
    expect(refused.state.statusCode).toBe(400);
    expect(errorMessage(refused)).toContain('rejected');
    expect(await invoiceIds(rejectedPipelineDoc)).toHaveLength(0);
  });

  it('leaves an unposted document postable — the guard fails both ways', async () => {
    // Same route, clean document: a fence that refuses everything is not a fence.
    expect(await postedAt(bothRoutesDoc)).toBeNull();
    expect((await pipeline(bothRoutesDoc)).state.statusCode).toBe(200);
    expect(await postedAt(bothRoutesDoc)).not.toBeNull();
    // Approved unattended — the case the credit-note refusal below must not become.
    expect(await invoiceStatuses(bothRoutesDoc)).toEqual(['approved']);
  });

  it('never approves a document whose own text prints two different totals', async () => {
    // The receipt routes refuse this slip; this one approved it, at whichever
    // figure the ambiguous read happened to store — measured on the k076 corpus
    // at R230.00 against a payable of R253.00, a WORSE number than the reader
    // this branch replaced produced. `status = 'approved'` is unattended.
    await markAmbiguousTotals(ambiguousTotalDoc);
    expect((await pipeline(ambiguousTotalDoc)).state.statusCode).toBe(200);
    expect(await invoiceStatuses(ambiguousTotalDoc)).toEqual(['draft']);
  });

  it('never approves figures the text fallback read (K-072 round 14)', async () => {
    // Same clean shape as `bothRoutesDoc`, which lands 'approved'; only the
    // extraction method differs.
    await pool.query(
      `UPDATE captured_documents
          SET extracted_data = jsonb_set(extracted_data, '{extractionMethod}', '"regex"')
        WHERE id=$1 AND company_id=$2`,
      [fallbackDoc, company],
    );
    expect((await pipeline(fallbackDoc)).state.statusCode).toBe(200);
    expect(await invoiceStatuses(fallbackDoc)).toEqual(['draft']);
  });

  it('never approves a credit note unattended, whatever sign its figures carry', async () => {
    // A refund booked as a supplier INVOICE raises the liability it should
    // reduce. Positive figures are the usual credit-note layout, so the sign
    // cannot be what stops it; the classification is.
    await markCreditNote(creditNoteDoc);
    expect((await pipeline(creditNoteDoc)).state.statusCode).toBe(200);
    expect(await invoiceStatuses(creditNoteDoc)).toEqual(['draft']);
  });
});

describe('K-072 r7 the posting claim has a way back', () => {
  it('reversing the journal releases the document, and it posts again', async () => {
    expect((await receiptToJournal(reversedJournalDoc)).state.statusCode).toBe(200);
    expect(await postedAt(reversedJournalDoc)).not.toBeNull();

    // Before the release existed, the refusal's "Reverse the journal or invoice
    // first" was a dead end: this next assertion was posted_at UNCHANGED.
    const [journalId] = await journalIds(reversedJournalDoc);
    expect((await reverseJournal(journalId!)).state.statusCode).toBe(200);
    expect(await postedAt(reversedJournalDoc)).toBeNull();

    // And the re-post actually lands. Without `reversed_at IS NULL` in
    // migration 672's index this 23505s against the row just reversed, so the
    // release would be a promise the database refused to keep.
    expect((await receiptToJournal(reversedJournalDoc)).state.statusCode).toBe(200);
    expect(await journalIds(reversedJournalDoc)).toHaveLength(2);

    // The reversal netted the first pair to zero, so one live claim remains.
    expect(await inputTaxClaimed(reversedJournalDoc)).toBe(statedVat(reversedJournalDoc));
  });

  it('cancelling the supplier invoice releases the document', async () => {
    expect((await pipeline(cancelledInvoiceDoc)).state.statusCode).toBe(200);
    const [invoiceId] = await invoiceIds(cancelledInvoiceDoc);

    expect((await cancelInvoice(invoiceId!)).state.statusCode).toBe(200);
    expect(await postedAt(cancelledInvoiceDoc)).toBeNull();
    expect(await inputTaxClaimed(cancelledInvoiceDoc)).toBe(0);
  });

  it('holds the claim while ANY live ledger row still references the document', async () => {
    // The both-directions case, and the one that decides whether the release is
    // a fence or a hole. A document that produced TWO live ledger rows must not
    // come back postable when only ONE of them is undone — otherwise the undo
    // path is a second way to double-claim the same input tax.
    expect((await receiptToJournal(twoLiveRowsDoc)).state.statusCode).toBe(200);

    // Clear the claim by hand to reach the state a release leaves behind, which
    // is the only way to get a live journal AND a live invoice onto one
    // document now that all four routes claim. Historic rows are in exactly
    // this shape: migration 672 backfilled `posted_at` onto documents that
    // already carried both.
    await pool.query('UPDATE captured_documents SET posted_at=NULL WHERE id=$1', [twoLiveRowsDoc]);
    expect((await pipeline(twoLiveRowsDoc)).state.statusCode).toBe(200);

    const [journalId] = await journalIds(twoLiveRowsDoc);
    const [invoiceId] = await invoiceIds(twoLiveRowsDoc);
    const stated = statedVat(twoLiveRowsDoc);
    expect(await inputTaxClaimed(twoLiveRowsDoc)).toBe(Math.round(stated * 2 * 100) / 100);

    // Undo ONE. The claim stays, because the journal is still standing.
    expect((await cancelInvoice(invoiceId!)).state.statusCode).toBe(200);
    expect(await postedAt(twoLiveRowsDoc)).not.toBeNull();
    expect(await inputTaxClaimed(twoLiveRowsDoc)).toBe(stated);

    // Undo the other, and only now does the document come back.
    expect((await reverseJournal(journalId!)).state.statusCode).toBe(200);
    expect(await postedAt(twoLiveRowsDoc)).toBeNull();
    expect(await inputTaxClaimed(twoLiveRowsDoc)).toBe(0);
  });
});

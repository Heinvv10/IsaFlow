// R-088 round 2: the posted-content fence on EVERY route that claims a slip.
//
// The first round fenced the two receipt routes only. The supplier-invoice
// routes, the manual expense-claim lines and the index stamp still let one
// slip be booked twice across routes: post it through receipt-to-journal,
// then post the same file from the capture inbox as a supplier invoice.
// Every case here is a route sequence asserting what the ledger holds.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import receiptRoute from '../../pages/api/accounting/receipt-to-journal';
import capturePostRoute from '../../pages/api/accounting/capture/[id]/post';
import pipelineRoute from '../../pages/api/accounting/ai-invoice-pipeline';
import claimsRoute from '../../pages/api/accounting/expense-claims';
import attachRoute from '../../pages/api/accounting/provisional/[jeId]/attach';
import siActionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  accounts, bytesHash, call, company, employee, errorOf, invoiceCount, journalCount, pool, postedAt,
  purge, seed, seedProvisional, stamped, today, upload, uploadToInbox,
} from './r088-receipt-content-dedupe.helpers';

assertDisposable();

const receiptToJournal = (documentId: string) =>
  call(receiptRoute, '/api/accounting/receipt-to-journal', { documentId });
const inboxPost = (eventId: string) =>
  call(capturePostRoute, `/api/accounting/capture/${eventId}/post`, {}, eventId);
const pipeline = (documentId: string) =>
  call(pipelineRoute, '/api/accounting/ai-invoice-pipeline', { documentId });
const createClaim = (sourceDocumentId: string, amount: number) =>
  call(claimsRoute, '/api/accounting/expense-claims', {
    employeeId: employee,
    lines: [{
      lineDate: today, description: 'R088 slip', merchant: 'Waltons', amount, vatAmount: 0, vatCode: 'none',
      glAccountId: accounts[company]!.office, costCentreId: null, projectId: null, sourceDocumentId,
      kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
    }],
  });
async function claimCount(): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM expense_claims WHERE company_id=$1', [company])).rows[0].n as number;
}

function expectContentRefusal(result: Awaited<ReturnType<typeof call>>, status: number) {
  expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(status);
  expect(errorOf(result).message).toMatch(/same file was already posted/i);
}

beforeAll(seed);
afterAll(async () => {
  try { await purge(); } finally { clearSystemAccountCache(); await pool.end(); }
}, 60_000);

describe('R-088 the same file cannot be booked twice across routes', () => {
  it('refuses the capture inbox supplier invoice of a slip already posted as a receipt journal', async () => {
    const receipt = await upload('fence-2070', { total: 2070, invoice: true });
    expect((await receiptToJournal(receipt)).state.statusCode).toBe(200);

    const { documentId, eventId } = await uploadToInbox('fence-2070', { total: 2070, invoice: true });
    expectContentRefusal(await inboxPost(eventId), 409);
    expect(await invoiceCount(documentId)).toBe(0);
    expect(await postedAt(documentId)).toBeNull();
  });

  it('refuses the AI invoice pipeline on a slip already posted as a receipt journal', async () => {
    const receipt = await upload('fence-2185', { total: 2185, invoice: true });
    expect((await receiptToJournal(receipt)).state.statusCode).toBe(200);

    const copy = await upload('fence-2185', { total: 2185, invoice: true });
    expectContentRefusal(await pipeline(copy), 409);
    expect(await invoiceCount(copy)).toBe(0);
    expect(await postedAt(copy)).toBeNull();
  });

  it('refuses a manual expense-claim line on a slip already posted', async () => {
    const receipt = await upload('fence-2300', { total: 2300 });
    expect((await receiptToJournal(receipt)).state.statusCode).toBe(200);

    const copy = await upload('fence-2300', { total: 2300 });
    const before = await claimCount();
    expectContentRefusal(await createClaim(copy, 2300), 400);
    expect(await claimCount()).toBe(before);
    expect(await postedAt(copy)).toBeNull();
  });

  it('refuses a receipt journal on a slip already raised as a supplier invoice', async () => {
    const { documentId, eventId } = await uploadToInbox('fence-2415', { total: 2415, invoice: true });
    expect((await inboxPost(eventId)).state.statusCode).toBe(200);
    expect(await invoiceCount(documentId)).toBe(1);

    const copy = await upload('fence-2415', { total: 2415, invoice: true });
    const refused = await receiptToJournal(copy);
    expect(refused.state.statusCode).toBe(409);
    expect(errorOf(refused).details).toMatchObject({ code: 'DUPLICATE_RECEIPT', earlierDocumentId: documentId, matchedOn: 'file' });
    expect(await journalCount([copy])).toBe(0);
  });

  it('stamps the posted bytes on every route that books a slip', async () => {
    const viaInbox = await uploadToInbox('stamp-inbox', { total: 2530, invoice: true });
    expect((await inboxPost(viaInbox.eventId)).state.statusCode).toBe(200);
    const viaPipeline = await upload('stamp-pipeline', { total: 2645, invoice: true });
    expect((await pipeline(viaPipeline)).state.statusCode).toBe(200);
    const viaClaim = await upload('stamp-claim', { total: 2760 });
    expect((await createClaim(viaClaim, 2760)).state.statusCode).toBe(201);
    const viaReceipt = await upload('stamp-receipt', { total: 2875 });
    expect((await receiptToJournal(viaReceipt)).state.statusCode).toBe(200);

    expect((await stamped(viaInbox.documentId)).content).toBe(bytesHash('stamp-inbox'));
    expect((await stamped(viaPipeline)).content).toBe(bytesHash('stamp-pipeline'));
    expect((await stamped(viaClaim)).content).toBe(bytesHash('stamp-claim'));
    expect((await stamped(viaReceipt)).content).toBe(bytesHash('stamp-receipt'));
  });
});

// R-127 x R-088: one slip, one booking. An evidence attach books nothing new
// (so it stamps nothing), but the slip IS booked — its provisional expensed
// the bank line. A SECOND upload of that slip is another document, and R-127
// settles only an invoice whose OWN document evidences the provisional; so an
// invoice from the second upload would be approved beside the provisional and
// book the bill twice. The attach therefore counts for EVERY route, invoices
// included. The legitimate R-127 flow — the invoice's own slip evidences the
// provisional — never asks the fence about another document.
/** Every debit on the provisional and on the journals of any invoice raised from these slips. */
async function bookedDebits(je: string, documentIds: string[]): Promise<number> {
  return Number((await pool.query(
    `SELECT COALESCE(SUM(l.debit),0)::numeric AS dr FROM gl_journal_lines l
      WHERE l.company_id=$1 AND l.journal_entry_id IN (
        SELECT $2::uuid UNION
        SELECT gl_journal_entry_id FROM supplier_invoices
         WHERE company_id=$1 AND source_document_id = ANY($3::uuid[]) AND gl_journal_entry_id IS NOT NULL)`,
    [company, je, documentIds])).rows[0].dr);
}
const attach = (je: string, documentId: string) => call(attachRoute, `/api/accounting/provisional/${je}/attach`,
  { capturedDocumentId: documentId }, undefined, company, { jeId: je });

describe('R-088 an evidence attach spends a slip for every route', () => {
  it('refuses the invoice routes and the receipt route on a second upload of an evidenced slip', async () => {
    const je = await seedProvisional(2990);
    const evidence = await upload('evidence-2990', { total: 2990, invoice: true });
    const attached = await attach(je, evidence);
    expect(attached.state.statusCode, JSON.stringify(attached.state.body)).toBe(200);
    expect(await postedAt(evidence)).not.toBeNull();
    expect((await stamped(evidence)).content).toBeNull();

    const inbox = await uploadToInbox('evidence-2990', { total: 2990, invoice: true });
    expectContentRefusal(await inboxPost(inbox.eventId), 409);
    expect(await invoiceCount(inbox.documentId)).toBe(0);
    expect(await postedAt(inbox.documentId)).toBeNull();

    const viaPipeline = await upload('evidence-2990', { total: 2990, invoice: true });
    expectContentRefusal(await pipeline(viaPipeline), 409);
    expect(await invoiceCount(viaPipeline)).toBe(0);
    expect(await postedAt(viaPipeline)).toBeNull();

    const receipt = await upload('evidence-2990', { total: 2990, invoice: true });
    const refused = await receiptToJournal(receipt);
    expect(refused.state.statusCode).toBe(409);
    expect(await journalCount([receipt])).toBe(0);
  });

  it('end to end: a second upload of an evidenced slip is never invoiced and approved into a double booking', async () => {
    const je = await seedProvisional(3450);
    const evidence = await upload('second-3450', { total: 3450, invoice: true });
    expect((await attach(je, evidence)).state.statusCode).toBe(200);

    // Read with low confidence, so the pipeline raises a DRAFT a person then approves.
    const copy = await upload('second-3450', { total: 3450, invoice: true, confidence: 0.5 });
    const raised = await pipeline(copy);
    const [invoice] = (await pool.query(
      'SELECT id FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2', [company, copy])).rows;
    if (invoice) {
      await call(siActionRoute, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: invoice.id });
    }

    // The slip is booked once: by the provisional, and by nothing else.
    expect(await bookedDebits(je, [evidence, copy])).toBe(3450);
    expectContentRefusal(raised, 409);
    expect(await invoiceCount(copy)).toBe(0);
  });

  it('the R-127 same-document flow still settles: the invoice\'s own slip evidences the provisional', async () => {
    const je = await seedProvisional(3565);
    const supplier = (await pool.query(
      "SELECT id FROM suppliers WHERE company_id=$1 AND name='Waltons Stationery'", [company])).rows[0].id as string;
    await pool.query('UPDATE bank_transactions SET predicted_supplier_id=$2 WHERE provisional_je_id=$1', [je, supplier]);
    const slip = await upload('same-3565', { total: 3565, invoice: true });

    const out = await pipeline(slip);
    expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
    const [row] = (await pool.query(
      'SELECT status FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2', [company, slip])).rows;
    expect(row.status).toBe('paid');
    const evidenced = (await pool.query('SELECT source_document_id FROM gl_journal_entries WHERE id=$1', [je])).rows[0];
    expect(evidenced.source_document_id).toBe(slip);
    // Booked once: expense + VAT net over the provisional, the invoice's journal and
    // the reclass that made the provisional its payment — cash and AP legs aside.
    const net = Number((await pool.query(
      `SELECT COALESCE(SUM(l.debit - l.credit),0)::numeric AS n FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.gl_account_id AND a.company_id = l.company_id
        WHERE l.company_id=$1 AND l.gl_account_id <> $2
          AND COALESCE(a.account_subtype,'') NOT IN ('payable','accounts_payable')
          AND l.journal_entry_id IN (
            SELECT $3::uuid
            UNION SELECT gl_journal_entry_id FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$4
            UNION SELECT gl_journal_entry_id FROM supplier_payments WHERE company_id=$1 AND settles_provisional_je_id=$3)`,
      [company, accounts[company]!.bank, je, slip])).rows[0].n);
    expect(net).toBe(3565);
  });

  it('counts a pre-710 slip that is both invoiced and evidences a provisional', async () => {
    // The R-127 same-document flow before 710: the inbox raised the invoice and
    // the auto-attach evidenced a provisional with the same slip; no stamp.
    const first = await uploadToInbox('pre710-3335', { total: 3335, invoice: true });
    expect((await inboxPost(first.eventId)).state.statusCode).toBe(200);
    const je = await seedProvisional(3335);
    await pool.query('UPDATE captured_documents SET posted_content_sha256 = NULL WHERE id = $1', [first.documentId]);
    await pool.query(
      'UPDATE gl_journal_entries SET source_document_id = $1, evidenced_at = NOW(), needs_evidence = false WHERE id = $2',
      [first.documentId, je]);

    // The same file, its total misread, so the invoice duplicate gate does not see it.
    const copy = await uploadToInbox('pre710-3335', { total: 3535, invoice: true });
    expectContentRefusal(await inboxPost(copy.eventId), 409);
    expect(await invoiceCount(copy.documentId)).toBe(0);
  });

  it('refuses a receipt journal for a slip that only evidences a provisional', async () => {
    // No invoice in between: the evidence attach alone must count on an expense route.
    const je = await seedProvisional(3220);
    const evidence = await upload('evidence-3220', { total: 3220 });
    expect((await call(attachRoute, `/api/accounting/provisional/${je}/attach`,
      { capturedDocumentId: evidence }, undefined, company, { jeId: je })).state.statusCode).toBe(200);

    const receipt = await upload('evidence-3220', { total: 3220 });
    const refused = await receiptToJournal(receipt);
    expect(refused.state.statusCode).toBe(409);
    expect(errorOf(refused).details).toMatchObject({ earlierDocumentId: evidence, matchedOn: 'file' });
    expect(await journalCount([receipt])).toBe(0);
  });
});

// The fence behind the checks: a writer that stamps but skips the check —
// one written later — still cannot land a second live posting of one file.
describe('R-088 backstop: the partial unique index on the posted bytes', () => {
  const stampAsPosted = (id: string, extra = '') => pool.query(
    `UPDATE captured_documents SET posted_at = NOW(), posted_content_sha256 = raw_bytes_sha256${extra} WHERE id = $1`, [id]);

  it('refuses a second live posting of the same bytes, confirmed repeat or not', async () => {
    const [x1, x2] = [await upload('backstop-a', { total: 920 }), await upload('backstop-a', { total: 920 })];
    await stampAsPosted(x1);
    await expect(stampAsPosted(x2)).rejects.toThrow(/uq_captured_documents_posted_content/);
    await expect(stampAsPosted(x2, `, posted_duplicate_of = '${x1}'`)).rejects.toThrow(/uq_captured_documents_posted_content/);
    expect(await postedAt(x2)).toBeNull();
  });

  it('does not count a row whose posting was released', async () => {
    const [y1, y2] = [await upload('backstop-b', { total: 930 }), await upload('backstop-b', { total: 930 })];
    await stampAsPosted(y1);
    // A release that cleared posted_at but not the stamp: the slip is no longer booked.
    await pool.query('UPDATE captured_documents SET posted_at = NULL WHERE id = $1', [y1]);
    await stampAsPosted(y2);
    expect(await postedAt(y2)).not.toBeNull();
  });
});

// A request waiting on another's post of the same content answers a busy 409
// of its own, naming no document.
describe('R-088 a fingerprint held by another request', () => {
  it('answers RECEIPT_POST_BUSY after the bounded wait', async () => {
    const slip = await upload('busy-3105', { total: 3105 });
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`r088|${company}|sha:${bytesHash('busy-3105')}`]);
      const out = await receiptToJournal(slip);
      expect(out.state.statusCode).toBe(409);
      const error = errorOf(out);
      expect(error.details).toMatchObject({ code: 'RECEIPT_POST_BUSY' });
      expect(error.message).not.toContain(slip);
      expect(await journalCount([slip])).toBe(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  }, 30_000);
});

// The posting fence, driven through the routes a person actually clicks.
//
// Round 5 hardened two routes that no `.tsx` in the repo calls, and left the
// one the capture inbox calls (`capture/[id]/post`) reading no document state
// at all — so one receipt turned into a posted GL journal AND an auto-approved
// supplier invoice carrying the same R150 of input tax, both feeding the
// VAT201. The other two leaks came from the same root: the fence was
// `captured_documents.status`, a lifecycle column, so the confirm button RESET
// it (post → confirm → post = two journals, R2 300 of bank credit), a
// `<> 'matched'` predicate ADMITTED the terminal 'rejected', and a document
// merely attached to a bank transaction as evidence was REFUSED with "already
// posted to a journal" while zero journals existed.
//
// The fence is now `captured_documents.posted_at` (migration 672), written by a
// posting path and nothing else. Every case below is a UI-shaped SEQUENCE and
// asserts the ledger outcome — journals, bank credit, supplier invoices — not
// the presence of a guard in the source.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import actionRoute from '../../pages/api/accounting/document-capture-action';
import capturePostRoute from '../../pages/api/accounting/capture/[id]/post';
import postExpenseRoute from '../../pages/api/accounting/capture/[id]/post-expense';
import receiptRoute from '../../pages/api/accounting/receipt-to-journal';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const vatInput = crypto.randomUUID();
const defaultExpense = crypto.randomUUID();
const office = crypto.randomUUID();
const supplier = crypto.randomUUID();
const bankTx = crypto.randomUUID();

const inboxAfterJournalDoc = crypto.randomUUID();
const confirmBypassDoc = crypto.randomUUID();
const rejectedDoc = crypto.randomUUID();
const rejectedInboxDoc = crypto.randomUUID();
const attachedDoc = crypto.randomUUID();
const inboxOnlyDoc = crypto.randomUUID();
const postedThenConfirmDoc = crypto.randomUUID();
const foreignDoc = crypto.randomUUID();
const creditNoteDoc = crypto.randomUUID();
const creditNoteJournalDoc = crypto.randomUUID();
const documents = [
  inboxAfterJournalDoc, confirmBypassDoc, rejectedDoc, rejectedInboxDoc,
  attachedDoc, inboxOnlyDoc, postedThenConfirmDoc, foreignDoc, creditNoteDoc, creditNoteJournalDoc,
];

const inboxAfterJournalEvent = crypto.randomUUID();
const confirmBypassEvent = crypto.randomUUID();
const rejectedInboxEvent = crypto.randomUUID();
const inboxOnlyEvent = crypto.randomUUID();
const creditNoteEvent = crypto.randomUUID();
const events = [
  inboxAfterJournalEvent, confirmBypassEvent, rejectedInboxEvent, inboxOnlyEvent, creditNoteEvent,
];

const today = new Date().toISOString().slice(0, 10);
let token = '';

const extracted = (reference: string) => ({
  documentType: 'receipt', vendorName: 'Waltons Stationery', date: today,
  referenceNumber: reference, currency: 'ZAR', subtotal: 1000, vatAmount: 150,
  vatRate: 15, totalAmount: 1150, lineItems: [], confidence: 0.9,
  // The text the auto-post gate re-reads — without it nothing posts unattended.
  rawText: 'Waltons Stationery\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00',
  warnings: [], extractionMethod: 'vlm',
});

async function seedDoc(id: string, owner = company): Promise<void> {
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','receipt',$4::jsonb,'pending')`,
    [id, owner, `k072f-${id}.pdf`, JSON.stringify(extracted(`REC-${id.slice(0, 8)}`))],
  );
}

async function seedEvent(docId: string, eventId: string): Promise<void> {
  await seedDoc(docId);
  await pool.query(
    `INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'pwa','extracted',$3)`,
    [eventId, company, docId],
  );
}

function receiptToJournal(documentId: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  req.url = '/api/accounting/receipt-to-journal';
  req.body = { documentId };
  const result = response();
  return receiptRoute(req, result.res).then(() => result);
}

/** The capture inbox's own posting button — the only one in the product. */
function inboxPost(eventId: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST', eventId);
  req.url = `/api/accounting/capture/${eventId}/post`;
  req.body = {};
  const result = response();
  return capturePostRoute(req, result.res).then(() => result);
}

function postExpense(eventId: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST', eventId);
  req.url = `/api/accounting/capture/${eventId}/post-expense`;
  req.body = { glAccountId: office };
  const result = response();
  return postExpenseRoute(req, result.res).then(() => result);
}

function documentAction(id: string, action: string, data?: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  req.url = '/api/accounting/document-capture-action';
  req.body = { id, action, ...(data ? { data } : {}) };
  const result = response();
  return actionRoute(req, result.res).then(() => result);
}

function errorMessage(result: { state: { body: unknown } }): string {
  return (result.state.body as { error: { message: string } }).error.message;
}

async function journalCount(documentId: string): Promise<number> {
  return (await pool.query(
    'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source_document_id=$2',
    [company, documentId],
  )).rows[0].n as number;
}

async function bankCredit(documentId: string): Promise<number> {
  return Number((await pool.query(
    `SELECT COALESCE(SUM(jl.credit),0)::numeric AS cr
     FROM gl_journal_lines jl
     JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
     WHERE je.company_id=$1 AND je.source_document_id=$2 AND jl.gl_account_id=$3`,
    [company, documentId, bank],
  )).rows[0].cr);
}

/** Every rand of input tax the document put in front of the VAT201, both ways. */
async function inputTaxClaimed(documentId: string): Promise<number> {
  const journal = Number((await pool.query(
    `SELECT COALESCE(SUM(jl.debit),0)::numeric AS dr
     FROM gl_journal_lines jl
     JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
     WHERE je.company_id=$1 AND je.source_document_id=$2 AND jl.gl_account_id=$3`,
    [company, documentId, vatInput],
  )).rows[0].dr);
  const invoice = Number((await pool.query(
    `SELECT COALESCE(SUM(tax_amount),0)::numeric AS tx FROM supplier_invoices
     WHERE company_id=$1 AND source_document_id=$2`,
    [company, documentId],
  )).rows[0].tx);
  return Math.round((journal + invoice) * 100) / 100;
}

/** The statuses of the supplier invoices a document produced — 'approved' is unattended. */
async function invoiceStatuses(documentId: string): Promise<string[]> {
  return (await pool.query(
    'SELECT status FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2 ORDER BY created_at',
    [company, documentId],
  )).rows.map((r) => String(r.status));
}

async function invoiceCount(documentId: string): Promise<number> {
  return (await pool.query(
    'SELECT COUNT(*)::int AS n FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2',
    [company, documentId],
  )).rows[0].n as number;
}

async function postedAt(documentId: string): Promise<Date | null> {
  return (await pool.query('SELECT posted_at FROM captured_documents WHERE id=$1', [documentId]))
    .rows[0]?.posted_at ?? null;
}

async function purge(): Promise<void> {
  await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id=$1', [bankTx]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM capture_events WHERE id=ANY($1::uuid[])', [events]);
  await pool.query('DELETE FROM captured_documents WHERE id=ANY($1::uuid[])', [documents]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])',
    [[bank, vatInput, defaultExpense, office]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K072F owner', otherCompany, 'K072F neighbour']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_system_account,is_active)
     VALUES($1,$5,'K072FB','K072F Bank','asset','bank','debit',true,true),
           ($2,$5,'1140','K072F VAT Input','asset','vat_input','debit',true,true),
           ($3,$5,'K072FDE','K072F Default expense','expense','default_expense','debit',true,true),
           ($4,$5,'5100','K072F Office supplies','expense',NULL,'debit',false,true)`,
    [bank, vatInput, defaultExpense, office, company],
  );
  await pool.query('INSERT INTO suppliers(id,company_id,name,is_active) VALUES($1,$2,$3,true)',
    [supplier, company, 'Waltons Stationery']);
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$2,$3,$4,$5,'K072F Waltons','imported')`,
    [bankTx, company, bank, today, -1150],
  );
  clearSystemAccountCache(company);

  await seedEvent(inboxAfterJournalDoc, inboxAfterJournalEvent);
  await seedEvent(confirmBypassDoc, confirmBypassEvent);
  await seedEvent(rejectedInboxDoc, rejectedInboxEvent);
  await seedEvent(inboxOnlyDoc, inboxOnlyEvent);
  await seedEvent(creditNoteDoc, creditNoteEvent);
  await seedDoc(rejectedDoc);
  await seedDoc(attachedDoc);
  await seedDoc(postedThenConfirmDoc);
  await seedDoc(foreignDoc, otherCompany);
  await seedDoc(creditNoteJournalDoc);

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

describe('K-072 HIGH-1 the capture inbox is inside the fence', () => {
  it('refuses the inbox post of a receipt already turned into a journal', async () => {
    expect((await receiptToJournal(inboxAfterJournalDoc)).state.statusCode).toBe(200);

    const second = await inboxPost(inboxAfterJournalEvent);
    expect(second.state.statusCode).toBe(400);
    expect(errorMessage(second)).toContain('already posted');

    // The outcome, not the guard: one journal, one R1 150 bank credit, no
    // supplier invoice, and R150 of input tax claimed ONCE. Before the fix this
    // was 1 journal + 1 auto-approved invoice and R300 of input tax.
    expect(await journalCount(inboxAfterJournalDoc)).toBe(1);
    expect(await bankCredit(inboxAfterJournalDoc)).toBe(1150);
    expect(await invoiceCount(inboxAfterJournalDoc)).toBe(0);
    expect(await inputTaxClaimed(inboxAfterJournalDoc)).toBe(150);
  });

  it('posts the inbox route once and refuses its own retry', async () => {
    // The legitimate path still works, and the claim is what makes the retry a
    // refusal rather than a second invoice.
    const first = await inboxPost(inboxOnlyEvent);
    expect(first.state.statusCode).toBe(200);
    expect(await invoiceCount(inboxOnlyDoc)).toBe(1);
    expect(await postedAt(inboxOnlyDoc)).not.toBeNull();
    // Approved unattended — the case the credit-note refusal below must not become.
    expect(await invoiceStatuses(inboxOnlyDoc)).toEqual(['approved']);

    const again = await inboxPost(inboxOnlyEvent);
    expect(again.state.statusCode).toBe(400);
    expect(await invoiceCount(inboxOnlyDoc)).toBe(1);
    expect(await inputTaxClaimed(inboxOnlyDoc)).toBe(150);
  });

  it('never approves a credit note from the inbox, whatever sign its figures carry', async () => {
    // A refund booked as a supplier INVOICE raises the liability it should
    // reduce, and positive figures are the usual credit-note layout.
    // Its own amount, so the duplicate gate does not answer 409 against the
    // R1 150 invoices the other cases create.
    const note = {
      documentType: 'credit_note', subtotal: 100, vatAmount: 15, totalAmount: 115,
      rawText: 'Sub Total 100.00\nVAT 15.00\nTotal 115.00',
    };
    await pool.query(
      'UPDATE captured_documents SET extracted_data = extracted_data || $3::jsonb WHERE id=$1 AND company_id=$2',
      [creditNoteDoc, company, JSON.stringify(note)],
    );
    expect((await inboxPost(creditNoteEvent)).state.statusCode).toBe(200);
    expect(await invoiceStatuses(creditNoteDoc)).toEqual(['draft']);
  });

  it('never auto-posts a credit note as a receipt journal', async () => {
    // Same R1 150 figures as every receipt here, which DO auto-post; only the
    // classification differs, so it is what keeps this journal a draft.
    await pool.query(
      `UPDATE captured_documents
          SET extracted_data = jsonb_set(extracted_data, '{documentType}', '"credit_note"')
        WHERE id=$1 AND company_id=$2`,
      [creditNoteJournalDoc, company],
    );
    expect((await receiptToJournal(creditNoteJournalDoc)).state.statusCode).toBe(200);
    const statuses = (await pool.query(
      'SELECT status FROM gl_journal_entries WHERE company_id=$1 AND source_document_id=$2',
      [company, creditNoteJournalDoc],
    )).rows.map((r) => String(r.status));
    expect(statuses).toEqual(['draft']);
  });
});

describe('K-072 HIGH-2 a lifecycle button cannot un-post a document', () => {
  it('refuses confirm after posting, and the second post stays refused', async () => {
    expect((await postExpense(confirmBypassEvent)).state.statusCode).toBe(200);

    const confirm = await documentAction(confirmBypassDoc, 'confirm');
    expect(confirm.state.statusCode).toBe(400);
    expect(errorMessage(confirm)).toContain('already posted to the ledger');

    const second = await postExpense(confirmBypassEvent);
    expect(second.state.statusCode).toBe(400);

    // post → confirm → post used to be 2 journals and R2 300 of bank credit.
    expect(await journalCount(confirmBypassDoc)).toBe(1);
    expect(await bankCredit(confirmBypassDoc)).toBe(1150);
    expect(await inputTaxClaimed(confirmBypassDoc)).toBe(150);
  });

  it('refuses reject after posting, and leaves the claim intact', async () => {
    expect((await receiptToJournal(postedThenConfirmDoc)).state.statusCode).toBe(200);
    const claimed = await postedAt(postedThenConfirmDoc);

    const reject = await documentAction(postedThenConfirmDoc, 'reject', { notes: 'changed my mind' });
    expect(reject.state.statusCode).toBe(400);

    expect(await postedAt(postedThenConfirmDoc)).toEqual(claimed);
    expect(await journalCount(postedThenConfirmDoc)).toBe(1);
  });
});

describe('K-072 HIGH-3 a rejected receipt does not post', () => {
  it('refuses receipt-to-journal on a rejected document', async () => {
    expect((await documentAction(rejectedDoc, 'reject')).state.statusCode).toBe(200);

    const result = await receiptToJournal(rejectedDoc);
    expect(result.state.statusCode).toBe(400);
    expect(errorMessage(result)).toContain('rejected');

    expect(await journalCount(rejectedDoc)).toBe(0);
    expect(await inputTaxClaimed(rejectedDoc)).toBe(0);
    expect(await postedAt(rejectedDoc)).toBeNull();
  });

  it('refuses the capture inbox on a rejected document', async () => {
    expect((await documentAction(rejectedInboxDoc, 'reject')).state.statusCode).toBe(200);

    const result = await inboxPost(rejectedInboxEvent);
    expect(result.state.statusCode).toBe(400);
    expect(errorMessage(result)).toContain('rejected');
    expect(await invoiceCount(rejectedInboxDoc)).toBe(0);
    expect(await journalCount(rejectedInboxDoc)).toBe(0);
  });
});

describe('K-072 MEDIUM-1 attaching a slip as evidence does not block posting it', () => {
  it('posts a document that is attached to a bank transaction', async () => {
    const attach = await documentAction(attachedDoc, 'match_bank_tx', { bankTxId: bankTx });
    expect(attach.state.statusCode).toBe(200);
    // The attach stamps the lifecycle column 'matched' — which the old fence
    // read as "already posted to a journal" while zero journals existed, and
    // whose only undo was the confirm button that HIGH-2 is about.
    expect((await pool.query('SELECT status FROM captured_documents WHERE id=$1', [attachedDoc]))
      .rows[0].status).toBe('matched');
    expect(await postedAt(attachedDoc)).toBeNull();

    const result = await receiptToJournal(attachedDoc);
    expect(result.state.statusCode).toBe(200);
    expect(await journalCount(attachedDoc)).toBe(1);
    expect(await bankCredit(attachedDoc)).toBe(1150);
  });
});

describe('K-072 adjacent cases', () => {
  it('does not let one tenant post another tenant\'s document', async () => {
    const result = await receiptToJournal(foreignDoc);
    expect(result.state.statusCode).toBe(404);
    expect(await postedAt(foreignDoc)).toBeNull();
    expect((await pool.query(
      'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE source_document_id=$1', [foreignDoc],
    )).rows[0].n).toBe(0);
  });

  it('refuses a second posting journal at the database, whatever route writes it', async () => {
    // The claim is the application fence; uq_gl_je_capture_source_document is
    // the one behind it, for a route that forgets to claim or gets invented
    // later. Insert straight past the application code to prove it exists.
    const [{ id: firstJe }] = (await pool.query(
      `SELECT id FROM gl_journal_entries
       WHERE company_id=$1 AND source_document_id=$2 AND source='auto_expense_receipt'`,
      [company, attachedDoc],
    )).rows;
    expect(firstJe).toBeTruthy();

    await expect(pool.query(
      `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,source_document_id,status,created_by)
       VALUES($1,'K072F-DUP',$2,'second posting journal','auto_expense_receipt',$3,'draft',$4)`,
      [company, today, attachedDoc, user],
    )).rejects.toMatchObject({ code: '23505' });

    expect(await journalCount(attachedDoc)).toBe(1);
  });
});

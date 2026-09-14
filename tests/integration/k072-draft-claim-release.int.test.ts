// A capture posting claim that produced NO ledger row can be given back.
//
// The four posting routes claim `captured_documents.posted_at` before their
// first ledger write. `receipt-to-journal` only POSTS the journal it builds
// when `shouldAutoPostReceipt` passes — over R5 000, below 0.85 confidence, or
// on any unreconciled warning it leaves a DRAFT. Measured before this file
// existed: the document stayed claimed, confirm answered 400, reject answered
// 400, the re-post answered 400, and `reverseJournalEntry` throws "Can only
// reverse posted entries" on a draft with no route that deletes one. The
// majority capture path had NO way back — a regression on the pre-branch
// behaviour, where confirm reset the status.
//
// The employee-claim branch was worse by construction: its claim journal
// carries `source_document_id = NULL`, so the reversal release can never reach
// the document, and a rejected claim held its slip forever.
//
// Every case below is a SEQUENCE through the real routes and asserts the
// OUTCOME — the claim column, the journals that exist, and whether the next
// post lands.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import actionRoute from '../../pages/api/accounting/document-capture-action';
import journalEntriesRoute from '../../pages/api/accounting/journal-entries';
import approveRoute from '../../pages/api/accounting/expense-claims/[id]/approve';
import jeActionRoute from '../../pages/api/accounting/journal-entries-action';
import postExpenseRoute from '../../pages/api/accounting/capture/[id]/post-expense';
import receiptRoute from '../../pages/api/accounting/receipt-to-journal';
import { claimCapturedDocumentForPosting } from '@/modules/accounting/services/capture/captureRowLock';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const user = crypto.randomUUID();
const employee = crypto.randomUUID();
const bank = crypto.randomUUID();
const vatInput = crypto.randomUUID();
const defaultExpense = crypto.randomUUID();
const office = crypto.randomUUID();
const supplier = crypto.randomUUID();

const draftConfirmDoc = crypto.randomUUID();
const draftRejectDoc = crypto.randomUUID();
const postedDoc = crypto.randomUUID();
const claimDoc = crypto.randomUUID();
const twiceClaimedDoc = crypto.randomUUID();
const duplicateMatchedDoc = crypto.randomUUID();
const manualSourceDoc = crypto.randomUUID();
const backfillLiveDoc = crypto.randomUUID();
const invoicedWithDraftDoc = crypto.randomUUID();
const reversedThenDraftDoc = crypto.randomUUID();
const twoClaimsDoc = crypto.randomUUID();
const claimedWithDraftDoc = crypto.randomUUID();
const documents = [
  draftConfirmDoc, draftRejectDoc, postedDoc, claimDoc, twiceClaimedDoc,
  duplicateMatchedDoc, manualSourceDoc, backfillLiveDoc, invoicedWithDraftDoc,
  reversedThenDraftDoc, twoClaimsDoc, claimedWithDraftDoc,
];

const claimEvent = crypto.randomUUID();
const twoClaimsEvent = crypto.randomUUID();
const events = [claimEvent, twoClaimsEvent];

const today = new Date().toISOString().slice(0, 10);
let token = '';

/**
 * `confidence` is what decides draft vs posted. 0.5 is below the 0.85 gate, so
 * the route creates the journal and leaves it a draft — the majority path.
 */
const extracted = (reference: string, confidence: number) => ({
  documentType: 'receipt', vendorName: 'Waltons Stationery', date: today,
  referenceNumber: reference, currency: 'ZAR', subtotal: 1000, vatAmount: 150,
  vatRate: 15, totalAmount: 1150, lineItems: [], confidence,
  // The text the auto-post gate re-reads: one printed total, so only
  // `confidence` decides draft vs posted here.
  // Under a purchase title (K-072 round 20), so the gate lets the structured read post.
  rawText: 'Waltons Stationery\nTAX INVOICE\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00',
  warnings: [], extractionMethod: 'vlm',
});

async function seedDoc(id: string, confidence: number): Promise<void> {
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','receipt',$4::jsonb,'pending')`,
    [id, company, `k072r8-${id}.pdf`, JSON.stringify(extracted(`REC-${id.slice(0, 8)}`, confidence))],
  );
}

function call(
  route: (req: never, res: never) => Promise<unknown> | unknown,
  url: string,
  body: Record<string, unknown>,
  targetId?: string,
) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST', targetId);
  req.url = url;
  req.body = body;
  const result = response();
  return Promise.resolve(route(req as never, result.res as never)).then(() => result);
}

const receiptToJournal = (documentId: string) =>
  call(receiptRoute, '/api/accounting/receipt-to-journal', { documentId });
const documentAction = (id: string, action: string, data?: Record<string, unknown>) =>
  call(actionRoute, '/api/accounting/document-capture-action', { id, action, ...(data ? { data } : {}) });
const reverseJournal = (id: string) =>
  call(jeActionRoute, '/api/accounting/journal-entries-action', { id, action: 'reverse' });
const postExpense = (eventId: string, body: Record<string, unknown>) =>
  call(postExpenseRoute, `/api/accounting/capture/${eventId}/post-expense`, body, eventId);
const rejectClaimRoute = (claimId: string) =>
  call(approveRoute, `/api/accounting/expense-claims/${claimId}/approve`,
    { decision: 'reject', reason: 'Not a company expense' }, claimId);

function errorMessage(result: { state: { body: unknown } }): string {
  return (result.state.body as { error: { message: string } }).error.message;
}

async function postedAt(documentId: string): Promise<Date | null> {
  return (await pool.query('SELECT posted_at FROM captured_documents WHERE id=$1', [documentId]))
    .rows[0]?.posted_at ?? null;
}

async function journals(documentId: string): Promise<Array<{ id: string; status: string }>> {
  return (await pool.query(
    `SELECT id, status FROM gl_journal_entries
     WHERE company_id=$1 AND source_document_id=$2 ORDER BY created_at`,
    [company, documentId],
  )).rows as Array<{ id: string; status: string }>;
}

async function orphanLines(): Promise<number> {
  return (await pool.query(
    `SELECT COUNT(*)::int AS n FROM gl_journal_lines jl
      WHERE jl.company_id=$1
        AND NOT EXISTS (SELECT 1 FROM gl_journal_entries je WHERE je.id = jl.journal_entry_id)`,
    [company],
  )).rows[0].n as number;
}

async function purge(): Promise<void> {
  await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM expense_claim_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM expense_claims WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM capture_events WHERE id=ANY($1::uuid[])', [events]);
  await pool.query('DELETE FROM captured_documents WHERE id=ANY($1::uuid[])', [documents]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])',
    [[bank, vatInput, defaultExpense, office]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM payroll_employees WHERE id=$1', [employee]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K072r8 owner']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,
       employment_type,start_date,status)
     VALUES($1,$2,'K072R8-01','Kay','Zeven','permanent',CURRENT_DATE,'active')`,
    [employee, company],
  );
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_system_account,is_active)
     VALUES($1,$5,'K72R8B','K072r8 Bank','asset','bank','debit',true,true),
           ($2,$5,'1140','K072r8 VAT Input','asset','vat_input','debit',true,true),
           ($3,$5,'K72R8DE','K072r8 Default expense','expense','default_expense','debit',true,true),
           ($4,$5,'5100','K072r8 Office supplies','expense',NULL,'debit',false,true)`,
    [bank, vatInput, defaultExpense, office, company],
  );
  await pool.query('INSERT INTO suppliers(id,company_id,name,is_active) VALUES($1,$2,$3,true)',
    [supplier, company, 'Waltons Stationery']);
  clearSystemAccountCache(company);

  await seedDoc(draftConfirmDoc, 0.5);
  await seedDoc(draftRejectDoc, 0.5);
  await seedDoc(postedDoc, 0.95);
  await seedDoc(claimDoc, 0.95);
  await seedDoc(twiceClaimedDoc, 0.95);
  await seedDoc(duplicateMatchedDoc, 0.95);
  await seedDoc(manualSourceDoc, 0.95);
  await seedDoc(backfillLiveDoc, 0.95);
  await seedDoc(invoicedWithDraftDoc, 0.95);
  await seedDoc(reversedThenDraftDoc, 0.95);
  await seedDoc(twoClaimsDoc, 0.95);
  await seedDoc(claimedWithDraftDoc, 0.95);
  await pool.query(
    `INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'pwa','extracted',$3)`,
    [claimEvent, company, claimDoc],
  );
  await pool.query(
    `INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'pwa','extracted',$3)`,
    [twoClaimsEvent, company, twoClaimsDoc],
  );

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

describe('K-072 a DRAFT capture journal is not a posting', () => {
  it('confirm gives the claim back, discards the draft, and the re-post lands', async () => {
    const posted = await receiptToJournal(draftConfirmDoc);
    expect(posted.state.statusCode).toBe(200);
    expect(await journals(draftConfirmDoc)).toEqual([
      { id: expect.any(String), status: 'draft' },
    ]);
    expect(await postedAt(draftConfirmDoc)).not.toBeNull();

    // The button an operator actually reaches for. Before the release it was a
    // 400 naming a remedy — reverse the journal — that throws on a draft.
    const confirmed = await documentAction(draftConfirmDoc, 'confirm', { totalAmount: 1150 });
    expect(confirmed.state.statusCode).toBe(200);
    expect(await postedAt(draftConfirmDoc)).toBeNull();
    // The draft is GONE, not orphaned: nothing that was never in the ledger is
    // left behind for the unposted-journals close check to report.
    expect(await journals(draftConfirmDoc)).toEqual([]);
    expect(await orphanLines()).toBe(0);

    // And the document is postable again — one journal, not two.
    expect((await receiptToJournal(draftConfirmDoc)).state.statusCode).toBe(200);
    expect(await journals(draftConfirmDoc)).toHaveLength(1);
  });

  it('reject gives the claim back the same way', async () => {
    expect((await receiptToJournal(draftRejectDoc)).state.statusCode).toBe(200);
    expect(await postedAt(draftRejectDoc)).not.toBeNull();

    const rejected = await documentAction(draftRejectDoc, 'reject', { notes: 'Personal' });
    expect(rejected.state.statusCode).toBe(200);
    expect(await postedAt(draftRejectDoc)).toBeNull();
    expect(await journals(draftRejectDoc)).toEqual([]);

    // The terminal status still refuses the next post — the release hands back
    // a claim, it does not reopen a rejected document.
    const reposted = await receiptToJournal(draftRejectDoc);
    expect(reposted.state.statusCode).toBe(400);
    expect(errorMessage(reposted)).toContain('rejected');
  });
});

describe('K-072 a POSTED capture journal still holds the document', () => {
  it('refuses confirm while the journal is live, and allows it after the reversal', async () => {
    expect((await receiptToJournal(postedDoc)).state.statusCode).toBe(200);
    const [entry] = await journals(postedDoc);
    expect(entry!.status).toBe('posted');

    const refused = await documentAction(postedDoc, 'confirm');
    expect(refused.state.statusCode).toBe(400);
    expect(errorMessage(refused)).toContain('already posted to the ledger');
    // The refusal wrote nothing — the posted journal is untouched.
    expect(await journals(postedDoc)).toHaveLength(1);
    expect(await postedAt(postedDoc)).not.toBeNull();

    expect((await reverseJournal(entry!.id)).state.statusCode).toBe(200);
    expect(await postedAt(postedDoc)).toBeNull();
    expect((await documentAction(postedDoc, 'confirm')).state.statusCode).toBe(200);
  });
});

describe('K-072 a rejected expense claim hands its slip back', () => {
  it('releases the document the claim was holding', async () => {
    const claimed = await postExpense(claimEvent, { employeeId: employee, glAccountId: office });
    expect(claimed.state.statusCode).toBe(200);
    expect(await postedAt(claimDoc)).not.toBeNull();
    const claimId = (claimed.state.body as { data: { expenseClaim: { id: string } } })
      .data.expenseClaim.id;

    // While the claim is in flight the slip stays claimed: the release must
    // fail in BOTH directions, so confirm is still refused here.
    const early = await documentAction(claimDoc, 'confirm');
    expect(early.state.statusCode).toBe(400);
    expect(await postedAt(claimDoc)).not.toBeNull();

    expect((await rejectClaimRoute(claimId)).state.statusCode).toBe(200);
    expect(await postedAt(claimDoc)).toBeNull();
    expect((await documentAction(claimDoc, 'confirm')).state.statusCode).toBe(200);
  });
});

describe('K-072 the claim statement is a fence on its own', () => {
  it('refuses the second claim of one document without any lock held', async () => {
    // The four routes take `FOR UPDATE` and re-read before claiming, so the
    // route tests cannot tell whether `AND posted_at IS NULL` on the UPDATE is
    // doing anything. Called directly, twice, it is the only thing between the
    // two callers — deleting that predicate makes the second call succeed.
    expect(await claimCapturedDocumentForPosting(company, twiceClaimedDoc)).toBeNull();
    expect(await claimCapturedDocumentForPosting(company, twiceClaimedDoc)).toBe('already_posted');
  });
});

describe('K-072 the manual journal route is not a way past the fence', () => {
  const createJournal = (body: Record<string, unknown>) =>
    call(journalEntriesRoute, '/api/accounting/journal-entries', body);

  const lines = [
    { glAccountId: office, debit: 100, credit: 0 },
    { glAccountId: bank, debit: 0, credit: 100 },
  ];

  it('refuses a hand-made journal that claims a capture source', async () => {
    // `source` used to go straight into the INSERT. With
    // 'auto_expense_receipt' the row lands inside
    // `uq_gl_je_capture_source_document` (a 23505 returned as raw Postgres
    // text); with any other auto_* value it is a live journal against a
    // claimed document that neither the index nor the posting claim sees.
    const result = await createJournal({
      entryDate: today, description: 'K072r8 manual', source: 'auto_expense_receipt',
      sourceDocumentId: manualSourceDoc, lines,
    });
    expect(result.state.statusCode).toBe(400);
    expect(errorMessage(result)).toContain('manual');
    expect(await journals(manualSourceDoc)).toEqual([]);
  });

  it('still creates the ordinary manual journal', async () => {
    // The guard has to fail in both directions: this is what the UI sends.
    const result = await createJournal({
      entryDate: today, description: 'K072r8 manual ok', source: 'manual', lines,
    });
    expect(result.state.statusCode).toBe(200);
  });
});

describe("K-072 migration 672's backfill agrees with the release", () => {
  it('claims what the release holds and leaves a duplicate-flagged document postable', async () => {
    // `ai-invoice-pipeline`'s duplicate branch writes status='matched' and
    // `matched_invoice_id`, answers 409, and `withAuth` COMMITs it — while the
    // document itself produced nothing. The backfill used to claim those rows
    // on a third disjunct that appears in neither `refusalForPosting` nor the
    // release, so they were refused by all four routes and by both lifecycle
    // buttons, permanently, with nothing that could hand them back.
    //
    // The REAL migration file is executed, not a paraphrase of it — inside a
    // transaction that is rolled back, because the fixture database is shared
    // and an unscoped backfill would otherwise reach another run's rows.
    await pool.query(
      "UPDATE captured_documents SET status='matched', matched_invoice_id=$1 WHERE id=$2",
      [crypto.randomUUID(), duplicateMatchedDoc],
    );
    // A document that DID produce a live posting journal, with its claim
    // cleared inside the transaction — the backfill's job is to claim exactly
    // this one back.
    expect((await receiptToJournal(backfillLiveDoc)).state.statusCode).toBe(200);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE captured_documents SET posted_at = NULL WHERE id=ANY($1::uuid[])',
        [[duplicateMatchedDoc, backfillLiveDoc]],
      );
      // The migration's duplicate check scans gl_journal_entries GLOBALLY, as it
      // must in production — but the fixture database is shared with six other
      // worktrees, and a peer's duplicate would abort this file's transaction
      // for a reason that has nothing to do with this branch. Inside the same
      // rolled-back transaction, stand the OTHER companies' duplicate groups
      // down to one live row each; this company's rows are left exactly as the
      // sequence above built them, which is what the assertions read.
      await client.query(
        `UPDATE gl_journal_entries SET reversed_at = NOW()
          WHERE company_id <> $1 AND id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id, source_document_id ORDER BY id) AS rn
                FROM gl_journal_entries
               WHERE source_document_id IS NOT NULL
                 AND source = 'auto_expense_receipt'
                 AND reversed_at IS NULL
                 AND company_id <> $1
            ) ranked WHERE ranked.rn > 1
          )`,
        [company],
      );
      await client.query(readFileSync('scripts/migrations/sql/672_capture_posting_claim_fence.sql', 'utf8'));

      const claimed = await client.query(
        'SELECT id, posted_at FROM captured_documents WHERE id=ANY($1::uuid[])',
        [[duplicateMatchedDoc, backfillLiveDoc]],
      );
      const byId = new Map(claimed.rows.map((r) => [r.id as string, r.posted_at as Date | null]));
      // Produced nothing → still postable.
      expect(byId.get(duplicateMatchedDoc)).toBeNull();
      // Produced a live posting journal → claimed, as the release requires.
      expect(byId.get(backfillLiveDoc)).not.toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    expect(await postedAt(duplicateMatchedDoc)).toBeNull();
    expect((await receiptToJournal(duplicateMatchedDoc)).state.statusCode).toBe(200);
  });
});

describe('K-072 the release refuses BEFORE it writes anything', () => {
  it('keeps the draft journal of a document an uncancelled invoice still holds', async () => {
    // The state, built directly because no route can reach it now: a captured
    // document claimed by a supplier invoice, carrying a draft capture journal
    // as well. `releaseUnpostedCaptureClaim` must answer "no" from its own
    // liveness read — before the DELETE — because `withAuth` COMMITs the 4xx
    // that follows, and a refusal that has already deleted a journal is a
    // refusal that changed the books.
    await pool.query(
      `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,
         subtotal,tax_amount,total_amount,status,source_document_id,created_by)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,1000,150,1150,'approved',$5,$6)`,
      [company, supplier, `K072R8-${invoicedWithDraftDoc.slice(0, 8)}`, today, invoicedWithDraftDoc, user],
    );
    const draft = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,
         status,source,source_document_id,created_by)
       VALUES($1,$2,$3,$4,'K072r8 stray draft','draft','auto_expense_receipt',$5,$6)`,
      [draft, company, `K072R8-${draft.slice(0, 8)}`, today, invoicedWithDraftDoc, user],
    );
    await pool.query("UPDATE captured_documents SET posted_at = NOW() WHERE id=$1", [invoicedWithDraftDoc]);

    const refused = await documentAction(invoicedWithDraftDoc, 'confirm');
    expect(refused.state.statusCode).toBe(400);
    expect(await postedAt(invoicedWithDraftDoc)).not.toBeNull();
    expect(await journals(invoicedWithDraftDoc)).toEqual([{ id: draft, status: 'draft' }]);
  });
});

describe('K-072 the release discards drafts and nothing else', () => {
  it('leaves the reversed posted journal standing when it hands the claim back', async () => {
    // Reversal, then a re-post the auto-post gate leaves as a draft: the
    // document now carries a POSTED (reversed) journal and a DRAFT one. The
    // reversed original is not live — so the release proceeds — and it is still
    // an entry in the ledger that a VAT201 has already carried. Only the draft
    // may go: `AND status = 'draft'` on the DELETE is what says so.
    expect((await receiptToJournal(reversedThenDraftDoc)).state.statusCode).toBe(200);
    const [original] = await journals(reversedThenDraftDoc);
    expect((await reverseJournal(original!.id)).state.statusCode).toBe(200);

    await pool.query(
      `UPDATE captured_documents
          SET extracted_data = jsonb_set(extracted_data, '{confidence}', '0.5')
        WHERE id=$1 AND company_id=$2`,
      [reversedThenDraftDoc, company],
    );
    expect((await receiptToJournal(reversedThenDraftDoc)).state.statusCode).toBe(200);
    expect((await journals(reversedThenDraftDoc)).map((j) => j.status).sort())
      .toEqual(['draft', 'posted']);

    expect((await documentAction(reversedThenDraftDoc, 'confirm')).state.statusCode).toBe(200);
    expect(await journals(reversedThenDraftDoc)).toEqual([
      { id: original!.id, status: 'posted' },
    ]);
  });
});

describe('K-072 a slip on a second live claim is not handed back', () => {
  it('keeps the claim while another submitted claim still references the document', async () => {
    const first = await postExpense(twoClaimsEvent, { employeeId: employee, glAccountId: office });
    expect(first.state.statusCode).toBe(200);
    const firstClaimId = (first.state.body as { data: { expenseClaim: { id: string } } })
      .data.expenseClaim.id;

    // A second claim carrying the same slip. `post-expense` cannot build this
    // one (the document is already claimed), so it is written directly — the
    // point is what the RELEASE does when one of two claims retires.
    const secondClaim = crypto.randomUUID();
    await pool.query(
      `INSERT INTO expense_claims(id,company_id,employee_id,claim_number,claim_date,status,created_by)
       VALUES($1,$2,$3,$4,$5,'submitted',$6)`,
      [secondClaim, company, employee, `K072R8-CL-${secondClaim.slice(0, 6)}`, today, user],
    );
    await pool.query(
      `INSERT INTO expense_claim_lines(id,claim_id,company_id,line_date,description,amount,vat_amount,
         gl_account_id,source_document_id)
       VALUES(gen_random_uuid(),$1,$2,$3,'K072r8 second claim',1150,150,$4,$5)`,
      [secondClaim, company, today, office, twoClaimsDoc],
    );

    expect((await rejectClaimRoute(firstClaimId)).state.statusCode).toBe(200);
    // Still claimed: the other claim is live, and the slip belongs to it.
    expect(await postedAt(twoClaimsDoc)).not.toBeNull();
    expect((await documentAction(twoClaimsDoc, 'confirm')).state.statusCode).toBe(400);
  });
});

describe('K-072 an in-flight claim refuses before the release writes', () => {
  it('keeps the draft journal of a document a submitted claim still references', async () => {
    // The claim twin of the supplier-invoice case above, and built the same
    // way for the same reason: `post-expense` will not claim a document that
    // already carries a capture journal, so the state is written directly. The
    // liveness read must see the live CLAIM — not just the journals and
    // invoices — or the 4xx that follows deletes a journal on its way out.
    const stray = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,
         status,source,source_document_id,created_by)
       VALUES($1,$2,$3,$4,'K072r8 claimed draft','draft','auto_expense_receipt',$5,$6)`,
      [stray, company, `K072R8-${stray.slice(0, 8)}`, today, claimedWithDraftDoc, user],
    );
    const liveClaim = crypto.randomUUID();
    await pool.query(
      `INSERT INTO expense_claims(id,company_id,employee_id,claim_number,claim_date,status,created_by)
       VALUES($1,$2,$3,$4,$5,'submitted',$6)`,
      [liveClaim, company, employee, `K072R8-CL-${liveClaim.slice(0, 6)}`, today, user],
    );
    await pool.query(
      `INSERT INTO expense_claim_lines(id,claim_id,company_id,line_date,description,amount,vat_amount,
         gl_account_id,source_document_id)
       VALUES(gen_random_uuid(),$1,$2,$3,'K072r8 live claim',1150,150,$4,$5)`,
      [liveClaim, company, today, office, claimedWithDraftDoc],
    );
    await pool.query('UPDATE captured_documents SET posted_at = NOW() WHERE id=$1', [claimedWithDraftDoc]);

    const refused = await documentAction(claimedWithDraftDoc, 'confirm');
    expect(refused.state.statusCode).toBe(400);
    expect(await postedAt(claimedWithDraftDoc)).not.toBeNull();
    expect(await journals(claimedWithDraftDoc)).toEqual([{ id: stray, status: 'draft' }]);
  });
});

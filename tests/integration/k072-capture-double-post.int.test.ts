// The capture post paths under CONCURRENCY, against the real ledger.
//
// Both routes read a status, refuse on the settled value, and stamp the settled
// value only at the very end of the request. That is a check-then-act window:
// two concurrent requests — the UI double-click the guard was added for, or a
// client retry — both read 'pending', both pass, and both create AND AUTO-POST
// a journal against the same source document. Nothing downstream catches it:
// idx_gl_je_source_document (409_capture_and_evidence_ledger.sql:91) is a plain
// index, not a unique one, so the ledger ends up with the expense and the bank
// credit doubled.
//
// The fix is a FOR UPDATE row lock taken before the check, so the second
// request blocks and then reads the settled status. This file drives the two
// requests concurrently on separate pool clients and asserts the OUTCOME —
// exactly one journal — rather than the presence of the lock in the source.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import postExpenseRoute from '../../pages/api/accounting/capture/[id]/post-expense';
import receiptRoute from '../../pages/api/accounting/receipt-to-journal';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const vatInput = crypto.randomUUID();
const defaultExpense = crypto.randomUUID();
const office = crypto.randomUUID();

const raceDoc = crypto.randomUUID();
const retryDoc = crypto.randomUUID();
const eventDoc = crypto.randomUUID();
const unconfiguredDoc = crypto.randomUUID();
// One document per cross-route order, plus one for the concurrent pair.
const journalFirstDoc = crypto.randomUUID();
const inboxFirstDoc = crypto.randomUUID();
const crossRaceDoc = crypto.randomUUID();
const documents = [
  raceDoc, retryDoc, eventDoc, unconfiguredDoc,
  journalFirstDoc, inboxFirstDoc, crossRaceDoc,
];
const raceEvent = crypto.randomUUID();
const journalFirstEvent = crypto.randomUUID();
const inboxFirstEvent = crypto.randomUUID();
const crossRaceEvent = crypto.randomUUID();
const events = [raceEvent, journalFirstEvent, inboxFirstEvent, crossRaceEvent];

const today = new Date().toISOString().slice(0, 10);
let token = '';

const extracted = () => ({
  documentType: 'receipt', vendorName: 'Waltons Stationery', date: today,
  referenceNumber: 'REC-K072C', currency: 'ZAR', subtotal: 1000, vatAmount: 150,
  vatRate: 15, totalAmount: 1150, lineItems: [], rawText: '', confidence: 0.9,
  warnings: [], extractionMethod: 'vlm',
});

async function seedDoc(id: string): Promise<void> {
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','receipt',$4::jsonb,'pending')`,
    [id, company, `k072c-${id}.pdf`, JSON.stringify(extracted())],
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

/** The anonymous petty-cash branch of the second post route. */
function postExpense(eventId: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST', eventId);
  req.url = `/api/accounting/capture/${eventId}/post-expense`;
  req.body = { glAccountId: office };
  const result = response();
  return postExpenseRoute(req, result.res).then(() => result);
}

function post(documentId: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  req.url = '/api/accounting/receipt-to-journal';
  req.body = { documentId };
  const result = response();
  return receiptRoute(req, result.res).then(() => result);
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

async function purge(): Promise<void> {
  await pool.query('DELETE FROM capture_events WHERE id=ANY($1::uuid[])', [events]);
  await pool.query('DELETE FROM captured_documents WHERE id=ANY($1::uuid[])', [documents]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])',
    [[bank, vatInput, defaultExpense, office]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K072C owner']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_system_account,is_active)
     VALUES($1,$5,'K072CB','K072C Bank','asset','bank','debit',true,true),
           ($2,$5,'1140','K072C VAT Input','asset','vat_input','debit',true,true),
           ($3,$5,'K072CDE','K072C Default expense','expense','default_expense','debit',true,true),
           ($4,$5,'5100','K072C Office supplies','expense',NULL,'debit',false,true)`,
    [bank, vatInput, defaultExpense, office, company],
  );
  clearSystemAccountCache(company);
  await seedDoc(raceDoc);
  await seedDoc(retryDoc);
  await seedEvent(eventDoc, raceEvent);
  await seedDoc(unconfiguredDoc);
  await seedEvent(journalFirstDoc, journalFirstEvent);
  await seedEvent(inboxFirstDoc, inboxFirstEvent);
  await seedEvent(crossRaceDoc, crossRaceEvent);

  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

// 60s, explicitly: the concurrency cases above burn up to 5s of `lock_timeout`
// each, and the default 10s hook budget was exceeded on a loaded shared fixture
// database — the file passed every assertion and still exited 1, leaving its
// rows behind for the next run to trip over.
afterAll(async () => {
  try {
    await purge();
  } finally {
    clearSystemAccountCache();
    await pool.end();
  }
}, 60_000);

describe('K-072 a double-click cannot post the same receipt twice', () => {
  it('serialises two concurrent posts of one document into one journal', async () => {
    const [first, second] = await Promise.all([post(raceDoc), post(raceDoc)]);

    const codes = [first.state.statusCode, second.state.statusCode].sort();
    expect(codes).toEqual([200, 400]);

    // The outcome that matters: one journal, and a bank credit that still
    // matches the R1 150 the statement will show. Two journals would double it.
    expect(await journalCount(raceDoc)).toBe(1);
    expect(await bankCredit(raceDoc)).toBe(1150);

    const refused = first.state.statusCode === 400 ? first : second;
    const message = (refused.state.body as { error: { message: string } }).error.message;
    expect(message).toMatch(/already posted|retry in a moment/i);

    expect((await pool.query('SELECT status FROM captured_documents WHERE id=$1', [raceDoc]))
      .rows[0].status).toBe('matched');
  });

  it('refuses a sequential retry of a document already posted', async () => {
    expect((await post(retryDoc)).state.statusCode).toBe(200);
    const again = await post(retryDoc);
    expect(again.state.statusCode).toBe(400);
    expect((again.state.body as { error: { message: string } }).error.message)
      .toContain('already posted');
    expect(await journalCount(retryDoc)).toBe(1);
    expect(await bankCredit(retryDoc)).toBe(1150);
  });
});

describe('K-072 the capture post-expense route serialises the same way', () => {
  it('posts one petty-cash journal for two concurrent posts of one event', async () => {
    const [first, second] = await Promise.all([postExpense(raceEvent), postExpense(raceEvent)]);

    const codes = [first.state.statusCode, second.state.statusCode].sort();
    expect(codes).toEqual([200, 400]);
    expect(await journalCount(eventDoc)).toBe(1);
    expect(await bankCredit(eventDoc)).toBe(1150);
    expect((await pool.query('SELECT status FROM capture_events WHERE id=$1', [raceEvent]))
      .rows[0].status).toBe('posted');
  });
});

describe('K-072 a missing system account is still a configuration answer', () => {
  it('answers 400 and names the remedy when the VAT Input role is empty', async () => {
    // The `catch` around the three role lookups now rethrows anything that is
    // not a MissingSystemAccountError, so that a transient database fault is no
    // longer reported to the operator as "set up your default accounts". This
    // pins the half that must NOT change: an actually-empty role still refuses
    // with the actionable message rather than a 500.
    await pool.query('UPDATE gl_accounts SET account_subtype = NULL WHERE id=$1 AND company_id=$2',
      [vatInput, company]);
    clearSystemAccountCache(company);
    try {
      const result = await post(unconfiguredDoc);
      expect(result.state.statusCode).toBe(400);
      expect((result.state.body as { error: { message: string } }).error.message)
        .toContain('Default accounts not configured');
      expect(await journalCount(unconfiguredDoc)).toBe(0);
    } finally {
      await pool.query("UPDATE gl_accounts SET account_subtype = 'vat_input' WHERE id=$1 AND company_id=$2",
        [vatInput, company]);
      clearSystemAccountCache(company);
    }
  });
});

describe('K-072 one receipt cannot be posted through BOTH routes', () => {
  // Not a race. `post-expense` never read `captured_documents.status` at all,
  // so posting a receipt to a journal and then opening the same document in the
  // capture inbox — two ordinary steps, in sequence, by one operator — wrote
  // two `auto_expense_receipt` journals against one `source_document_id`:
  // double expense, double bank credit, double input-tax claim. A row lock does
  // not close that; a status check does.
  it('refuses the capture inbox after receipt-to-journal has posted', async () => {
    expect((await post(journalFirstDoc)).state.statusCode).toBe(200);

    const second = await postExpense(journalFirstEvent);
    expect(second.state.statusCode).toBe(400);
    expect((second.state.body as { error: { message: string } }).error.message)
      .toContain('already posted');

    expect(await journalCount(journalFirstDoc)).toBe(1);
    expect(await bankCredit(journalFirstDoc)).toBe(1150);
    expect((await pool.query('SELECT status FROM capture_events WHERE id=$1', [journalFirstEvent]))
      .rows[0].status).not.toBe('posted');
  });

  it('refuses receipt-to-journal after the capture inbox has posted', async () => {
    expect((await postExpense(inboxFirstEvent)).state.statusCode).toBe(200);

    const second = await post(inboxFirstDoc);
    expect(second.state.statusCode).toBe(400);
    expect((second.state.body as { error: { message: string } }).error.message)
      .toContain('already posted');

    expect(await journalCount(inboxFirstDoc)).toBe(1);
    expect(await bankCredit(inboxFirstDoc)).toBe(1150);
  });

  it('serialises the two routes when they run concurrently', async () => {
    const [a, b] = await Promise.all([post(crossRaceDoc), postExpense(crossRaceEvent)]);

    const codes = [a.state.statusCode, b.state.statusCode].sort();
    expect(codes).toEqual([200, 400]);
    expect(await journalCount(crossRaceDoc)).toBe(1);
    expect(await bankCredit(crossRaceDoc)).toBe(1150);
    expect((await pool.query('SELECT status FROM captured_documents WHERE id=$1', [crossRaceDoc]))
      .rows[0].status).toBe('matched');
  });
});

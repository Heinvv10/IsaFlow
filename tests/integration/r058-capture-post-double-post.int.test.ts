/**
 * R-058. The two capture POSTING routes read `capture_events.status` with a
 * plain SELECT, refused in JavaScript when it was already `'posted'`, and then
 * closed with an `UPDATE ... SET status = 'posted'` carrying NO status
 * predicate:
 *
 *   pages/api/accounting/capture/[id]/post-expense.ts  → expense claim / GL journal
 *   pages/api/accounting/capture/[id]/post.ts          → supplier_invoices INSERT
 *
 * Two concurrent requests both read a non-posted status, both passed the check
 * and both posted — one captured document, two journals or two accruals.
 *
 * Proved by OUTCOME (journals, claims and invoices actually written), under two
 * genuinely concurrent requests AND two sequential attempts. The sequential case
 * matters on its own: a check-then-act can also be defeated without concurrency
 * if the closing UPDATE is ever skipped.
 *
 * The guard is also proved in the OTHER direction: a legitimate first post
 * succeeds on both routes, and an event whose earlier post failed hard (rolled
 * back) is still retryable rather than being stuck 'posted' with no journal.
 *
 * Round 2 adds the rest of the class. The guard reads a column THREE handlers
 * write, and refusing only the literal `'posted'` left the other terminal state
 * postable:
 *
 *   - post-after-DISCARD: no race at all — discard a captured bill, post it
 *     anyway. Refused now by the postable ALLOW-list.
 *   - discard-after-POST, sequentially and concurrently: `discard.ts` took no
 *     lock and its UPDATE carried no status predicate, so a discard queued
 *     behind a post landed after it and reset the status the post guard reads.
 *   - the lock's own 409: another transaction holding the row past the 5s
 *     `lock_timeout`.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import postExpense from '../../pages/api/accounting/capture/[id]/post-expense';
import post from '../../pages/api/accounting/capture/[id]/post';
import discard from '../../pages/api/accounting/capture/[id]/discard';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const employee = crypto.randomUUID();
const supplier = crypto.randomUUID();
let adminToken = '';

const RECEIPT = {
  documentType: 'receipt',
  vendorName: 'R058 Fuel Stop',
  date: '2026-04-10',
  totalAmount: 115,
  subtotal: 100,
  vatAmount: 15,
  vatRate: 15,
  confidence: 0.95,
};

const BILL = {
  documentType: 'invoice',
  vendorName: 'R058 Supplier',
  date: '2026-04-10',
  referenceNumber: 'R058-INV-1',
  totalAmount: 1150,
  subtotal: 1000,
  vatAmount: 150,
  vatRate: 15,
  confidence: 0.99,
  // buildInvoiceFromExtraction and computePipelineConfidence read `.length` on
  // both of these without a guard — absent, the route 500s before it reaches
  // anything this test is about.
  lineItems: [],
  warnings: [],
};

/**
 * A bill amount unique to one test. `decide()`'s duplicate step also matches
 * FUZZILY — same supplier, near amount, near date — so two bill tests sharing
 * an amount would block the second as a duplicate and prove nothing about the
 * lock.
 */
function bill(total: number) {
  return { totalAmount: total, subtotal: total / 1.15, vatAmount: total - total / 1.15 };
}

/** One extracted document + one extracted capture event ready to post. */
async function seedEvent(
  extracted: Record<string, unknown>,
  tag: string,
  overrides: Record<string, unknown> = {},
) {
  const documentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,extracted_data,status)
     VALUES($1,$2,$3,'pdf',$4::jsonb,'pending')`,
    [documentId, company, `r058-${tag}.pdf`,
      JSON.stringify({ ...extracted, referenceNumber: `R058-${tag}`, ...overrides })],
  );
  await pool.query(
    `INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'api','extracted',$3)`,
    [eventId, company, documentId],
  );
  return { eventId, documentId };
}

function call(handler: typeof postExpense, eventId: string, body: unknown) {
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/capture/x';
  req.query = { id: eventId };
  req.body = body;
  const result = response();
  return handler(req as never, result.res).then(() => result);
}

/** Journals actually written against a captured document, whatever their status. */
async function journalsFor(documentId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source_document_id=$2',
    [company, documentId],
  );
  return rows[0].n as number;
}

async function claimsFor(documentId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT ecl.claim_id)::int AS n FROM expense_claim_lines ecl
      WHERE ecl.company_id=$1 AND ecl.source_document_id=$2`,
    [company, documentId],
  );
  return rows[0].n as number;
}

async function invoicesFor(documentId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM supplier_invoices WHERE company_id=$1 AND source_document_id=$2',
    [company, documentId],
  );
  return rows[0].n as number;
}

/** Hold the event row from an INDEPENDENT transaction, past the 5s lock_timeout. */
async function holdEventRow(eventId: string): Promise<() => Promise<void>> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM capture_events WHERE id=$1 FOR UPDATE', [eventId]);
  return async () => {
    await client.query('ROLLBACK');
    client.release();
  };
}

async function statusOf(eventId: string): Promise<string> {
  const { rows } = await pool.query('SELECT status FROM capture_events WHERE id=$1', [eventId]);
  return rows[0].status as string;
}

async function account(code: string, name: string, type: string, subtype: string, normal: string) {
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true)`,
    [company, code, name, type, subtype, normal],
  );
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'R058 capture fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [admin, `${admin}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)',
    [company, admin, 'admin']);

  const y = 2026;
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'R058 FY',1,$2,$3,$4,'open')`,
    [company, y, `${y}-01-01`, `${y}-12-31`],
  );

  await account('6000', 'R058 Expense', 'expense', 'default_expense', 'debit');
  await account('1000', 'R058 Bank', 'asset', 'bank', 'debit');
  await account('1300', 'R058 VAT Input', 'asset', 'vat_input', 'debit');
  await account('2000', 'R058 Payables', 'liability', 'payable', 'credit');
  clearSystemAccountCache(company);

  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date)
     VALUES($1,$2,'R058-E1','Ray','Tester','2026-01-01')`,
    [employee, company],
  );
  await pool.query('INSERT INTO suppliers(id,company_id,name,is_active) VALUES($1,$2,$3,true)',
    [supplier, company, 'R058 Supplier']);

  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(secret);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE expense_claims SET posted_je_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM expense_claim_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM expense_claims WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM capture_events WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

// ── post-expense, anonymous direct-GL path ─────────────────────────────────

it('post-expense: a legitimate first post writes exactly one journal', async () => {
  const { eventId, documentId } = await seedEvent(RECEIPT, 'seq-gl');
  const first = await call(postExpense, eventId, {});
  expect(first.state.statusCode).toBe(200);
  expect(await journalsFor(documentId)).toBe(1);
  expect(await statusOf(eventId)).toBe('posted');
});

it('post-expense: a SEQUENTIAL second attempt is refused and writes nothing', async () => {
  const { eventId, documentId } = await seedEvent(RECEIPT, 'seq-gl-2');
  await call(postExpense, eventId, {});
  expect(await journalsFor(documentId)).toBe(1);

  const second = await call(postExpense, eventId, {});
  expect(second.state.statusCode).toBe(400);
  // withAuth COMMITs any response below 500, so a refusal that ran after a
  // write would leave that write behind. Nothing new may exist.
  expect(await journalsFor(documentId)).toBe(1);
});

it('post-expense: two CONCURRENT requests post ONE journal, not two', async () => {
  const { eventId, documentId } = await seedEvent(RECEIPT, 'race-gl');
  const [a, b] = await Promise.all([call(postExpense, eventId, {}), call(postExpense, eventId, {})]);
  const codes = [a.state.statusCode, b.state.statusCode].sort();
  expect(codes).toEqual([200, 400]);
  expect(await journalsFor(documentId)).toBe(1);
});

it('post-expense: the one journal balances at the receipt total', async () => {
  const { eventId, documentId } = await seedEvent(RECEIPT, 'balance-gl');
  await call(postExpense, eventId, {});
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(jl.debit),0)::float8 AS debit, COALESCE(SUM(jl.credit),0)::float8 AS credit
       FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id=$1 AND je.source_document_id=$2`,
    [company, documentId],
  );
  expect(rows[0].debit).toBeCloseTo(115, 2);
  expect(rows[0].credit).toBeCloseTo(115, 2);
});

// ── post-expense, employee expense-claim path ──────────────────────────────

it('post-expense: two CONCURRENT employee posts create ONE expense claim', async () => {
  const { eventId, documentId } = await seedEvent(RECEIPT, 'race-claim');
  const body = { employeeId: employee };
  const [a, b] = await Promise.all([call(postExpense, eventId, body), call(postExpense, eventId, body)]);
  const codes = [a.state.statusCode, b.state.statusCode].sort();
  expect(codes).toEqual([200, 400]);
  expect(await claimsFor(documentId)).toBe(1);
});

// ── the guard must fail in BOTH directions ─────────────────────────────────

it('post-expense: an event whose post failed hard is still retryable', async () => {
  const { eventId, documentId } = await seedEvent(RECEIPT, 'retry');

  // An employeeId that satisfies the UUID cast but no employee row: createClaim
  // violates the FK, withErrorHandler answers 500, withAuth ROLLBACKs. Nothing
  // — including the 'posted' stamp — may survive.
  const failed = await call(postExpense, eventId, { employeeId: crypto.randomUUID() });
  expect(failed.state.statusCode).toBeGreaterThanOrEqual(500);
  expect(await statusOf(eventId)).toBe('extracted');
  expect(await claimsFor(documentId)).toBe(0);
  expect(await journalsFor(documentId)).toBe(0);

  // …and the retry succeeds rather than hitting a permanent 'already posted'.
  const retry = await call(postExpense, eventId, {});
  expect(retry.state.statusCode).toBe(200);
  expect(await journalsFor(documentId)).toBe(1);
});

// ── post.ts, the supplier-invoice sibling ──────────────────────────────────

it('post: a legitimate first post creates exactly one supplier invoice', async () => {
  const { eventId, documentId } = await seedEvent(BILL, 'seq-bill', bill(1150));
  const first = await call(post as typeof postExpense, eventId, {});
  expect(first.state.statusCode).toBe(200);
  expect(await invoicesFor(documentId)).toBe(1);
});

it('post: two CONCURRENT requests accrue the bill ONCE', async () => {
  const { eventId, documentId } = await seedEvent(BILL, 'race-bill', bill(2350));
  const [a, b] = await Promise.all([
    call(post as typeof postExpense, eventId, {}),
    call(post as typeof postExpense, eventId, {}),
  ]);
  const codes = [a.state.statusCode, b.state.statusCode].sort();
  expect(codes).toEqual([200, 400]);
  expect(await invoicesFor(documentId)).toBe(1);
});

it('post: a SEQUENTIAL second attempt is refused and accrues nothing more', async () => {
  const { eventId, documentId } = await seedEvent(BILL, 'seq-bill-2', bill(4750));
  await call(post as typeof postExpense, eventId, {});
  expect(await invoicesFor(documentId)).toBe(1);

  const second = await call(post as typeof postExpense, eventId, {});
  expect(second.state.statusCode).toBe(400);
  expect(await invoicesFor(documentId)).toBe(1);
});

// ── the guard reads a column three handlers write ──────────────────────────

it('post: a DISCARDED event is refused — no race needed', async () => {
  const { eventId, documentId } = await seedEvent(BILL, 'discarded-bill', bill(6150));

  const dropped = await call(discard as typeof postExpense, eventId, { reason: 'wrong company' });
  expect(dropped.state.statusCode).toBe(200);
  expect(await statusOf(eventId)).toBe('discarded');

  // Before the postable allow-list this returned 200 and accrued the bill to
  // payables: the refusal named `'posted'` and nothing else.
  const posted = await call(post as typeof postExpense, eventId, {});
  expect(posted.state.statusCode).toBe(400);
  expect(await invoicesFor(documentId)).toBe(0);
  expect(await statusOf(eventId)).toBe('discarded');
});

it('post-expense: a DISCARDED event creates no expense claim', async () => {
  const { eventId, documentId } = await seedEvent(RECEIPT, 'discarded-claim');
  await call(discard as typeof postExpense, eventId, {});

  const posted = await call(postExpense, eventId, { employeeId: employee });
  expect(posted.state.statusCode).toBe(400);
  // expense_claim_lines carries only a NON-unique index on source_document_id,
  // so this path has no database backstop — the guard is the whole defence.
  expect(await claimsFor(documentId)).toBe(0);
  expect(await journalsFor(documentId)).toBe(0);
});

it('discard: a POSTED event cannot be discarded back into a postable state', async () => {
  const { eventId, documentId } = await seedEvent(RECEIPT, 'discard-after-post');
  expect((await call(postExpense, eventId, { employeeId: employee })).state.statusCode).toBe(200);
  expect(await claimsFor(documentId)).toBe(1);

  const dropped = await call(discard as typeof postExpense, eventId, {});
  expect(dropped.state.statusCode).toBe(400);
  expect(await statusOf(eventId)).toBe('posted');

  // …and the event is therefore still not re-postable: this sequence used to
  // produce a SECOND expense claim for one receipt.
  const again = await call(postExpense, eventId, { employeeId: employee });
  expect(again.state.statusCode).toBe(400);
  expect(await claimsFor(documentId)).toBe(1);
});

it('discard CONCURRENT with post never leaves a posted bill on a discarded event', async () => {
  const { eventId, documentId } = await seedEvent(BILL, 'race-discard', bill(7350));
  const [p, d] = await Promise.all([
    call(post as typeof postExpense, eventId, {}),
    call(discard as typeof postExpense, eventId, {}),
  ]);
  expect([p.state.statusCode, d.state.statusCode].sort()).toEqual([200, 400]);

  // Whichever won, the ledger and the inbox agree: an accrual exists if and
  // only if the event reads 'posted'.
  const status = await statusOf(eventId);
  expect(await invoicesFor(documentId)).toBe(status === 'posted' ? 1 : 0);
  expect(['posted', 'discarded']).toContain(status);
});

// ── the guard must still fail in the OTHER direction ───────────────────────

it('discard: an extracted event is still discardable', async () => {
  const { eventId } = await seedEvent(RECEIPT, 'discard-ok');
  const dropped = await call(discard as typeof postExpense, eventId, { reason: 'duplicate scan' });
  expect(dropped.state.statusCode).toBe(200);
  expect(await statusOf(eventId)).toBe('discarded');
});

// ── the lock's own 409 branch ──────────────────────────────────────────────

it('post-expense: answers 409 when another transaction holds the event', async () => {
  const { eventId, documentId } = await seedEvent(RECEIPT, 'locked');
  const release = await holdEventRow(eventId);
  try {
    const blocked = await call(postExpense, eventId, {});
    expect(blocked.state.statusCode).toBe(409);
    expect(await journalsFor(documentId)).toBe(0);
  } finally {
    await release();
  }

  // The 409 is retryable, not terminal: once the holder lets go it posts.
  const retry = await call(postExpense, eventId, {});
  expect(retry.state.statusCode).toBe(200);
  expect(await journalsFor(documentId)).toBe(1);
}, 30_000);

it('discard: answers 409 when another transaction holds the event', async () => {
  const { eventId } = await seedEvent(RECEIPT, 'locked-discard');
  const release = await holdEventRow(eventId);
  try {
    const blocked = await call(discard as typeof postExpense, eventId, {});
    expect(blocked.state.statusCode).toBe(409);
    expect(await statusOf(eventId)).toBe('extracted');
  } finally {
    await release();
  }
}, 30_000);

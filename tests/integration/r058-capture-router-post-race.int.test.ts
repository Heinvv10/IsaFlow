/**
 * R-058 round 4 (R-071, fixed here). `captureRouterService.routeEvent`'s
 * post-extraction status writes were themselves UNPREDICATED
 * (`WHERE id AND company_id` only). `capture_events.extracted_data`'s sibling
 * column, `captured_documents.extracted_data`, is written in an earlier,
 * separate statement — so a request lands in the ms-wide window where
 * `status = 'extracting'` (postable) WITH data already present, passes the
 * post routes' checks, and completes. `routeEvent` then finishes and its
 * unpredicated write silently reverted the event from `'posted'` back to
 * `'extracted'` — postable again — with no race needed on a SECOND call.
 * Measured before this fix: an employee expense claim went 1 → 2.
 *
 * Fix: the three writes `routeEvent` makes after extraction (`captureRouterService.ts`)
 * now carry `AND status = 'extracting'` and check their row count. A `routeEvent`
 * that loses the race to a post is a no-op on `capture_events` (logged), not a
 * silent revert.
 *
 * The rival write below intercepts the REAL `sql` call `routeEvent` makes —
 * not a replay of the statement — so this is the real interleave, same
 * technique as `k122b-portal-token-race.int.test.ts`.
 *
 * Round 5 adds the rest of the class, found by blind review of round 4:
 *
 *   - MEDIUM: the FIRST write ('received' → 'extracting') was also
 *     unpredicated. `captured_documents.extracted_data` defaults to `'{}'`
 *     (migration 233) — truthy in JS — so `post-expense.ts`'s
 *     `!extracted_data` refusal never fires on a fresh, un-extracted event. A
 *     post at 'received' succeeds from the empty default, and an unpredicated
 *     first write then reverted that 'posted' event back to 'extracting'
 *     (postable) with no race needed on a second post. Fixed by predicating
 *     that write `AND status = 'received'` too.
 *   - LOW-1: the two predicates round 4 didn't exercise (the no-data
 *     'extracted' branch and the 'failed' branch) had no test that fails when
 *     removed. Pinned below via discard-during-extraction, which is the
 *     legitimate way to land a status OTHER than 'extracting' underneath
 *     those writes.
 *   - LOW-2: the `captured_documents` write in the with-data branch used to
 *     run BEFORE the predicated `capture_events` write, so a "dropped" result
 *     still landed half of itself — rewriting a POSTED event's document
 *     (status + extracted_data) even though the event write was correctly
 *     refused. Fixed by reordering: the event transition is claimed FIRST,
 *     and `captured_documents` is written only if that claim succeeds.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';

let beforeExtractedWrite: (() => Promise<void>) | null = null;
/**
 * Failure injection for round 6. `routeEvent` has no transaction, so which of
 * its two writes fails decides which status the event is left in when the
 * catch runs — 'extracting' or 'extracted'. Both must end 'failed' with the
 * error recorded.
 */
let failWrite: 'doc' | 'event' | null = null;

vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    const isExtractedWrite = /UPDATE\s+capture_events/.test(text)
      && /SET\s+status\s*=\s*'extracted',/.test(text)
      && /document_category/.test(text);
    const isDocWrite = /UPDATE\s+captured_documents/.test(text) && /extracted_data\s*=/.test(text);
    if (failWrite === 'event' && isExtractedWrite) {
      failWrite = null;
      return Promise.reject(new Error('r058f event write failure'));
    }
    if (failWrite === 'doc' && isDocWrite) {
      failWrite = null;
      return Promise.reject(new Error('r058f document write failure'));
    }
    if (beforeExtractedWrite && isExtractedWrite) {
      const hook = beforeExtractedWrite;
      beforeExtractedWrite = null;
      return hook().then(() => original.sql(strings, ...values));
    }
    return original.sql(strings, ...values);
  };
  return { ...original, sql };
});
vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchRawBytes: async () => ({ buffer: Buffer.from('%PDF-race'), mimeType: 'application/pdf' }),
}));

/**
 * Extraction control for LOW-1: `mode` picks which branch `routeEvent` takes
 * (data / null / OCR throws), `hold` — when set — pauses `extractFromPdf`
 * so a test can land a discard while the event sits at `'extracting'`, the
 * legitimate (non-race) way to have a status other than `'extracting'`
 * underneath the two post-extraction writes round 4 left unpinned.
 */
const ext = vi.hoisted(() => ({
  mode: 'data' as 'data' | 'null' | 'throw',
  hold: null as Promise<void> | null,
}));
vi.mock('@/modules/accounting/services/core/ocrService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractFromPdf: async () => {
    if (ext.hold) await ext.hold;
    if (ext.mode === 'throw') throw new Error('r058e OCR failure');
    if (ext.mode === 'null') return null;
    return EXTRACTED;
  },
}));

import { routeEvent } from '@/modules/accounting/services/capture/captureRouterService';
import postExpense from '../../pages/api/accounting/capture/[id]/post-expense';
import discard from '../../pages/api/accounting/capture/[id]/discard';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

beforeEach(() => {
  ext.mode = 'data';
  ext.hold = null;
  beforeExtractedWrite = null;
  failWrite = null;
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const employee = crypto.randomUUID();
let adminToken = '';

const EXTRACTED = {
  documentType: 'receipt',
  vendorName: 'R058d Fuel Stop',
  date: '2026-04-10',
  totalAmount: 115,
  subtotal: 100,
  vatAmount: 15,
  vatRate: 15,
  confidence: 0.95,
};

function callWith(handler: typeof postExpense, eventId: string, body: unknown) {
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/capture/x';
  req.query = { id: eventId };
  req.body = body;
  const result = response();
  return handler(req as never, result.res).then(() => result);
}

function call(eventId: string, body: unknown) {
  return callWith(postExpense, eventId, body);
}

/** Poll until the event reaches 'extracting' — the window `ext.hold` opens. */
async function waitForExtracting(eventId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await statusOf(eventId)) === 'extracting') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`event ${eventId} never reached 'extracting'`);
}

async function claimsFor(documentId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT ecl.claim_id)::int AS n FROM expense_claim_lines ecl
      WHERE ecl.company_id=$1 AND ecl.source_document_id=$2`,
    [company, documentId],
  );
  return rows[0].n as number;
}

async function statusOf(eventId: string): Promise<string> {
  const { rows } = await pool.query('SELECT status FROM capture_events WHERE id=$1', [eventId]);
  return rows[0].status as string;
}

async function errorOf(eventId: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT error FROM capture_events WHERE id=$1', [eventId]);
  return (rows[0].error as string | null);
}

async function documentInfo(documentId: string): Promise<{ status: string; hasData: boolean }> {
  const { rows } = await pool.query(
    "SELECT status, (extracted_data IS NOT NULL AND extracted_data <> '{}'::jsonb) AS has_data "
    + 'FROM captured_documents WHERE id=$1',
    [documentId],
  );
  return { status: rows[0].status as string, hasData: rows[0].has_data as boolean };
}

async function account(code: string, name: string, type: string, subtype: string, normal: string) {
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true)`,
    [company, code, name, type, subtype, normal],
  );
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'R058d router-race fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [admin, `${admin}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)',
    [company, admin, 'admin']);

  const y = 2026;
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'R058d FY',1,$2,$3,$4,'open')`,
    [company, y, `${y}-01-01`, `${y}-12-31`],
  );

  await account('6000', 'R058d Expense', 'expense', 'default_expense', 'debit');
  await account('1000', 'R058d Bank', 'asset', 'bank', 'debit');
  await account('1300', 'R058d VAT Input', 'asset', 'vat_input', 'debit');
  await account('2000', 'R058d Payables', 'liability', 'payable', 'credit');
  clearSystemAccountCache(company);

  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date)
     VALUES($1,$2,'R058d-E1','Ray','Tester','2026-01-01')`,
    [employee, company],
  );

  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(secret);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE expense_claims SET posted_je_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM expense_claim_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM expense_claims WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM capture_events WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

it('a legitimate routeEvent (no race) still transitions the event to extracted with data', async () => {
  const documentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
     VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058d-norace.pdf']);
  await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

  await routeEvent(eventId, company);

  expect(await statusOf(eventId)).toBe('extracted');
  const { rows } = await pool.query(
    'SELECT extracted_data IS NOT NULL AS has FROM captured_documents WHERE id=$1', [documentId],
  );
  expect(rows[0].has).toBe(true);
});

it(
  "a post that lands and completes inside routeEvent's extracting window is not undone "
  + 'when routeEvent finishes afterwards',
  async () => {
    const documentId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
       VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058d-race.pdf']);
    await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
       VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

    const reached = new Promise<void>((resolveReached) => {
      beforeExtractedWrite = () => new Promise<void>((releaseHook) => {
        resolveReached();
        // Give the post time to reach the DB and commit before routeEvent's
        // delayed write is allowed to run.
        setTimeout(releaseHook, 500);
      });
    });

    const routing = routeEvent(eventId, company);
    await reached;

    // At this instant capture_events.status is still 'extracting' — the
    // window the postable allow-list treats as open. The intercept holds
    // routeEvent's EVENT write, which (since the LOW-2 reorder) now runs
    // BEFORE the captured_documents write, so the document is still at its
    // untouched 'pending' state with no extracted_data here.
    const beforeDoc = await documentInfo(documentId);
    expect(beforeDoc.status).toBe('pending');
    expect(beforeDoc.hasData).toBe(false);

    const mid = await call(eventId, { employeeId: employee });
    expect(mid.state.statusCode).toBe(200);
    expect(await claimsFor(documentId)).toBe(1);
    expect(await statusOf(eventId)).toBe('posted');
    const midDoc = await documentInfo(documentId);
    expect(midDoc.status).toBe('matched'); // post-expense's own write

    await routing; // let routeEvent's delayed write run now that the post has committed

    // routeEvent's write must NOT have reverted the posted event or produced
    // a second claim...
    expect(await statusOf(eventId)).toBe('posted');
    expect(await claimsFor(documentId)).toBe(1);
    // ...and (LOW-2) the dropped result must not have written HALF of
    // itself: captured_documents must stay exactly as the post left it, not
    // reverted to 'pending' with routeEvent's stale extracted_data.
    const afterDoc = await documentInfo(documentId);
    expect(afterDoc.status).toBe('matched');
    expect(afterDoc.hasData).toBe(false);

    const second = await call(eventId, { employeeId: employee });
    expect(second.state.statusCode).toBe(400);
    expect(await claimsFor(documentId)).toBe(1);
  },
  30_000,
);

// ── MEDIUM: the FIRST write ('received' → 'extracting') was unpredicated ───

it(
  "a post at 'received' (from the truthy '{}' extracted_data default) is not undone "
  + 'by a subsequent routeEvent',
  async () => {
    const documentId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
       VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058e-received.pdf']);
    await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
       VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

    // `captured_documents.extracted_data` defaults to '{}' (migration 233) —
    // truthy in JS — so post-expense's `!extracted_data` refusal never fires
    // on a fresh, un-extracted event.
    const before = await documentInfo(documentId);
    expect(before.hasData).toBe(false);

    const first = await call(eventId, { employeeId: employee });
    expect(first.state.statusCode).toBe(200);
    expect(await claimsFor(documentId)).toBe(1);
    expect(await statusOf(eventId)).toBe('posted');

    // routeEvent now runs on the same event. Before this fix, its
    // unpredicated 'received' → 'extracting' write ran unconditionally,
    // reverting the posted event to 'extracting' (postable) and letting the
    // extraction complete normally — a second post then succeeded too.
    await routeEvent(eventId, company);

    expect(await statusOf(eventId)).toBe('posted');
    expect(await claimsFor(documentId)).toBe(1);

    const second = await call(eventId, { employeeId: employee });
    expect(second.state.statusCode).toBe(400);
    expect(await claimsFor(documentId)).toBe(1);
  },
);

// ── LOW-1: the two round-4 predicates without a red-on-removal test ────────
//
// Discard-during-extraction is the legitimate (non-race) way to land the
// event on a status OTHER than 'extracting' while routeEvent is still
// running — exactly what the no-data and 'failed' branch predicates guard
// against.

it("discard during extraction (OCR returns no data) leaves the event 'discarded', not revived", async () => {
  ext.mode = 'null';
  let release!: () => void;
  ext.hold = new Promise<void>((r) => { release = r; });

  const documentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
     VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058e-discard-null.pdf']);
  await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

  const routing = routeEvent(eventId, company);
  await waitForExtracting(eventId);

  const dropped = await callWith(discard as typeof postExpense, eventId, { reason: 'junk' });
  expect(dropped.state.statusCode).toBe(200);
  expect(await statusOf(eventId)).toBe('discarded');

  release();
  ext.hold = null;
  await routing;

  // Before the fix, the no-data branch's unpredicated write reverted this to
  // 'extracted' — postable again, with no DB backstop on expense claims.
  expect(await statusOf(eventId)).toBe('discarded');

  const post = await call(eventId, { employeeId: employee });
  expect(post.state.statusCode).toBe(400);
  expect(await claimsFor(documentId)).toBe(0);
}, 30_000);

it("discard during extraction (OCR throws) leaves the event 'discarded', not revived to 'failed'", async () => {
  ext.mode = 'throw';
  let release!: () => void;
  ext.hold = new Promise<void>((r) => { release = r; });

  const documentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
     VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058e-discard-throw.pdf']);
  await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

  const routing = routeEvent(eventId, company);
  await waitForExtracting(eventId);

  const dropped = await callWith(discard as typeof postExpense, eventId, { reason: 'junk' });
  expect(dropped.state.statusCode).toBe(200);
  expect(await statusOf(eventId)).toBe('discarded');

  release();
  ext.hold = null;
  await routing;

  // Before the fix, the 'failed' branch's unpredicated write reverted this
  // to 'failed' — postable (it's the duplicate-retry state) — reviving a
  // discarded event.
  expect(await statusOf(eventId)).toBe('discarded');

  const post = await call(eventId, { employeeId: employee });
  expect(post.state.statusCode).toBe(400);
  expect(await claimsFor(documentId)).toBe(0);
}, 30_000);

// ── LOW-1: the with-data branch's predicate, pinned against a discard ──────
//
// Round 5 pinned the no-data and 'failed' branches only. The with-data branch
// is the NORMAL path, and a post leaves 'posted', which almost any weaker
// predicate still refuses — so the post race does not pin it. A discard does:
// the reviewer's MX2 (`AND status = 'extracting'` → `AND status <> 'posted'`)
// survived all 23 tests yet revived a discarded event to 'extracted' and let a
// post through.

it("discard during extraction (OCR returns data) leaves the event 'discarded', not revived", async () => {
  ext.mode = 'data';
  let release!: () => void;
  ext.hold = new Promise<void>((r) => { release = r; });

  const documentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
     VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058f-discard-data.pdf']);
  await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

  const routing = routeEvent(eventId, company);
  await waitForExtracting(eventId);

  const dropped = await callWith(discard as typeof postExpense, eventId, { reason: 'junk' });
  expect(dropped.state.statusCode).toBe(200);
  expect(await statusOf(eventId)).toBe('discarded');

  release();
  ext.hold = null;
  await routing;

  expect(await statusOf(eventId)).toBe('discarded');
  // The whole result is dropped, document included (round 5's LOW-2 ordering).
  const doc = await documentInfo(documentId);
  expect(doc.status).toBe('pending');
  expect(doc.hasData).toBe(false);

  const post = await call(eventId, { employeeId: employee });
  expect(post.state.statusCode).toBe(400);
  expect(await claimsFor(documentId)).toBe(0);
}, 30_000);

// ── MEDIUM: either write failing must still record the extraction error ────
//
// routeEvent has no transaction. Since the event transition is claimed BEFORE
// the captured_documents UPDATE, a failure of that second write leaves the
// event on 'extracted' — so a recovery write predicated on 'extracting' alone
// matched 0 rows, dropped the error, and left the event claiming success with
// no extraction behind it and no path out.

it("a captured_documents write failure leaves the event 'failed' with the error recorded", async () => {
  const documentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
     VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058f-doc-fail.pdf']);
  await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

  failWrite = 'doc';
  await routeEvent(eventId, company);

  expect(await statusOf(eventId)).toBe('failed');
  expect(await errorOf(eventId)).toContain('r058f document write failure');
  // Nothing of the extraction landed.
  const doc = await documentInfo(documentId);
  expect(doc.status).toBe('pending');
  expect(doc.hasData).toBe(false);
}, 30_000);

it("a capture_events transition failure leaves the event 'failed' with the error recorded", async () => {
  const documentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status)
     VALUES($1,$2,$3,'pdf','pending')`, [documentId, company, 'r058f-event-fail.pdf']);
  await pool.query(`INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'api','received',$3)`, [eventId, company, documentId]);

  failWrite = 'event';
  await routeEvent(eventId, company);

  expect(await statusOf(eventId)).toBe('failed');
  expect(await errorOf(eventId)).toContain('r058f event write failure');
  const doc = await documentInfo(documentId);
  expect(doc.status).toBe('pending');
  expect(doc.hasData).toBe(false);
}, 30_000);

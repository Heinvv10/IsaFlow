// R-105 — a manual expense claim line takes the capture posting claim on its
// source document.
//
// POST /api/accounting/expense-claims and POST /api/accounting/expense-claims/[id]
// wrote lines[].sourceDocumentId straight into expense_claim_lines. Nothing
// checked it: a slip already posted through capture could go on a manual
// claim (the same input VAT claimed twice), a slip could sit on two claims, and
// another company's captured_documents id was accepted because the FK check
// runs without RLS. The capture path (`post-expense`) stamps
// captured_documents.posted_at before it creates its claim; the manual paths
// now take the same claim, all or nothing, before they write anything, and the
// line and claim deletes give it back.
//
// Every case runs through the real routes (withAuth, app_user, RLS) and asserts
// the outcome: the status, the claim column, and the rows that exist.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import claimsRoute from '../../pages/api/accounting/expense-claims';
import claimRoute from '../../pages/api/accounting/expense-claims/[id]';
import lineRoute from '../../pages/api/accounting/expense-claims/[id]/lines/[lineId]';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import {
  ClaimSourceDocumentError,
  claimLineSourceDocuments,
  lockClaimReadSourceDocumentIds,
} from '@/modules/accounting/services/expense/claimSourceDocuments';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const employee = crypto.randomUUID();
const expense = crypto.randomUUID();

const postedDoc = crypto.randomUUID();
const rejectedDoc = crypto.randomUUID();
const foreignDoc = crypto.randomUUID();
const freshDoc = crypto.randomUUID();
const atomicFreshDoc = crypto.randomUUID();
const twiceInOneDoc = crypto.randomUUID();
const deleteLineDoc = crypto.randomUUID();
const deleteClaimDoc = crypto.randomUUID();
const addLineDoc = crypto.randomUUID();
const raceDoc = crypto.randomUUID();
const busyDoc = crypto.randomUUID();
const deleteRaceDoc = crypto.randomUUID();
const pairRaceX = crypto.randomUUID();
const pairRaceY = crypto.randomUUID();
const legacyDoc = crypto.randomUUID();
const ownDocs = [legacyDoc, pairRaceX, pairRaceY, postedDoc, rejectedDoc, freshDoc, atomicFreshDoc, twiceInOneDoc,
  deleteLineDoc, deleteClaimDoc, addLineDoc, raceDoc, busyDoc, deleteRaceDoc];

const today = new Date().toISOString().slice(0, 10);
let token = '';

async function seedDoc(id: string, owner: string, status = 'pending', posted = false): Promise<void> {
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status,posted_at)
     VALUES($1,$2,$3,'application/pdf','receipt','{}'::jsonb,$4,$5)`,
    [id, owner, `r105-${id}.pdf`, status, posted ? new Date() : null],
  );
}

function line(sourceDocumentId: string | null, amount = 115) {
  return {
    lineDate: today, description: 'R105 slip', merchant: 'Waltons', amount, vatAmount: 15,
    vatCode: 'standard', glAccountId: expense, costCentreId: null, projectId: null,
    sourceDocumentId, kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
  };
}

async function call(
  route: (req: never, res: never) => Promise<unknown> | unknown,
  method: string,
  url: string,
  query: Record<string, string>,
  body?: unknown,
) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, method) as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.url = url;
  req.query = query;
  req.body = body ?? {};
  const out = response();
  await route(req as never, out.res as never);
  return out.state as { statusCode: number; body: { data?: { claim?: { id: string; lines?: Array<{ id: string }> } }; error?: { message?: string } } };
}

const createClaim = (lines: unknown[]) =>
  call(claimsRoute, 'POST', '/api/accounting/expense-claims', {}, { employeeId: employee, lines });
const addLine = (claimId: string, body: unknown) =>
  call(claimRoute, 'POST', `/api/accounting/expense-claims/${claimId}`, { id: claimId }, body);
const deleteClaim = (claimId: string) =>
  call(claimRoute, 'DELETE', `/api/accounting/expense-claims/${claimId}`, { id: claimId });
const deleteLine = (claimId: string, lineId: string) =>
  call(lineRoute, 'DELETE', `/api/accounting/expense-claims/${claimId}/lines/${lineId}`, { id: claimId, lineId });

async function postedAt(id: string): Promise<Date | null> {
  return (await pool.query('SELECT posted_at FROM captured_documents WHERE id=$1', [id])).rows[0]?.posted_at ?? null;
}
async function claimCount(): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM expense_claims WHERE company_id=$1', [company])).rows[0].n;
}
async function linesOn(docId: string): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM expense_claim_lines WHERE source_document_id=$1', [docId])).rows[0].n;
}

async function purge(): Promise<void> {
  await pool.query('DELETE FROM expense_claim_lines WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM expense_claims WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM payroll_employees WHERE id=$1', [employee]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'R105 owner', otherCompany, 'R105 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,employment_type,start_date,status)
     VALUES($1,$2,'R105-01','Arr','Onefive','permanent',CURRENT_DATE,'active')`, [employee, company]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active)
     VALUES($1,$2,'R105EX','R105 Office supplies','expense','debit',true)`, [expense, company]);
  await seedDoc(postedDoc, company, 'matched', true);
  await seedDoc(rejectedDoc, company, 'rejected');
  await seedDoc(foreignDoc, otherCompany);
  for (const id of [freshDoc, atomicFreshDoc, twiceInOneDoc, deleteLineDoc, deleteClaimDoc, addLineDoc,
    raceDoc, busyDoc, deleteRaceDoc, pairRaceX, pairRaceY, legacyDoc]) {
    await seedDoc(id, company);
  }
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try { await purge(); } finally { await pool.end(); }
}, 60_000);

/** An open request transaction on its own connection, as withAuth runs one. */
async function openTx() {
  const c = await pool.connect();
  await c.query('BEGIN');
  const run = <T>(fn: () => Promise<T>) =>
    als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
  const end = async (verb: 'COMMIT' | 'ROLLBACK') => {
    try { await c.query(verb); } finally { c.release(); }
  };
  return { run, end };
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('R-105: a manual expense claim line claims its source document', () => {
  it('refuses a slip already posted through capture, and creates no claim', async () => {
    const before = await claimCount();
    const out = await createClaim([line(postedDoc)]);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/already posted/i);
    expect(await claimCount()).toBe(before);
    expect(await linesOn(postedDoc)).toBe(0);
  });

  it('refuses an already-posted slip whatever the case of its id', async () => {
    const out = await createClaim([line(postedDoc.toUpperCase())]);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/already posted/i);
  });

  // Lines written before R-105 never stamped posted_at.
  it('refuses a slip already on a live claim line that never claimed it', async () => {
    const legacy = crypto.randomUUID();
    await pool.query(
      `INSERT INTO expense_claims (id, company_id, employee_id, claim_number, claim_date, status)
       VALUES ($1, $2, $3, 'R105-LEGACY', CURRENT_DATE, 'submitted')`, [legacy, company, employee]);
    await pool.query(
      `INSERT INTO expense_claim_lines (claim_id, company_id, line_date, description, amount, vat_amount, source_document_id)
       VALUES ($1, $2, CURRENT_DATE, 'R105 legacy', 115, 15, $3)`, [legacy, company, legacyDoc]);
    expect(await postedAt(legacyDoc)).toBeNull();
    const out = await createClaim([line(legacyDoc)]);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/already on another expense claim/i);
    expect(await linesOn(legacyDoc)).toBe(1);
    // Once that claim is rejected, the slip is free.
    await pool.query("UPDATE expense_claims SET status='rejected' WHERE id=$1", [legacy]);
    const again = await createClaim([line(legacyDoc)]);
    expect(again.statusCode, JSON.stringify(again.body)).toBe(201);
  });

  it('refuses a slip an operator rejected', async () => {
    const out = await createClaim([line(rejectedDoc)]);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/rejected/i);
    expect(await linesOn(rejectedDoc)).toBe(0);
  });

  it('refuses another company\'s captured document, and leaves it unclaimed', async () => {
    const out = await createClaim([line(foreignDoc)]);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/not found/i);
    expect(await linesOn(foreignDoc)).toBe(0);
    expect(await postedAt(foreignDoc)).toBeNull();
  });

  // The service's own company filter, on a connection RLS does not narrow
  // (the fixture's role bypasses RLS, as a cron or MCP path's may): the route
  // test above would pass on RLS alone.
  it('the claim is company-scoped even where RLS does not apply', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const err = await als.run({ client: c, userId: user, companyId: company, claims: {} } as never,
        () => claimLineSourceDocuments(company, [{ sourceDocumentId: foreignDoc }])).catch((e: unknown) => e);
      await c.query('COMMIT');
      expect(err).toBeInstanceOf(ClaimSourceDocumentError);
      expect((err as ClaimSourceDocumentError).refusal).toBe('not_found');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(await postedAt(foreignDoc)).toBeNull();
  });

  it('claims a fresh slip, and a second claim on the same slip is refused', async () => {
    const first = await createClaim([line(freshDoc)]);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    expect(await postedAt(freshDoc)).not.toBeNull();
    const second = await createClaim([line(freshDoc)]);
    expect(second.statusCode, JSON.stringify(second.body)).toBe(400);
    expect(await linesOn(freshDoc)).toBe(1);
  });

  it('is all or nothing: one refused line leaves the other slip unclaimed and no claim behind', async () => {
    const before = await claimCount();
    const out = await createClaim([line(atomicFreshDoc), line(postedDoc)]);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await postedAt(atomicFreshDoc)).toBeNull();
    expect(await claimCount()).toBe(before);
  });

  it('refuses the same slip on two lines of one claim', async () => {
    const out = await createClaim([line(twiceInOneDoc), line(twiceInOneDoc)]);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/more than one line/i);
    expect(await postedAt(twiceInOneDoc)).toBeNull();
    expect(await linesOn(twiceInOneDoc)).toBe(0);
  });

  it('adding a line to a draft claims its slip too, and refuses a posted one', async () => {
    const created = await createClaim([line(null)]);
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    const claimId = created.body.data!.claim!.id;
    const refused = await addLine(claimId, line(postedDoc));
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error?.message).toMatch(/already posted/i);
    expect(await linesOn(postedDoc)).toBe(0);
    const added = await addLine(claimId, line(addLineDoc));
    expect(added.statusCode, JSON.stringify(added.body)).toBe(200);
    expect(await postedAt(addLineDoc)).not.toBeNull();
  });

  it('two concurrent claims on one slip: the second waits, then is refused', async () => {
    const a = await openTx();
    const b = await openTx();
    try {
      await a.run(() => claimLineSourceDocuments(company, [{ sourceDocumentId: raceDoc }]));
      const second = settle(b.run(() => claimLineSourceDocuments(company, [{ sourceDocumentId: raceDoc }])));
      await pause(300);
      await a.end('COMMIT');
      const out = await second;
      expect(out.ok).toBe(false);
      expect((out as { e: ClaimSourceDocumentError }).e.refusal).toBe('already_posted');
    } finally {
      await b.end('ROLLBACK');
    }
  });

  it('a two-slip claim racing a claim on one of its slips stamps neither, and commits nothing', async () => {
    const a = await openTx();
    const b = await openTx();
    let bOutcome: 'COMMIT' | 'ROLLBACK' = 'ROLLBACK';
    try {
      await a.run(() => claimLineSourceDocuments(company, [{ sourceDocumentId: pairRaceX }]));
      const pair = settle(b.run(() => claimLineSourceDocuments(company,
        [{ sourceDocumentId: pairRaceY }, { sourceDocumentId: pairRaceX }])));
      await pause(300);
      await a.end('COMMIT');
      const out = await pair;
      expect(out.ok).toBe(false);
      // A refusal is answered 4xx, and withAuth COMMITs a 4xx: commit it here too.
      expect((out as { e: unknown }).e).toBeInstanceOf(ClaimSourceDocumentError);
      bOutcome = 'COMMIT';
    } finally {
      await b.end(bOutcome);
    }
    expect(await postedAt(pairRaceY)).toBeNull();
  });

  it('a claim that cannot get the lock in 5s is refused as busy, not left hanging', async () => {
    const holder = await pool.connect();
    const b = await openTx();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM captured_documents WHERE id=$1 FOR UPDATE', [busyDoc]);
      const out = await settle(b.run(() => claimLineSourceDocuments(company, [{ sourceDocumentId: busyDoc }])));
      expect(out.ok).toBe(false);
      expect((out as { e: ClaimSourceDocumentError }).e.refusal).toBe('busy');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await b.end('ROLLBACK');
    }
    expect(await postedAt(busyDoc)).toBeNull();
  }, 20_000);

  it('the draft-claim delete waits for a concurrent add-line and sees its slip', async () => {
    const created = await createClaim([line(null)]);
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    const claimId = created.body.data!.claim!.id;
    const adder = await openTx();
    const deleter = await openTx();
    try {
      // An add-line, mid-request: slip claimed and line inserted, not committed.
      await adder.run(async () => {
        await claimLineSourceDocuments(company, [{ sourceDocumentId: deleteRaceDoc }]);
        await sql`INSERT INTO expense_claim_lines (claim_id, company_id, line_date, description, amount, vat_amount, source_document_id)
                  VALUES (${claimId}::uuid, ${company}::uuid, ${today}::date, 'R105 race', 115, 15, ${deleteRaceDoc}::uuid)`;
      });
      const read = settle(deleter.run(() => lockClaimReadSourceDocumentIds(claimId, company)));
      await pause(300);
      await adder.end('COMMIT');
      const out = await read;
      expect(out.ok).toBe(true);
      expect((out as { v: string[] }).v).toContain(deleteRaceDoc);
    } finally {
      await deleter.end('ROLLBACK');
    }
  });

  it('deleting a line gives its slip back', async () => {
    const created = await createClaim([line(deleteLineDoc)]);
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    const claimId = created.body.data!.claim!.id;
    const lineId = (await pool.query('SELECT id FROM expense_claim_lines WHERE claim_id=$1', [claimId])).rows[0].id as string;
    const out = await deleteLine(claimId, lineId);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await postedAt(deleteLineDoc)).toBeNull();
    const again = await createClaim([line(deleteLineDoc)]);
    expect(again.statusCode, JSON.stringify(again.body)).toBe(201);
  });

  it('deleting a draft claim gives its slips back', async () => {
    const created = await createClaim([line(deleteClaimDoc)]);
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    const out = await deleteClaim(created.body.data!.claim!.id);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await postedAt(deleteClaimDoc)).toBeNull();
  });
});

/**
 * R-147 review round 1 — five more siblings of approvalService.listRequests'
 * defect, all in accounting: each LEFT JOINed `users` directly (or
 * concatenated first_name/last_name) to resolve who approved/posted/locked/
 * marked something, under app_user. `users_self_read` (FORCE RLS) lets
 * app_user SELECT only its own row, so every one of these showed a blank
 * name for anyone but the actor themselves. Each is fixed by routing through
 * the same SECURITY DEFINER approval_company_member_name (migration 714)
 * that approvalService.listRequests and payrollEmployeeHistoryService use.
 *
 * These run the actual service functions inside an ALS context with a real
 * `SET ROLE app_user` + the same session GUCs withAuth sets — not through
 * an HTTP handler — so `sql` (via ALS) executes under real RLS, the same
 * pattern tests/integration/api/creditNoteLock.test.ts uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generateCreditNotePdf } from '../../src/modules/accounting/services/ar/creditNotePdfBuilder';
import { queryAuditTrail } from '../../src/modules/accounting/services/gl/auditTrailLedgerService';
import { getAuditTrail as getLedgerAuditTrail } from '../../src/modules/accounting/services/gl/transactionLedgerService';
import { getStaffUtilisation } from '../../src/modules/accounting/services/practice/practiceReportsService';
import { findVatDeclaredElsewhere } from '../../src/modules/accounting/services/reports/vatDeclaredElsewhereQuery';
import { listVatPeriodLocks } from '../../src/modules/accounting/services/reports/vatPeriodLockService';
import { newCompany, cleanup as cleanupCommon } from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];

async function namedUser(email: string, firstName: string, lastName: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO users(id,email,first_name,last_name,role,is_active) VALUES($1,$2,$3,$4,$5,true)',
    [id, email, firstName, lastName, 'admin']);
  users.push(id);
  return id;
}

let actor = '';
let viewer = '';

beforeAll(async () => {
  actor = await namedUser('r147-actor@test.local', 'Naledi', 'Van der Merwe');
  viewer = await namedUser('r147-viewer@test.local', 'Sizwe', 'Adams');
});
afterAll(async () => {
  // Tables the shared cleanup helper doesn't know about, deleted first so the
  // FKs it does clean up (companies, users) can go.
  await pool.query('DELETE FROM credit_notes WHERE company_id=ANY($1)', [companies]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1)', [companies]);
  await pool.query('DELETE FROM time_entries WHERE company_id=ANY($1)', [companies]);
  await pool.query('DELETE FROM practice_clients WHERE company_id=ANY($1)', [companies]);
  await pool.query('DELETE FROM vat_period_locks WHERE company_id=ANY($1)', [companies]);
  await cleanupCommon(pool, companies, users);
});

/** Runs fn on its own client, as app_user, with the session GUCs withAuth sets. */
async function asViewer<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: viewer })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    await client.query('SET LOCAL ROLE app_user');
    const ctx = { client, userId: viewer, companyId, claims: { sub: viewer }, afterCommit: [] };
    return await als.run(ctx as never, fn);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** jsPDF writes uncompressed content streams; literal parens are escaped. */
function pdfText(buf: Buffer): string[] {
  return [...buf.toString('latin1').matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
    .map((m) => m[1]!.replace(/\\([()\\])/g, '$1'));
}

describe('credit note PDF resolves approved_by_name for a DIFFERENT company member (R-147 review)', () => {
  it('prints the real approver name, not a blank, in "Approved by: ..."', async () => {
    const company = await newCompany(pool, [[actor, 'owner'], [viewer, 'owner']], companies);
    const creditNoteId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO credit_notes(id,type,credit_date,subtotal,total_amount,status,created_by,approved_by,approved_at,company_id)
       VALUES($1,'customer',DATE '2026-01-01',100,115,'approved',$2,$2,NOW(),$3)`,
      [creditNoteId, actor, company]);

    const pdf = await asViewer(company, () => generateCreditNotePdf(company, creditNoteId));
    const text = pdfText(pdf).join(' | ');
    expect(text).toContain('Approved by: Naledi Van der Merwe');
  });
});

describe('GL audit trail resolves created_by_name/posted_by_name for a DIFFERENT company member (R-147 review)', () => {
  it('shows the real names, not blank, in the audit trail ledger', async () => {
    const company = await newCompany(pool, [[actor, 'owner'], [viewer, 'owner']], companies);
    await pool.query(
      `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,status,source,created_by,posted_by,posted_at,actor_type)
       VALUES($1,'R147-JE-1',DATE '2026-01-15','R147 audit trail test','posted','manual',$2,$2,NOW(),'human')`,
      [company, actor]);

    const page = await asViewer(company, () => queryAuditTrail(company, { from: '2026-01-01', to: '2026-01-31', limit: 50 }));
    const row = page.rows.find((r) => r.userId === actor);
    expect(row?.userName).toBe('Naledi Van der Merwe');
    expect(row?.postedByUserName).toBe('Naledi Van der Merwe');
  });
});

describe('GL transaction ledger resolves created_by_name for a DIFFERENT company member (R-147 review)', () => {
  it('shows the real name, not the raw user id, for the ledger entry', async () => {
    const company = await newCompany(pool, [[actor, 'owner'], [viewer, 'owner']], companies);
    await pool.query(
      `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,status,source,created_by)
       VALUES($1,'R147-JE-2',DATE '2026-01-16','R147 ledger test','posted','manual',$2)`,
      [company, actor]);

    const rows = await asViewer(company, () => getLedgerAuditTrail(company, '2026-01-01', '2026-01-31'));
    const row = rows.find((r) => r.entryNumber === 'R147-JE-2');
    expect(row?.createdBy).toBe('Naledi Van der Merwe');
  });
});

describe('practice staff utilisation resolves the user display name for a DIFFERENT company member (R-147 review)', () => {
  it('shows the real name, not blank, for a time entry logged by someone else', async () => {
    const company = await newCompany(pool, [[actor, 'owner'], [viewer, 'owner']], companies);
    const practiceClientId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO practice_clients(id, company_id, legal_name) VALUES ($1,$2,'R147 Practice Client')`,
      [practiceClientId, company]);
    await pool.query(
      `INSERT INTO time_entries(company_id, user_id, entry_date, hours, billable, practice_client_id, task_description)
       VALUES($1,$2,DATE '2026-01-10',2.5,true,$3,'R147 utilisation test')`,
      [company, actor, practiceClientId]);

    const rows = await asViewer(company, () => getStaffUtilisation(company, { dateFrom: '2026-01-01', dateTo: '2026-01-31' }));
    const row = rows.find((r) => r.userId === actor);
    expect(row?.userDisplayName).toBe('Naledi Van der Merwe');
  });
});

describe('VAT declared-elsewhere query resolves marked_by_name for a DIFFERENT company member (R-147 review)', () => {
  it('shows the real name, not blank, for who marked the invoice', async () => {
    const company = await newCompany(pool, [[actor, 'owner'], [viewer, 'owner']], companies);
    const customerId = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customerId, company, 'R147 VAT Customer']);
    await pool.query(
      `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,invoice_date,subtotal,tax_amount,total_amount,status,
         vat_declared_elsewhere_at,vat_declared_elsewhere_by,vat_declared_elsewhere_reason,created_by)
       VALUES(gen_random_uuid(),$1,'R147-VAT-1',$2,DATE '2026-01-05',100,15,115,'sent',NOW(),$3,'test reason',$4)`,
      [company, customerId, actor, actor]);

    const rows = await asViewer(company, () => findVatDeclaredElsewhere(company, '2026-01-01', '2026-01-31'));
    const row = rows.find((r) => r.invoice_number === 'R147-VAT-1');
    expect(row?.marked_by_name).toBe('Naledi Van der Merwe');
  });
});

describe('VAT period lock service resolves locked_by_name for a DIFFERENT company member (R-147 review)', () => {
  it('shows the real name, not blank, for who locked the period', async () => {
    const company = await newCompany(pool, [[actor, 'owner'], [viewer, 'owner']], companies);
    await pool.query(
      `INSERT INTO vat_period_locks(company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by, actor_type, locked_at)
       VALUES($1, DATE '2026-01-01', DATE '2026-01-31', 100, 50, 50, NOW(), $2, 'human', NOW())`,
      [company, actor]);

    const rows = await asViewer(company, () => listVatPeriodLocks(company));
    const row = rows.find((r) => r.periodStart === '2026-01-01');
    expect(row?.lockedByName).toBe('Naledi Van der Merwe');
  });
});

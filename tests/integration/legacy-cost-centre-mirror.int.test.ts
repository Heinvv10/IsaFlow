/**
 * CC1 is cc1_id alone (PR #688 round 2, Hein 2026-10-10), so createJournalEntry
 * mirrors a legacy-only cost centre into the canonical slots
 * (gl/legacyCostCentreMirror.ts) — on a new line and on a reversal's contra.
 *
 *  - a CC1 centre becomes cc1_id; a CC2 becomes cc2_id and new-assignment
 *    derivation adds its FNO;
 *  - a contra of a pre-887 legacy-only line gets cc1_id, and a legacy CC2 never
 *    lands in the CC1 slot, so the line stays reversible;
 *  - an explicit cc1Id is never overridden.
 * Disposable databases only.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { createJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryCrudService';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const expense = crypto.randomUUID(), accrual = crypto.randomUUID();
const fno = crypto.randomUUID(), other = crypto.randomUUID(), project = crypto.randomUUID();
const legacyCc1Entry = crypto.randomUUID(), legacyCc2Entry = crypto.randomUUID();
const DATE = '2026-03-16';
let periodId = '';

async function inRequestTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(
      { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0],
      () => fn(client),
    );
    await client.query('ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/** A posted entry as the data stood before migration 887: cost_center_id set, cc1_id NULL. */
async function seedLegacyEntry(id: string, number: string, costCentre: string): Promise<void> {
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_at,posted_by)
     VALUES($1,$2,$3,$4::date,$5,'LCM history','manual','posted',$6,NOW(),$6)`,
    [id, company, number, DATE, periodId, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description,cost_center_id)
     VALUES($1,$2,$3,250,0,'legacy-debit',$4), ($1,$2,$5,0,250,'untagged-credit',NULL)`,
    [company, id, expense, costCentre, accrual]);
}

const linesOf = async (client: PoolClient, entryId: string) => (await client.query(
  `SELECT description, cost_center_id, cc1_id, cc2_id FROM gl_journal_lines
    WHERE company_id = $1 AND journal_entry_id = $2 ORDER BY description`, [company, entryId])).rows;

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'LCM co')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'LCM-6000','LCM Expense','expense','debit',3,true), ($3,$2,'LCM-2000','LCM Accruals','liability','credit',3,true)`,
    [expense, company, accrual]);
  const { rows: fp } = await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'LCM Mar 2026',3,2026,'2026-03-01','2026-03-31','open') RETURNING id`, [company]);
  periodId = String(fp[0].id);
  await pool.query(
    `INSERT INTO cost_centres(id,company_id,code,name,cc_type,parent_id)
     VALUES($1,$4,'LCM-FNO','LCM FNO','cc1',NULL), ($2,$4,'LCM-OTHER','LCM other FNO','cc1',NULL),
           ($3,$4,'LCM-PRJ','LCM project','cc2',$1)`,
    [fno, other, project, company]);
  await seedLegacyEntry(legacyCc1Entry, 'LCM-JE-1', fno);
  await seedLegacyEntry(legacyCc2Entry, 'LCM-JE-2', project);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('UPDATE cost_centres SET parent_id = NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM cost_centres WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('a new line: a legacy CC1 becomes cc1_id, a legacy CC2 becomes cc2_id with its FNO, an explicit CC1 wins', async () => {
  const rows = await inRequestTx(async (client) => {
    const entry = await createJournalEntry(company, {
      entryDate: DATE, description: 'LCM new',
      lines: [
        { glAccountId: expense, debit: 10, credit: 0, description: 'a-cc1', costCenterId: fno },
        { glAccountId: expense, debit: 20, credit: 0, description: 'b-cc2', costCenterId: project },
        { glAccountId: expense, debit: 30, credit: 0, description: 'c-explicit', costCenterId: fno, cc1Id: other },
        { glAccountId: accrual, debit: 0, credit: 60, description: 'd-credit' },
      ],
    }, user);
    return linesOf(client, entry.id);
  });
  expect(rows).toEqual([
    { description: 'a-cc1', cost_center_id: fno, cc1_id: fno, cc2_id: null },
    { description: 'b-cc2', cost_center_id: project, cc1_id: fno, cc2_id: project },
    { description: 'c-explicit', cost_center_id: fno, cc1_id: other, cc2_id: null },
    { description: 'd-credit', cost_center_id: null, cc1_id: null, cc2_id: null },
  ]);
}, 60_000);

it('a reversal of a pre-887 legacy-only line: the contra carries cc1_id; a legacy CC2 stays reversible', async () => {
  const seen = await inRequestTx(async (client) => {
    const r1 = await reverseJournalEntry(company, legacyCc1Entry, user);
    const r2 = await reverseJournalEntry(company, legacyCc2Entry, user);
    return { cc1: await linesOf(client, r1.id), cc2: await linesOf(client, r2.id) };
  });
  expect(seen.cc1.find((l) => String(l.description).includes('legacy-debit')))
    .toMatchObject({ cost_center_id: fno, cc1_id: fno, cc2_id: null });
  expect(seen.cc2.find((l) => String(l.description).includes('legacy-debit')))
    .toMatchObject({ cost_center_id: project, cc1_id: null, cc2_id: project });
}, 60_000);

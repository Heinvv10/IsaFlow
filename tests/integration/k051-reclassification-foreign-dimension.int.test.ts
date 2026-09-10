/**
 * K-051 (round 7) — the ownership guard must not unwind a reclassification over
 * a HISTORICAL dimension tag.
 *
 * `assertJournalLinesOwned` refuses a line naming another company's project,
 * cost centre or business unit. Right for a caller asserting a tag on a new
 * line; wrong for `reclassification/journals.ts`, which copies those three ids
 * off the posted source line. Those columns carry no foreign key, so a legacy
 * line can already hold a foreign id — the exact population this branch exists
 * because of — and `post.ts` catches nothing, so ONE such line aborted the whole
 * batch.
 *
 * `plan.ts` now resolves the ids once per batch and drops what this company does
 * not own (./dimensions.ts). Both directions are proved here: the foreign tag is
 * dropped and the batch posts, an OWN tag is carried forward untouched, and the
 * caller-supplied path is still refused (see
 * k051-cross-company-journal-line.int.test.ts).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { planReclassification, isRefusal } from '../../src/modules/accounting/services/gl/reclassification/plan';
import { postReclassBatch } from '../../src/modules/accounting/services/gl/reclassification/post';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const otherCompany = crypto.randomUUID(), otherUser = crypto.randomUUID();
const source = crypto.randomUUID(), target = crypto.randomUUID(), contra = crypto.randomUUID();
const ownCc = crypto.randomUUID();
const foreignCc = crypto.randomUUID(), foreignProject = crypto.randomUUID(), foreignBu = crypto.randomUUID();
const entry = crypto.randomUUID();
const foreignLine = crypto.randomUUID(), ownLine = crypto.randomUUID();
const DATE = '2026-03-16';

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

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K051D own'),($2,'K051D other')",
    [company, otherCompany]);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true),($3,$4,'admin',true)",
    [user, `${user}@test.local`, otherUser, `${otherUser}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K051D-6000','K051D Unallocated expense','expense','debit',3,true),
            ($3,$2,'K051D-5100','K051D Materials','expense','debit',3,true),
            ($4,$2,'K051D-2000','K051D Accruals','liability','credit',3,true)`,
    [source, company, target, contra]);
  const { rows: fp } = await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K051D Mar 2026',3,2026,'2026-03-01','2026-03-31','open') RETURNING id`, [company]);
  await pool.query(
    "INSERT INTO cost_centres(id,company_id,code,name) VALUES($1,$2,'K051D-CC','K051D own cc'),($3,$4,'K051D-CCF','K051D other cc')",
    [ownCc, company, foreignCc, otherCompany]);
  await pool.query(
    "INSERT INTO projects(id,company_id,project_number,name) VALUES($1,$2,'K051D-P','K051D other project')",
    [foreignProject, otherCompany]);
  await pool.query(
    "INSERT INTO business_units(id,company_id,code,name) VALUES($1,$2,'K051D-BU','K051D other bu')",
    [foreignBu, otherCompany]);
  // The posted history: two lines on the source account, one tagged to another
  // company's three dimensions (no FK stops it, and none ever did), one tagged
  // to this company's own cost centre.
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_at)
     VALUES($1,$2,'K051D-JE-1',$3::date,$4,'K051D history','manual','posted',$5,NOW())`,
    [entry, company, DATE, fp[0].id, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit,description,project_id,cost_center_id,bu_id)
     VALUES($1,$2,$3,$4,1000,0,'foreign-tagged',$5,$6,$7)`,
    [foreignLine, company, entry, source, foreignProject, foreignCc, foreignBu]);
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit,description,cost_center_id)
     VALUES($1,$2,$3,$4,400,0,'own-tagged',$5)`,
    [ownLine, company, entry, source, ownCc]);
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,0,1400)`,
    [company, entry, contra]);
});

afterAll(async () => {
  try {
    const ids = [company, otherCompany];
    await pool.query('DELETE FROM reclassification_batch_lines WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM reclassification_batches WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=ANY($1))', [ids]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM cost_centres WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM projects WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM business_units WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id=ANY($1)', [[user, otherUser]]);
  } finally { await pool.end(); }
});

it('posts the batch, dropping only the dimensions this company does not own', async () => {
  const seen = await inRequestTx(async (client) => {
    const plan = await planReclassification({
      companyId: company,
      sourceAccountId: source,
      targetAccountId: target,
      from: DATE, to: DATE, postingDate: null, lockCandidateLines: false,
    });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.refused}`);

    // The preview and the batch build the same drafts, so a reader is told what
    // will actually post.
    const warned = plan.warnings.some((w) => w.code === 'foreign_dimension_dropped');

    // Before the fix this threw 'One or more journal lines name a project
    // outside this company' and unwound the whole batch.
    const result = await postReclassBatch(company, user, {
      tool: 'post_reclassification_batch',
      sourceAccountId: source,
      targetAccountId: target,
      postingDate: null,
      idempotencyKey: null,
      drafts: plan.drafts,
    });

    const { rows: legs } = await client.query(
      `SELECT jl.gl_account_id, jl.debit::float8 AS debit, jl.credit::float8 AS credit,
              jl.project_id, jl.cost_center_id, jl.bu_id, jl.description
         FROM gl_journal_lines jl
        WHERE jl.company_id = $1 AND jl.journal_entry_id = ANY($2::uuid[])
        ORDER BY jl.description, jl.gl_account_id`,
      [company, result.journals.map((j) => j.journalEntryId)]);
    const { rows: net } = await client.query(
      `SELECT COALESCE(SUM(jl.debit - jl.credit),0)::float8 AS n
         FROM gl_journal_lines jl
         JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
        WHERE jl.company_id = $1 AND jl.gl_account_id = $2 AND je.status = 'posted'`,
      [company, source]);
    const { rows: original } = await client.query(
      'SELECT project_id, cost_center_id, bu_id FROM gl_journal_lines WHERE id = $1', [foreignLine]);

    return { plan, warned, result, legs, sourceNet: Number(net[0].n), original: original[0] };
  });

  expect(seen.plan.movable.map((m) => m.lineId).sort()).toEqual([foreignLine, ownLine].sort());
  expect(seen.warned).toBe(true);
  expect(seen.result.movedLineCount).toBe(2);
  expect(seen.legs).toHaveLength(4);

  // The foreign-tagged line's pair carries NO dimension — on BOTH legs, so the
  // contra and the re-application net to zero in the untagged bucket.
  const fromForeign = seen.legs.filter((l) => String(l.description).includes('foreign-tagged'));
  expect(fromForeign).toHaveLength(2);
  for (const leg of fromForeign) {
    expect(leg.project_id).toBeNull();
    expect(leg.cost_center_id).toBeNull();
    expect(leg.bu_id).toBeNull();
  }
  expect(fromForeign.reduce((t, l) => t + l.debit - l.credit, 0)).toBeCloseTo(0, 2);

  // The OWN cost centre is carried forward untouched: this drops what is
  // foreign, not what is tagged.
  const fromOwn = seen.legs.filter((l) => String(l.description).includes('own-tagged'));
  expect(fromOwn).toHaveLength(2);
  for (const leg of fromOwn) expect(leg.cost_center_id).toBe(ownCc);

  // The ledger duties: every journal balances, the source account nets to zero
  // after its own contras, and the posted history is untouched.
  const debits = seen.legs.reduce((t, l) => t + l.debit, 0);
  const credits = seen.legs.reduce((t, l) => t + l.credit, 0);
  expect(debits).toBeCloseTo(credits, 2);
  expect(debits).toBeCloseTo(1400, 2);
  expect(seen.sourceNet).toBeCloseTo(0, 2);
  expect(seen.original.project_id).toBe(foreignProject);
  expect(seen.original.cost_center_id).toBe(foreignCc);
  expect(seen.original.bu_id).toBe(foreignBu);
}, 60_000);

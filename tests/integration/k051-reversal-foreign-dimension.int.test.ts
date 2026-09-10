/**
 * K-051 (round 8) — the ownership guard must not make a posted journal
 * un-reversible over a HISTORICAL dimension tag.
 *
 * `reverseJournalEntry` is the SECOND copy-forward path: it reads the posted
 * lines and mirrors them, dimensions included. Those three columns carry no
 * foreign key, so a legacy line can already hold another company's id — the
 * exact population this branch exists because of — and
 * `assertJournalLinesOwned` then threw out of `createJournalEntry`. Reversal is
 * the only correction mechanism in this schema (supplier-invoice cancel,
 * credit-note cancel, payment void and the MCP tool all route through it), so
 * the refusal stranded the entry with no user-side workaround.
 *
 * `reversalLines.ts` now drops what this company does not own, per line and per
 * dimension, and reports the count. Proved here in both directions: the foreign
 * tag is dropped and the contra posts, an OWN tag is carried forward untouched,
 * the MCP dry run says the same thing the live call does, and a CALLER naming
 * another company's dimension on a new line is still refused.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { createJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryCrudService';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { reverseJournalEntryTool } from '../../src/lib/mcp/tools/writeJournalReverse';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const otherCompany = crypto.randomUUID(), otherUser = crypto.randomUUID();
const expense = crypto.randomUUID(), accrual = crypto.randomUUID();
const ownCc = crypto.randomUUID();
const foreignCc = crypto.randomUUID(), foreignProject = crypto.randomUUID(), foreignBu = crypto.randomUUID();
const mixedEntry = crypto.randomUUID(), ownEntry = crypto.randomUUID(), dryEntry = crypto.randomUUID();
const foreignLine = crypto.randomUUID(), ownLine = crypto.randomUUID();
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

/** One posted, balanced entry on expense/accrual, tagged as asked. */
async function seedEntry(
  id: string,
  number: string,
  debitLine: { id?: string; projectId?: string; costCentreId?: string; buId?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_at,posted_by)
     VALUES($1,$2,$3,$4::date,$5,'K051R history','manual','posted',$6,NOW(),$6)`,
    [id, company, number, DATE, periodId, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit,description,project_id,cost_center_id,bu_id)
     VALUES($1,$2,$3,$4,1000,0,'tagged-debit',$5,$6,$7)`,
    [debitLine.id ?? crypto.randomUUID(), company, id, expense,
      debitLine.projectId ?? null, debitLine.costCentreId ?? null, debitLine.buId ?? null]);
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
     VALUES($1,$2,$3,0,1000,'untagged-credit')`,
    [company, id, accrual]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K051R own'),($2,'K051R other')",
    [company, otherCompany]);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true),($3,$4,'admin',true)",
    [user, `${user}@test.local`, otherUser, `${otherUser}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$2,'K051R-6000','K051R Expense','expense','debit',3,true),
            ($3,$2,'K051R-2000','K051R Accruals','liability','credit',3,true)`,
    [expense, company, accrual]);
  const { rows: fp } = await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K051R Mar 2026',3,2026,'2026-03-01','2026-03-31','open') RETURNING id`, [company]);
  periodId = String(fp[0].id);
  await pool.query(
    "INSERT INTO cost_centres(id,company_id,code,name) VALUES($1,$2,'K051R-CC','K051R own cc'),($3,$4,'K051R-CCF','K051R other cc')",
    [ownCc, company, foreignCc, otherCompany]);
  await pool.query(
    "INSERT INTO projects(id,company_id,project_number,name) VALUES($1,$2,'K051R-P','K051R other project')",
    [foreignProject, otherCompany]);
  await pool.query(
    "INSERT INTO business_units(id,company_id,code,name) VALUES($1,$2,'K051R-BU','K051R other bu')",
    [foreignBu, otherCompany]);

  // The legacy row: another company's project, cost centre and business unit on
  // a posted line of THIS company. No FK stops it, and none ever did.
  await seedEntry(mixedEntry, 'K051R-JE-1',
    { id: foreignLine, projectId: foreignProject, costCentreId: foreignCc, buId: foreignBu });
  await seedEntry(ownEntry, 'K051R-JE-2', { id: ownLine, costCentreId: ownCc });
  await seedEntry(dryEntry, 'K051R-JE-3',
    { projectId: foreignProject, costCentreId: foreignCc, buId: foreignBu });
});

afterAll(async () => {
  try {
    const ids = [company, otherCompany];
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

it('reverses a journal carrying another company\'s dimensions, dropping only those', async () => {
  const seen = await inRequestTx(async (client) => {
    // Before the fix this threw 'One or more journal lines name a project
    // outside this company' and the entry could never be reversed at all.
    const reversal = await reverseJournalEntry(company, mixedEntry, user);

    const { rows: legs } = await client.query(
      `SELECT gl_account_id, debit::float8 AS debit, credit::float8 AS credit,
              project_id, cost_center_id, bu_id, description
         FROM gl_journal_lines
        WHERE company_id = $1 AND journal_entry_id = $2
        ORDER BY description`, [company, reversal.id]);
    const { rows: head } = await client.query(
      'SELECT status, entry_date, reversal_of_id, fiscal_period_id FROM gl_journal_entries WHERE id = $1',
      [reversal.id]);
    const { rows: original } = await client.query(
      'SELECT reversed_at, status FROM gl_journal_entries WHERE id = $1', [mixedEntry]);
    const { rows: originalLine } = await client.query(
      'SELECT project_id, cost_center_id, bu_id FROM gl_journal_lines WHERE id = $1', [foreignLine]);
    // The PAIR: original plus its contra. Scoped to these two entries because
    // the other fixtures post to the same account.
    const { rows: net } = await client.query(
      `SELECT COALESCE(SUM(jl.debit - jl.credit),0)::float8 AS n
         FROM gl_journal_lines jl
         JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
        WHERE jl.company_id = $1 AND jl.gl_account_id = $2 AND je.status = 'posted'
          AND je.id = ANY($3::uuid[])`,
      [company, expense, [mixedEntry, reversal.id]]);

    return {
      reversal, legs, head: head[0], original: original[0],
      originalLine: originalLine[0], net: Number(net[0].n),
    };
  });

  expect(seen.reversal.foreignDimensionDroppedLines).toBe(1);
  expect(seen.head.status).toBe('posted');
  expect(seen.head.reversal_of_id).toBe(mixedEntry);
  expect(seen.head.fiscal_period_id).toBe(periodId);
  expect(seen.original.reversed_at).not.toBeNull();
  // Standard reversal semantics: the original KEEPS status 'posted'.
  expect(seen.original.status).toBe('posted');

  // The contra of the foreign-tagged line carries NO dimension at all.
  expect(seen.legs).toHaveLength(2);
  const contra = seen.legs.find((l) => String(l.description).includes('tagged-debit'));
  expect(contra).toBeDefined();
  expect(contra.project_id).toBeNull();
  expect(contra.cost_center_id).toBeNull();
  expect(contra.bu_id).toBeNull();
  // Debits and credits swapped, and the pair nets to zero on the account.
  expect(Number(contra.debit)).toBeCloseTo(0, 2);
  expect(Number(contra.credit)).toBeCloseTo(1000, 2);
  expect(seen.legs.reduce((t, l) => t + Number(l.debit), 0))
    .toBeCloseTo(seen.legs.reduce((t, l) => t + Number(l.credit), 0), 2);
  expect(seen.net).toBeCloseTo(0, 2);

  // The posted history is untouched — the drop is on the CONTRA, not a rewrite
  // of the row being corrected.
  expect(seen.originalLine.project_id).toBe(foreignProject);
  expect(seen.originalLine.cost_center_id).toBe(foreignCc);
  expect(seen.originalLine.bu_id).toBe(foreignBu);
}, 60_000);

it('carries an OWN dimension forward untouched, and reports nothing dropped', async () => {
  const seen = await inRequestTx(async (client) => {
    const reversal = await reverseJournalEntry(company, ownEntry, user);
    const { rows } = await client.query(
      `SELECT cost_center_id, description FROM gl_journal_lines
        WHERE company_id = $1 AND journal_entry_id = $2 ORDER BY description`,
      [company, reversal.id]);
    return { reversal, rows };
  });

  expect(seen.reversal.foreignDimensionDroppedLines).toBe(0);
  const contra = seen.rows.find((r) => String(r.description).includes('tagged-debit'));
  expect(contra.cost_center_id).toBe(ownCc);
});

it('still refuses a CALLER that names another company\'s dimension on a new line', async () => {
  const seen = await inRequestTx(async (client) => {
    let message = '';
    try {
      await createJournalEntry(company, {
        entryDate: DATE,
        description: 'K051R caller claim',
        lines: [
          { glAccountId: expense, debit: 100, credit: 0, projectId: foreignProject },
          { glAccountId: accrual, debit: 0, credit: 100 },
        ],
      }, user);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    const { rows } = await client.query(
      "SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND description = 'K051R caller claim'",
      [company]);
    return { message, written: rows[0].n };
  });

  expect(seen.message).toContain('project outside this company');
  expect(seen.written).toBe(0);
});

it('says the same thing in the MCP dry run as the live call, and writes nothing', async () => {
  const seen = await inRequestTx(async (client) => {
    const result = await reverseJournalEntryTool.handler(
      { journal_entry_id: dryEntry, idempotency_key: crypto.randomUUID(), dry_run: true },
      { userId: user, companyId: company, scopes: ['write:journals'], tokenJti: null, oauthAppId: null },
    );
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS n, MAX(reversed_at::text) AS reversed FROM gl_journal_entries WHERE company_id = $1',
      [company]);
    return { result, count: rows[0].n, reversed: rows[0].reversed };
  });

  expect(seen.result.isError).toBeFalsy();
  expect(seen.result.wroteNothing).toBe(true);
  const payload = JSON.parse(seen.result.content[0]!.text) as {
    dryRun: boolean; warnings: { code: string }[];
  };
  expect(payload.dryRun).toBe(true);
  expect(payload.warnings.map((w) => w.code)).toContain('foreign_dimension_dropped');
  // Three seeded entries and no fourth: the preview wrote nothing.
  expect(seen.count).toBe(3);
  expect(seen.reversed).toBeNull();
}, 60_000);

it('renders the same warning on the LIVE MCP call, which really does write the contra', async () => {
  const seen = await inRequestTx(async (client) => {
    const result = await reverseJournalEntryTool.handler(
      { journal_entry_id: dryEntry, idempotency_key: crypto.randomUUID() },
      { userId: user, companyId: company, scopes: ['write:journals'], tokenJti: null, oauthAppId: null },
    );
    const payload = JSON.parse(result.content[0]!.text) as {
      reversal_entry_id: string; warnings: { code: string }[];
    };
    const { rows } = await client.query(
      `SELECT project_id, cost_center_id, bu_id FROM gl_journal_lines
        WHERE company_id = $1 AND journal_entry_id = $2`,
      [company, payload.reversal_entry_id]);
    return { result, payload, rows };
  });

  expect(seen.result.isError).toBeFalsy();
  expect(seen.result.wroteNothing).toBeFalsy();
  // The live response carries the drop, not only the dry run: deleting
  // `warnings:` from the live payload object turns this red.
  expect(seen.payload.warnings.map((w) => w.code)).toContain('foreign_dimension_dropped');
  // And it is a real contra, with the foreign tags left off.
  expect(seen.rows.length).toBeGreaterThan(0);
  for (const r of seen.rows) {
    expect(r.project_id).toBeNull();
    expect(r.cost_center_id).toBeNull();
    expect(r.bu_id).toBeNull();
  }
}, 60_000);

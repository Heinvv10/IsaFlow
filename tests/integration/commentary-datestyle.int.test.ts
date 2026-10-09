/**
 * A board row is still recognised as BOARD when the session's DateStyle is not
 * ISO. `printsOnFixedPage` recovers the pack type by hashing (type, from, to), so
 * the dates must reach it as YYYY-MM-DD whatever DateStyle says: under
 * `SQL, DMY` a bare `period_start::text` is `01/01/2026`, matches no type, and
 * a MANAGEMENT row would then be budgeted like a board one (and a board row
 * would pass only because unknown rows fail closed).
 *
 * Proved by outcome on real Postgres, both ways: a management row carrying more
 * text than a board page could hold is approved (no budget), and a board row
 * with the same text is refused (budgeted). Needs the disposable fixture DB.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { approveCommentary } from '@/modules/accounting/services/commentary/commentaryService';
import { MAX_APPROVED_PACK_EMS, commentaryCost } from '@/modules/accounting/services/commentary/commentaryLimits';
import { canonicalParamsHash } from '@/modules/accounting/services/reports/packParamsHash';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

// Login-as guard: needs a sessions table this minimal fixture lacks; covered in tests/unit/auth.
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = randomUUID();
const boardRow = randomUUID();
const managementRow = randomUUID();
const FROM = '2026-01-01';
const TO = '2026-03-31';
const LONG = (() => {
  let out = 'Revenue grew on the rollout. ';
  while (commentaryCost([out]) <= MAX_APPROVED_PACK_EMS * 1.5) out += 'Revenue grew on the rollout. ';
  return out.trim();
})();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'commentary datestyle']);
  for (const [id, type] of [[boardRow, 'board'], [managementRow, 'management']] as const) {
    await pool.query(
      `INSERT INTO report_commentary(id,company_id,report_kind,params_hash,period_start,period_end,
         section_ref,row_ref,draft_text,generated_by)
       VALUES($1,$2,'pack',$3,$4,$5,'income_statement','revenue','machine draft','u0')`,
      [id, company, canonicalParamsHash({ type, from: FROM, to: TO }), FROM, TO]);
  }
}, 60_000);

afterAll(async () => {
  await pool.query('DELETE FROM report_commentary WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.end();
}, 60_000);

async function approveUnder(dateStyle: string, id: string) {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL datestyle = '${dateStyle}'`);
    const result = await als.run({ client, userId: 'u1', companyId: company, claims: {} } as never,
      () => approveCommentary(company, id, 'u1', LONG));
    await client.query('ROLLBACK'); // each case starts from a draft
    return result;
  } finally {
    client.release();
  }
}

it('the premise: the text is over the budget, and DMY really changes how a date prints', async () => {
  expect(commentaryCost([LONG])).toBeGreaterThan(MAX_APPROVED_PACK_EMS);
  const client = await pool.connect();
  try {
    await client.query("SET datestyle = 'SQL, DMY'");
    const { rows } = await client.query("SELECT '2026-01-01'::date::text AS d");
    expect(rows[0].d).toBe('01/01/2026');
  } finally {
    client.release();
  }
});

for (const dateStyle of ['ISO, YMD', 'SQL, DMY', 'German, DMY', 'Postgres, MDY']) {
  it(`under datestyle ${dateStyle}: a management row is unbudgeted and a board row is budgeted`, async () => {
    const management = await approveUnder(dateStyle, managementRow);
    expect(management.ok, 'a management row was budgeted: its pack type was not recognised').toBe(true);
    const board = await approveUnder(dateStyle, boardRow);
    expect(board.ok).toBe(false);
    if (!board.ok) expect(board.code).toBe('commentary_budget_exceeded');
  });
}

/**
 * Two approvals of DIFFERENT rows of one pack, racing.
 *
 * Each is sized from the CURRENT budget: it fits alone (about 60% of it) and the
 * two together do not (about 120%). Both read the sum "before" the other writes, so without a per-pack
 * lock both pass and page 4 — which joins every approved row — overflows and
 * refuses the whole board pack. The proof is by outcome against real Postgres:
 * the second approval must be seen WAITING on the lock while the first is
 * uncommitted, and must then be refused by name; the pack must end at one
 * approved row. Delete the `pg_advisory_xact_lock` and the second approval
 * finishes without waiting (and succeeds), so this goes red.
 *
 * Needs the disposable fixture DB (see assertDisposable); the table is the
 * 611/612 schema, nothing else is touched.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { approveCommentary } from '@/modules/accounting/services/commentary/commentaryService';
import { MAX_APPROVED_PACK_EMS, commentaryCost } from '@/modules/accounting/services/commentary/commentaryLimits';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

// The Login-as guard reads the sessions table, which this minimal fixture does
// not have; it is covered by tests/unit/auth/impersonationGuard.test.ts.
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = randomUUID();
const rowA = randomUUID();
const rowB = randomUUID();
/** Prose costing about `share` of the pack budget, so the test follows the budget. */
function sized(share: number, seed: string): string {
  const sentence = `${seed} revenue grew because the two largest contracts renewed and the rollout reached full billing. `;
  let out = '';
  while (commentaryCost([out + sentence]) <= MAX_APPROVED_PACK_EMS * share) out += sentence;
  return out.trim();
}
const textA = sized(0.6, 'Alpha');
const textB = sized(0.6, 'Bravo');

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'commentary race']);
  for (const [id, ref] of [[rowA, 'revenue'], [rowB, 'cogs']] as const) {
    await pool.query(
      `INSERT INTO report_commentary(id,company_id,report_kind,params_hash,period_start,period_end,
         section_ref,row_ref,draft_text,generated_by)
       VALUES($1,$2,'pack','race-hash','2026-01-01','2026-03-31','income_statement',$3,'machine draft','u0')`,
      [id, company, ref]);
  }
}, 60_000);

afterAll(async () => {
  await pool.query('DELETE FROM report_commentary WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.end();
}, 60_000);

async function inTx(user: string): Promise<{ client: PoolClient; run: <T>(f: () => Promise<T>) => Promise<T> }> {
  const client = await pool.connect();
  await client.query('BEGIN');
  return { client, run: (f) => als.run({ client, userId: user, companyId: company, claims: {} } as never, f) };
}

it('sizes the premise from the budget: each fits alone, both together do not', () => {
  expect(commentaryCost([textA])).toBeLessThanOrEqual(MAX_APPROVED_PACK_EMS);
  expect(commentaryCost([textB])).toBeLessThanOrEqual(MAX_APPROVED_PACK_EMS);
  expect(commentaryCost([textA, textB])).toBeGreaterThan(MAX_APPROVED_PACK_EMS);
});

it('serialises two approvals of one pack: the second waits, then is refused by name', async () => {
  const a = await inTx('u1');
  const b = await inTx('u2');
  try {
    const first = await a.run(() => approveCommentary(company, rowA, 'u1', textA));
    expect(first.ok).toBe(true); // A holds the pack lock, uncommitted

    let settled = false;
    const second = b.run(() => approveCommentary(company, rowB, 'u2', textB))
      .finally(() => { settled = true; });

    let waiting = false;
    for (let i = 0; i < 60 && !waiting; i++) {
      const { rows } = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'");
      waiting = rows.length > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    expect(waiting, 'the second approval never waited: nothing serialises the pack').toBe(true);
    expect(settled, 'the second approval finished while the first was uncommitted').toBe(false);

    await a.client.query('COMMIT');
    const result = await second;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('commentary_budget_exceeded');
    await b.client.query('COMMIT');
  } finally {
    await a.client.query('ROLLBACK').catch(() => undefined);
    await b.client.query('ROLLBACK').catch(() => undefined);
    a.client.release();
    b.client.release();
  }

  const { rows } = await pool.query(
    "SELECT approved_text FROM report_commentary WHERE company_id=$1 AND status='approved'", [company]);
  expect(rows).toHaveLength(1);
  expect(commentaryCost(rows.map((r: { approved_text: string }) => r.approved_text))).toBeLessThanOrEqual(MAX_APPROVED_PACK_EMS);
}, 30_000);

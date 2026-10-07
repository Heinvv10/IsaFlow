/**
 * R-035 PR6: an approved manual journal dated inside a FILED VAT period still
 * posts as the s16(3) late input-VAT claim through the UI route.
 *
 * The route marks the draft and posts it in one savepoint; the split rewrites
 * the original's VAT lines (onto the clearing account, codes off). Migration
 * 869's backstop judges a marked journal's digest as it ENTERS 'posted', so
 * the split posts the original with the lines the approver approved, and only
 * then rewrites them (gl/vatLateClaimSplit.ts). Rewriting first — the old
 * order — made the backstop see content nobody approved and refuse every late
 * claim of an approved journal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr6, enforceJournals, journalRoutes, journalState } from './r035-pr6.helpers';
import { P, balanceOf, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = journalRoutes(tokens);
let fx: LateFixture;

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
  fx = await seedLateFixture('R6L', process.env.DATABASE_URL!);
  await lockPeriod(fx, P.start, P.end);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'owner')", [fx.companyId, u.a, u.b]);
  await plantRule(pool, fx.companyId, 'owner', { documentType: 'manual_journal' });
  await enforceJournals(pool, fx.companyId, u.b);
}, 120000);

afterAll(async () => {
  if (fx) {
    await pool.query('DELETE FROM audit_log WHERE company_id = $1', [fx.companyId]);
    await pool.query('DELETE FROM approval_requests WHERE company_id = $1', [fx.companyId]);
    await pool.query('DELETE FROM approval_rules WHERE company_id = $1', [fx.companyId]);
    await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [fx.companyId]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = ANY($2::text[])', [fx.companyId, Object.values(u)]);
    await dropLateFixture(fx);
  }
  await cleanupPr6(pool, [], Object.values(u));
}, 120000);

/** A draft inside the filed period P: DR expense 100 + DR VAT input 15 (standard) / CR AP 115. */
async function lateDraft(): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO gl_journal_entries(id,company_id,entry_date,description,source,status,created_by)
    VALUES(${id}::UUID,${fx.companyId}::UUID,DATE '2026-06-12','R035 late journal','manual','draft',${u.a}::UUID)`;
  await sql`
    INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,vat_type)
    VALUES(${fx.companyId}::UUID,${id}::UUID,${fx.expenseId}::UUID,100,0,'standard'),
          (${fx.companyId}::UUID,${id}::UUID,${fx.vatInputId}::UUID,15,0,'standard'),
          (${fx.companyId}::UUID,${id}::UUID,${fx.apId}::UUID,0,115,NULL)`;
  return id;
}

describe('a late claim of an approved manual journal', () => {
  it('is refused (409) before approval, and posts as the s16(3) split once approved', async () => {
    const id = await lateDraft();
    expect((await r.post(u.a, fx.companyId, id)).state.statusCode).toBe(409);

    await r.approvedBy(pool, u.a, u.b, fx.companyId, id);
    const res = await r.post(u.a, fx.companyId, id);
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    const posted = dataOf<{ lateClaim: { claimDate: string; companionEntryId: string; inputTax: number } }>(res);
    expect(posted.lateClaim).toMatchObject({ claimDate: '2026-07-01', inputTax: 15 });
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
    const lines = (await pool.query(
      `SELECT ga.account_subtype, jl.vat_type FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE jl.journal_entry_id = $1`, [id])).rows as { account_subtype: string; vat_type: string | null }[];
    expect(lines.map((l) => l.account_subtype)).toContain('vat_input_late_claim');
    expect(lines.every((l) => l.vat_type === null)).toBe(true);
    const companion = (await pool.query('SELECT status, approval_document_type FROM gl_journal_entries WHERE id = $1',
      [posted.lateClaim.companionEntryId])).rows[0];
    expect(companion).toEqual({ status: 'posted', approval_document_type: null });
    expect(await balanceOf(fx, fx.clearingId)).toBe(0);
  });
});

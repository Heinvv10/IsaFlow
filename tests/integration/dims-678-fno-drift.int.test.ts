/**
 * #678 review item 5 (Hein, 2026-10-09): the journal-posting vs project-move
 * race is closed by detection. The `project_fno_mismatch` integrity check flags
 * every journal and bank line whose stored CC1 is not the FNO its CC2 derives
 * through the CURRENT parent chain — company-scoped, against real Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runIntegrityChecks } from '@/modules/accounting/services/gl/integrityChecks';
import { dataIntegrityChecksTool } from '@/lib/mcp/tools/integrity';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { bankLine, costCentre, dropBase, inRequest, journalLine, seedBase, type Base } from './dims-678.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const AS_AT = '2026-09-30';
let b: Base;
let ob: Base;
const ids: Record<string, string> = {};

/** A line on `base` carrying cc2 and (maybe) cc1, written as one INSERT like a posting would. */
const tagged = async (base: Base, kind: 'journal' | 'bank', cc2: string, cc1: string | null) => {
  const id = kind === 'journal' ? await journalLine(pool, base, 'cc2_id', cc2) : await bankLine(pool, base, 'cc2_id', cc2);
  await pool.query(`UPDATE ${kind === 'journal' ? 'gl_journal_lines' : 'bank_transactions'} SET cc1_id = $2 WHERE id = $1`, [id, cc1]);
  return id;
};

const flagged = async (companyId: string, base: Base) => inRequest(pool, base, async () => {
  const report = await runIntegrityChecks(companyId, { asAt: AS_AT, limit: 100, checks: ['project_fno_mismatch'] });
  const check = report.checks[0]!;
  return { count: check.count, amount: check.amount, ids: check.sample.map((s) => s.id).sort(), sample: check.sample };
});

beforeAll(async () => {
  b = await seedBase(pool, company, user);
  ob = await seedBase(pool, other, user);
  // F1 > PROG (programme CC2) > PROJ ; F2 a second FNO.
  ids.f1 = await costCentre(pool, company, 'D-F1');
  ids.f2 = await costCentre(pool, company, 'D-F2');
  ids.prog = await costCentre(pool, company, 'D-PROG', 'cc2', ids.f1);
  ids.proj = await costCentre(pool, company, 'D-PROJ', 'cc2', ids.prog);
  ids.consistent = await tagged(b, 'journal', ids.proj, ids.f1);
  ids.wrongJournal = await tagged(b, 'journal', ids.proj, ids.f2);
  ids.missingCc1 = await tagged(b, 'journal', ids.proj, null);
  ids.wrongBank = await tagged(b, 'bank', ids.proj, ids.f2);
  // A feed row the bank withdrew: never posted, never allocated (a posted row cannot become removed).
  const conn = (await pool.query(
    `INSERT INTO bank_feed_connections(company_id, bank_account_id, provider, status, is_active)
     VALUES($1, $2, 'test_provider', 'active', true) RETURNING id`, [company, b.bank])).rows[0].id as string;
  ids.removedBank = (await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status,
       bank_feed_connection_id, provider_transaction_id, feed_state, cc1_id, cc2_id)
     VALUES($1, $2, '2026-08-01', 10, 'D678 removed', 'imported', $3, 'd678-removed', 'removed', $4, $5) RETURNING id`,
    [company, b.bank, conn, ids.f2, ids.proj])).rows[0].id as string;
  // Another company: its own ladder and its own mismatched line.
  ids.of1 = await costCentre(pool, other, 'D-F1');
  ids.of2 = await costCentre(pool, other, 'D-F2');
  ids.oproj = await costCentre(pool, other, 'D-PROJ', 'cc2', ids.of1);
  ids.otherWrong = await tagged(ob, 'journal', ids.oproj, ids.of2);
}, 60000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_transactions WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id = $1', [company]);
    await dropBase(pool, [company, other], [user]);
  } finally { await pool.end(); }
}, 60000);

describe('project_fno_mismatch', () => {
  it('flags the mismatched and CC1-less lines (journal and bank), not the consistent one, not a removed feed row, not another company\'s', async () => {
    const r = await flagged(company, b);
    expect(r.ids).toEqual([ids.wrongJournal, ids.missingCc1, ids.wrongBank].sort());
    expect(r.count).toBe(3);
    expect(r.amount).toBe(30); // 10 + 10 + 10: every failing row, not the sample
    expect(r.sample.find((s) => s.id === ids.wrongJournal)!.detail).toBe('journal line: project D-PROJ stores FNO D-F2, derives D-F1');
    expect(r.sample.find((s) => s.id === ids.wrongBank)!.detail).toBe('bank line: project D-PROJ stores FNO D-F2, derives D-F1');
  });

  it('flags the other company\'s line in its own report only', async () => {
    const r = await flagged(other, ob);
    expect(r.ids).toEqual([ids.otherWrong]);
  });

  it('flags a line committed under the old FNO once its project has moved (the race it closes)', async () => {
    const proj = await costCentre(pool, company, 'D-MOVE', 'cc2', ids.f1);
    const line = await tagged(b, 'journal', proj, ids.f1);
    expect((await flagged(company, b)).ids).not.toContain(line);
    await pool.query('UPDATE cost_centres SET parent_id = $2 WHERE id = $1', [proj, ids.f2]);
    expect((await flagged(company, b)).ids).toContain(line);
  });

  it('reaches the MCP data_integrity_checks tool', async () => {
    const ctx = { companyId: company, userId: user, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null } as unknown as McpToolContext;
    const out = await inRequest(pool, b, () => dataIntegrityChecksTool.handler({ checks: ['project_fno_mismatch'], as_at: AS_AT }, ctx));
    expect(out.isError).toBeFalsy();
    const body = JSON.parse(out.content[0]!.text) as { rows: { id: string; count: number }[] };
    expect(body.rows[0]).toMatchObject({ id: 'project_fno_mismatch' });
    expect(body.rows[0]!.count).toBeGreaterThanOrEqual(3);
  });
});

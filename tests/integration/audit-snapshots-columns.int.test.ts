/**
 * Column census for the frozen journal and line rows (breaker r1 F2): every column of gl_journal_entries and
 * gl_journal_lines is either in the snapshot's canonical row — so a later change to it shows as "changed" and
 * breaks the material hash — or named here as not material, with the reason. A column added later fails this until
 * someone decides which. The decisions live in tests/helpers/auditSnapshotColumns.ts (the unit census reads them too).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { members, newCompany } from './entity-changes.helpers';
import { cleanupAudit, plantJournal, plantLedger } from './audit-snapshots.helpers';
import { runAuditTx } from '../../src/modules/accounting/services/audit/auditTx';
import { journalRows, lineRows } from '../../src/modules/accounting/services/audit/snapshotRows';
import { NOT_MATERIAL, RENAMED } from '../helpers/auditSnapshotColumns';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '';
beforeAll(async () => { [o] = await members(pool, tokens, 1); });
afterAll(() => cleanupAudit(pool, companies, [o]));

async function columns(table: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`, [table]);
  return rows.map((r) => r.column_name as string);
}

describe('frozen columns', () => {
  it('every journal and line column is frozen or named as not material', async () => {
    const c = await newCompany(pool, [[o, 'owner']], companies);
    const l = await plantLedger(pool, c);
    await plantJournal(pool, c, { date: '2026-03-10', amount: 10, debit: l.bank, credit: l.sales, by: o });
    const p = { userId: o, companyId: c, claims: { sub: o, session_id: crypto.randomUUID() } };
    const [j, ln] = await runAuditTx(p, 'READ COMMITTED', async () =>
      [await journalRows(c, '2026-12-31'), await lineRows(c, '2026-12-31')] as const);
    for (const [table, keys] of [['gl_journal_entries', Object.keys(j[0]!.row)], ['gl_journal_lines', Object.keys(ln[0]!.row)]] as const) {
      const unaccounted = (await columns(table)).filter((col) => !keys.includes(RENAMED[col] ?? col) && !(col in NOT_MATERIAL[table]!));
      expect(unaccounted, `${table}: neither frozen nor listed as not material`).toEqual([]);
    }
  });
});

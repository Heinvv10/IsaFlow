/**
 * The bank-row sync against a concurrent writer (PR #698 round 2, breaker H2 /
 * H3): the live path locks the candidate rows between its read and its write, so
 * another request cannot slip a change in; and a row that did change is never
 * overwritten — the sync throws and nothing of the batch is left.
 *
 * `@/lib/neon`'s sql is wrapped so a hook fires straight after the candidate
 * SELECT (the window between the read and the write), passing every statement
 * through otherwise. Disposable databases only.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asToken } from './bank-controls-a.helpers';
import {
  allocate, bankDims, cleanupSync, json, mcpAs, newKey, setBankDims, syncFixture, type SyncFixture,
} from './bank-dimension-sync.helpers';
import { writeBankRows } from '../../src/modules/accounting/services/gl/dimensions/dimensionBankSync';
import { sql } from '../../src/lib/neon';

const hooks = vi.hoisted(() => ({ afterCandidateSelect: null as null | (() => Promise<void>), fired: 0 }));

vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>;
  const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const hook = hooks.afterCandidateSelect;
    const text = strings.join('?');
    if (!hook || !text.includes('FROM bank_transactions bt') || !text.includes('ORDER BY bt.id')) return realSql(strings, ...values);
    hooks.afterCandidateSelect = null;
    return (async () => {
      const rows = await realSql(strings, ...values);
      hooks.fired += 1;
      await hook();
      return rows;
    })();
  };
  return { ...real, sql: Object.assign(wrapped, realSql) };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const other = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};
const mcp = mcpAs(pool);
afterAll(async () => { await other.end(); await cleanupSync(pool, companies, users); });

const WINDOW = { date_from: '2026-01-01', date_to: '2026-12-31' };
async function fresh(): Promise<SyncFixture> {
  const f = await syncFixture(pool, tokens, companies);
  users.push(f.user);
  return f;
}
const code = (f: SyncFixture, k: string) => `${k}${f.c.slice(0, 6)}`;
const counts = async (f: SyncFixture) => (await pool.query(
  `SELECT (SELECT COUNT(*) FROM dimension_tag_batches WHERE company_id = $1)::INT AS batches,
          (SELECT COUNT(*) FROM dimension_tag_batch_bank_rows WHERE company_id = $1)::INT AS bank_rows`, [f.c])).rows[0] as
  { batches: number; bank_rows: number };

describe('the candidate rows are locked from the read to the commit', () => {
  it('a writer that tries a candidate row between the SELECT and the UPDATE is made to wait, and the sync lands whole', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    let outcome = 'not run';
    hooks.fired = 0;
    hooks.afterCandidateSelect = async () => {
      const c = await other.connect();
      try {
        await c.query("SET lock_timeout = '400ms'");
        await c.query('UPDATE bank_transactions SET bu_id = $2 WHERE id = $1', [a.tx, f.bu.B2]);
        outcome = 'updated';
      } catch (err) {
        outcome = (err as { code?: string }).code ?? String(err);
      } finally {
        await c.query('RESET lock_timeout');
        c.release();
      }
    };
    const res = await mcp(f.user, f.c, 'sync_bank_dimensions', { ...WINDOW, idempotency_key: newKey('lock') });
    expect(hooks.fired).toBe(1);
    expect(outcome).toBe('55P03');
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(json<{ bank_rows_synced: number }>(res).bank_rows_synced).toBe(1);
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: null });
  });
});

describe('a row that changed since it was planned is never overwritten', () => {
  it('one stale row among fresh ones: typed error, no batch, no audit rows, every row as it was', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, { cc2: code(f, 'P1') });
    const b = await allocate(pool, f, { cc2: code(f, 'P2') });
    // The plan (what a sync read): both rows blank. Then `a` is changed by someone else.
    const blank = { cc1Id: null, cc2Id: null, buId: null };
    const planned = (tx: string, cc1: string, cc2: string) => ({
      bankTransactionId: tx, transactionDate: '2026-09-01', amount: -1150, description: 'x',
      old: blank, next: { cc1Id: cc1, cc2Id: cc2, buId: null }, blanks: [] as never[],
    });
    await setBankDims(pool, a.tx, { bu: f.bu.B2 });

    await expect(asToken(pool, f.user, f.c, async () => {
      const [batch] = (await sql`
        INSERT INTO dimension_tag_batches (company_id, idempotency_key, line_count, sync_date_from, sync_date_to)
        VALUES (${f.c}::UUID, ${newKey('stale')}, 0, DATE '2026-01-01', DATE '2026-12-31') RETURNING id::TEXT AS id`) as { id: string }[];
      await writeBankRows(f.c, batch!.id, [planned(a.tx, f.cc.F1, f.cc.P1), planned(b.tx, f.cc.F2, f.cc.P2)]);
    })).rejects.toMatchObject({ code: 'BANK_DIMENSION_SYNC_REFUSED', message: expect.stringMatching(/1 bank transaction\(s\) were changed/) });

    expect(await counts(f)).toEqual({ batches: 0, bank_rows: 0 });
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: null, cc2: null, bu: f.bu.B2 });
    expect(await bankDims(pool, b.tx)).toEqual({ cc1: null, cc2: null, bu: null });
  });
});

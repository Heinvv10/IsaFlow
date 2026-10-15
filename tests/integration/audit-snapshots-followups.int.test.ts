/**
 * Forensic-controls step 4, after the first production snapshot (Velocity Fibre, 2026-10-15):
 *  - take_audit_snapshot honours dry_run: every refusal the take makes before it writes, and the line count against
 *    the cap; nothing written, and the idempotency key stays free for the real call;
 *  - a READ tool whose SQL fails is still audited (the failed statement no longer poisons the request transaction);
 *  - migration 893: the audit tables' read policy runs the reader once per query (an InitPlan), not once per row,
 *    and shows exactly the rows 891's did.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const knobs = vi.hoisted(() => ({ lines: null as number | null }));
vi.mock('../../src/modules/accounting/services/audit/snapshotRows', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/accounting/services/audit/snapshotRows')>();
  return { ...real, countPostedLines: async (c: string, cutoff: string) => knobs.lines ?? real.countPostedLines(c, cutoff) };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { members, newCompany } from './entity-changes.helpers';
import { cleanupAudit, plantJournal, plantLedger } from './audit-snapshots.helpers';
import { mcpRun } from './audit-snapshots-mcp.helpers';
import { auditSnapshotsTool, takeAuditSnapshotTool } from '../../src/lib/mcp/tools/auditSnapshots';
import { MAX_SNAPSHOT_LINES } from '../../src/modules/accounting/services/audit/snapshotService';
import { withSnapshotSlot } from '../../src/modules/accounting/services/audit/snapshotSlots';
import { sql } from '../../src/lib/neon';
import type { McpTool } from '../../src/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', m = '', v = '', b = '';
const TOOLS = [auditSnapshotsTool, takeAuditSnapshotTool];
const TAKE = ['read:reports', 'write:journals'];
const KEY = 'f'.repeat(48);

beforeAll(async () => {
  [o, m, v, b] = await members(pool, tokens, 4);
  process.env.AUDIT_SNAPSHOT_SIGNING_KEY = KEY;
  process.env.AUDIT_SNAPSHOT_KEY_ID = 'followups-test';
});
afterAll(async () => {
  await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = ANY($1)', [companies]);
  await cleanupAudit(pool, companies, [o, m, v, b]);
});

async function company(roles: [string, string][] = [[o, 'owner'], [m, 'manager'], [v, 'viewer']]) {
  const c = await newCompany(pool, roles, companies);
  const l = await plantLedger(pool, c);
  await plantJournal(pool, c, { date: '2026-03-10', amount: 1000, debit: l.bank, credit: l.sales, by: o });
  await plantJournal(pool, c, { date: '2026-08-10', amount: 50, debit: l.expense, credit: l.bank, by: o });
  return c;
}
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const snapshots = async (c: string) =>
  (await pool.query('SELECT count(*)::int AS n FROM audit_snapshots WHERE company_id = $1', [c])).rows[0].n as number;
const calls = async (c: string, tool: string) => (await pool.query(
  'SELECT status, idempotency_key FROM mcp_tool_calls WHERE company_id = $1 AND tool = $2 ORDER BY created_at', [c, tool])).rows;
async function run(user: string, c: string, role: string, name: string, args: Record<string, unknown>, scopes = TAKE, tools = TOOLS) {
  return mcpRun(pool, tools, user, c, role, name, args, scopes);
}

describe('take_audit_snapshot dry_run', { timeout: 120_000 }, () => {
  it('previews the lines the snapshot would freeze, writes nothing, and leaves the key for the real take', async () => {
    const c = await company();
    const key = crypto.randomUUID();
    const dry = await run(o, c, 'owner', 'take_audit_snapshot', { cutoff: '2026-06-30', dry_run: true, idempotency_key: key });
    expect(dry.isError, text(dry)).toBeFalsy();
    expect(JSON.parse(text(dry))).toMatchObject({ dryRun: true, journals: [], journalsTotal: 0,
      snapshot: { cutoff: '2026-06-30', lines: 2, maxLines: MAX_SNAPSHOT_LINES } });
    expect(await snapshots(c)).toBe(0);
    // Audited, without the key: the real call that follows is not served the preview.
    expect(await calls(c, 'take_audit_snapshot')).toEqual([{ status: 'ok', idempotency_key: null }]);
    const real = await run(o, c, 'owner', 'take_audit_snapshot', { cutoff: '2026-06-30', idempotency_key: key });
    expect(JSON.parse(text(real)).snapshot).toMatchObject({ status: 'sealed', lines: 2 });
    expect(await snapshots(c)).toBe(1);
  });

  it('refuses exactly as the take does: role, size cap, missing key, busy', async () => {
    const c = await company();
    const both = async (user: string, role: string) => {
      const out: string[] = [];
      for (const dry of [true, false]) {
        const r = await run(user, c, role, 'take_audit_snapshot', { cutoff: '2026-06-30', dry_run: dry });
        expect(r.isError, `${role} dry=${dry}`).toBe(true);
        out.push(text(r));
      }
      expect(out[0], role).toBe(out[1]);
      return out[0]!;
    };
    expect(await both(m, 'manager')).toBe('Only an owner or admin can take an audit snapshot.');
    knobs.lines = MAX_SNAPSHOT_LINES + 1;
    try { expect(await both(o, 'owner')).toMatch(/^SNAPSHOT_TOO_LARGE: /); } finally { knobs.lines = null; }
    process.env.AUDIT_SNAPSHOT_SIGNING_KEY = '';
    try { expect(await both(o, 'owner')).toMatch(/^SIGNING_KEY_MISSING: /); } finally { process.env.AUDIT_SNAPSHOT_SIGNING_KEY = KEY; }
    let free = () => {};
    const held = withSnapshotSlot(c, false, () => new Promise<void>((r) => { free = r; }));
    try { expect(await both(o, 'owner')).toMatch(/^SNAPSHOT_BUSY: /); } finally { free(); await held; }
    expect(await snapshots(c)).toBe(0);
  });
});

describe('a read tool whose SQL fails', { timeout: 60_000 }, () => {
  it('is still audited: the failed statement does not poison the request transaction', async () => {
    const c = await company();
    const boom: McpTool = {
      name: 'followups_boom', description: 'fails in SQL', scope: 'read:reports', write: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => { await sql`SELECT 1 / 0`; return { content: [{ type: 'text', text: '"unreachable"' }] }; },
    };
    const r = await run(o, c, 'owner', 'followups_boom', {}, ['read:reports'], [boom]);
    expect(r.isError).toBe(true);
    expect(await calls(c, 'followups_boom')).toEqual([{ status: 'error', idempotency_key: null }]);
  });
});

describe('migration 893', { timeout: 120_000 }, () => {
  const TABLES = ['audit_check_runs', 'audit_check_results', 'audit_snapshots', 'audit_snapshot_tb', 'audit_snapshot_journals',
    'audit_snapshot_lines'];

  /** `fn` as app_user with `user`'s claims and `c` as the company GUC; rolled back. */
  async function asMember<T>(user: string, c: string | null, fn: (q: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c ?? '']);
      await client.query('SET LOCAL ROLE app_user');
      return await fn((t, vals) => client.query(t, vals));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('the reader runs once per query (an InitPlan), not once per row', async () => {
    const c = await company();
    await run(o, c, 'owner', 'take_audit_snapshot', { cutoff: '2026-06-30' });
    for (const t of TABLES) {
      const plan = await asMember(o, c, async (q) =>
        (await q(`EXPLAIN (COSTS OFF) SELECT * FROM ${t}`)).rows.map((r) => String(r['QUERY PLAN'])).join('\n'));
      expect(plan, t).toMatch(/InitPlan/);
      expect(plan, t).not.toMatch(/audit_snapshot_reader\(company_id\)/);
    }
  });

  it('shows exactly what 891 showed: the reader roles of the session company, nothing for a viewer, another company or no company', async () => {
    const c = await company();
    const other = await company([[o, 'owner']]);
    for (const x of [c, other]) await run(o, x, 'owner', 'take_audit_snapshot', { cutoff: '2026-06-30' });
    const seen = (user: string, gucCompany: string | null) => asMember(user, gucCompany, async (q) => {
      const out: Record<string, string[]> = {};
      for (const t of TABLES) out[t] = (await q(`SELECT DISTINCT company_id::text AS c FROM ${t} ORDER BY 1`)).rows.map((r) => String(r.c));
      return out;
    });
    const only = (x: string[]) => Object.fromEntries(TABLES.map((t) => [t, x]));
    expect(await seen(o, c)).toEqual(only([c]));
    expect(await seen(m, c)).toEqual(only([c]));
    expect(await seen(v, c)).toEqual(only([]));
    expect(await seen(o, null)).toEqual(only([]));
    // The owner of both, pointed at one, sees that one only.
    expect(await seen(o, other)).toEqual(only([other]));
    // A member of c only, pointed at the other company, sees nothing.
    expect(await seen(m, other)).toEqual(only([]));
  });

  it('a company GUC changed in mid-query cannot pair one company\'s rows with another\'s membership (breaker L3)', async () => {
    const c = await company();
    const bOwn = await company([[b, 'owner']]);
    for (const x of [c, bOwn]) await run(x === c ? o : b, x, 'owner', 'take_audit_snapshot', { cutoff: '2026-06-30' });
    // b owns bOwn and is no member of c. Row 1 points the GUC at c and fetches nothing; row 2 points it at bOwn and
    // rescans. A policy that read the GUC twice kept c from the first read and checked membership for bOwn.
    const probe = async (twoReads: boolean) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (twoReads) {
          await client.query('DROP POLICY audit_check_runs_read ON public.audit_check_runs');
          await client.query(`CREATE POLICY audit_check_runs_read ON public.audit_check_runs FOR SELECT TO app_user USING (
            company_id = (SELECT app.current_company_id()) AND (SELECT public.audit_snapshot_reader(app.current_company_id())))`);
        }
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: b, role: 'authenticated' })]);
        await client.query('SET LOCAL ROLE app_user');
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_bitmapscan = off');
        const { rows } = await client.query(`SELECT r.company_id::text AS c
          FROM (VALUES (1, 'infinity'::timestamptz, $1::text), (2, '-infinity'::timestamptz, $2::text)) v(n, t, g),
          LATERAL (SELECT set_config('app.current_company_id', v.g, true) AS s OFFSET 0) s,
          LATERAL (SELECT r.company_id FROM audit_check_runs r WHERE r.taken_at > v.t AND s.s IS NOT NULL OFFSET 0) r`, [c, bOwn]);
        return rows.map((r) => String(r.c));
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    // The probe works: the two-read form shows c's runs to b ...
    expect(await probe(true)).toContain(c);
    // ... and 893's one-read form does not.
    expect(await probe(false)).not.toContain(c);
  });

  it('its self-check refuses a read policy that is not the once-per-query reader', async () => {
    const sqlText = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/893_audit_snapshot_rls_once_per_query.sql'), 'utf8');
    const check = sqlText.slice(sqlText.indexOf('DO $$', sqlText.indexOf('-- Every audit table still has')));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(check);
      await client.query('DROP POLICY audit_snapshot_lines_read ON public.audit_snapshot_lines');
      await client.query('CREATE POLICY audit_snapshot_lines_read ON public.audit_snapshot_lines FOR SELECT TO app_user USING (true)');
      await expect(client.query(check)).rejects.toThrow(/migration 893/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

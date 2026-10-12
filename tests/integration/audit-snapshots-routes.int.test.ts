/**
 * Forensic-controls step 4 — the snapshot, check-run and comparison routes and
 * the MCP tools, as people and agents reach them:
 *  - owner / admin take (a person in their own session; Login-as refused),
 *    manager reads and compares, viewer is refused everything;
 *  - another company's snapshot is not found;
 *  - typed refusals: the size cap (413) and a missing key (503);
 *  - MCP: read tools for owner / admin / manager; take needs write:journals
 *    and owner / admin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import auditSnapshots from '../../pages/api/accounting/audit-snapshots';
import auditCheckRuns from '../../pages/api/accounting/audit-check-runs';
import auditComparisons from '../../pages/api/accounting/audit-comparisons';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { members, newCompany } from './entity-changes.helpers';
import { cleanupAudit, plantJournal, plantLedger } from './audit-snapshots.helpers';
import { mcpRun } from './audit-snapshots-mcp.helpers';
import { auditSnapshotsTool, compareAuditSnapshotTool, takeAuditSnapshotTool } from '../../src/lib/mcp/tools/auditSnapshots';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '', v = '', x = '';
const TOOLS = [auditSnapshotsTool, compareAuditSnapshotTool, takeAuditSnapshotTool];

beforeAll(async () => {
  [o, a, m, v, x] = await members(pool, tokens, 5);
  process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'r'.repeat(48);
  process.env.AUDIT_SNAPSHOT_KEY_ID = 'routes-test';
});
afterAll(() => cleanupAudit(pool, companies, [o, a, m, v, x]));

async function company() {
  const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer']], companies);
  const l = await plantLedger(pool, c);
  await plantJournal(pool, c, { date: '2026-03-10', amount: 1000, debit: l.bank, credit: l.sales, by: o });
  return c;
}
const snap = (user: string, c: string, method: string, body?: unknown, query: Record<string, string> = {}, token = tokens[user]!) =>
  callRoute(auditSnapshots, token, c, method, body, '/api/accounting/audit-snapshots', query);
const take = (user: string, c: string, token?: string) => snap(user, c, 'POST', { cutoff: '2026-06-30' }, {}, token);
const reason = (r: { state: { body: unknown } }) => (r.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason;

describe('routes', { timeout: 120_000 }, () => {
  it('owner and admin take; manager and viewer may not; Login-as may not', async () => {
    const c = await company();
    for (const u of [o, a]) expect((await take(u, c)).state.statusCode, u).toBe(201);
    expect((await take(m, c)).state.statusCode).toBe(403);
    expect((await take(v, c)).state.statusCode).toBe(403);
    const imp = await take(o, c, await impersonationToken(pool, o, x));
    expect([imp.state.statusCode, reason(imp)]).toEqual([403, 'IMPERSONATION_FORBIDDEN']);
    const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM audit_snapshots WHERE company_id = $1', [c]);
    expect(n.n).toBe(2);
  });

  it('owner, admin and manager read, verify and compare; a viewer reads nothing', async () => {
    const c = await company();
    const id = (dataOf<{ snapshot: { id: string } }>(await take(o, c))).snapshot.id;
    for (const u of [o, a, m]) {
      const list = dataOf<{ snapshots: { id: string }[] }>(await snap(u, c, 'GET'));
      expect(list.snapshots.map((s) => s.id), u).toEqual([id]);
      const detail = dataOf<{ snapshot: { status: string }; checkRun: { results: unknown[] } }>(await snap(u, c, 'GET', undefined, { id }));
      expect(detail.snapshot.status).toBe('sealed');
      expect(detail.checkRun.results).toHaveLength(24);
      const ver = dataOf<{ verification: { status: string } }>(await snap(u, c, 'GET', undefined, { id, verify: '1' }));
      expect(ver.verification.status).toBe('valid');
      const tb = dataOf<{ rows: unknown[] }>(await snap(u, c, 'GET', undefined, { id, section: 'tb' }));
      expect(tb.rows).toHaveLength(2);
      const cmp = await callRoute(auditComparisons, tokens[u]!, c, 'GET', undefined, '/api/accounting/audit-comparisons', { snapshotId: id });
      expect(cmp.state.statusCode, u).toBe(200);
    }
    expect((await snap(v, c, 'GET')).state.statusCode).toBe(403);
    expect((await snap(v, c, 'GET', undefined, { id, verify: '1' })).state.statusCode).toBe(403);
    expect((await callRoute(auditComparisons, tokens[v]!, c, 'GET', undefined, '/x', { snapshotId: id })).state.statusCode).toBe(403);
  });

  it("another company's snapshot is not found, and is not compared", async () => {
    const c = await company();
    const id = (dataOf<{ snapshot: { id: string } }>(await take(o, c))).snapshot.id;
    const other = await newCompany(pool, [[o, 'owner']], companies);
    expect((await snap(o, other, 'GET', undefined, { id })).state.statusCode).toBe(404);
    const cmp = await callRoute(auditComparisons, tokens[o]!, other, 'GET', undefined, '/x', { snapshotId: id });
    expect([cmp.state.statusCode, reason(cmp)]).toEqual([400, 'COMPARISON_REFUSED']);
  });

  it('typed refusals: a missing key is 503, a bad or impossible date 422', async () => {
    const c = await company();
    process.env.AUDIT_SNAPSHOT_SIGNING_KEY = '';
    try {
      const r = await take(o, c);
      expect([r.state.statusCode, reason(r)]).toEqual([503, 'SIGNING_KEY_MISSING']);
    } finally { process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'r'.repeat(48); }
    expect((await snap(o, c, 'POST', { cutoff: '30/06/2026' })).state.statusCode).toBe(422);
    // A well-formed but impossible day is refused before the ::DATE cast, not a 500.
    expect((await snap(o, c, 'POST', { cutoff: '2026-02-30' })).state.statusCode).toBe(422);
    expect((await callRoute(auditCheckRuns, tokens[o]!, c, 'POST', { asAt: '2026-04-31' }, '/x')).state.statusCode).toBe(422);
  });

  it('check runs: owner runs one on its own; manager reads it; viewer neither', async () => {
    const c = await company();
    const run = await callRoute(auditCheckRuns, tokens[o]!, c, 'POST', { asAt: '2026-06-30' }, '/api/accounting/audit-check-runs');
    expect(run.state.statusCode).toBe(201);
    const id = dataOf<{ run: { id: string } }>(run).run.id;
    expect((await callRoute(auditCheckRuns, tokens[m]!, c, 'POST', { asAt: '2026-06-30' }, '/x')).state.statusCode).toBe(403);
    const got = dataOf<{ run: { results: unknown[]; purpose: string } }>(await callRoute(auditCheckRuns, tokens[m]!, c, 'GET', undefined, '/x', { id }));
    expect([got.run.results.length, got.run.purpose]).toEqual([24, 'standalone']);
    expect((await callRoute(auditCheckRuns, tokens[v]!, c, 'GET', undefined, '/x')).state.statusCode).toBe(403);
  });
});

describe('MCP', { timeout: 120_000 }, () => {
  const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

  it('take needs write:journals and owner / admin; the reads serve owner, admin and manager, not a viewer', async () => {
    const c = await company();
    const noScope = await mcpRun(pool, TOOLS, o, c, 'owner', 'take_audit_snapshot', { cutoff: '2026-06-30' }, ['read:reports']);
    expect(noScope.isError).toBe(true);
    const mgr = await mcpRun(pool, TOOLS, m, c, 'manager', 'take_audit_snapshot', { cutoff: '2026-06-30' }, ['read:reports', 'write:journals']);
    expect([mgr.isError, text(mgr)]).toEqual([true, 'Only an owner or admin can take an audit snapshot.']);
    const taken = await mcpRun(pool, TOOLS, o, c, 'owner', 'take_audit_snapshot', { cutoff: '2026-06-30' }, ['read:reports', 'write:journals']);
    expect(taken.isError, text(taken)).toBeFalsy();
    const id = (JSON.parse(text(taken)) as { snapshot: { id: string } }).snapshot.id;
    const { rows: [s] } = await pool.query('SELECT channel, taken_by FROM audit_snapshots WHERE id = $1', [id]);
    expect(s).toEqual({ channel: 'token', taken_by: o });
    for (const [u, role] of [[o, 'owner'], [a, 'admin'], [m, 'manager']] as const) {
      const ver = await mcpRun(pool, TOOLS, u, c, role, 'audit_snapshots', { snapshot_id: id, verify: true }, ['read:reports']);
      expect(JSON.parse(text(ver)).verification.status, u).toBe('valid');
      const cmp = await mcpRun(pool, TOOLS, u, c, role, 'compare_audit_snapshot', { snapshot_id: id }, ['read:reports']);
      expect(JSON.parse(text(cmp)).comparison.counts.changed, u).toBe(0);
    }
    const viewer = await mcpRun(pool, TOOLS, v, c, 'viewer', 'audit_snapshots', {}, ['read:reports']);
    expect(viewer.isError).toBe(true);
  });
});

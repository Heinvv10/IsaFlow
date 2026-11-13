/**
 * update_company_profile on a real database, through a real McpRegistry, in a request transaction as app_user with
 * the company's GUCs (as withAuth runs it): the companies UPDATE grant and RLS, the company row lock, the filing
 * footprint over vat_returns / vat_period_locks, the dry run that rolls its write back and
 * leaves the idempotency key free, the acknowledgement gate, and the undo from the reply's before values.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { McpRegistry } from '@/lib/mcp/registry';
import type { McpToolResult } from '@/lib/mcp/types';
import { updateCompanyProfileTool } from '@/lib/mcp/tools/writeCompanyProfile';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { asApp, asOwner, seedTenants } from './helpers/transferLinkLogHarness';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = randomUUID();
const other = randomUUID();
const user = randomUUID();
const otherUser = randomUUID();
const registry = new McpRegistry();
registry.register(updateCompanyProfileTool);
const key = () => randomUUID();

interface Reply { isError: boolean; text: string; body: Record<string, unknown> | null }

async function call(args: Record<string, unknown>, role = 'owner', companyId = company): Promise<Reply> {
  const r: McpToolResult = await asApp(companyId, user, () => registry.call('update_company_profile', args, {
    userId: user, companyId, scopes: ['read:vat', 'write:vat'], companyRole: role, tokenJti: null, oauthAppId: null,
  }));
  const text = r.content[0]!.text;
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }
  return { isError: r.isError === true, text, body };
}

async function row(id = company) {
  return (await pool.query(`SELECT vat_number, tax_number, vat_period, vat_period_alignment, vat_system_type
    FROM companies WHERE id = $1`, [id])).rows[0] as Record<string, string | null>;
}

async function reset(id: string, over: Partial<Record<'vat_period' | 'vat_period_alignment' | 'vat_system_type', string>> = {}) {
  await pool.query(`DELETE FROM tax_return_versions WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM vat_period_locks WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM vat_returns WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM mcp_tool_calls WHERE company_id = $1`, [id]);
  await pool.query(`UPDATE companies SET vat_number = NULL, tax_number = NULL, vat_period = $2, vat_period_alignment = $3,
    vat_system_type = $4 WHERE id = $1`, [id, over.vat_period ?? 'bi-monthly', over.vat_period_alignment ?? 'odd', over.vat_system_type ?? 'invoice']);
}

async function lock(id: string, unlocked = false): Promise<string> {
  const r = await pool.query(`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat,
      posted_through, locked_by, actor_type, unlocked_at, unlocked_by, unlock_reason)
    VALUES ($1, '2026-09-01', '2026-10-31', 100, 40, 60, now(), $2, 'human', $3, $4, $5) RETURNING id`,
  [id, user, unlocked ? new Date() : null, unlocked ? user : null, unlocked ? 'amend' : null]);
  return String(r.rows[0].id);
}

beforeAll(async () => {
  assertNotProductionDb('This suite seeds companies and writes companies, vat_period_locks and mcp_tool_calls rows.');
  await seedTenants(pool, { company, other, user, otherUser });
}, 120000);

beforeEach(async () => { await reset(company); await reset(other); });

afterAll(async () => {
  try {
    for (const id of [company, other]) await reset(id);
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[user, otherUser]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, other]]);
  } finally {
    await pool.end();
  }
}, 120000);

describe('update_company_profile as app_user', () => {
  it('changes the numbers and the category through the settings write, and returns before, after and the undo', async () => {
    const r = await call({ dry_run: false, idempotency_key: key(), vat_number: '4123 456 789', income_tax_number: '9123456789', vat_category: 'B' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({
      changed: ['vat_number', 'income_tax_number', 'vat_category'],
      before: { vat_number: null, income_tax_number: null, vat_category: 'A', vat_alignment: 'odd' },
      after: { vat_number: '4123456789', income_tax_number: '9123456789', vat_category: 'B', vat_alignment: 'even' },
      undo_arguments: { vat_category: 'A' },
    });
    expect(await row()).toMatchObject({ vat_number: '4123456789', tax_number: '9123456789', vat_period: 'bi-monthly', vat_period_alignment: 'even' });
  });

  it('writes only the token company', async () => {
    await call({ dry_run: false, idempotency_key: key(), vat_number: '4123456789', vat_category: 'C' });
    expect(await row(other)).toMatchObject({ vat_number: null, vat_period: 'bi-monthly', vat_period_alignment: 'odd' });
    expect(await row()).toMatchObject({ vat_number: '4123456789', vat_period: 'monthly' });
  });

  it('refuses a company_id that is not the token company and writes nothing', async () => {
    const r = await call({ dry_run: false, idempotency_key: key(), company_id: other, vat_number: '4123456789' });
    expect(r.isError).toBe(true);
    expect(await row(other)).toMatchObject({ vat_number: null });
    expect(await row()).toMatchObject({ vat_number: null });
  });

  it.each(['manager', 'viewer'])('refuses a %s and writes nothing', async (role) => {
    const r = await call({ dry_run: false, idempotency_key: key(), vat_number: '4123456789' }, role);
    expect(r.isError).toBe(true);
    expect(await row()).toMatchObject({ vat_number: null });
  });

  it('refuses a company that is not VAT registered: no VAT number, no category', async () => {
    await reset(company, { vat_system_type: 'none', vat_period: 'none' });
    expect((await call({ dry_run: false, idempotency_key: key(), vat_number: '4123456789' })).text).toContain('not registered');
    expect((await call({ dry_run: false, idempotency_key: key(), vat_category: 'A' })).text).toContain('not registered');
    expect(await row()).toMatchObject({ vat_number: null, vat_period: 'none' });
    expect((await call({ dry_run: false, idempotency_key: key(), income_tax_number: '9123456789' })).isError).toBe(false);
  });

  it('a dry run rolls its write back, reports the after values, and leaves the key free for the live call', async () => {
    const k = key();
    const args = { idempotency_key: k, vat_number: '4123456789', vat_category: 'B' };
    const dry = await call({ ...args, dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body).toMatchObject({ dry_run: true, after: { vat_number: '4123456789', vat_category: 'B' } });
    expect(await row()).toMatchObject({ vat_number: null, vat_period_alignment: 'odd' });
    const stored = await pool.query(`SELECT 1 FROM mcp_tool_calls WHERE company_id = $1 AND idempotency_key = $2`, [company, k]);
    expect(stored.rowCount).toBe(0);
    const live = await call({ ...args, dry_run: false });
    expect(live.isError, live.text).toBe(false);
    expect(await row()).toMatchObject({ vat_number: '4123456789', vat_period_alignment: 'even' });
  });

  it('the dry run reports the current and next VAT periods under the old and the new cycle', async () => {
    const r = await call({ dry_run: true, idempotency_key: key(), vat_category: 'C' });
    const impact = r.body!.period_impact as { changes_periods: boolean; current: { old: unknown; new: { from: string; to: string } }; next: { new: { from: string } } };
    expect(impact.changes_periods).toBe(true);
    expect(impact.current.old).toMatchObject({ from: expect.stringMatching(/^\d{4}-\d{2}-01$/), to: expect.any(String) });
    expect(impact.current.new.to.slice(0, 7)).toBe(impact.current.new.from.slice(0, 7)); // monthly: one month
    expect(impact.next.new.from > impact.current.new.to).toBe(true);
  });

  it('a request that matches the company changes nothing and keeps the key free', async () => {
    const k = key();
    const r = await call({ dry_run: false, idempotency_key: k, vat_category: 'A', vat_alignment: 'odd' });
    expect(r.body).toMatchObject({ nothing_changed: true, changed: [] });
    expect((await pool.query('SELECT 1 FROM mcp_tool_calls WHERE company_id = $1 AND idempotency_key = $2', [company, k])).rowCount).toBe(0);
  });

  it('refuses malformed numbers before writing', async () => {
    for (const args of [{ vat_number: '3123456789' }, { vat_number: '412345678' }, { income_tax_number: '5123456789' }, { vat_category: 'D' }]) {
      const r = await call({ dry_run: false, idempotency_key: key(), ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(await row()).toMatchObject({ vat_number: null, tax_number: null, vat_period_alignment: 'odd' });
  });
});

describe('moving the VAT period boundaries over filed history', () => {
  const sources: [string, (id: string) => Promise<unknown>][] = [
    ['an active VAT period lock', (id) => lock(id)],
    ['a lock since unlocked for an amendment', (id) => lock(id, true)],
    ['a submitted VAT return', (id) => pool.query(`INSERT INTO vat_returns (company_id, period_start, period_end, total_output_tax, total_input_tax, net_vat)
      VALUES ($1, '2026-09-01', '2026-10-31', 100, 40, 60)`, [id])],
  ];

  it.each(sources)('refuses %s without the acknowledgement, dry run and live alike, and names the periods', async (_n, seed) => {
    await seed(company);
    for (const dry_run of [true, false]) {
      const r = await call({ dry_run, idempotency_key: key(), vat_category: 'B' });
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toContain('acknowledge_period_change: true');
      expect(r.text).toContain('2026-09-01..2026-10-31');
    }
    expect(await row()).toMatchObject({ vat_period: 'bi-monthly', vat_period_alignment: 'odd' });
  });

  it('with the acknowledgement it moves the periods, leaves the filed rows alone, and the undo arguments put the category back', async () => {
    const lockId = await lock(company);
    const dry = await call({ dry_run: true, idempotency_key: key(), vat_category: 'B', acknowledge_period_change: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(await row()).toMatchObject({ vat_period_alignment: 'odd' });
    const live = await call({ dry_run: false, idempotency_key: key(), vat_category: 'B', acknowledge_period_change: true });
    expect(live.body).toMatchObject({ after: { vat_category: 'B' }, undo_arguments: { vat_category: 'A', acknowledge_period_change: true } });
    expect(live.body!.warnings).toHaveLength(1);
    expect(await row()).toMatchObject({ vat_period_alignment: 'even' });
    const locks = await pool.query(`SELECT period_start::text, period_end::text, unlocked_at FROM vat_period_locks WHERE id = $1`, [lockId]);
    expect(locks.rows[0]).toMatchObject({ period_start: '2026-09-01', period_end: '2026-10-31', unlocked_at: null });

    const undo = await call({ dry_run: false, idempotency_key: key(), ...(live.body!.undo_arguments as Record<string, unknown>) });
    expect(undo.isError, undo.text).toBe(false);
    expect(await row()).toMatchObject({ vat_period: 'bi-monthly', vat_period_alignment: 'odd' });
  });

  it('a number-only change over filed history needs no acknowledgement', async () => {
    await lock(company);
    const r = await call({ dry_run: false, idempotency_key: key(), income_tax_number: '9123456789' });
    expect(r.isError, r.text).toBe(false);
    expect(await row()).toMatchObject({ tax_number: '9123456789', vat_period_alignment: 'odd' });
  });

  it("the footprint query scopes itself: another company's lock does not gate this one even without RLS (table owner)", async () => {
    await lock(other);
    const r: McpToolResult = await asOwner(company, user, () => registry.call('update_company_profile',
      { dry_run: false, idempotency_key: key(), vat_category: 'B' },
      { userId: user, companyId: company, scopes: ['read:vat', 'write:vat'], companyRole: 'owner', tokenJti: null, oauthAppId: null }));
    expect(r.isError, r.content[0]!.text).toBeUndefined();
    expect(await row()).toMatchObject({ vat_period_alignment: 'even' });
  });

  it("another company's filings do not gate this one", async () => {
    await lock(other);
    const r = await call({ dry_run: false, idempotency_key: key(), vat_category: 'B' });
    expect(r.isError, r.text).toBe(false);
  });
});

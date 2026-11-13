/**
 * update_company_profile lock order, proven by outcome on two real connections (never a 40P01).
 *
 * Posting takes the SHARED VAT key and then inserts a journal (an FK KEY SHARE lock on its company);
 * lock_vat_period takes the EXCLUSIVE key and then inserts a vat_period_locks row (the same FK). The tool must
 * therefore take the VAT key BEFORE the companies row and lock that row FOR NO KEY UPDATE, or the tool (holding the
 * row, waiting for the key) and the other transaction (holding the key, waiting for the row) deadlock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { McpRegistry } from '@/lib/mcp/registry';
import type { McpToolResult } from '@/lib/mcp/types';
import { updateCompanyProfileTool } from '@/lib/mcp/tools/writeCompanyProfile';
import { lockVatPeriod } from '@/modules/accounting/services/reports/vatPeriodLockService';
import { takeVatLockExclusive, takeVatLockShared } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { asApp, seedTenants } from './helpers/transferLinkLogHarness';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = randomUUID();
const other = randomUUID();
const user = randomUUID();
const otherUser = randomUUID();
const registry = new McpRegistry();
registry.register(updateCompanyProfileTool);

/** The tool call as a request transaction as app_user; started, not awaited. */
function startTool(args: Record<string, unknown>): Promise<McpToolResult> {
  return asApp(company, user, () => registry.call('update_company_profile', { dry_run: false, idempotency_key: randomUUID(), ...args }, {
    userId: user, companyId: company, scopes: ['read:vat', 'write:company'], companyRole: 'owner', tokenJti: null, oauthAppId: null,
  }));
}

/** Resolves once some backend is waiting on an advisory lock (the tool, queued behind the other connection). */
async function toolIsWaiting(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await pool.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    if (r.rowCount) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('the tool never queued behind the VAT key');
}

const asClient = <T>(c: PoolClient, fn: () => Promise<T>): Promise<T> =>
  als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);

const row = async () => (await pool.query('SELECT vat_period_alignment FROM companies WHERE id = $1', [company])).rows[0] as { vat_period_alignment: string };
const text = (r: McpToolResult) => r.content[0]!.text;

beforeAll(async () => {
  assertNotProductionDb('This suite seeds companies and writes journals, vat_period_locks and mcp_tool_calls rows.');
  await seedTenants(pool, { company, other, user, otherUser });
}, 120000);

beforeEach(async () => {
  await pool.query('DELETE FROM vat_period_locks WHERE company_id = $1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [company]);
  await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [company]);
  await pool.query(`UPDATE companies SET vat_period = 'bi-monthly', vat_period_alignment = 'odd', vat_system_type = 'invoice' WHERE id = $1`, [company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM vat_period_locks WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[user, otherUser]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, other]]);
  } finally {
    await pool.end();
  }
}, 120000);

describe('lock order against a concurrent post and a concurrent VAT lock', () => {
  it('a post holding the shared VAT key inserts its journal while the tool waits; then the tool proceeds (no 40P01)', async () => {
    const p = await pool.connect();
    try {
      await p.query('BEGIN');
      await asClient(p, () => takeVatLockShared(company));
      const tool = startTool({ vat_category: 'B' });
      await toolIsWaiting();
      // The journal insert needs KEY SHARE on the company row: it must not wait for the tool.
      await p.query(`SET LOCAL lock_timeout = '2s'`);
      await p.query(`INSERT INTO gl_journal_entries (id, company_id, entry_date, description, status, created_by)
        VALUES ($1, $2, '2026-11-01', 'post during profile change', 'draft', $3)`, [randomUUID(), company, user]);
      await p.query('COMMIT');
      const r = await tool;
      expect(r.isError, text(r)).toBeUndefined();
    } finally {
      await p.query('ROLLBACK').catch(() => undefined);
      p.release();
    }
    expect(await row()).toMatchObject({ vat_period_alignment: 'even' });
    expect((await pool.query('SELECT 1 FROM gl_journal_entries WHERE company_id = $1', [company])).rowCount).toBe(1);
  }, 30000);

  it('lock_vat_period holding the exclusive key inserts its lock while the tool waits; the tool then sees the lock and asks for the acknowledgement (no 40P01)', async () => {
    const p = await pool.connect();
    let tool: Promise<McpToolResult>;
    try {
      await p.query('BEGIN');
      await p.query(`SET LOCAL lock_timeout = '2s'`);
      await asClient(p, () => takeVatLockExclusive(company));
      tool = startTool({ vat_category: 'B' });
      await toolIsWaiting();
      await asClient(p, () => lockVatPeriod(company, '2026-09-01', '2026-10-31',
        { outputTax: 100, inputTax: 40, netVat: 60, postedThrough: '2026-10-31T10:00:00.000Z' }, { userId: user, actorType: 'human' }));
      await p.query('COMMIT');
    } catch (err) {
      await p.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      p.release();
    }
    const r = await tool;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('acknowledge_period_change: true');
    expect(text(r)).toContain('vat_period_lock 2026-09-01..2026-10-31');
    expect(await row()).toMatchObject({ vat_period_alignment: 'odd' });
  }, 30000);
  it('a path holding the shared VAT key that then UPDATEs the company row is not deadlocked either (the order itself, whatever the row-lock mode)', async () => {
    const p = await pool.connect();
    try {
      await p.query('BEGIN');
      await asClient(p, () => takeVatLockShared(company));
      const tool = startTool({ vat_category: 'B' });
      await toolIsWaiting();
      await p.query(`SET LOCAL lock_timeout = '2s'`);
      await p.query(`UPDATE companies SET website = 'https://example.invalid' WHERE id = $1`, [company]);
      await p.query('COMMIT');
      expect((await tool).isError).toBeUndefined();
    } finally {
      await p.query('ROLLBACK').catch(() => undefined);
      p.release();
    }
  }, 30000);

  it('the row lock is FOR NO KEY UPDATE: a concurrent FK KEY SHARE on the company does not make a number-only change wait', async () => {
    const p = await pool.connect();
    try {
      await p.query('BEGIN');
      await p.query('SELECT id FROM companies WHERE id = $1 FOR KEY SHARE', [company]);
      const tool = startTool({ income_tax_number: '9123456789' });
      const first = await Promise.race([tool, new Promise<'waited'>((res) => setTimeout(() => res('waited'), 3000))]);
      expect(first).not.toBe('waited');
      await p.query('COMMIT');
      await tool;
    } finally {
      await p.query('ROLLBACK').catch(() => undefined);
      p.release();
    }
  }, 30000);
});

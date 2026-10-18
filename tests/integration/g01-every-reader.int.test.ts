/**
 * G-01 review: pin EVERY reader the census marks "exclude", not the eight the first suite reached.
 *
 * Tenant X posts the year-end close for FY2025; tenant Y is identical and never closes. Each reader
 * in tests/integration/helpers/g01Readers.ts is run for both, in four ledger states, and its output
 * (with ids and timestamps scrubbed) must be EQUAL. Anchors stop a reader that errors or returns
 * nothing for both from passing: its output has to contain the fixture's own figures. A reader
 * that forgets to skip the close reads it on X and not on Y, so its mutant fails here by name.
 *
 * States: the close posted; the close reversed and posted again; and a reopened closed year (the
 * close sits inside an OPEN financial year's window, which is what the budget routes read).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newTenant, seedTenant, cleanupTenant, type G01Tenant } from './helpers/g01Fixture';

vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/rateLimit', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkRateLimit: vi.fn(async () => true),
  checkReportRateLimit: vi.fn(async () => true),
}));

import { readers } from './helpers/g01Readers';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const x = newTenant();
const y = newTenant();
// A second pair with a retained-earnings account that is not the textbook one: another code and name, and a
// decoy equity account called "Retained earnings (old)" that does NOT hold the role. The close's equity leg
// is on the role account (subtype retained_earnings), which is what the readers that exclude only that
// subtype (cash-flow page and export, management accounts) rely on.
const x2 = newTenant({ reCode: '9999', reName: 'Accumulated funds', decoy: true });
const y2 = newTenant({ reCode: '9999', reName: 'Accumulated funds', decoy: true });
const rx = readers(x, user, pool);
const ry = readers(y, user, pool);
const rx2 = readers(x2, user, pool);
const ry2 = readers(y2, user, pool);

/** Replace a tenant's own ids by their role names, then every other uuid and timestamp by a token. */
function scrub(value: unknown, ...tenants: G01Tenant[]): string {
  let text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) ?? 'undefined';
  for (const t of tenants) {
    const ids: Array<[string, string]> = [
      [t.company, 'COMPANY'], [t.group, 'GROUP'], ...(t.decoy ? [[t.decoy, 'DECOY'] as [string, string]] : []), [t.ccA, 'CCA'], [t.ccB, 'CCB'], [t.ccP, 'CCP'], [t.bu, 'BU'],
      ...Object.entries(t.acct).map(([k, v]) => [v, `ACCT_${k}`] as [string, string]),
      ...Object.entries(t.period).map(([k, v]) => [v, `PERIOD_${k}`] as [string, string]),
    ];
    for (const [uuid, role] of ids) text = text.split(uuid).join(role);
  }
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, 'TS');
}

const outputs = new Map<string, string>();
async function run(r: { name: string; run: () => Promise<unknown> }, t: G01Tenant): Promise<string> {
  try { return scrub(await r.run(), t); } catch (err) { return `ERROR ${(err as Error).message}`; }
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g01all-${user}@test.local`]);
  await seedTenant(pool, x, user, 'G01 readers');
  await seedTenant(pool, y, user, 'G01 readers');
  await seedTenant(pool, x2, user, 'G01 readers');
  await seedTenant(pool, y2, user, 'G01 readers');
}, 180000);

afterAll(async () => {
  try {
    await cleanupTenant(pool, x);
    await cleanupTenant(pool, y);
    await cleanupTenant(pool, x2);
    await cleanupTenant(pool, y2);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('baseline: Y never closed', () => {
  it.each(ry.map((r) => [r.name, r] as const))('%s returns the fixture figures', async (_n, r) => {
    const out = await run(r, y);
    outputs.set(r.name, out);
    expect(out.startsWith('ERROR')).toBe(false);
    expect(out).not.toMatch(/"success":false|"isError":true|DATABASE_ERROR/);
    for (const anchor of r.anchors) expect(out).toMatch(anchor);
  }, 60000);
});

function compareAll(label: string): void {
  describe(label, () => {
    it.each(rx.map((r, i) => [r.name, r, ry[i]!] as const))('%s equals the never-closed tenant', async (_n, a, b) => {
      const [outX, outY] = [await run(a, x), await run(b, y)];
      expect(outX.startsWith('ERROR')).toBe(false);
      // A route that answers an error body (or an MCP tool an isError result) is not "equal output".
      expect(outX).not.toMatch(/"success":false|"isError":true|DATABASE_ERROR/);
      expect(outX).toBe(outY);
    }, 60000);
  });
}

describe('state 1: the close is posted', () => {
  it('posts it on X only', async () => {
    const closed = await closeFiscalYear(x.company, '2025', user) as { alreadyClosed: boolean };
    expect(closed.alreadyClosed).toBe(false);
    await pool.query("UPDATE fiscal_periods SET status='locked' WHERE id=$1", [y.period.p25]);
    const n = await pool.query("SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=ANY($1) AND source='year_end'", [[x.company, y.company]]);
    expect(n.rows[0].n).toBe(1);
  });
});
compareAll('state 1 readers');

describe('state 2: the close is reversed and posted again', () => {
  it('leaves three year_end journals on X', async () => {
    const first = await pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND entry_number='YE-2025'", [x.company]);
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE id=$1", [x.period.p25]);
    await reverseJournalEntry(x.company, first.rows[0].id, user);
    await pool.query("UPDATE fiscal_periods SET status='closed' WHERE id=$1", [x.period.p25]);
    const again = await closeFiscalYear(x.company, '2025', user) as { alreadyClosed: boolean };
    expect(again.alreadyClosed).toBe(false);
    const n = await pool.query("SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'", [x.company]);
    expect(n.rows[0].n).toBe(3);
  }, 60000);
});
compareAll('state 2 readers');

describe('state 3: the closed year is reopened, so its window is an open financial year', () => {
  it('reopens FY2025 and closes FY2026 on both tenants', async () => {
    for (const t of [x, y]) {
      await pool.query("UPDATE fiscal_periods SET status='open' WHERE id=$1", [t.period.p25]);
      await pool.query("UPDATE fiscal_periods SET status='closed' WHERE id=$1", [t.period.p26]);
    }
  });
});
compareAll('state 3 readers');

describe('a retained-earnings account that is not 3200 "Retained Earnings", beside a decoy that merely sounds like it', () => {
  it.each(ry2.map((r) => [r.name, r] as const))('%s returns the fixture figures on the never-closed tenant', async (_n, r) => {
    const out = await run(r, y2);
    expect(out.startsWith('ERROR')).toBe(false);
    expect(out).not.toMatch(/"success":false|"isError":true|DATABASE_ERROR/);
    for (const anchor of r.anchors) expect(out).toMatch(anchor);
  }, 60000);

  it('the close puts its equity leg on the role account, not the decoy', async () => {
    // FY2025 is locked on y2 only after the close below; reopen nothing: x2 closes now.
    const closed = await closeFiscalYear(x2.company, '2025', user) as { alreadyClosed: boolean };
    expect(closed.alreadyClosed).toBe(false);
    await pool.query("UPDATE fiscal_periods SET status='locked' WHERE id=$1", [y2.period.p25]);
    const legs = await pool.query(
      `SELECT ga.account_code, ga.account_subtype FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
       JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE je.company_id=$1 AND je.source='year_end' AND ga.account_type='equity'`, [x2.company]);
    expect(legs.rows).toEqual([{ account_code: '9999', account_subtype: 'retained_earnings' }]);
  }, 60000);

  it.each(rx2.map((r, i) => [r.name, r, ry2[i]!] as const))('%s equals the never-closed tenant', async (_n, a, b) => {
    const [outX, outY] = [await run(a, x2), await run(b, y2)];
    expect(outX.startsWith('ERROR')).toBe(false);
    expect(outX).not.toMatch(/"success":false|"isError":true|DATABASE_ERROR/);
    expect(outX).toBe(outY);
  }, 60000);
});

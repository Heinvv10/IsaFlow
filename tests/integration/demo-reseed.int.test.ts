/**
 * The Demo company reseed (scripts/reseed-demo-company.ts) against the real
 * schema: wipe + seed on a dirtied Demo company, a second tenant left
 * byte-for-byte untouched, every post-check and the deploy's 16 integrity
 * checks green, the guards, the rollback, the census, and three app services
 * the production deploy gate reaches run on the reseeded data.
 *
 * Runs in the schema fixture inside ONE outer transaction rolled back in
 * afterAll (the reseed nests in a SAVEPOINT), so the shared fixture is never
 * changed. Run it as a superuser and as production's non-superuser BYPASSRLS
 * `postgres`: both must pass.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { DEMO, OTHER, changed, checksums, companies, dirtyDemo, q, rowsFor } from './helpers/demoReseedFixture';
import { runReseed, type RunOptions } from '../../scripts/lib/demoReseed/run';
import { runPostChecks, deployChecks } from '../../scripts/lib/demoReseed/postCheck';
import { txOver } from '../../scripts/lib/demoReseed/db';
import { windowFor } from '../../scripts/lib/demoReseed/dates';
import { WIPE_STEPS, BALANCE_CACHE_STEP } from '../../scripts/lib/demoReseed/wipePlan';
import { withAppContext } from '../../scripts/lib/demoReseed/appContext';
import { reserveNextDocumentNumber } from '@/modules/accounting/services/core/companySettingsService';
import { calculatePayrollRun, createPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { runDepreciation } from '@/modules/accounting/services/items/depreciationRunService';

const TODAY = '2026-11-16';
let c: pg.Client;
let dirty: Awaited<ReturnType<typeof dirtyDemo>>;
let demoBefore: Record<string, string>;
let otherBefore: Record<string, string>;
let lines: string[] = [];
const ACTOR = 'a0000000-0000-0000-0000-000000000001';

function run(over: Partial<RunOptions> = {}) {
  lines = [];
  return runReseed({ companyId: DEMO, mode: 'run', seed: 7, today: TODAY, client: c, out: (l) => lines.push(l), ...over });
}

async function inSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  await c.query('SAVEPOINT probe');
  try { return await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT probe'); }
}

beforeAll(async () => {
  assertDisposable();
  c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');
  await companies(c);
  await rowsFor(c, OTHER, 'Other', { invoiceDay: '2025-05-05', journalDay: '2025-05-06', runYear: 2025 });
  dirty = await dirtyDemo(c);
  demoBefore = await checksums(c, DEMO);
  otherBefore = await checksums(c, OTHER);
}, 120_000);

afterAll(async () => {
  if (!c) return;
  await c.query('ROLLBACK');
  await c.end();
});

describe('Demo reseed: refusals and dry run change nothing', () => {
  it('dry run counts the dirt and writes nothing', async () => {
    const r = await run({ mode: 'dry-run' });
    expect(r.exitCode).toBe(0);
    expect(r.deleted.customers).toBeGreaterThanOrEqual(2);
    expect(r.inserted.customer_invoices).toBeGreaterThan(200);
    expect(changed(demoBefore, await checksums(c, DEMO))).toEqual([]);
    expect(changed(otherBefore, await checksums(c, OTHER))).toEqual([]);
  }, 120_000);

  it('refuses the other tenant and changes nothing', async () => {
    expect((await run({ companyId: OTHER })).exitCode).toBe(2);
    expect(lines.join('\n')).toMatch(/only the Demo company/);
    expect(changed(otherBefore, await checksums(c, OTHER))).toEqual([]);
  });

  it('refuses when a table holds Demo rows and is in neither list (census)', async () => {
    await inSavepoint(async () => {
      await c.query('CREATE TABLE zz_probe (id uuid, company_id uuid)');
      await c.query('INSERT INTO zz_probe VALUES (gen_random_uuid(), $1)', [DEMO]);
      expect((await run()).exitCode).toBe(2);
      expect(lines.join('\n')).toMatch(/zz_probe/);
    });
    expect(changed(demoBefore, await checksums(c, DEMO))).toEqual([]);
  }, 120_000);

  it('refuses before any write when supplier payment approval is enforced', async () => {
    await inSavepoint(async () => {
      await c.query(`INSERT INTO approval_enforcement (company_id, document_type, enabled_by) VALUES ($1, 'supplier_payment', 'qa')`, [DEMO]);
      expect((await run()).exitCode).toBe(2);
      expect(lines.join('\n')).toMatch(/without forging approvals/);
    });
    expect(changed(demoBefore, await checksums(c, DEMO))).toEqual([]);
  }, 120_000);

  it('rolls everything back when a post-check fails', async () => {
    const r = await run({ extraChecks: [async () => ({ label: 'injected', status: 'fail', detail: 'test' })] });
    expect(r.exitCode).toBe(1);
    expect(changed(demoBefore, await checksums(c, DEMO))).toEqual([]);
    const [co] = await q(c)('SELECT name FROM companies WHERE id = $1', [DEMO]);
    expect(co!.name).toBe('ISAFlow Demo (Pty) Ltd');
  }, 180_000);
});

describe('Demo reseed: the real run', () => {
  let accountsBefore = 0;
  let periodsBefore: Array<Record<string, unknown>> = [];
  let auditBefore = 0;
  let firstInserted: Record<string, number> = {};

  it('reseeds with invoice and bill approval enforced (the import exemption)', async () => {
    accountsBefore = Number((await q(c)('SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1', [DEMO]))[0]!.n);
    periodsBefore = await q(c)('SELECT id, status FROM fiscal_periods WHERE company_id = $1 ORDER BY id', [DEMO]);
    auditBefore = Number((await q(c)('SELECT count(*)::int AS n FROM audit_log'))[0]!.n);
    // Enforcement plus an active rule: without the import exemption every sent invoice and approved bill would raise R035.
    await c.query(`INSERT INTO approval_enforcement (company_id, document_type, enabled_by) VALUES ($1, 'customer_invoice', 'qa'), ($1, 'supplier_invoice', 'qa')
                   ON CONFLICT DO NOTHING`, [DEMO]);
    await c.query(`INSERT INTO approval_rules (company_id, name, document_type, condition_operator, approver_role, is_active)
                   VALUES ($1, 'All invoices', 'customer_invoice', 'any', 'manager', true), ($1, 'All bills', 'supplier_invoice', 'any', 'manager', true)`, [DEMO]);
    const r = await run();
    expect(r.exitCode, lines.filter((l) => /FAIL|REFUSED/.test(l)).join('\n')).toBe(0);
    firstInserted = r.inserted;
    const [co] = await q(c)('SELECT name, trading_name FROM companies WHERE id = $1', [DEMO]);
    expect(co).toEqual({ name: 'IsaFlow Demo (Pty) Ltd', trading_name: 'IsaFlow Demo' });
  }, 300_000);

  it('leaves the other tenant byte-for-byte untouched', async () => {
    expect(changed(otherBefore, await checksums(c, OTHER))).toEqual([]);
  }, 120_000);

  it('passes every Demo post-check and every deploy integrity check', async () => {
    const report = await runPostChecks(txOver(c), { companyId: DEMO, win: windowFor(TODAY) });
    expect(report.demo.filter((x) => x.status === 'fail').map((x) => `${x.label}: ${x.lines?.join('; ')}`)).toEqual([]);
    for (const id of ['N1', 'N2', 'N3', 'N4', 'D1', 'A1', 'J1', 'J2', 'B1', 'P1', 'P2', 'V1', 'C1', 'F1']) {
      expect(report.demo.find((x) => x.label.startsWith(`${id} `))?.status, id).toBe('pass');
    }
    const deploy = await deployChecks(txOver(c));
    expect(deploy).toHaveLength(16);
    expect(deploy.filter((x) => x.status !== 'pass' && x.status !== 'info').map((x) => x.label)).toEqual([]);
  }, 120_000);

  it('keeps the chart, calendar, cost centres, budgets, append-only rows and the audit log', async () => {
    const x = q(c);
    expect(Number((await x('SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1', [DEMO]))[0]!.n)).toBe(accountsBefore);
    const periods = await x('SELECT id, status FROM fiscal_periods WHERE company_id = $1 ORDER BY id', [DEMO]);
    for (const p of periodsBefore) expect(periods.find((n) => n.id === p.id)?.status).toBe(p.status);
    expect(await x('SELECT id FROM cost_centres WHERE id = $1', [dirty.costCentre])).toHaveLength(1);
    expect(await x('SELECT id FROM budget_versions WHERE id = $1', [dirty.budget])).toHaveLength(1);
    expect(await x('SELECT id FROM tax_return_versions WHERE id = $1', [dirty.trv])).toHaveLength(1);
    expect(await x('SELECT id FROM sars_submissions WHERE id = $1', [dirty.submission])).toHaveLength(1);
    expect(await x(`SELECT id FROM imap_mirror_connections WHERE company_id = $1 AND display_name = 'Accounts inbox'`, [DEMO])).toHaveLength(1);
    expect(Number((await x('SELECT count(*)::int AS n FROM audit_log'))[0]!.n)).toBe(auditBefore);
    expect(Number((await x(`SELECT count(*)::int AS n FROM entity_changes WHERE company_id = $1 AND entity_type = 'company'`, [DEMO]))[0]!.n)).toBeGreaterThan(0);
  });

  it('is idempotent: a second run succeeds with the same counts', async () => {
    const r = await run();
    expect(r.exitCode, lines.filter((l) => /FAIL|REFUSED/.test(l)).join('\n')).toBe(0);
    expect(r.inserted).toEqual(firstInserted);
  }, 300_000);

  it('orders the wipe children-first against the live catalog', async () => {
    const pos = new Map([...WIPE_STEPS, BALANCE_CACHE_STEP].map((s, i) => [s.table, i]));
    const fks = await q(c)(`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
      FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND confdeltype NOT IN ('c', 'n') AND conrelid <> confrelid`);
    const wrong = fks.filter((f) => pos.has(String(f.child)) && pos.has(String(f.parent)) && pos.get(String(f.child))! > pos.get(String(f.parent))!);
    expect(wrong).toEqual([]);
  });
});

describe('Demo reseed: what the deploy gate reaches still works on the reseeded data', () => {
  // Each in its own savepoint, so one service's failure cannot poison the next.
  const app = <T>(fn: () => Promise<T>) => withAppContext(c, { userId: ACTOR, companyId: DEMO }, fn);

  it('reserves invoice and quote numbers above every seeded one', async () => { await inSavepoint(async () => {
    const inv = await app(() => reserveNextDocumentNumber(DEMO, 'customer_invoice'));
    const quo = await app(() => reserveNextDocumentNumber(DEMO, 'quotation'));
    expect(await q(c)('SELECT 1 FROM customer_invoices WHERE company_id = $1 AND invoice_number = $2', [DEMO, inv])).toHaveLength(0);
    await c.query(`INSERT INTO customer_quotes (company_id, quote_number, quote_date) VALUES ($1, $2, $3)`, [DEMO, quo, TODAY]);
  }); });

  it('creates and calculates the 2027-02 sandbox run with no journal blocker but approval', async () => { await inSavepoint(async () => {
    const created = await app(() => createPayrollRun(DEMO, { month: 2, year: 2027 }, ACTOR));
    await app(() => calculatePayrollRun(created.id, DEMO, ACTOR));
    const plan = await app(() => buildPayrollJournalPlan(DEMO, created.id));
    expect(plan).not.toBeNull();
    expect(plan!.blockers.map((b) => b.code).filter((code) => code !== 'run_not_approved')).toEqual([]);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
  }); }, 120_000);

  it('runs this month\'s depreciation for every seeded asset, and nothing for a month already seeded', async () => { await inSavepoint(async () => {
    const now = await app(() => runDepreciation(DEMO, ACTOR, '2026-11-30'));
    expect(now.glFailed).toBe(0);
    expect(now.processed).toBe(6);
    const again = await app(() => runDepreciation(DEMO, ACTOR, '2026-10-31'));
    expect(again.processed).toBe(0);
  }); }, 120_000);
});

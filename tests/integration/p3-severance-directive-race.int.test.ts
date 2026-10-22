/**
 * Audit 2026-10-18 P3: approving a run that pays a severance directive and
 * paying the same directive outside payroll, at once — exactly one pays.
 *
 * Both write the directive's one tax_directive_payments row (UNIQUE
 * (company_id, tax_directive_id), migration 403): the run at approval, the
 * stand-alone path before it posts its journal. Each order is made
 * deterministic by parking the first writer just after its claim, holding the
 * row uncommitted, until the second is seen waiting on it. Real routes
 * (withAuth, app_user, RLS); disposable database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const park = vi.hoisted(() => ({
  run: null as null | { hold: Promise<void>; entered: () => void },
  standalone: null as null | { hold: Promise<void>; entered: () => void },
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunDirectiveClaim', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/payroll/payrollRunDirectiveClaim')>();
  return {
    ...actual,
    claimRunSeveranceDirectives: async (...a: Parameters<typeof actual.claimRunSeveranceDirectives>) => {
      await actual.claimRunSeveranceDirectives(...a);
      const p = park.run;
      if (p) { park.run = null; p.entered(); await p.hold; }
    },
  };
});
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/gl/journalEntryCrudService')>();
  return {
    ...actual,
    createJournalEntry: async (...a: Parameters<typeof actual.createJournalEntry>) => {
      const p = park.standalone;
      if (p) { park.standalone = null; p.entered(); await p.hold; }
      return actual.createJournalEntry(...a);
    },
  };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  applyStandalone, approvedDirective, approveRun, calculatedSeverance, calculateRun, cleanSeveranceFixtures,
  createRunFor, directivePayments, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fixtures: SeveranceFixture[] = [];

function parked() {
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const inside = new Promise<void>((r) => { entered = r; });
  return { slot: { hold, entered }, inside, release: () => release() };
}

/** 'waiting' once a backend waits on a lock while inserting a directive payment. */
async function waitsOnPaymentRow(): Promise<'waiting'> {
  for (let i = 0; i < 200; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%INSERT INTO tax_directive_payments%'`);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('the second writer never waited on the payment row');
}

async function finalRunWithDirective(name: string) {
  const f = await seedRetrenchedEmployee(pool, '2026-09-30', name);
  fixtures.push(f);
  const directive = await approvedDirective(f, calculatedSeverance('2026-09-30'), 0.1, '2026-09-01');
  const sept = await createRunFor(f, 9);
  await calculateRun(f, sept);
  return { f, directive, sept };
}

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('P3: run approval and stand-alone payment of one directive, concurrently', () => {
  it('approval claims first: the stand-alone payment waits, then is refused', async () => {
    const { f, directive, sept } = await finalRunWithDirective('P3 race, approval first');
    const p = parked();
    park.run = p.slot;
    const approval = approveRun(f, sept);
    await p.inside;
    const standalone = applyStandalone(f, directive);
    const state = await Promise.race([standalone.then(() => 'finished' as const), waitsOnPaymentRow()]);
    p.release();
    const [a, s] = await Promise.all([approval, standalone]);
    expect(state).toBe('waiting');
    expect(a.statusCode).toBe(200);
    expect(s.statusCode).toBe(409);
    const paid = await directivePayments(pool, directive);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.payroll_run_id).toBe(sept);
  });

  it('the stand-alone payment claims first: approval waits, then is refused before anything is written', async () => {
    const { f, directive, sept } = await finalRunWithDirective('P3 race, stand-alone first');
    const p = parked();
    park.standalone = p.slot;
    const standalone = applyStandalone(f, directive);
    await p.inside;
    const approval = approveRun(f, sept);
    const state = await Promise.race([approval.then(() => 'finished' as const), waitsOnPaymentRow()]);
    p.release();
    const [s, a] = await Promise.all([standalone, approval]);
    expect(state).toBe('waiting');
    expect(s.statusCode).toBe(200);
    expect(a.statusCode).toBe(400);
    const paid = await directivePayments(pool, directive);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.payroll_run_id).toBeNull();
    const header = (await pool.query('SELECT status, journal_entry_id FROM payroll_run_headers WHERE id = $1', [sept])).rows[0];
    expect(header).toEqual({ status: 'calculated', journal_entry_id: null });
  });
});

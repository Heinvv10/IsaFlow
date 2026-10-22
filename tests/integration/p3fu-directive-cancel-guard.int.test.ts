/**
 * PAYE 4a follow-ups (G5): a SARS directive that has been paid cannot be
 * cancelled (or expired, or sent back to pending). Hein 2026-10-22: "paid"
 * means a tax_directive_payments row of either kind, a run's claim or a
 * stand-alone payment, while the journal that books it stands (reversing it is
 * the way back). Refused with 409, nothing written.
 *
 * The races are made deterministic by parking one side inside its
 * transaction, holding its lock, until the other is seen waiting on a lock;
 * each is judged by its outcome: no cancelled directive ever holds a standing
 * payment.
 * Real routes (withAuth, app_user, RLS); disposable database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const park = vi.hoisted(() => ({
  claim: null as null | { hold: Promise<void>; entered: () => void },
  cancel: null as null | { hold: Promise<void>; entered: () => void },
  cancelFired: 0,
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunDirectiveClaim', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/payroll/payrollRunDirectiveClaim')>();
  return {
    ...actual,
    claimRunSeveranceDirectives: async (...a: Parameters<typeof actual.claimRunSeveranceDirectives>) => {
      await actual.claimRunSeveranceDirectives(...a);
      const p = park.claim;
      if (p) { park.claim = null; p.entered(); await p.hold; }
    },
  };
});
// Parks the status change just after it has read (and, with the guard, locked)
// the directive row: the hook fires on the first statement that reads
// tax_directives FOR UPDATE, then on the UPDATE itself as a fallback, so a
// build without the guard still parks (before writing) and the test judges it.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<typeof import('@/lib/neon')>();
  const wrapper = ((s: TemplateStringsArray, ...v: unknown[]) => {
    const text = s.join('?');
    const p = park.cancel;
    if (p && /tax_directives/.test(text) && (/FOR UPDATE/i.test(text) || /^\s*UPDATE tax_directives/i.test(text))) {
      park.cancel = null;
      park.cancelFired += 1;
      if (/FOR UPDATE/i.test(text)) {
        return (async () => { const r = await real.sql(s, ...v); p.entered(); await p.hold; return r; })();
      }
      return (async () => { p.entered(); await p.hold; return real.sql(s, ...v); })();
    }
    return real.sql(s, ...v);
  }) as typeof real.sql;
  Object.assign(wrapper, real.sql);
  return { ...real, sql: wrapper };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import directiveRoute from '../../pages/api/accounting/tax-directives/[id]';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import type { Route } from './w3-01-payroll.helpers';
import {
  applyStandalone, approvedDirective, approveRun, calculatedSeverance, calculateRun, cleanSeveranceFixtures,
  createRunFor, directivePayments, reopenRun, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fixtures: SeveranceFixture[] = [];

const patch = (f: SeveranceFixture, id: string, body: Record<string, unknown>) =>
  f.call(directiveRoute as Route, 'PATCH', `/api/accounting/tax-directives/${id}`, id, { body });
const reverseJournal = (f: SeveranceFixture, id: string) =>
  f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id, action: 'reverse' } });
const runJournal = async (runId: string) =>
  String((await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [runId])).rows[0]!.journal_entry_id);
const status = async (id: string) =>
  String((await pool.query('SELECT status FROM tax_directives WHERE id = $1', [id])).rows[0]!.status);

function parked() {
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const inside = new Promise<void>((r) => { entered = r; });
  return { slot: { hold, entered }, inside, release: () => release() };
}

/** Resolves once some backend waits on a lock in a statement matching `pattern`. */
async function waitsOnLock(pattern: string): Promise<'waiting'> {
  for (let i = 0; i < 250; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
      [pattern]);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`nothing waited on a lock in ${pattern}`);
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

describe('G5: a paid directive cannot be cancelled', () => {
  it('after a run claim: 409 naming the run and how to release it; the directive stays approved', async () => {
    const { f, directive, sept } = await finalRunWithDirective('P3fu cancel after claim');
    expect((await approveRun(f, sept)).statusCode).toBe(200);
    for (const to of ['cancelled', 'expired', 'pending']) {
      const r = await patch(f, directive, { status: to });
      expect(r.statusCode, `${to}: ${JSON.stringify(r.body)}`).toBe(409);
      expect(JSON.stringify(r.body)).toMatch(/payroll run 2026-09/);
      expect(JSON.stringify(r.body)).toMatch(/[Rr]eopen/);
    }
    expect(await status(directive)).toBe('approved');
    // Re-approving an approved directive changes nothing and is allowed.
    expect((await patch(f, directive, { status: 'approved' })).statusCode).toBe(200);
    // The way out the message names (#752's reopen path): reopen the run, reverse
    // its journal, cancel, recalculate and approve; the approval releases the claim.
    expect((await reopenRun(f, sept)).statusCode).toBe(200);
    expect((await patch(f, directive, { status: 'cancelled' })).statusCode).toBe(409);
    expect((await reverseJournal(f, await runJournal(sept))).statusCode).toBe(200);
    expect((await patch(f, directive, { status: 'cancelled' })).statusCode).toBe(200);
    await calculateRun(f, sept);
    const reapproved = await approveRun(f, sept);
    expect(reapproved.statusCode, JSON.stringify(reapproved.body)).toBe(200);
    expect(await directivePayments(pool, directive)).toEqual([]);
  });

  it('after a stand-alone payment: 409 naming the payment', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-09-30', 'P3fu cancel after stand-alone');
    fixtures.push(f);
    const directive = await approvedDirective(f, 50_000, 0.2, '2026-09-01');
    expect((await applyStandalone(f, directive, '2026-09-15')).statusCode).toBe(200);
    const r = await patch(f, directive, { status: 'cancelled' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/outside payroll on 2026-09-15/);
    expect(await status(directive)).toBe('approved');
    // Reversing the payment's journal is the way back.
    const journal = String((await directivePayments(pool, directive))[0]!.journal_entry_id);
    expect((await reverseJournal(f, journal)).statusCode).toBe(200);
    expect((await patch(f, directive, { status: 'cancelled' })).statusCode).toBe(200);
  });

  it('unpaid: cancelling is allowed (200)', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-09-30', 'P3fu cancel unpaid');
    fixtures.push(f);
    const directive = await approvedDirective(f, 50_000, 0.2, '2026-09-01');
    const r = await patch(f, directive, { status: 'cancelled' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(await status(directive)).toBe('cancelled');
  });
});

describe('G5: cancel races', () => {
  it('claim first: the cancel waits on the directive row, then is refused; the claim stands', async () => {
    const { f, directive, sept } = await finalRunWithDirective('P3fu race claim first');
    const p = parked();
    park.claim = p.slot;
    const approval = approveRun(f, sept);
    await p.inside;
    const cancel = patch(f, directive, { status: 'cancelled' });
    const state = await Promise.race([cancel.then(() => 'finished' as const), waitsOnLock('%tax_directives%')]);
    p.release();
    const [a, c] = await Promise.all([approval, cancel]);
    expect(state).toBe('waiting');
    expect(a.statusCode).toBe(200);
    expect(c.statusCode).toBe(409);
    expect(await status(directive)).toBe('approved');
    expect((await directivePayments(pool, directive))[0]!.payroll_run_id).toBe(sept);
  });

  it('cancel first: the approval waits, then is refused; nothing is claimed', async () => {
    const { f, directive, sept } = await finalRunWithDirective('P3fu race cancel first');
    const p = parked();
    park.cancel = p.slot;
    const fired = park.cancelFired;
    const cancel = patch(f, directive, { status: 'cancelled' });
    await p.inside;
    const approval = approveRun(f, sept);
    const state = await Promise.race([approval.then(() => 'finished' as const), waitsOnLock('%tax_directives%')]);
    p.release();
    const [c, a] = await Promise.all([cancel, approval]);
    expect(park.cancelFired).toBe(fired + 1);
    expect(state).toBe('waiting');
    expect(c.statusCode).toBe(200);
    expect(a.statusCode).toBe(400);
    expect(await status(directive)).toBe('cancelled');
    expect(await directivePayments(pool, directive)).toEqual([]);
  });

  it('cancel first against the stand-alone payment: it waits, then is refused; nothing is paid', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-09-30', 'P3fu race cancel vs apply');
    fixtures.push(f);
    const directive = await approvedDirective(f, 50_000, 0.2, '2026-09-01');
    const p = parked();
    park.cancel = p.slot;
    const cancel = patch(f, directive, { status: 'cancelled' });
    await p.inside;
    const apply = applyStandalone(f, directive, '2026-09-15');
    const state = await Promise.race([apply.then(() => 'finished' as const), waitsOnLock('%tax_directives%')]);
    p.release();
    const [c, s] = await Promise.all([cancel, apply]);
    expect(state).toBe('waiting');
    expect(c.statusCode).toBe(200);
    expect(s.statusCode).toBe(409);
    expect(await status(directive)).toBe('cancelled');
    expect(await directivePayments(pool, directive)).toEqual([]);
  });
});

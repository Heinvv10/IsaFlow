/**
 * Budgets P5-6 reminders (spec §3f, §6 T11 "reminder dedupe across reruns") on real PostgreSQL AS
 * THE CRON'S ROLE: every connection the run opens is `isaflow_service` (the service pool's login:
 * app_service, no claims, 915's mirrors). Data committed.
 * - stages: due in 3 days (and up to the day before), due today, overdue; an open or returned slice of
 *   a draft only; a submitted slice, a slice due later and an approved version remind nobody;
 * - reruns (the same day twice, then the next day) add only a stage not sent before;
 * - one company failing does not stop the next; which companies the run takes.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const cron = vi.hoisted(() => ({ pool: null as unknown, failCompany: null as string | null }));
vi.mock('@/lib/neon', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/neon')>();
  return { ...m, getPool: () => cron.pool as ReturnType<typeof m.getPool> };
});
// One company's notify fails on demand (the isolation test); every other call is the real service.
vi.mock('@/modules/accounting/services/notifications/userNotificationService', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/modules/accounting/services/notifications/userNotificationService')>();
  return {
    ...m,
    notifyUsers: async (...args: Parameters<typeof m.notifyUsers>) => {
      if (args[0] === cron.failCompany) throw new Error('simulated notify failure');
      return m.notifyUsers(...args);
    },
  };
});

import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetHoldersFixture, type GridWorld } from './helpers/budgetHoldersFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { loadReminderCompanies, reminderStage, runSliceRemindersFor } from '@/modules/accounting/services/budgets/sliceReminders';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const cronPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
cronPool.on('connect', (c) => { void c.query('SET ROLE isaflow_service'); });
cron.pool = cronPool;
const fx = budgetHoldersFixture(pool, saveRoute);
let w: GridWorld;
let w2: GridWorld;
let holder: SetupUser;
let holder2: SetupUser;
const AS_OF = '2030-05-10';
const day = (offset: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const slices: Record<string, string> = {};

beforeAll(async () => {
  w = await fx.world();
  w2 = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
  holder2 = await fx.member(w2.u.homeCompanyId, 'manager');
  const v = await fx.version(w);
  slices.soon = await fx.hold(w, v, holder.userId, { cc1: w.cc1 }, { due: day(3) });
  slices.today = await fx.hold(w, v, holder.userId, { cc2: w.cc2 }, { due: day(0) });
  slices.late = await fx.hold(w, v, holder.userId, { bu: w.bu }, { due: day(-1) });
  slices.later = await fx.hold(w, v, holder.userId, {}, { due: day(4) });
  await fx.setStatus(slices.today, 'submitted', holder.userId);
  await fx.setStatus(slices.today, 'returned', w.u.userId, 'again');
  const v2 = await fx.version(w);
  slices.submitted = await fx.hold(w, v2, holder.userId, { cc1: w.cc1 }, { due: day(0) });
  await fx.setStatus(slices.submitted, 'submitted', holder.userId);
  const approved = await fx.version(w);
  slices.approvedVersion = await fx.hold(w, approved, holder.userId, { cc1: w.cc1 }, { due: day(0) });
  await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [approved, w.u.userId]);
  const v3 = await fx.version(w2);
  slices.other = await fx.hold(w2, v3, holder2.userId, { cc1: w2.cc1 }, { due: day(1) });
}, 120_000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await cronPool.end(); await pool.end(); }
}, 120_000);

const reminders = async (companyId: string, userId: string) => (await fx.notes(companyId, userId))
  .filter((n) => n.kind === 'budget_reminder').map((n) => n.dedupe_key).sort();
const key = (name: string, stage: string) => `budget_reminder:${slices[name]}:${stage}`;

describe('reminderStage', () => {
  it.each([[3, 'due_soon'], [1, 'due_soon'], [0, 'due'], [-1, 'overdue'], [-40, 'overdue'], [4, null]] as const)(
    'due in %i days → %s', (offset, stage) => expect(reminderStage(day(offset), AS_OF)).toBe(stage));
});

describe('the daily run as isaflow_service', () => {
  it('takes the companies with something to remind', async () => {
    const companies = await loadReminderCompanies(AS_OF);
    expect(companies).toEqual(expect.arrayContaining([w.u.homeCompanyId, w2.u.homeCompanyId]));
    expect(await loadReminderCompanies(day(-30))).not.toContain(w.u.homeCompanyId);
  });

  it('one reminder per slice per stage; reruns the same day add nothing; the next day adds only a new stage', async () => {
    const first = await runSliceRemindersFor([w.u.homeCompanyId], AS_OF);
    expect(first).toMatchObject({ companies: 1, failed: 0, reminded: 3 });
    const expected = [key('soon', 'due_soon'), key('today', 'due'), key('late', 'overdue')].sort();
    expect(await reminders(w.u.homeCompanyId, holder.userId)).toEqual(expected);
    await runSliceRemindersFor([w.u.homeCompanyId], AS_OF);
    expect(await reminders(w.u.homeCompanyId, holder.userId)).toEqual(expected);
    await runSliceRemindersFor([w.u.homeCompanyId], day(1));
    expect(await reminders(w.u.homeCompanyId, holder.userId)).toEqual([...expected, key('today', 'overdue'), key('later', 'due_soon')].sort());
  });

  it('one company failing is logged and counted; the next company still runs', async () => {
    cron.failCompany = w.u.homeCompanyId;
    try {
      const out = await runSliceRemindersFor([w.u.homeCompanyId, w2.u.homeCompanyId], AS_OF);
      expect(out).toMatchObject({ companies: 2, failed: 1 });
      expect(out.perCompany.map((r) => r.ok)).toEqual([false, true]);
    } finally { cron.failCompany = null; }
    expect(await reminders(w2.u.homeCompanyId, holder2.userId)).toEqual([key('other', 'due_soon')]);
  });
});

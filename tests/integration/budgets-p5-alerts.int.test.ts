/**
 * Budgets P5-4 (spec §3d, §6 T9, §7): `evaluateOverspend` on real PostgreSQL, as Evaluate now runs
 * it: app_user under forced RLS with an owner's claims, every case in one rolled-back request.
 * One alert and one notification per crossing however often it runs; resolve when spend falls
 * (a reversal, a raised budget); re-fire after a resolve; threshold precedence; expense accounts
 * only; committed PO spend counted; owner + admin notified, manager not; a zero budget; another
 * company untouched.
 * Seed: helpers/budgetAlertsFixture.ts (asOf 2026-04-20: FY2027 March and April are evaluated).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { evaluateOverspend } from '@/modules/accounting/services/budgets/overspendAlerts';
import { listBudgetAlerts } from '@/modules/accounting/services/budgets/budgetAlertList';
import { notifyUsers } from '@/modules/accounting/services/notifications/userNotificationService';
import { formatMoney } from '@/lib/money/formatMoney';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { approvedPo, AS_OF, dropAlertFixture, inRequest, journal, seedAlertFixture, type AlertFixture } from './helpers/budgetAlertsFixture';

// The real notifyUsers, recorded: a rerun must not even ASK to notify (the table's dedupe would hide it).
vi.mock('@/modules/accounting/services/notifications/userNotificationService', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/modules/accounting/services/notifications/userNotificationService')>();
  return { ...m, notifyUsers: vi.fn(m.notifyUsers) };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: AlertFixture;

beforeAll(async () => { f = await seedAlertFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropAlertFixture(pool, f); } finally { await pool.end(); }
});

const notifySpy = vi.mocked(notifyUsers);
const run = () => evaluateOverspend(f.a, { asOf: AS_OF });
type Row = { gl_account_id: string; cc1_id: string | null; month: string; threshold: string; resolved_at: Date | null; pct: string; fired_at: Date; id: string };
const alerts = async (c: PoolClient): Promise<Row[]> => (await c.query(
  `SELECT id::TEXT AS id, gl_account_id::TEXT AS gl_account_id, cc1_id::TEXT AS cc1_id, to_char(month, 'YYYY-MM') AS month,
          threshold::TEXT AS threshold, resolved_at, pct::TEXT AS pct, fired_at
     FROM budget_alerts WHERE company_id = $1 ORDER BY budget_alerts.gl_account_id, budget_alerts.month, budget_alerts.threshold`, [f.a])).rows as Row[];
/** Every recipient's rows: read as the superuser (app_user sees only its own, 954's read policy). */
const notes = async (c: PoolClient, user: string) => (await c.query(
  `SELECT dedupe_key, title, body, href, ref_id::TEXT AS ref_id FROM user_notifications WHERE company_id = $1 AND user_id = $2 AND kind = 'budget_alert' ORDER BY dedupe_key`,
  [f.a, user])).rows as Array<{ dedupe_key: string; title: string; body: string; href: string; ref_id: string }>;
/** April opex spend of `amount` (Dr opex, Cr bank). */
const opexSpend = (c: PoolClient, amount: number, date = '2026-04-10') =>
  journal(c, f.a, date, f.ownerA, [[f.acc.opex, amount, 0], [f.acc.bank, 0, amount]]);

describe('evaluateOverspend: one alert and one notification per crossing', () => {
  it('80 and 100 crossed in one run: both recorded, ONE notification (the 100) to owner and admin, none to the manager; a rerun announces nothing', async () => {
    await inRequest(pool, f.a, f.ownerA, async ({ client, asSuper }) => {
      notifySpy.mockClear();
      const first = await run();
      expect(first.versionId).toBe(f.vA);
      expect(first.fired.map((a) => [a.glAccountId, a.month, a.threshold])).toEqual([
        [f.acc.opex, '2026-04', 80], [f.acc.opex, '2026-04', 100],
      ]);
      expect(first.fired[1]).toMatchObject({ budget: 1000, actual: 1050, committed: 0, pct: 105, refired: false, accountCode: 'P5A-6000' });
      expect(notifySpy).toHaveBeenCalledTimes(1);
      for (const _ of [1, 2]) {
        const again = await run();
        expect(again.fired).toEqual([]);
        expect(again.resolved).toEqual([]);
      }
      expect(notifySpy).toHaveBeenCalledTimes(1);
      const rows = await alerts(client);
      expect(rows.map((r) => [r.month, r.threshold, r.resolved_at])).toEqual([['2026-04', '80', null], ['2026-04', '100', null]]);
      for (const u of [f.ownerA, f.adminA]) {
        const n = await asSuper((c) => notes(c, u));
        expect(n.map((x) => [x.dedupe_key, x.ref_id])).toEqual([[`budget_alert:${rows[1]!.id}`, rows[1]!.id]]);
      }
      expect(await asSuper((c) => notes(c, f.managerA))).toEqual([]);
      const n100 = (await notes(client, f.ownerA)).find((x) => x.dedupe_key === `budget_alert:${rows[1]!.id}`)!;
      expect(n100.title).toBe('P5A-6000 Office costs passed 100% of budget');
      expect(n100.body).toContain(`Apr 2026: actual ${formatMoney(1050)} + committed ${formatMoney(0)} = ${formatMoney(1050)} against a budget of ${formatMoney(1000)} (105%)`);
      expect(formatMoney(1050)).toBe('R\u00a01\u00a0050.00');
      expect(n100.href).toBe('/accounting/reports/budget-vs-actual?period=month&month=2026-04');
    }, (c) => opexSpend(c, 1050));
  });

  it('committed PO spend counts: actual 700 + an approved April PO of 400 is 110%', async () => {
    await inRequest(pool, f.a, f.ownerA, async () => {
      const out = await run();
      expect(out.fired.map((a) => [a.threshold, a.actual, a.committed, a.pct])).toEqual([[80, 700, 400, 110], [100, 700, 400, 110]]);
    }, async (c) => { await opexSpend(c, 700); await approvedPo(c, f.a, '2026-04-05', f.acc.opex, 400); });
  });

  it('expense accounts only: sales five times over budget alerts nothing', async () => {
    await inRequest(pool, f.a, f.ownerA, async ({ client }) => {
      const out = await run();
      expect(out.fired).toEqual([]);
      expect(await alerts(client)).toEqual([]);
    }, (c) => journal(c, f.a, '2026-04-10', f.ownerA, [[f.acc.bank, 5000, 0], [f.acc.sales, 0, 5000]]));
  });

  it('a zero budget with spend crosses every threshold (pct stored as Infinity, listed as null); the slice links to BvA filtered to it', async () => {
    await inRequest(pool, f.a, f.ownerA, async ({ client }) => {
      const out = await run();
      expect(out.fired.map((a) => [a.cc1Id, a.threshold, a.pct])).toEqual([[f.cc.HT, 80, Infinity], [f.cc.HT, 100, Infinity], [f.cc.HT, 120, Infinity]]);
      expect(out.fired[0]).toMatchObject({ sliceName: 'HT Hometech', href: `/accounting/reports/budget-vs-actual?period=month&month=2026-04&cc1_id=${f.cc.HT}` });
      expect((await alerts(client)).map((r) => r.pct)).toEqual(['Infinity', 'Infinity', 'Infinity']);
      const list = await listBudgetAlerts(f.a);
      expect(list.open.map((a) => a.pct)).toEqual([null, null, null]);
      expect((await notes(client, f.ownerA))[0]!.body).toContain('(spent against a zero budget)');
    }, (c) => journal(c, f.a, '2026-04-10', f.ownerA, [[f.acc.rent, 10, 0, { cc1: f.cc.HT }], [f.acc.bank, 0, 10]]));
  });
});

describe('evaluateOverspend: a backlog', () => {
  it('more than 10 lines crossed in one run: every crossing recorded, ONE summary per owner/admin, and a rerun adds nothing', async () => {
    const asOf = '2026-09-20';
    await inRequest(pool, f.a, f.ownerA, async ({ client, asSuper }) => {
      notifySpy.mockClear();
      const out = await evaluateOverspend(f.a, { asOf });
      // Mar-Sep: opex 105% (80, 100) and rent FT 120% (80, 100, 120) every month = 7 × 5 rows, 14 lines.
      expect(out.fired).toHaveLength(35);
      expect((await alerts(client))).toHaveLength(35);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      for (const u of [f.ownerA, f.adminA]) {
        const n = await asSuper((c) => notes(c, u));
        expect(n).toEqual([{ dedupe_key: expect.stringMatching(new RegExp(`^budget_alert_summary:${asOf}:[0-9a-f-]{36}$`)), ref_id: null, href: '/accounting/budgets/controls',
          title: '14 budget lines crossed their thresholds — see Budget controls', body: expect.stringContaining('Budget controls lists each one') }]);
      }
      expect(await asSuper((c) => notes(c, f.managerA))).toEqual([]);
      expect((await evaluateOverspend(f.a, { asOf })).fired).toEqual([]);
      expect(notifySpy).toHaveBeenCalledTimes(1);
    }, async (c) => {
      for (const m of ['03', '04', '05', '06', '07', '08', '09']) {
        await opexSpend(c, 1050, `2026-${m}-10`);
        await journal(c, f.a, `2026-${m}-10`, f.ownerA, [[f.acc.rent, 600, 0, { cc1: f.cc.FT }], [f.acc.bank, 0, 600]]);
      }
    });
  });

  it('a second backlog the same day gets its own summary (one per run, not one per date)', async () => {
    const asOf = '2026-09-20';
    await inRequest(pool, f.a, f.ownerA, async ({ asSuper }) => {
      expect((await evaluateOverspend(f.a, { asOf })).fired).toHaveLength(35);
      await asSuper(async (c) => {
        for (const m of ['03', '04', '05', '06', '07', '08', '09']) {
          await opexSpend(c, 200, `2026-${m}-11`); // opex 125%: crosses 120
          await journal(c, f.a, `2026-${m}-11`, f.ownerA, [[f.acc.rent, 5, 0, { cc1: f.cc.HT }], [f.acc.bank, 0, 5]]); // R0 budget
        }
      });
      expect((await evaluateOverspend(f.a, { asOf })).fired).toHaveLength(28);
      const n = await asSuper((c) => notes(c, f.ownerA));
      expect(n.map((x) => x.title).sort()).toEqual(['14 budget lines crossed their thresholds — see Budget controls',
        '14 budget lines crossed their thresholds — see Budget controls']);
    }, async (c) => {
      for (const m of ['03', '04', '05', '06', '07', '08', '09']) {
        await opexSpend(c, 1050, `2026-${m}-10`);
        await journal(c, f.a, `2026-${m}-10`, f.ownerA, [[f.acc.rent, 600, 0, { cc1: f.cc.FT }], [f.acc.bank, 0, 600]]);
      }
    });
  });

  it('exactly 10 lines: no summary, one notification per line (its highest threshold)', async () => {
    const asOf = '2026-07-20';
    await inRequest(pool, f.a, f.ownerA, async ({ asSuper }) => {
      const out = await evaluateOverspend(f.a, { asOf });
      expect(out.fired).toHaveLength(25);
      const n = await asSuper((c) => notes(c, f.ownerA));
      expect(n).toHaveLength(10);
      expect(n.every((x) => / passed (100|120)% of budget$/.test(x.title))).toBe(true);
    }, async (c) => {
      for (const m of ['03', '04', '05', '06', '07']) {
        await opexSpend(c, 1050, `2026-${m}-10`);
        await journal(c, f.a, `2026-${m}-10`, f.ownerA, [[f.acc.rent, 600, 0, { cc1: f.cc.FT }], [f.acc.bank, 0, 600]]);
      }
    });
  });
});

describe('evaluateOverspend: recipients', () => {
  it('a suspended or deactivated owner/admin is not notified (the digest\'s rule)', async () => {
    await inRequest(pool, f.a, f.ownerA, async ({ asSuper }) => {
      expect((await run()).fired).toHaveLength(2);
      expect(await asSuper((c) => notes(c, f.ownerA))).toHaveLength(1);
      expect(await asSuper((c) => notes(c, f.adminA))).toEqual([]);
    }, async (c) => {
      await opexSpend(c, 1050);
      await c.query(`UPDATE users SET suspended_at = now(), status = 'suspended' WHERE id = $1`, [f.adminA]);
    });
    await inRequest(pool, f.a, f.adminA, async ({ asSuper }) => {
      expect((await run()).fired).toHaveLength(2);
      expect(await asSuper((c) => notes(c, f.ownerA))).toEqual([]);
      expect(await asSuper((c) => notes(c, f.adminA))).toHaveLength(1);
    }, async (c) => {
      await opexSpend(c, 1050);
      await c.query('UPDATE users SET is_active = false WHERE id = $1', [f.ownerA]);
    });
    // A SUSPENDED owner (Evaluate now by the admin, the request path): no bell alert for them.
    await inRequest(pool, f.a, f.adminA, async ({ asSuper }) => {
      expect((await run()).fired).toHaveLength(2);
      expect(await asSuper((c) => notes(c, f.ownerA))).toEqual([]);
      expect(await asSuper((c) => notes(c, f.adminA))).toHaveLength(1);
    }, async (c) => {
      await opexSpend(c, 1050);
      await c.query(`UPDATE users SET status = 'suspended', suspended_at = now() WHERE id = $1`, [f.ownerA]);
    });
  });
});

describe('evaluateOverspend: resolve and re-fire', () => {
  it('a reversal resolves the crossings; spending again re-fires the same rows with a new notification', async () => {
    await inRequest(pool, f.a, f.ownerA, async ({ client, asSuper }) => {
      const first = await run();
      expect(first.fired).toHaveLength(2);
      await asSuper((c) => journal(c, f.a, '2026-04-15', f.ownerA, [[f.acc.opex, 0, 600], [f.acc.bank, 600, 0]]));
      const down = await run();
      expect(down.fired).toEqual([]);
      expect(down.resolved.sort()).toEqual(first.fired.map((a) => a.id).sort());
      const resolved = await alerts(client);
      expect(resolved.every((r) => r.resolved_at !== null)).toBe(true);
      expect((await run()).resolved).toEqual([]);

      await asSuper((c) => opexSpend(c, 700, '2026-04-18'));
      notifySpy.mockClear();
      const up = await run();
      expect(up.fired.map((a) => [a.id, a.threshold, a.refired, a.pct])).toEqual(first.fired.map((a) => [a.id, a.threshold, true, 115]));
      expect(notifySpy).toHaveBeenCalledTimes(1);
      const back = await alerts(client);
      expect(back.map((r) => r.resolved_at)).toEqual([null, null]);
      expect(back.map((r) => r.id)).toEqual(resolved.map((r) => r.id));
      const owner = await notes(client, f.ownerA);
      // The first run's 100 and the re-fire's 100: the 80s are recorded, never announced.
      expect(owner).toHaveLength(2);
      const refires = owner.filter((n) => /^budget_alert:[0-9a-f-]{36}:\d+$/.test(n.dedupe_key));
      expect(refires.map((n) => [n.ref_id, n.title])).toEqual([[first.fired[1]!.id, 'P5A-6000 Office costs passed 100% of budget']]);
      expect(refires[0]!.body).toContain('is over again');
      expect((await run()).fired).toEqual([]);
    }, (c) => opexSpend(c, 1050));
  });

  it('raising the budget resolves the crossings it no longer meets', async () => {
    await inRequest(pool, f.a, f.ownerA, async ({ asSuper }) => {
      expect((await run()).fired.map((a) => a.threshold)).toEqual([80, 100]);
      await asSuper((c) => c.query(`UPDATE budget_month_amounts SET amount = 1250 WHERE company_id = $1 AND gl_account_id = $2 AND month = '2026-04-01'`,
        [f.a, f.acc.opex]));
      const out = await run();
      // 1050 / 1250 = 84%: 100 resolves, 80 stays open.
      expect(out.resolved).toHaveLength(1);
      const list = await listBudgetAlerts(f.a);
      expect(list.open.map((a) => [a.threshold, a.pct, a.budget])).toEqual([[80, 84, 1250]]);
      expect(list.resolved.map((a) => a.threshold)).toEqual([100]);
    }, (c) => opexSpend(c, 1050));
  });
});

describe('evaluateOverspend: thresholds', () => {
  it('slice override beats account override beats company default beats 80/100/120', async () => {
    await inRequest(pool, f.a, f.ownerA, async ({ asSuper }) => {
      // Rent FT spent 300 of 500 (60%); opex 600 of 1000 (60%).
      expect((await run()).fired).toEqual([]);
      await asSuper(async (c) => {
        await c.query(`INSERT INTO budget_control_settings (company_id, default_thresholds, updated_by) VALUES ($1, '{55}', $2)`, [f.a, f.ownerA]);
      });
      // Fired alerts come back in account code order: opex P5A-6000, then rent P5A-6100.
      expect((await run()).fired.map((a) => [a.glAccountId, a.threshold])).toEqual([[f.acc.opex, 55], [f.acc.rent, 55]]);
      await asSuper(async (c) => {
        await c.query(`INSERT INTO budget_alert_thresholds (company_id, gl_account_id, thresholds, created_by) VALUES ($1, $2, '{50,90}', $3)`,
          [f.a, f.acc.rent, f.ownerA]);
        await c.query(`INSERT INTO budget_alert_thresholds (company_id, gl_account_id, cc1_id, thresholds, created_by) VALUES ($1, $2, $3, '{40}', $4)`,
          [f.a, f.acc.rent, f.cc.FT, f.ownerA]);
        await c.query(`INSERT INTO budget_alert_thresholds (company_id, gl_account_id, thresholds, created_by) VALUES ($1, $2, '{65}', $3)`,
          [f.a, f.acc.opex, f.ownerA]);
      });
      const out = await run();
      // Rent FT: the slice's 40 (not the account's 50/90, not the default 55). Opex: its account 65 is not crossed.
      expect(out.fired.map((a) => [a.glAccountId, a.cc1Id, a.threshold])).toEqual([[f.acc.rent, f.cc.FT, 40]]);
      const open = (await listBudgetAlerts(f.a)).open.map((a) => [a.accountCode, a.threshold]).sort();
      // The two 55% crossings no longer apply: resolved.
      expect(open).toEqual([['P5A-6100', 40]]);
    }, async (c) => {
      await opexSpend(c, 600);
      await journal(c, f.a, '2026-04-10', f.ownerA, [[f.acc.rent, 300, 0, { cc1: f.cc.FT }], [f.acc.bank, 0, 300]]);
    });
  });
});

describe('evaluateOverspend: tenancy', () => {
  it('another company\'s spend, alerts and members are untouched', async () => {
    await inRequest(pool, f.a, f.ownerA, async ({ client }) => {
      const out = await run();
      expect(out.fired.map((a) => a.glAccountId)).toEqual([f.acc.opex, f.acc.opex]);
      const b = await client.query(`SELECT COUNT(*)::INT n FROM budget_alerts WHERE company_id = $1`, [f.b]);
      expect(b.rows[0].n).toBe(0); // RLS hides B's open alert; nothing new was written for B
      expect((await listBudgetAlerts(f.a)).open.every((a) => !a.accountName.includes('SECRET'))).toBe(true);
    }, async (c) => {
      await opexSpend(c, 1050);
      await journal(c, f.b, '2026-04-10', f.ownerB, [[f.acc.bOpex, 900, 0], [f.acc.bBank, 0, 900]]);
      await c.query(`INSERT INTO budget_alerts (company_id, version_id, gl_account_id, month, threshold, budget, actual, committed, pct)
                     VALUES ($1, $2, $3, '2026-04-01', 80, 100, 900, 0, 900)`, [f.b, f.vB, f.acc.bOpex]);
    });
    // B's open alert (seeded in the rolled-back request) never resolved by A's run: checked as the superuser inside it.
    await inRequest(pool, f.a, f.ownerA, async ({ asSuper }) => {
      await run();
      const b = await asSuper((c) => c.query(`SELECT resolved_at FROM budget_alerts WHERE company_id = $1`, [f.b]));
      expect(b.rows).toEqual([{ resolved_at: null }]);
      const n = await asSuper((c) => c.query(`SELECT COUNT(*)::INT n FROM user_notifications WHERE company_id = $1`, [f.b]));
      expect(n.rows[0].n).toBe(0);
    }, (c) => c.query(`INSERT INTO budget_alerts (company_id, version_id, gl_account_id, month, threshold, budget, actual, committed, pct)
                       VALUES ($1, $2, $3, '2026-04-01', 80, 100, 900, 0, 900)`, [f.b, f.vB, f.acc.bOpex]));
  });
});

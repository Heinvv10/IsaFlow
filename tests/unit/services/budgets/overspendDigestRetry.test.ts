/**
 * PR #1115 review: a digest delivery failure must not read as a finished run.
 * - the plan adds, for a recipient whose earlier send failed, the alerts they missed (and only for them);
 * - nothing fired + nothing owed is still `nothing_fired`; nothing fired + a debt is a plan;
 * - the company run is not ok while a send failed, and the run counts that company as failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: vi.fn(async () => [] as unknown[]),
  pending: vi.fn(async () => new Map<string, unknown[]>()),
  readSettings: vi.fn(async () => ({ alertEmailEnabled: true })),
}));
vi.mock('@/lib/neon', () => ({ sql: h.sql, getPool: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: vi.fn(), logEmailAttempt: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetControlSettings', () => ({
  alertEmailAllowedOnServer: () => process.env.BUDGET_ALERT_EMAIL_ENABLED === '1', readControlSettings: h.readSettings,
}));
vi.mock('@/modules/accounting/services/budgets/overspendDigestPending', () => ({ readPendingDigestAlerts: h.pending }));
vi.mock('@/lib/alsTransaction', () => ({ withAlsTransaction: async (_c: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetAlertRuns', () => ({ recordEvaluated: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/budgets/overspendAlerts', () => ({ evaluateOverspend: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/overspendDigest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/budgets/overspendDigest')>()),
  sendOverspendDigest: vi.fn(),
}));

import { planOverspendDigest, sendOverspendDigest } from '@/modules/accounting/services/budgets/overspendDigest';
import { evaluateOverspend, type FiredAlert } from '@/modules/accounting/services/budgets/overspendAlerts';
import { runBudgetAlertsFor } from '@/modules/accounting/services/budgets/budgetAlertCron';

const CO = '00000000-0000-4000-8000-000000000001';
const alert = (id: string, code: string) => ({ id, glAccountId: 'g', cc1Id: null, cc2Id: null, buId: null, month: '2026-04', threshold: 100,
  budget: 1000, actual: 1050, committed: 0, pct: 105, firedAt: '2026-04-20T00:00:00.000Z', accountCode: code, accountName: `Acct ${code}`,
  sliceName: null, refired: false, href: '/accounting/reports/budget-vs-actual?period=month&month=2026-04' }) as FiredAlert;
const TODAY = alert('a-today', '6000');
const MISSED = alert('a-missed', '6100');

/** The users query answers the two owners/admins; every other read answers nothing. */
function users() {
  h.sql.mockImplementation((async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('FROM company_users')) return [{ email: 'a@x', name: 'A' }, { email: 'b@x', name: 'B' }];
    if (q.includes('FROM companies')) return [{ name: 'Acme' }];
    return [];
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BUDGET_ALERT_EMAIL_ENABLED = '1';
  h.readSettings.mockResolvedValue({ alertEmailEnabled: true });
  h.pending.mockResolvedValue(new Map());
  users();
});

describe('planOverspendDigest: retrying the recipients whose send failed', () => {
  it('adds the missed alert for the failed recipient only; the others get just what fired', async () => {
    h.pending.mockResolvedValue(new Map([['b@x', [MISSED]]]));
    const plan = await planOverspendDigest(CO, [TODAY]);
    if (plan.skip !== null) throw new Error('expected a plan');
    const by = Object.fromEntries(plan.emails.map((e) => [e.to, e.html]));
    expect(by['a@x']).toContain('Acct 6000');
    expect(by['a@x']).not.toContain('Acct 6100');
    expect(by['b@x']).toContain('Acct 6000');
    expect(by['b@x']).toContain('Acct 6100');
  });

  it('nothing fired but one recipient owed a digest: a plan with that recipient alone', async () => {
    h.pending.mockResolvedValue(new Map([['b@x', [MISSED]]]));
    const plan = await planOverspendDigest(CO, []);
    if (plan.skip !== null) throw new Error('expected a plan');
    expect(plan.emails.map((e) => e.to)).toEqual(['b@x']);
    expect(plan.emails[0]!.html).toContain('Acct 6100');
  });

  it('an alert both fired now and owed is listed once', async () => {
    h.pending.mockResolvedValue(new Map([['b@x', [TODAY]]]));
    const plan = await planOverspendDigest(CO, [TODAY]);
    if (plan.skip !== null) throw new Error('expected a plan');
    expect(plan.emails.find((e) => e.to === 'b@x')!.html.match(/Acct 6000/g)).toHaveLength(1);
  });

  it('nothing fired and nothing owed: nothing_fired, as before', async () => {
    expect(await planOverspendDigest(CO, [])).toEqual({ skip: 'nothing_fired' });
  });

  it('the switches still rule: with the server switch off a debt sends nothing', async () => {
    delete process.env.BUDGET_ALERT_EMAIL_ENABLED;
    h.pending.mockResolvedValue(new Map([['b@x', [MISSED]]]));
    expect(await planOverspendDigest(CO, [])).toEqual({ skip: 'nothing_fired' });
    expect(await planOverspendDigest(CO, [TODAY])).toEqual({ skip: 'server_off' });
  });
});

describe('the company run reports a digest that did not get through', () => {
  it('a failed send makes the company run not ok (the cron then answers 500); the evaluation counts stay', async () => {
    vi.mocked(evaluateOverspend).mockResolvedValue({ fiscalYear: 2027, versionId: 'v', keys: 1, fired: [TODAY], resolved: [] });
    vi.mocked(sendOverspendDigest).mockResolvedValue({ skipped: null, sent: 1, failed: 1 });
    const out = await runBudgetAlertsFor([CO], '2026-04-20');
    expect(out.failed).toBe(1);
    expect(out.perCompany[0]).toMatchObject({ ok: false, fired: 1, digest: { sent: 1, failed: 1 }, error: 'digest delivery failed; see logs' });
  });

  it('every send delivered: the run is ok', async () => {
    vi.mocked(evaluateOverspend).mockResolvedValue({ fiscalYear: 2027, versionId: 'v', keys: 1, fired: [TODAY], resolved: [] });
    vi.mocked(sendOverspendDigest).mockResolvedValue({ skipped: null, sent: 2, failed: 0 });
    const out = await runBudgetAlertsFor([CO], '2026-04-20');
    expect(out.failed).toBe(0);
    expect(out.perCompany[0]).toMatchObject({ ok: true });
  });
});

/**
 * Budgets P5-4 (spec §3d, decision 9): the overspend email digest. The rendered HTML escapes every
 * value from the books (company, recipient, account, slice, month, link); the subject carries no
 * line break. The plan sends nothing without the server switch (BUDGET_ALERT_EMAIL_ENABLED=1), and
 * decides that before any database read; with no alerts it sends nothing at all. `sendOverspendDigest`
 * calls `sendEmail` only for a plan that is not skipped. The company flag (default OFF) is proven on
 * real PostgreSQL in budgets-p5-alerts-cron.int.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sql, sendEmail, logEmailAttempt } = vi.hoisted(() => ({
  logEmailAttempt: vi.fn(async () => undefined),
  sql: vi.fn(() => { throw new Error('no database read expected'); }),
  sendEmail: vi.fn(async () => ({ success: true })),
}));
vi.mock('@/lib/neon', () => ({ sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail, logEmailAttempt }));
// The owed-digest read (retry state) is covered in overspendDigestRetry.test.ts and the integration suite.
vi.mock('@/modules/accounting/services/budgets/overspendDigestPending', () => ({ readPendingDigestAlerts: vi.fn(async () => new Map()) }));

import { renderBudgetDigestHtml, renderBudgetDigestSubject, type BudgetDigestPayload } from '@/lib/email-templates-budget-digest';
import { planOverspendDigest, sendOverspendDigest } from '@/modules/accounting/services/budgets/overspendDigest';
import type { FiredAlert } from '@/modules/accounting/services/budgets/overspendAlerts';

const CO = '00000000-0000-4000-8000-000000000001';
const hostile = '<script>alert("x")</script> & \'q\'';

const payload = (): BudgetDigestPayload => ({
  companyName: `Acme ${hostile}\r\nBcc: evil@example.com`,
  recipientName: hostile,
  appBaseUrl: 'https://app.example',
  alerts: [{
    accountCode: '6000', accountName: hostile, sliceName: hostile, monthLabel: 'Apr 2026', threshold: 100,
    budget: 'R 1 000.00', spent: 'R 1 050.00', pctLabel: '105%',
    href: '/accounting/reports/budget-vs-actual?period=month&month=2026-04&cc1_id="><img src=x onerror=1>', refired: true,
  }],
});

const fired = [{ id: 'a1', glAccountId: 'g', cc1Id: null, cc2Id: null, buId: null, month: '2026-04', threshold: 100, budget: 1000,
  actual: 1050, committed: 0, pct: 105, firedAt: '2026-04-20T00:00:00.000Z', accountCode: '6000', accountName: 'Opex',
  sliceName: null, refired: false, href: '/accounting/reports/budget-vs-actual?period=month&month=2026-04' }] as FiredAlert[];

const envBefore = process.env.BUDGET_ALERT_EMAIL_ENABLED;
beforeEach(() => { vi.clearAllMocks(); delete process.env.BUDGET_ALERT_EMAIL_ENABLED; });
afterEach(() => {
  if (envBefore === undefined) delete process.env.BUDGET_ALERT_EMAIL_ENABLED; else process.env.BUDGET_ALERT_EMAIL_ENABLED = envBefore;
});

describe('renderBudgetDigestHtml', () => {
  it('escapes every value from the books, in text and in the link attribute', () => {
    const html = renderBudgetDigestHtml(payload());
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"><img');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#039;q&#039;');
    expect(html).toContain('href="https://app.example/accounting/reports/budget-vs-actual?period=month&amp;month=2026-04&amp;cc1_id=&quot;&gt;&lt;img');
    expect(html).toContain('(again)');
    expect(html).toContain('R 1 050.00');
    expect(html).toContain('href="https://app.example/accounting/budgets/controls"');
  });

  it('the subject names the company on one line and counts the alerts', () => {
    const s = renderBudgetDigestSubject(payload());
    expect(s).not.toMatch(/[\r\n]/);
    expect(s).toMatch(/^Budget alerts — Acme .*: 1 new overspend alert$/);
  });
});

describe('planOverspendDigest / sendOverspendDigest', () => {
  it('with the server switch unset: skipped before any database read, and nothing is sent', async () => {
    const plan = await planOverspendDigest(CO, fired);
    expect(plan).toEqual({ skip: 'server_off' });
    expect(sql).not.toHaveBeenCalled();
    expect(await sendOverspendDigest(CO, plan)).toEqual({ skipped: 'server_off', sent: 0, failed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each(['true', '0', 'yes', ' 1'])('BUDGET_ALERT_EMAIL_ENABLED=%j is not the switch', async (v) => {
    process.env.BUDGET_ALERT_EMAIL_ENABLED = v;
    expect(await planOverspendDigest(CO, fired)).toEqual({ skip: 'server_off' });
  });

  it('no alerts fired and none owed: nothing to send, whatever the switches', async () => {
    expect(await planOverspendDigest(CO, [])).toEqual({ skip: 'nothing_fired' });
    expect(sql).not.toHaveBeenCalled();
    process.env.BUDGET_ALERT_EMAIL_ENABLED = '1';
    sql.mockImplementationOnce((() => [] as never) as never); // the company's settings: no row = flag off
    expect(await planOverspendDigest(CO, [])).toEqual({ skip: 'nothing_fired' });
  });

  it('a plan with emails sends each one, counts each actual outcome (a throw is one failure), and logs each in the given context', async () => {
    sendEmail.mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'smtp down' } as never)
      .mockRejectedValueOnce(new Error('socket hang up'));
    const contexts: string[] = [];
    const inLog = vi.fn(async (write: () => Promise<void>) => { contexts.push('open'); await write(); });
    const emails = ['a@x', 'b@x', 'c@x'].map((to) => ({ to, subject: 's', html: 'h' }));
    const out = await sendOverspendDigest(CO, { skip: null, emails }, inLog);
    expect(out).toEqual({ skipped: null, sent: 1, failed: 2 });
    expect(sendEmail).toHaveBeenCalledTimes(3);
    // sendEmail itself writes no log (no _log): the digest writes one row per email, in its own context.
    expect(sendEmail.mock.calls.every(([o]) => !('_log' in (o as object)))).toBe(true);
    expect(contexts).toHaveLength(3);
    expect(logEmailAttempt.mock.calls.map(([p]) => [p.recipientEmail, p.status, p.errorMessage ?? null])).toEqual([
      ['a@x', 'sent', null], ['b@x', 'failed', 'smtp down'], ['c@x', 'failed', 'socket hang up'],
    ]);
  });
});

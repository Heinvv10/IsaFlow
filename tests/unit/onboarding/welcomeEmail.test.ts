/**
 * The welcome email a new trial owner gets once verify-email has provisioned
 * their tenant. Pinned here:
 *   - one send per company: a 'sent' welcome row in email_log blocks another
 *   - never for a demo company, never for a company that does not exist
 *   - a failed guard query or a failed send resolves 'failed', never throws
 *   - the accountant and SME copy differ, and both state TRIAL_DAYS
 *   - user input (name, company name) is escaped in the HTML
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendEmailMock, sqlMock, logError } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  sqlMock: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: sendEmailMock }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() } }));

import { sendWelcomeEmail, sendWelcomeEmailOnce, type WelcomeNotice } from '@/modules/onboarding/services/welcomeEmail';
import { TRIAL_DAYS } from '@/modules/onboarding/services/trialPeriod';

const notice = (over: Partial<WelcomeNotice> = {}): WelcomeNotice => ({
  companyId: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.co.za',
  firstName: 'Thandi',
  companyName: 'Example Traders',
  signupType: 'direct',
  ...over,
});

type SentMail = { to: string; subject: string; html: string; _log: unknown };
const sent = (): SentMail => sendEmailMock.mock.calls[0]![0] as SentMail;
/** The guard query's SQL text and bound values. */
const guardCall = () => {
  const [strings, ...values] = sqlMock.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
  return { text: strings.join('?'), values };
};

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{ is_demo: false, already_sent: false }]);
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'm-1' });
});

describe('sendWelcomeEmailOnce: who gets it', () => {
  it('sends once to the owner and logs it against the new company as a welcome', async () => {
    await expect(sendWelcomeEmailOnce(notice())).resolves.toBe('sent');

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sent().to).toBe('owner@example.co.za');
    expect(sent()._log).toEqual({
      companyId: '11111111-1111-4111-8111-111111111111', emailType: 'welcome', sentBy: null,
    });
    const g = guardCall();
    expect(g.values).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(g.text).toMatch(/email_log/);
    expect(g.text).toMatch(/email_type = 'welcome'/);
    expect(g.text).toMatch(/status = 'sent'/);
    expect(g.text).toMatch(/is_demo/);
  });

  it('does not send a second welcome when one was already sent for the company', async () => {
    sqlMock.mockResolvedValue([{ is_demo: false, already_sent: true }]);
    await expect(sendWelcomeEmailOnce(notice())).resolves.toBe('skipped');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not send for a demo company', async () => {
    sqlMock.mockResolvedValue([{ is_demo: true, already_sent: false }]);
    await expect(sendWelcomeEmailOnce(notice())).resolves.toBe('skipped');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not send when the company row does not exist', async () => {
    sqlMock.mockResolvedValue([]);
    await expect(sendWelcomeEmailOnce(notice())).resolves.toBe('skipped');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('sendWelcomeEmailOnce: failures never escape', () => {
  it('a failed guard query does not send, logs, and resolves failed', async () => {
    sqlMock.mockRejectedValue(new Error('db down'));
    await expect(sendWelcomeEmailOnce(notice())).resolves.toBe('failed');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });

  it('a send that rejects resolves failed and logs', async () => {
    sendEmailMock.mockRejectedValue(new Error('smtp down'));
    await expect(sendWelcomeEmailOnce(notice())).resolves.toBe('failed');
    expect(logError).toHaveBeenCalled();
  });

  it('a send that reports failure resolves failed', async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: 'rejected' });
    await expect(sendWelcomeEmailOnce(notice())).resolves.toBe('failed');
  });

  it('the fire-and-forget wrapper returns at once and never rejects', async () => {
    sendEmailMock.mockRejectedValue(new Error('smtp down'));
    expect(sendWelcomeEmail(notice())).toBeUndefined();
    await vi.waitFor(() => expect(logError).toHaveBeenCalled());
  });
});

describe('welcome copy', () => {
  it('the accountant and SME variants differ, and both state the trial length', async () => {
    await sendWelcomeEmailOnce(notice({ signupType: 'direct' }));
    await sendWelcomeEmailOnce(notice({ signupType: 'accountant' }));
    const [sme, acc] = sendEmailMock.mock.calls.map((c) => c[0] as SentMail);

    expect(sme!.subject).not.toBe(acc!.subject);
    expect(acc!.html).toMatch(/practice/i);
    expect(acc!.html).toMatch(/clients/i);
    expect(sme!.html).not.toMatch(/your practice/i);
    for (const m of [sme!, acc!]) {
      expect(m.html).toContain(`${TRIAL_DAYS}-day free trial`);
      expect(m.html).toContain('Thandi');
      expect(m.html).toContain('Example Traders');
    }
  });

  it('escapes the name and company name', async () => {
    await sendWelcomeEmailOnce(notice({ firstName: '<b>x</b>', companyName: 'A & B <script>alert(1)</script>' }));
    expect(sent().html).not.toContain('<script>');
    expect(sent().html).not.toContain('<b>x</b>');
    expect(sent().html).toContain('A &amp; B &lt;script&gt;');
  });

  it('greets "there" when the first name is missing', async () => {
    await sendWelcomeEmailOnce(notice({ firstName: null }));
    expect(sent().html).toMatch(/Hi <strong[^>]*>there<\/strong>/);
  });

  it('has no em dash and spells IsaFlow correctly', async () => {
    await sendWelcomeEmailOnce(notice({ signupType: 'direct' }));
    await sendWelcomeEmailOnce(notice({ signupType: 'accountant' }));
    for (const c of sendEmailMock.mock.calls) {
      const m = c[0] as SentMail;
      const text = m.subject + m.html;
      expect(text).not.toMatch(/—|&mdash;|&#8212;/);
      expect(text).not.toMatch(/Isaflow|ISAFlow|isaFlow/);
      expect(m.subject).toContain('IsaFlow');
    }
  });
});

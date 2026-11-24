/**
 * Trial lifecycle email copy: no em dash, no currency figure, "IsaFlow" spelled right, hostile names
 * escaped, subjects free of line breaks, the configurable upgrade link, and day 3 listing only the
 * steps it is given.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderSetupNudge } from '@/lib/email-templates-trial/setupNudge';
import { renderCheckIn } from '@/lib/email-templates-trial/checkIn';
import { renderEndingSoon } from '@/lib/email-templates-trial/endingSoon';
import { renderEnded } from '@/lib/email-templates-trial/ended';
import type { RenderedEmail, TrialEmailPayload } from '@/lib/email-templates-trial/shared';

const payload = (over: Partial<TrialEmailPayload> = {}): TrialEmailPayload => ({
  companyName: 'Example Traders', recipientName: 'Sam', trialEndsAt: new Date('2026-12-01T09:00:00Z'),
  appBaseUrl: 'https://app.example.test', ...over,
});
const steps = [
  { label: 'Add a customer', href: '/accounting/customers/new' },
  { label: 'Add a bank account', href: '/accounting/bank-accounts' },
];
const all = (p: TrialEmailPayload): [string, RenderedEmail][] => [
  ['setup_nudge', renderSetupNudge(p, steps)], ['check_in', renderCheckIn(p)],
  ['ending_soon', renderEndingSoon(p)], ['ended', renderEnded(p)],
];

afterEach(() => { delete process.env.TRIAL_UPGRADE_URL; });

describe('trial lifecycle templates', () => {
  it.each(all(payload()))('%s: no em dash (character or entity), no currency figure, IsaFlow spelled right', (_s, e) => {
    for (const text of [e.subject, e.html]) {
      expect(text).not.toMatch(/—|&#8212;|&mdash;/);
      expect(text).not.toMatch(/\bR\s?\d/);
      expect(text).not.toMatch(/ZAR|\$\d|per month|\/month|per year/i);
      expect(text).not.toMatch(/Isaflow|ISAFLOW|isaFlow|Isa Flow/);
    }
    expect(e.html).toContain('IsaFlow');
  });

  it.each(all(payload({ companyName: '<script>x</script>\r\nBcc: a@b.test', recipientName: '"><img src=x>' })))(
    '%s: escapes hostile names and keeps the subject on one line', (_s, e) => {
      expect(e.html).not.toContain('<script>');
      expect(e.html).not.toContain('<img src=x>');
      expect(e.subject).not.toMatch(/[\r\n]/);
    });

  it('ending soon names the end date in South African time', () => {
    expect(renderEndingSoon(payload()).subject).toContain('1 December 2026');
  });

  it('upgrade button defaults to an email to the contact address', () => {
    expect(renderEndingSoon(payload()).html).toContain('href="mailto:accounts@isaflow.co.za?subject=');
  });

  it('upgrade button uses TRIAL_UPGRADE_URL when it is https or mailto, and ignores anything else', () => {
    process.env.TRIAL_UPGRADE_URL = 'https://www.example.test/upgrade';
    expect(renderEnded(payload()).html).toContain('href="https://www.example.test/upgrade"');
    process.env.TRIAL_UPGRADE_URL = 'javascript:alert(1)';
    expect(renderEnded(payload()).html).not.toContain('javascript:');
  });

  it('day 3 lists only the steps it is given, at most three', () => {
    const html = renderSetupNudge(payload(), steps).html;
    expect(html).toContain('Add a customer');
    expect(html).toContain('Add a bank account');
    expect(html).not.toContain('Add a supplier');
    const many = [...steps, { label: 'Add a supplier', href: '/s' }, { label: 'Run payroll', href: '/p' }];
    const capped = renderSetupNudge(payload(), many).html;
    expect(capped).toContain('Add a supplier');
    expect(capped).not.toContain('Run payroll');
  });

  it('no email offers an unsubscribe link (there is no mechanism behind one)', () => {
    for (const [, e] of all(payload())) expect(e.html).not.toMatch(/unsubscribe|preferences/i);
  });

  it('ended email makes no promise about access, data or features after the trial', () => {
    const html = renderEnded(payload()).html;
    expect(html).not.toMatch(/still sign in|data you captured|is kept|no longer be available|features/i);
    expect(html).toContain('Reply to this email');
  });

  it.each([['ending_soon', renderEndingSoon], ['ended', renderEnded]] as const)(
    '%s: every plain-text mention of the contact address in the bullets is a mailto link', (_s, render) => {
      const html = render(payload()).html;
      const bullets = html.slice(html.indexOf('<ul'), html.indexOf('</ul>'));
      expect(bullets).toContain('<a href="mailto:accounts@isaflow.co.za" style="color:');
      const bare = bullets.replace(/<a [^>]*>accounts@isaflow\.co\.za<\/a>/g, '').replace(/href="[^"]*"/g, '');
      expect(bare).not.toContain('accounts@isaflow.co.za');
    });

  it.each(all(payload()))('%s: footer text is #475569 (7.24:1 on the #f8fafc footer)', (_s, e) => {
    const footer = e.html.slice(e.html.indexOf('IsaFlow, South African cloud accounting') - 400);
    expect(footer).toMatch(/background-color:#f8fafc;[^"]*color:#475569;/);
    expect(e.html).not.toContain('#94a3b8');
  });
});

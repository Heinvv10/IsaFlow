/**
 * Audit 2026-10-18 S-08: one sign-in email per request, listing every company
 * the portal contact is on, each with its own link labelled by company name.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendEmailMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: sendEmailMock }));

import { notifyMagicLinkRequested } from '@/modules/accounting/services/afs/portalNotificationService';

beforeEach(() => sendEmailMock.mockReset());

describe('notifyMagicLinkRequested — one email, one link per company', () => {
  it('sends ONE email to the contact with each company and its own link', async () => {
    await notifyMagicLinkRequested({ name: 'Jo Director', email: 'jo@client.co' }, [
      { companyId: 'co-1', companyName: 'Alpha (Pty) Ltd', url: 'https://app/verify?token=aaa' },
      { companyId: 'co-2', companyName: 'Beta Holdings', url: 'https://app/verify?token=bbb' },
    ]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const msg = sendEmailMock.mock.calls[0]![0] as { to: string; html: string };
    expect(msg.to).toBe('jo@client.co');
    const alpha = msg.html.indexOf('Alpha (Pty) Ltd');
    const beta = msg.html.indexOf('Beta Holdings');
    expect(alpha).toBeGreaterThan(-1);
    expect(beta).toBeGreaterThan(alpha);
    // Each company's link follows its own label, before the next company's.
    const tokA = msg.html.indexOf('token=aaa');
    const tokB = msg.html.indexOf('token=bbb');
    expect(tokA).toBeGreaterThan(alpha);
    expect(tokA).toBeLessThan(beta);
    expect(tokB).toBeGreaterThan(beta);
  });

  it('sends nothing when there are no links', async () => {
    await notifyMagicLinkRequested({ name: 'Jo', email: 'jo@client.co' }, []);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

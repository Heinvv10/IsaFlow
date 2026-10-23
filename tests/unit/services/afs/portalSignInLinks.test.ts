/**
 * Audit S-08 — sendPortalSignInLinks: one email with a link per live company.
 * It never rejects (the route does not wait for it): a failure is logged. A
 * live company with a blank name is labelled 'Your company'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  createMagicLink: vi.fn(),
  notify: vi.fn(),
  logError: vi.fn(),
  live: [] as Array<{ companyId: string; companyName: string }>,
}));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => [{ id: 'k1', company_id: 'co-1', name: 'Jo', email: 'jo@client.co' }]),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() } }));
vi.mock('@/lib/auth/liveCompanies', () => ({ listLiveCompanies: vi.fn(async () => h.live) }));
vi.mock('@/modules/accounting/services/afs/magicLinkService', () => ({ createMagicLink: h.createMagicLink }));
vi.mock('@/modules/accounting/services/afs/portalNotificationService', () => ({ notifyMagicLinkRequested: h.notify }));

import { sendPortalSignInLinks } from '@/modules/accounting/services/afs/portalSignInLinks';

beforeEach(() => {
  vi.clearAllMocks();
  h.createMagicLink.mockResolvedValue({ token: 'a'.repeat(64), expiresAt: new Date() });
  h.live = [{ companyId: 'co-1', companyName: 'Alpha' }];
});

describe('sendPortalSignInLinks', () => {
  it('sends one email whose link points at the verify route', async () => {
    await sendPortalSignInLinks('jo@client.co', 'https://app.test');
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]?.[0]).toEqual({ name: 'Jo', email: 'jo@client.co' });
    expect(h.notify.mock.calls[0]?.[1]).toEqual([{
      companyId: 'co-1', companyName: 'Alpha', url: `https://app.test/api/accounting/portal/auth/verify?token=${'a'.repeat(64)}`,
    }]);
  });

  it('resolves and logs when a link cannot be created', async () => {
    h.createMagicLink.mockRejectedValue(new Error('insert failed'));
    await expect(sendPortalSignInLinks('jo@client.co', 'https://app.test')).resolves.toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.logError).toHaveBeenCalledWith('Portal magic links could not be created', expect.anything(), 'portalSignInLinks');
  });

  it("labels a live company with a blank name 'Your company'", async () => {
    h.live = [{ companyId: 'co-1', companyName: '' }];
    await sendPortalSignInLinks('jo@client.co', 'https://app.test');
    expect(h.notify.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ companyName: 'Your company' })]);
  });

  it('gives no link for a contact whose company is not live', async () => {
    h.live = [];
    await sendPortalSignInLinks('jo@client.co', 'https://app.test');
    expect(h.createMagicLink).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});

/**
 * The reserved-name rule must hold for EVERY writer, not only the one that
 * remembered it.
 *
 * It was enforced in pages/api/oauth/register.ts alone, while
 * pages/api/developer/oauth-apps/index.ts wrote body.name straight to
 * oauth_apps. The consent screen renders app.name identically whether the app
 * is dynamic or not, so any signed-in user could register an app called plainly
 * "IsaFlow" and have the screen say "IsaFlow would like to access your ISAFlow
 * account". No Unicode trick — the control was simply absent on that path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
  getPoolForTests: vi.fn(),
}));

import { registerOauthApp, ReservedClientNameError } from '@/lib/auth/oauth';

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{ id: 'app-1', client_id: 'client_x' }]);
});

const input = (name: string) => ({
  ownerUserId: 'user-1',
  name,
  redirectUris: ['https://client.example/cb'],
});

describe('registerOauthApp — the guard that covers every writer', () => {
  it('refuses a reserved name however it got here', async () => {
    for (const name of ['IsaFlow', 'IsaFlow Connector', 'OfficialIsaFlow', 'Isa Flow', 'TheIsaFlow']) {
      await expect(registerOauthApp(input(name)), name).rejects.toBeInstanceOf(ReservedClientNameError);
    }
    expect(sqlMock).not.toHaveBeenCalled();
  });

  // The write path and the check must agree on the string, or a name can be
  // stored that renders as something the check never saw.
  it('stores the NFC form, and checks that same form', async () => {
    // U+FACF is a letter the browser declines to draw; NFC maps it to the
    // ideograph it stands for, which does render.
    await registerOauthApp(input('Acme𢡊Books'));
    const params = sqlMock.mock.calls[0]?.slice(1) ?? [];
    expect(params).toContain('Acme\u{2284A}Books');
    expect(params).not.toContain('Acme𢡊Books');
  });

  it('lets an ordinary name through untouched', async () => {
    for (const name of ['Acme Bookkeeping', '会计 (IsaFlow)', 'Claude Code (isaflow)']) {
      sqlMock.mockClear();
      await expect(registerOauthApp(input(name)), name).resolves.toBeTruthy();
      expect(sqlMock.mock.calls[0]?.slice(1), name).toContain(name);
    }
  });
});

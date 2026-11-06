// Api.loginAs logs in as the user it is given, on a context of its own: never the suite's stored session.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ newContext: vi.fn(), loginGolden: vi.fn() }));
vi.mock('@playwright/test', () => ({ request: { newContext: h.newContext } }));
vi.mock('../../e2e/golden-paths/helpers/goldenLogin', () => ({ loginGolden: h.loginGolden }));

import { Api } from '../../e2e/golden-paths/_api';

const AS = { email: 'second@x', password: 'pw', companyId: '601d0000-0000-4000-8000-000000000001' };

function ctx(csrf = 'tok') {
  return {
    storageState: vi.fn(async () => ({ cookies: csrf ? [{ name: 'isaflow_csrf', value: csrf }] : [] })),
    dispose: vi.fn(async () => undefined),
  };
}

beforeEach(() => { h.newContext.mockReset(); h.loginGolden.mockReset(); });

describe('Api.loginAs', () => {
  it('logs the given user in on a fresh context without the stored session', async () => {
    const c = ctx();
    h.newContext.mockResolvedValue(c);
    h.loginGolden.mockResolvedValue(undefined);
    await Api.loginAs('http://x', AS);
    expect(h.newContext).toHaveBeenCalledWith({ baseURL: 'http://x' });
    expect(h.newContext.mock.calls[0]![0]).not.toHaveProperty('storageState');
    expect(h.loginGolden).toHaveBeenCalledWith(c, AS);
  });

  it('disposes the context when login fails', async () => {
    const c = ctx();
    h.newContext.mockResolvedValue(c);
    h.loginGolden.mockRejectedValue(new Error('golden-paths login failed: 401'));
    await expect(Api.loginAs('http://x', AS)).rejects.toThrow(/401/);
    expect(c.dispose).toHaveBeenCalled();
  });

  it('disposes when no CSRF cookie comes back', async () => {
    const c = ctx('');
    h.newContext.mockResolvedValue(c);
    h.loginGolden.mockResolvedValue(undefined);
    await expect(Api.loginAs('http://x', AS)).rejects.toThrow(/csrf/);
    expect(c.dispose).toHaveBeenCalled();
  });

  it('names the user and company when the company switch is refused', async () => {
    const c = ctx();
    h.newContext.mockResolvedValue(c);
    h.loginGolden.mockRejectedValue(new Error('golden slot: switch to slot company X failed: 403 {}. Is second@x a member of it (scripts/ci/golden/provision-slots.ts)?'));
    await expect(Api.loginAs('http://x', AS)).rejects.toThrow(`approver second@x is not a member of company ${AS.companyId}`);
    expect(c.dispose).toHaveBeenCalled();
  });
});

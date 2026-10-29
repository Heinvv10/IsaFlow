// How the golden suite picks its company. A slot is configured by three env vars the golden-paths job derives from
// the runner; with none of them set (post-deploy verify, local runs) the suite behaves exactly as before and logs in
// as E2E_ADMIN_* to that user's own default company. A half-set slot must fail, never fall back to Demo.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIRequestContext } from '@playwright/test';
import { describeGoldenCompany, readGoldenSlot } from '../../e2e/golden-paths/helpers/goldenSlot';
import { loginGolden } from '../../e2e/golden-paths/helpers/goldenLogin';

const SLOT_ID = '601d0000-0000-4000-8000-000000000002';
const SLOT = { companyId: SLOT_ID, email: 'golden-slot-2@isaflow.dev', password: 'slot-pass' };
const SLOT_ENV = { GOLDEN_COMPANY_ID: SLOT.companyId, GOLDEN_USER_EMAIL: SLOT.email, GOLDEN_USER_PASSWORD: SLOT.password };

describe('readGoldenSlot', () => {
  it('is null when no slot variable is set, so the default Demo path is untouched', () => {
    expect(readGoldenSlot({})).toBeNull();
    expect(readGoldenSlot({ E2E_ADMIN_EMAIL: 'a@b.c', E2E_ADMIN_PASSWORD: 'x' })).toBeNull();
    expect(readGoldenSlot({ GOLDEN_COMPANY_ID: '', GOLDEN_USER_EMAIL: '', GOLDEN_USER_PASSWORD: '' })).toBeNull();
  });

  it('reads a complete slot', () => {
    expect(readGoldenSlot(SLOT_ENV)).toEqual(SLOT);
  });

  it.each([
    ['company without a user', { GOLDEN_COMPANY_ID: SLOT_ID }],
    ['company without a password', { GOLDEN_COMPANY_ID: SLOT_ID, GOLDEN_USER_EMAIL: SLOT.email }],
    ['a user without a company (would log in to whatever that user defaults to)', { GOLDEN_USER_EMAIL: SLOT.email, GOLDEN_USER_PASSWORD: 'x' }],
    ['a password alone', { GOLDEN_USER_PASSWORD: 'x' }],
  ])('refuses %s', (_label, env) => {
    expect(() => readGoldenSlot(env)).toThrow(/GOLDEN_COMPANY_ID, GOLDEN_USER_EMAIL and GOLDEN_USER_PASSWORD/);
  });

  it('refuses a company id that is not a uuid (it goes into a request body)', () => {
    expect(() => readGoldenSlot({ ...SLOT_ENV, GOLDEN_COMPANY_ID: 'demo' })).toThrow(/uuid/);
  });
});

describe('describeGoldenCompany', () => {
  it('names the Demo company when no slot is set', () => {
    expect(describeGoldenCompany({})).toBe('the Demo company');
  });

  it('names the slot, its company and user, and the command that rebuilds it', () => {
    const text = describeGoldenCompany(SLOT_ENV);
    expect(text).toContain('GOLDEN SLOT 2');
    expect(text).toContain(SLOT_ID);
    expect(text).toContain('golden-slot-2@isaflow.dev');
    expect(text).toContain('--reset-slot 2');
    // The CLI refuses a reset without a seed url, so the advice must carry one.
    expect(text).toMatch(/--reset-slot 2 --seed-url http:\/\/localhost:/);
  });

  it('still names the company for a slot user whose email is not a slot email, without a rebuild hint', () => {
    const text = describeGoldenCompany({ ...SLOT_ENV, GOLDEN_USER_EMAIL: 'someone@x.test' });
    expect(text).toContain(SLOT_ID);
    expect(text).not.toContain('--reset-slot');
  });
});

interface Call { method: 'get' | 'post'; url: string; options?: { data?: unknown; headers?: Record<string, string> } }

/** A fake request context that records calls and answers like the app would. */
function fakeCtx(opts: { loginStatus?: number; switchStatus?: number; activeAfterSwitch?: string; csrf?: string | null } = {}): { ctx: APIRequestContext; calls: Call[] } {
  const calls: Call[] = [];
  let active = 'default-company';
  const reply = (status: number, body: unknown) => ({ status: () => status, text: async () => JSON.stringify(body), json: async () => body });
  const ctx = {
    post: async (url: string, options?: Call['options']) => {
      calls.push({ method: 'post', url, options });
      if (url === '/api/auth/login') return reply(opts.loginStatus ?? 200, { success: true });
      if (url === '/api/auth/switch-company') {
        const status = opts.switchStatus ?? 200;
        if (status === 200) active = opts.activeAfterSwitch ?? (options?.data as { companyId: string }).companyId;
        return reply(status, { success: status === 200 });
      }
      return reply(404, {});
    },
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      if (url.startsWith('/api/accounting/companies')) return reply(200, { success: true, data: { activeCompanyId: active } });
      return reply(200, {});
    },
    storageState: async () => ({ cookies: opts.csrf === null ? [] : [{ name: 'isaflow_csrf', value: opts.csrf ?? 'csrf-token' }], origins: [] }),
  };
  return { ctx: ctx as unknown as APIRequestContext, calls };
}

describe('loginGolden', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('without a slot logs in once and never touches the active company (today\'s behaviour)', async () => {
    const { ctx, calls } = fakeCtx();
    vi.stubEnv('E2E_ADMIN_EMAIL', 'admin@example.test');
    vi.stubEnv('E2E_ADMIN_PASSWORD', 'pw');
    await loginGolden(ctx, null);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['post /api/auth/login', 'get /accounting']);
    expect(calls[0]!.options!.data).toEqual({ email: 'admin@example.test', password: 'pw' });
  });

  it('with a slot logs in as the slot user, switches company with the CSRF token and proves the switch', async () => {
    const { ctx, calls } = fakeCtx();
    await loginGolden(ctx, SLOT);
    expect(calls[0]!.options!.data).toEqual({ email: SLOT.email, password: SLOT.password });
    const sw = calls.find((c) => c.url === '/api/auth/switch-company')!;
    expect(sw.options!.data).toEqual({ companyId: SLOT_ID });
    expect(sw.options!.headers).toEqual({ 'x-csrf-token': 'csrf-token' });
    expect(calls.at(-1)!.url).toBe('/api/accounting/companies?action=user-companies');
  });

  it('fails when the login is refused', async () => {
    await expect(loginGolden(fakeCtx({ loginStatus: 401 }).ctx, SLOT)).rejects.toThrow(/golden-paths login failed: 401/);
  });

  it('fails when the user is not a member of the slot company (switch refused)', async () => {
    await expect(loginGolden(fakeCtx({ switchStatus: 403 }).ctx, SLOT)).rejects.toThrow(/switch to slot company .* failed: 403/);
  });

  it('fails when the switch answered 200 but the session is still scoped elsewhere', async () => {
    await expect(loginGolden(fakeCtx({ activeAfterSwitch: 'other-company' }).ctx, SLOT)).rejects.toThrow(/scoped to other-company, not the slot company/);
  });

  it('fails when no CSRF cookie was issued, rather than posting without it', async () => {
    await expect(loginGolden(fakeCtx({ csrf: null }).ctx, SLOT)).rejects.toThrow(/CSRF/);
  });
});

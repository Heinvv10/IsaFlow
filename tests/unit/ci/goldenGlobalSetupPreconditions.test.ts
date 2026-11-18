// The golden suite's REAL global setup (tests/e2e/golden-paths/_global-setup.ts) with Playwright's request context replaced by a
// scripted app: what it throws when the session is refused (the 2026-11-18 incident) and when the verify login is in the wrong
// company. Only failure paths: a passing setup writes its storage-state file under the repo, and these tests write nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullConfig } from '@playwright/test';

type Answer = { status: number; body: unknown };
const script = vi.hoisted(() => ({ answer: (_path: string): { status: number; body: unknown } => ({ status: 404, body: null }), asked: [] as string[] }));

vi.mock('@playwright/test', () => ({
  request: {
    newContext: async () => ({
      post: async () => ({ status: () => 200, text: async () => '{}' }),
      get: async (path: string) => {
        script.asked.push(path);
        const a = script.answer(path);
        return { status: () => a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
      },
      storageState: async () => ({ cookies: [] }),
      dispose: async () => undefined,
    }),
  },
}));

const { default: globalSetup } = await import('../../e2e/golden-paths/_global-setup');
const config = (baseURL: string) => ({ projects: [{ use: { baseURL } }] }) as unknown as FullConfig;
const KEYS = ['E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD', 'E2E_APPROVER_EMAIL', 'E2E_APPROVER_PASSWORD', 'GOLDEN_SLOT_NUMBER', 'GOLDEN_COMPANY_ID', 'GOLDEN_USER_EMAIL', 'GOLDEN_USER_PASSWORD'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.E2E_ADMIN_EMAIL = 'deploy-verify@isaflow.co.za';
  process.env[KEYS[1]!] = 'x'.repeat(12); // E2E_ADMIN_PASSWORD: the scripted app never reads it
  script.asked = [];
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('golden global setup', () => {
  it('THE INCIDENT: login 200, then every GET 401 at http://127.0.0.1:3101 fails as a refused session pointing at localhost, not as missing accounts', async () => {
    script.answer = (): Answer => ({ status: 401, body: { success: false, error: { code: 'UNAUTHORIZED' } } });
    const err = await globalSetup(config('http://127.0.0.1:3101')).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('answered 401');
    expect(err?.message).toContain('http://localhost:3101');
    expect(err?.message).not.toMatch(/system account/);
  });

  it('a verify login in the wrong company is reported as that, before the chart is read', async () => {
    script.answer = (p): Answer => (p.includes('user-companies')
      ? { status: 200, body: { data: { activeCompanyId: 'c2', items: [{ companyId: 'c1', companyName: 'Deploy Verification', isDemo: true }, { companyId: 'c2', companyName: '0GP Golden Migration Sandbox', isDemo: true }] } } }
      : { status: 200, body: { data: [] } });
    await expect(globalSetup(config('http://localhost:3101'))).rejects.toThrow(/not in the Deploy Verification company: the active company is "0GP Golden Migration Sandbox"/);
    expect(script.asked.filter((p) => p.includes('chart-of-accounts'))).toEqual([]);
  });

  it('a session that works in a company without the system accounts still fails on the accounts (Demo login)', async () => {
    process.env.E2E_ADMIN_EMAIL = 'admin@isaflow.co.za';
    script.answer = (p): Answer => (p.includes('user-companies') ? { status: 200, body: { data: { activeCompanyId: 'd', items: [] } } } : { status: 200, body: { data: [] } });
    await expect(globalSetup(config('http://localhost:3101'))).rejects.toThrow(/company has no system account for \[receivable, default_revenue, vat_output, payable, vat_input, default_expense\]/);
  });

  describe('approver failure message', () => {
    const home = { companyId: 'c1', companyName: 'Deploy Verification', isDemo: true };
    const sandbox = { companyId: 'c2', companyName: '0GP Golden Migration Sandbox', isDemo: true };
    /** The verify login passes; the approver's (the second user-companies read) is answered by `approver`. */
    const withApprover = (approver: Answer) => {
      process.env.E2E_APPROVER_EMAIL = 'approver@isaflow.co.za';
      process.env.E2E_APPROVER_PASSWORD = 'y'.repeat(12);
      let reads = 0;
      script.answer = (p): Answer => {
        if (p.includes('user-companies')) return ++reads === 1 ? { status: 200, body: { data: { activeCompanyId: 'c1', items: [home] } } } : approver;
        if (p.includes('chart-of-accounts')) return { status: 200, body: { data: [{ id: 'a', isSystemAccount: true }] } };
        return { status: 404, body: null };
      };
    };

    it('a problem with no full stop is closed before "No spec runs", and joined problems never run together', async () => {
      withApprover({ status: 200, body: { data: { items: [home, sandbox] } } });
      const err = await globalSetup(config('http://localhost:3101')).then(() => null, (e: Error) => e);
      expect(err?.message).toBe('golden-paths: the approver login\'s companies are ["Deploy Verification", "0GP Golden Migration Sandbox"]; they must be exactly '
        + '["Deploy Verification"] (is_demo). No spec runs: re-run scripts/deploy/provision-verify-company.sh or fix the approver\'s memberships.');
    });

    it('a problem that already ends in a full stop gets no second one', async () => {
      withApprover({ status: 403, body: null });
      const err = await globalSetup(config('http://localhost:3101')).then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/the app refused the session\. No spec runs: re-run /);
      expect(err?.message).not.toMatch(/\.\./);
    });
  });
});

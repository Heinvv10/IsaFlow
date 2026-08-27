/**
 * setDefaultCompany must go through auth.set_default_company (mig 516).
 * A plain UPDATE on company_users is a silent 0-row no-op for non-admin roles
 * under RLS (cu_admin_write) once withTransaction runs on the request tx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ text: string; values: unknown[] }> = [];
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ text: strings.join('$'), values }); return []; }),
    { unsafe: vi.fn((s: string) => s) },
  ),
  withTransaction: vi.fn(async () => { throw new Error('withTransaction must not be used here'); }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { setDefaultCompany } from '@/modules/accounting/services/core/companyService';

describe('setDefaultCompany', () => {
  beforeEach(() => { calls.length = 0; });

  it('calls auth.set_default_company with (user, company) and never a raw UPDATE', async () => {
    await setDefaultCompany('user-1', 'cccccccc-0000-0000-0000-000000000001');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('auth.set_default_company(');
    expect(calls[0]?.text).not.toMatch(/UPDATE\s+company_users/i);
    expect(calls[0]?.values).toEqual(['user-1', 'cccccccc-0000-0000-0000-000000000001']);
  });
});

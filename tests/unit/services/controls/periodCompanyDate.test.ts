import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
const record = vi.hoisted(() => vi.fn(async (_ctx: unknown, _input: unknown) => ({ eventId: 'event', newVersion: 2 })));
vi.mock('@/lib/auth/effectivePermissions', () => ({ resolveEffectivePermissions: async () => ({ role: 'admin' }) }));
vi.mock('@/modules/accounting/services/controls/changeEventService', () => ({ recordCommittedChange: record }));
vi.mock('@/modules/accounting/services/controls/operationVersions', () => ({ readControlEntityVersion: async () => ({ version: 1 }) }));
import { withControlRequest } from '@/modules/accounting/services/controls/context';
import { updateCompany } from '@/modules/accounting/services/core/companyService';
it('preserves the accounting date of a pg local-midnight lockdown date during a harmless edit', async () => {
  const companyId = 'b1111111-1111-4111-8111-111111111111';
  const row = { id: companyId, name: 'Synthetic', lockdown_enabled: true, lockdown_date: new Date(2026,7,31) };
  const client = { query: vi.fn(async (query: string) => ({ rows: query.includes('companies') ? [row] : [] })) } as unknown as PoolClient;
  await withControlRequest({ client, userId: 'u1', companyId, claims: {} }, { personId: 'u1', companyId, authMethod: 'cookie' },
    () => updateCompany(companyId, { tradingName: 'Harmless' }));
  expect(record.mock.calls[0]?.[1]).toMatchObject({ accountingDate: '2026-08-31', action: 'company_updated' });
});

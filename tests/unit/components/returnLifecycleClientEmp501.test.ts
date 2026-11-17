/**
 * The shared lifecycle client sends EMP501 to its own payroll-detail route (wave 6 EFb): one path, the action in the
 * body; VAT201 and EMP201 keep /api/accounting/sars/returns/[form]/[action].
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', () => ({ apiFetch, assertOk: vi.fn() }));

import { loadReturnVersions, postReturnAction } from '@/components/accounting/sars/returns/returnLifecycleClient';

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { versions: [], vatReturn: null } }) });
});

describe('returnLifecycleClient for EMP501', () => {
  it('loads versions from the EMP501 route', async () => {
    await loadReturnVersions('EMP501', '2025-03-01', '2025-08-31');
    expect(apiFetch.mock.calls[0]![0]).toBe('/api/payroll/emp501/returns?periodStart=2025-03-01&periodEnd=2025-08-31');
  });

  it('posts the action in the body to the EMP501 route', async () => {
    await postReturnAction('EMP501', 'file', { versionId: 'v1', reference: 'R' });
    expect(apiFetch.mock.calls[0]![0]).toBe('/api/payroll/emp501/returns');
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toEqual({ action: 'file', versionId: 'v1', reference: 'R' });
  });

  it('EMP201 keeps the generic route and body', async () => {
    await postReturnAction('EMP201', 'amend', { versionId: 'v1', reason: 'x' });
    expect(apiFetch.mock.calls[0]![0]).toBe('/api/accounting/sars/returns/emp201/amend');
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toEqual({ versionId: 'v1', reason: 'x' });
  });
});

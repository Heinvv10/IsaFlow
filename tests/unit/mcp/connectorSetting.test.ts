/** The MCP connector setting (migration 1056): the platform-lock truth table and the two SQL calls. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, hasFeatureMock } = vi.hoisted(() => ({ sqlMock: vi.fn(), hasFeatureMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: hasFeatureMock }));

import { getConnectorSetting, isLockedByPlatform, setConnectorSelfServe } from '@/lib/mcp/connectorSetting';

beforeEach(() => { sqlMock.mockReset(); hasFeatureMock.mockReset(); });

describe('isLockedByPlatform', () => {
  it.each([
    [{ enabled: false, set_via: null }, true],
    [{ enabled: false, set_via: 'platform_admin' }, true],
    [{ enabled: false, set_via: 'company_admin' }, false],
    [{ enabled: false, set_via: 'default_new_company' }, false],
    [{ enabled: true, set_via: null }, false],
    [{ enabled: true, set_via: 'platform_admin' }, false],
    [{ enabled: true, set_via: 'company_admin' }, false],
    [null, false],
  ])('%j -> %s', (row, locked) => {
    expect(isLockedByPlatform(row)).toBe(locked);
  });
});

describe('getConnectorSetting', () => {
  it('enabled comes from hasFeature (precedence unchanged), the lock from the override row', async () => {
    hasFeatureMock.mockResolvedValue(false);
    sqlMock.mockResolvedValue([{ enabled: false, set_via: null }]);
    await expect(getConnectorSetting('co-1')).resolves.toEqual({ enabled: false, lockedByPlatform: true });
    expect(hasFeatureMock).toHaveBeenCalledWith('co-1', 'mcp_connector');
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual(['co-1', 'mcp_connector']);
  });

  it('no row: not locked', async () => {
    hasFeatureMock.mockResolvedValue(false);
    sqlMock.mockResolvedValue([]);
    await expect(getConnectorSetting('co-1')).resolves.toEqual({ enabled: false, lockedByPlatform: false });
  });
});

describe('setConnectorSelfServe', () => {
  it('calls mcp_connector_self_serve_set with the company and state bound', async () => {
    sqlMock.mockResolvedValue([{ result: 'ok', was_enabled: true, was_set_via: 'default_new_company' }]);
    await expect(setConnectorSelfServe('co-1', false)).resolves.toEqual({ result: 'ok', wasEnabled: true, wasSetVia: 'default_new_company' });
    const [strings, ...values] = sqlMock.mock.calls[0]!;
    expect((strings as string[]).join('?')).toContain('public.mcp_connector_self_serve_set(');
    expect(values).toEqual(['co-1', false]);
  });

  it.each([[[]], [[{ result: 'surprise', was_enabled: null, was_set_via: null }]]])('an unexpected answer (%j) is forbidden', async (rows) => {
    sqlMock.mockResolvedValue(rows);
    await expect(setConnectorSelfServe('co-1', true)).resolves.toMatchObject({ result: 'forbidden' });
  });
});

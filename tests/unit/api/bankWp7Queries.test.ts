/**
 * WP7: bank-tx-queries. POST is rate-limited per company (429 before anything is sent), and changing the company's
 * default query number (saveAsDefault, settings PATCH) is for an owner or admin only. Real withWriteAccess; transport mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UUID_A, callRoute } from '../helpers/apiRouteCall';

const createAndSendQuery = vi.fn();
const saveQuerySettings = vi.fn();
const getQuerySettings = vi.fn();
const sendLimit = vi.fn();
vi.mock('@/modules/accounting/services/capture/bankTxQueryService', () => ({
  createAndSendQuery: (...a: unknown[]) => createAndSendQuery(...a),
  listQueries: vi.fn(async () => []),
  saveQuerySettings: (...a: unknown[]) => saveQuerySettings(...a),
  getQuerySettings: (...a: unknown[]) => getQuerySettings(...a),
}));
vi.mock('@/lib/rateLimit', () => ({ checkSendRateLimit: (...a: unknown[]) => sendLimit(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', async () => ({ withAuth: (h: unknown) => h, withWriteAccess: (await import('@/lib/auth/withWriteAccess')).withWriteAccess }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import queries from '../../../pages/api/accounting/bank-tx-queries/index';
import settings from '../../../pages/api/accounting/bank-tx-queries/settings';

const body = { bankTransactionId: UUID_A, toNumber: '+27821234567' };
beforeEach(() => {
  createAndSendQuery.mockReset().mockResolvedValue({ ok: true, query: { id: 'q1' } });
  saveQuerySettings.mockReset().mockResolvedValue({ ok: true });
  getQuerySettings.mockReset().mockResolvedValue({ clientQueryWhatsapp: null, companyName: 'Co' });
  sendLimit.mockReset().mockResolvedValue(true);
});

describe('POST /bank-tx-queries', () => {
  it('sends when under the limit, charging the company bucket by name', async () => {
    expect((await callRoute(queries, { method: 'POST', body, role: 'manager' })).code).toBe(201);
    expect(sendLimit).toHaveBeenCalledWith(expect.anything(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bank-tx-queries', expect.objectContaining({ companyMax: expect.any(Number), dailyMax: expect.any(Number) }));
  });

  it('over the limit is a 429 and nothing is sent', async () => {
    sendLimit.mockResolvedValue(false);
    expect((await callRoute(queries, { method: 'POST', body })).code).toBe(429);
    expect(createAndSendQuery).not.toHaveBeenCalled();
  });

  it('an invalid body does not spend the limit', async () => {
    expect((await callRoute(queries, { method: 'POST', body: { toNumber: '1' } })).code).toBeGreaterThanOrEqual(400);
    expect(sendLimit).not.toHaveBeenCalled();
  });

  it('saveAsDefault by a manager is a 403 (it rewrites the company setting); an admin may', async () => {
    expect((await callRoute(queries, { method: 'POST', body: { ...body, saveAsDefault: true }, role: 'manager' })).code).toBe(403);
    expect(createAndSendQuery).not.toHaveBeenCalled();
    expect((await callRoute(queries, { method: 'POST', body: { ...body, saveAsDefault: true }, role: 'admin' })).code).toBe(201);
  });
});

describe('settings', () => {
  it.each(['manager', 'accountant', 'viewer'])('PATCH by a %s is a 403 and saves nothing', async (role) => {
    const r = await callRoute(settings, { method: 'PATCH', body: { clientQueryWhatsapp: '+27821234567' }, role });
    expect(r.code).toBe(403);
    expect(saveQuerySettings).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('PATCH by an %s saves', async (role) => {
    expect((await callRoute(settings, { method: 'PATCH', body: { clientQueryWhatsapp: '+27821234567' }, role })).code).toBe(200);
    expect(saveQuerySettings).toHaveBeenCalledTimes(1);
  });

  it('GET stays open to a manager', async () => {
    expect((await callRoute(settings, { method: 'GET', role: 'manager' })).code).toBe(200);
  });
});

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
const mayMessage = vi.fn();
vi.mock('@/modules/accounting/services/capture/bankTxQueryService', () => ({
  createAndSendQuery: (...a: unknown[]) => createAndSendQuery(...a),
  listQueries: vi.fn(async () => []),
  mayMessageNumber: (...a: unknown[]) => mayMessage(...a),
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
  mayMessage.mockReset().mockResolvedValue(false);
});

describe('POST /bank-tx-queries', () => {
  it('sends when under the limit, charging the company bucket by name', async () => {
    expect((await callRoute(queries, { method: 'POST', body, role: 'admin' })).code).toBe(201);
    expect(sendLimit).toHaveBeenCalledWith(expect.anything(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bank-tx-queries', expect.objectContaining({ companyMax: expect.any(Number), dailyMax: expect.any(Number) }));
  });

  it('over the limit is a 429 and nothing is sent', async () => {
    sendLimit.mockResolvedValue(false);
    expect((await callRoute(queries, { method: 'POST', body, role: 'owner' })).code).toBe(429);
    expect(createAndSendQuery).not.toHaveBeenCalled();
  });

  it('an invalid body, or a number that cannot be messaged, does not spend the limit', async () => {
    expect((await callRoute(queries, { method: 'POST', body: { toNumber: '1' }, role: 'owner' })).code).toBeGreaterThanOrEqual(400);
    expect((await callRoute(queries, { method: 'POST', body: { ...body, toNumber: 'not a number!!' }, role: 'owner' })).code).toBe(400);
    expect(sendLimit).not.toHaveBeenCalled();
    expect(createAndSendQuery).not.toHaveBeenCalled();
  });

  it('an unconfirmed send is a 409 carrying the reason (the row is recorded; the 4xx commits it)', async () => {
    createAndSendQuery.mockResolvedValue({ ok: false, unconfirmed: true, reason: 'could not be confirmed' });
    const r = await callRoute(queries, { method: 'POST', body, role: 'owner' });
    expect(r.code).toBe(409);
    createAndSendQuery.mockResolvedValue({ ok: false, reason: 'twilio not configured' });
    expect((await callRoute(queries, { method: 'POST', body, role: 'owner' })).code).toBe(400); // a definite refusal
  });

  describe('who may message which number', () => {
    it.each(['owner', 'admin'])('an %s may message any number, and set the default', async (role) => {
      expect((await callRoute(queries, { method: 'POST', body: { ...body, saveAsDefault: true }, role })).code).toBe(201);
      expect(mayMessage).not.toHaveBeenCalled();
    });

    it.each(['manager', 'accountant', 'viewer'])('a %s may NOT message a number that is neither the default nor on the line\'s thread (403, nothing sent, nothing charged)', async (role) => {
      mayMessage.mockResolvedValue(false);
      const r = await callRoute(queries, { method: 'POST', body, role });
      // a viewer never gets this far in production (withWriteAccess); the route's own rule still holds
      expect(r.code).toBe(403);
      expect(createAndSendQuery).not.toHaveBeenCalled();
      expect(sendLimit).not.toHaveBeenCalled();
    });

    it('a manager may message the saved default number, or reply on an existing thread (mayMessageNumber true)', async () => {
      mayMessage.mockResolvedValue(true);
      expect((await callRoute(queries, { method: 'POST', body, role: 'manager' })).code).toBe(201);
      expect(mayMessage).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', UUID_A, '+27821234567'); // normalised
    });

    it('a manager may not set the default number even to a permitted one (403)', async () => {
      mayMessage.mockResolvedValue(true);
      expect((await callRoute(queries, { method: 'POST', body: { ...body, saveAsDefault: true }, role: 'manager' })).code).toBe(403);
      expect(createAndSendQuery).not.toHaveBeenCalled();
    });
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

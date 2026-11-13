/**
 * The three-way fetchers (budgets P6 spec §7, §13.18): `apiFetch` RESOLVES on a 4xx, so every answer is checked
 * with `res.ok` and turned into a typed result the UI switches on. Nothing here throws on a status, and a 4xx is
 * never read as data (a `?? []` over an error body would show an empty budget).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: h.apiFetch }));

import { fetchThreeWay, saveAssumptionsDoc, fetchCompare, fetchAssumptions, fetchDerive } from '@/components/accounting/budgets/threeWay/threeWayClient';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, details: Record<string, unknown>, message = 'refused') => json(status, { success: false, error: { message, details } });
const DOC = { schemaVersion: 1 } as const;
const V = '11111111-1111-4111-8111-111111111111';

afterEach(() => { h.apiFetch.mockReset(); });

describe('saveAssumptionsDoc', () => {
  it('PUTs the version, the document and the token as read', async () => {
    h.apiFetch.mockResolvedValueOnce(json(200, { success: true, data: { versionId: V, doc: DOC, updatedAt: 't2', updatedBy: 'u' } }));
    const r = await saveAssumptionsDoc(V, DOC, 't1');
    expect(r).toEqual({ ok: true, data: { versionId: V, doc: DOC, updatedAt: 't2', updatedBy: 'u' } });
    const [url, init] = h.apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/accounting/budget-three-way/assumptions');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ version_id: V, doc: DOC, expected_updated_at: 't1' });
  });

  it('409 BUDGET_ASSUMPTIONS_STALE → stale, with the token now', async () => {
    h.apiFetch.mockResolvedValueOnce(err(409, { code: 'BUDGET_ASSUMPTIONS_STALE', currentUpdatedAt: 't9' }, 'changed'));
    expect(await saveAssumptionsDoc(V, DOC, 't1')).toEqual({ ok: false, kind: 'stale', message: 'changed', currentUpdatedAt: 't9' });
  });

  it('409 BUDGET_VERSION_LOCKED → locked', async () => {
    h.apiFetch.mockResolvedValueOnce(err(409, { code: 'BUDGET_VERSION_LOCKED' }, 'locked'));
    expect(await saveAssumptionsDoc(V, DOC, null)).toEqual({ ok: false, kind: 'locked', message: 'locked' });
  });

  it('400 BUDGET_ASSUMPTIONS_INVALID → invalid, naming every issue by path', async () => {
    h.apiFetch.mockResolvedValueOnce(err(400, { code: 'BUDGET_ASSUMPTIONS_INVALID', issues: [{ path: 'workingCapital.debtorDays.value', message: 'Too big' }] }));
    const r = await saveAssumptionsDoc(V, DOC, null);
    expect(r).toMatchObject({ ok: false, kind: 'invalid', issues: ['workingCapital.debtorDays.value: Too big'] });
  });

  it('a dropped connection → network, never a throw', async () => {
    h.apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await saveAssumptionsDoc(V, DOC, null)).toMatchObject({ ok: false, kind: 'network' });
  });

  it('a 2xx that is not the envelope is a failure, not data', async () => {
    h.apiFetch.mockResolvedValueOnce(new Response('<html>proxy</html>', { status: 200 }));
    expect(await saveAssumptionsDoc(V, DOC, null)).toMatchObject({ ok: false, kind: 'failed' });
  });
});

describe('fetchThreeWay / fetchCompare', () => {
  it('403 (no flag) → forbidden: the error body is never read as a run', async () => {
    h.apiFetch.mockResolvedValueOnce(err(403, {}, 'This feature is not enabled'));
    expect(await fetchThreeWay(V)).toEqual({ ok: false, kind: 'forbidden', message: 'This feature is not enabled' });
    expect(h.apiFetch.mock.calls[0]![0]).toBe(`/api/accounting/budget-three-way?version_id=${V}`);
  });

  it('409 BUDGET_OPENING_UNBALANCED → conflict carrying the code', async () => {
    h.apiFetch.mockResolvedValueOnce(err(409, { code: 'BUDGET_OPENING_UNBALANCED', differenceCents: 5 }, 'Opening does not balance'));
    expect(await fetchThreeWay(V)).toMatchObject({ ok: false, kind: 'conflict', code: 'BUDGET_OPENING_UNBALANCED' });
  });

  it('compare sends the ids comma-separated', async () => {
    h.apiFetch.mockResolvedValueOnce(json(200, { success: true, data: { fiscalYear: 2027, months: [], versions: [] } }));
    const r = await fetchCompare([V, 'b']);
    expect(r.ok).toBe(true);
    expect(h.apiFetch.mock.calls[0]![0]).toBe(`/api/accounting/budget-three-way/compare?version_ids=${V}%2Cb`);
  });
});

describe('fetchAssumptions / fetchDerive', () => {
  it('400 BUDGET_ASSUMPTIONS_INVALID on a read → invalidDoc with every issue (the form offers the replacement)', async () => {
    h.apiFetch.mockResolvedValueOnce(err(400, { code: 'BUDGET_ASSUMPTIONS_INVALID', issues: [{ path: 'vat.basis.value', message: 'Invalid option' }] }, 'The assumptions document is invalid'));
    expect(await fetchAssumptions(V)).toEqual({ ok: false, kind: 'invalidDoc', message: 'The assumptions document is invalid', issues: ['vat.basis.value: Invalid option'] });
  });
  it('another 400 is not an invalid document', async () => {
    h.apiFetch.mockResolvedValueOnce(err(400, { code: 'BUDGET_SCENARIO_CHAIN', reason: 'CYCLE' }, 'chain'));
    expect(await fetchAssumptions(V)).toMatchObject({ ok: false, kind: 'failed', status: 400 });
  });
  it('403 → forbidden; a dropped connection → network', async () => {
    h.apiFetch.mockResolvedValueOnce(err(403, {}, 'off'));
    expect(await fetchAssumptions(V)).toEqual({ ok: false, kind: 'forbidden', message: 'off' });
    h.apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await fetchAssumptions(V)).toMatchObject({ ok: false, kind: 'network' });
  });
  it('derive POSTs the version id', async () => {
    h.apiFetch.mockResolvedValueOnce(json(200, { success: true, data: { version: {}, assumptions: {}, evidence: {} } }));
    expect((await fetchDerive(V)).ok).toBe(true);
    const [url, init] = h.apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/accounting/budget-three-way/derive');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ version_id: V });
  });
});

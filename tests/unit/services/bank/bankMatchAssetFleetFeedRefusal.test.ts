/**
 * bank-match-asset / bank-match-fleet — the routes' answers (mig 853: the link is an annotation, written by
 * `bankAssetLinkService.setBankLineLink`, which decides every refusal BEFORE its write — proven against Postgres in
 * tests/integration/fleet-asset-links.int.test.ts and d12-r2-links.int.test.ts).
 *
 * Here: the body each route accepts (a null id unlinks), the kind it passes on, and the one answer per refusal —
 *   - line not found for this company → 404;
 *   - target missing OR another company's → the same 404, naming no id;
 *   - pending/removed → 409 with BankTransactionNotPostedError's message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

const { setBankLineLink } = vi.hoisted(() => ({ setBankLineLink: vi.fn() }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/modules/accounting/services/bank/bankAssetLinkService', () => ({ setBankLineLink }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    notFound: vi.fn((_res: unknown, resource: string) => ({ kind: 'notFound', message: `${resource} not found` })),
    conflict: vi.fn((_res: unknown, message: string) => ({ kind: 'conflict', message })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

import assetHandler from '../../../../pages/api/accounting/bank-match-asset';
import fleetHandler from '../../../../pages/api/accounting/bank-match-fleet';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const BANK_TX_ID = '00000000-0000-0000-0000-000000000002';
const ASSET_ID = '00000000-0000-0000-0000-000000000003';
const FLEET_ID = '00000000-0000-0000-0000-000000000004';

type Out = { kind: string; message?: string; data?: Record<string, unknown> };
const req = (body: Record<string, unknown>) => ({ method: 'POST', companyId: COMPANY_ID, body } as never);
const asset = async (assetId: string | null) =>
  (await assetHandler(req({ bankTransactionId: BANK_TX_ID, assetId }), {} as NextApiResponse)) as unknown as Out;
const fleet = async (fleetEntityType: string, fleetEntityId: string | null) => (await fleetHandler(
  req({ bankTransactionId: BANK_TX_ID, fleetEntityType, fleetEntityId }), {} as NextApiResponse)) as unknown as Out;

beforeEach(() => { vi.clearAllMocks(); setBankLineLink.mockReset(); });

describe('bank-match-asset', () => {
  it('links: passes kind asset and the id; 200 linked', async () => {
    setBankLineLink.mockResolvedValueOnce({ ok: true });
    const out = await asset(ASSET_ID);
    expect(setBankLineLink).toHaveBeenCalledWith(COMPANY_ID, BANK_TX_ID, 'asset', ASSET_ID);
    expect(out).toMatchObject({ kind: 'success', data: { linked: true, bankTransactionId: BANK_TX_ID, assetId: ASSET_ID } });
  });

  it('a null assetId unlinks', async () => {
    setBankLineLink.mockResolvedValueOnce({ ok: true });
    const out = await asset(null);
    expect(setBankLineLink).toHaveBeenCalledWith(COMPANY_ID, BANK_TX_ID, 'asset', null);
    expect(out).toMatchObject({ kind: 'success', data: { linked: false, assetId: null } });
  });

  it('a missing line is 404', async () => {
    setBankLineLink.mockResolvedValueOnce({ ok: false, refused: 'line' });
    expect(await asset(ASSET_ID)).toEqual({ kind: 'notFound', message: 'Bank transaction not found' });
  });

  it('a missing or foreign asset is the same 404, naming no id', async () => {
    setBankLineLink.mockResolvedValueOnce({ ok: false, refused: 'target' });
    expect(await asset(ASSET_ID)).toEqual({ kind: 'notFound', message: 'Asset not found' });
  });

  it('a pending line is 409 with the not-posted message', async () => {
    setBankLineLink.mockResolvedValueOnce({ ok: false, refused: 'not_posted', feedState: 'pending' });
    const out = await asset(ASSET_ID);
    expect(out.kind).toBe('conflict');
    expect(out.message).toMatch(/still pending at the bank/);
  });

  it('an unknown field or a non-UUID id is refused before the service runs', async () => {
    expect((await assetHandler(req({ bankTransactionId: BANK_TX_ID, assetId: ASSET_ID, status: 'matched' }),
      {} as NextApiResponse) as unknown as Out).kind).toBe('validationError');
    expect((await asset('not-a-uuid')).kind).toBe('validationError');
    expect(setBankLineLink).not.toHaveBeenCalled();
  });
});

describe('bank-match-fleet', () => {
  it.each(['fuel', 'service'])('links a %s record: passes that kind', async (kind) => {
    setBankLineLink.mockResolvedValueOnce({ ok: true });
    const out = await fleet(kind, FLEET_ID);
    expect(setBankLineLink).toHaveBeenCalledWith(COMPANY_ID, BANK_TX_ID, kind, FLEET_ID);
    expect(out).toMatchObject({ kind: 'success', data: { linked: true, fleetEntityType: kind, fleetEntityId: FLEET_ID } });
  });

  it('a null fleetEntityId unlinks that kind', async () => {
    setBankLineLink.mockResolvedValueOnce({ ok: true });
    const out = await fleet('service', null);
    expect(setBankLineLink).toHaveBeenCalledWith(COMPANY_ID, BANK_TX_ID, 'service', null);
    expect(out).toMatchObject({ kind: 'success', data: { linked: false, fleetEntityId: null } });
  });

  it.each([['fuel', 'Fuel record not found'], ['service', 'Service record not found']])(
    'a missing or foreign %s record is one 404', async (kind, message) => {
      setBankLineLink.mockResolvedValueOnce({ ok: false, refused: 'target' });
      expect(await fleet(kind, FLEET_ID)).toEqual({ kind: 'notFound', message });
    });

  it('a removed line is 409 with the not-posted message', async () => {
    setBankLineLink.mockResolvedValueOnce({ ok: false, refused: 'not_posted', feedState: 'removed' });
    const out = await fleet('fuel', FLEET_ID);
    expect(out.kind).toBe('conflict');
    expect(out.message).toMatch(/removed by the bank/);
  });

  it('an unknown fleetEntityType is refused before the service runs', async () => {
    expect((await fleet('vehicle', FLEET_ID)).kind).toBe('validationError');
    expect(setBankLineLink).not.toHaveBeenCalled();
  });
});

/**
 * R-035 PR5 (orchestrator decision, fail closed under opt-in enforcement): the
 * two routes that turn a batch into money leaving — the EFT file
 * (eft-generate) and the Netcash submission (netcash/submit) — check no batch
 * status. Under payment_batch enforcement they answer 409 for a batch the
 * approval gate does not clear; under either payment type's enforcement
 * Netcash refuses a raw payments[] list (403: nothing can approve it). With
 * enforcement off both behave as before. Netcash is never called: its client
 * is replaced with a spy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import eftGenerate from '../../pages/api/accounting/eft-generate';
import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupPr5, enforcePay, payCompany, payRoutes, plantBatch, type PayType } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = payRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'R035-SPY', mock: true });
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

async function fixture(enforced: PayType[] = ['payment_batch']) {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  for (const type of ['supplier_payment', 'payment_batch'] as const) await plantRule(pool, c, 'owner', { documentType: type });
  for (const type of enforced) await enforcePay(pool, c, type, u.b);
  return { c, b: await plantBatch(pool, c, u.a, bank) };
}

const eft = (c: string, batchId: string) => callRoute(eftGenerate, tokens[u.a]!, c, 'POST', { batchId, bank: 'fnb' },
  '/api/accounting/eft-generate');
const netcash = (c: string, body: Record<string, unknown>) => callRoute(netcashSubmit, tokens[u.a]!, c, 'POST', body,
  '/api/accounting/netcash/submit');
const RAW = { payments: [{ accountHolder: 'Anyone', bankCode: '250655', accountNumber: '62000000009', amount: 100000, reference: 'x' }] };

describe('eft-generate', () => {
  it('refuses 409 for a batch the gate does not clear', async () => {
    const { c, b } = await fixture();
    const res = await eft(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).toMatch(/^Payment batch \S+ needs owner approval before it can be paid/);
  });

  it('answers an approved batch, and an unenforced one, exactly alike (whatever the route answered before)', async () => {
    const enforced = await fixture();
    await r.approvedBy(pool, u.a, u.b, enforced.c, 'payment_batch', enforced.b.id);
    const off = await fixture([]);
    const [onRes, offRes] = [await eft(enforced.c, enforced.b.id), await eft(off.c, off.b.id)];
    expect(onRes.state.statusCode).not.toBe(409);
    expect(onRes.state.statusCode).toBe(offRes.state.statusCode);
  });
});

describe('netcash/submit', () => {
  it('refuses 409 for an ungated batch before anything is sent', async () => {
    const { c, b } = await fixture();
    const res = await netcash(c, { batchPaymentId: b.id });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(submitEftBatch).not.toHaveBeenCalled();
  });

  it.each([[['payment_batch']], [['supplier_payment']]] as PayType[][][])(
    'refuses a raw payments[] list 403 under %s enforcement, before anything is sent', async (enforced) => {
      const { c } = await fixture(enforced);
      const res = await netcash(c, RAW);
      expect(res.state.statusCode).toBe(403);
      expect(messageOf(res)).toBe('Supplier payment approvals are enforced, and a raw payment list cannot be approved — submit an approved batch.');
      expect(submitEftBatch).not.toHaveBeenCalled();
      expect((await pool.query('SELECT count(*)::INT AS n FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].n).toBe(0);
    });

  it('enforcement off: a raw list is sent as before', async () => {
    const { c } = await fixture([]);
    const res = await netcash(c, RAW);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(submitEftBatch).toHaveBeenCalledTimes(1);
  });
});

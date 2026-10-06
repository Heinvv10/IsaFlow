/**
 * R-035 PR5 (orchestrator decision, fail closed under opt-in enforcement; round
 * 1 LOWs a, e, f): the two routes that turn a batch into money leaving — the
 * EFT file (eft-generate) and the Netcash submission (netcash/submit). Under
 * payment_batch enforcement they answer 409 for a batch that is not approved,
 * or that the approval gate does not clear, its payees share-locked first so
 * an edit in flight is judged; Netcash refuses a raw payments[] list (403:
 * nothing can approve it); a cleared batch gets a correct file (the
 * pre-existing `sp.amount` sent R0 / failed). Enforcement off: as before.
 * Netcash is never called: its client is replaced with a spy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import eftGenerate from '../../pages/api/accounting/eft-generate';
import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr5, enforcePay, payCompany, payRoutes, plantBatch, type PayType } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', v: '' };
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
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.v, 'viewer']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  for (const type of ['supplier_payment', 'payment_batch'] as const) await plantRule(pool, c, 'owner', { documentType: type });
  for (const type of enforced) await enforcePay(pool, c, type, u.b);
  return { c, b: await plantBatch(pool, c, u.a, bank) };
}

const eft = (c: string, batchId: string) => callRoute(eftGenerate, tokens[u.a]!, c, 'POST', { batchId, bank: 'fnb' },
  '/api/accounting/eft-generate');
const netcash = (c: string, body: Record<string, unknown>) => callRoute(netcashSubmit, tokens[u.a]!, c, 'POST', body,
  '/api/accounting/netcash/submit');
/** Approved through the real routes: B approves A's request for the current content, A approves the batch. */
async function cleared(c: string, batchId: string) {
  await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', batchId);
  expect((await r.batch(u.a, c, 'approve', batchId)).state.statusCode).toBe(200);
}
/** Approved (status) while enforcement was off, then enforced: no approval clears it. */
async function approvedBeforeEnforcement() {
  const fx = await fixture([]);
  expect((await r.batch(u.a, fx.c, 'approve', fx.b.id)).state.statusCode).toBe(200);
  await enforcePay(pool, fx.c, 'payment_batch', u.b);
  return fx;
}
const DRAFT = 'Batch is draft, so it cannot be sent to the bank: approve it first.';
const RAW = { payments: [{ accountHolder: 'Anyone', bankCode: '250655', accountNumber: '62000000009', amount: 100000, reference: 'x' }] };

describe('eft-generate', () => {
  it('under enforcement refuses 409 a batch that is still a draft (round 1 LOW f)', async () => {
    const { c, b } = await fixture();
    const res = await eft(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(messageOf(res)).toBe(DRAFT);
  });

  it('refuses 409 an approved batch the gate does not clear', async () => {
    const { c, b } = await approvedBeforeEnforcement();
    const res = await eft(c, b.id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).toMatch(/^Payment batch \S+ needs owner approval before it can be paid/);
  });

  it('a cleared batch gets a correct file: every line, its payee account, its amount (round 1 LOW e)', async () => {
    const { c, b } = await fixture();
    await cleared(c, b.id);
    const res = await eft(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const data = dataOf<{ paymentCount: number; totalAmount: number; content: string }>(res);
    expect(data).toMatchObject({ paymentCount: 2, totalAmount: 3450 });
    expect(data.content).toContain('62000000001');
  });

  it('enforcement off: a draft batch gets its file as before, now with its real amounts', async () => {
    const { c, b } = await fixture([]);
    const res = await eft(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ totalAmount: number }>(res).totalAmount).toBe(3450);
  });

  it('waits for a payee bank-detail edit in flight, and the gate then judges the new details: 409 stale (LOW a)', async () => {
    const { c, b } = await fixture();
    await cleared(c, b.id);
    const held = await pool.connect();
    await held.query('BEGIN');
    await held.query("UPDATE suppliers SET bank_account_number = '62999999999' WHERE id = $1", [b.members[0]!.supplierId]);
    const generating = eft(c, b.id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await held.query('COMMIT');
    held.release();
    const res = await generating;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_STALE');
  });
});

describe('netcash/submit', () => {
  it('under enforcement refuses 409 a draft batch and an uncleared approved one, before anything is sent', async () => {
    const draft = await fixture();
    const res = await netcash(draft.c, { batchPaymentId: draft.b.id });
    expect(res.state.statusCode).toBe(409);
    expect(messageOf(res)).toBe(DRAFT);
    const uncleared = await approvedBeforeEnforcement();
    const gated = await netcash(uncleared.c, { batchPaymentId: uncleared.b.id });
    expect(gated.state.statusCode).toBe(409);
    expect(reasonOf(gated)).toBe('APPROVAL_REQUIRED');
    expect(submitEftBatch).not.toHaveBeenCalled();
  });

  it('a cleared batch is submitted with every payee and its amount in cents (round 1 LOW e)', async () => {
    const { c, b } = await fixture();
    await cleared(c, b.id);
    const res = await netcash(c, { batchPaymentId: b.id });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(submitEftBatch).toHaveBeenCalledTimes(1);
    const sent = submitEftBatch.mock.calls[0]![2] as { accountNumber: string; amount: number }[];
    expect(sent.map((p) => p.amount).sort((x, y) => x - y)).toEqual([115000, 230000]);
    expect(sent.every((p) => p.accountNumber === '62000000001')).toBe(true);
  });

  it('refuses a raw payments[] list 403 under (coupled) payment enforcement, before anything is sent', async () => {
    const { c } = await fixture(['supplier_payment']);
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

  it('a read-only member cannot submit (withWriteAccess, round 1 LOW f)', async () => {
    const { c } = await fixture([]);
    const res = await callRoute(netcashSubmit, tokens[u.v]!, c, 'POST', RAW, '/api/accounting/netcash/submit');
    expect(res.state.statusCode).toBe(403);
    expect(submitEftBatch).not.toHaveBeenCalled();
  });
});

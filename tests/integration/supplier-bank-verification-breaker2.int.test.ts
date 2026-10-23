/**
 * The adversarial reviewer's round-2 repros for PR #679 (attacks on the round-1
 * fixes at 36d817177), kept as regression tests. R2-1: a baseline is written
 * only on the company's FIRST switch-on, so off/on cannot launder a supplier
 * created, or given details, while the control was on. R2-2: an owner-level
 * payment rule does not leave the sole owner's own change unverifiable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { createSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, reasonOf } from './r035-approval.helpers';
import { cleanupPr5, inRequest, plantApprovedBatch, plantSupplier } from './r035-pr5.helpers';
import { bankCompany, bankRoutes } from './supplier-bank-verification.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
/** a admin (attacker), b owner, c admin. */
const u = { a: '', b: '', c: '' };
const r = bankRoutes(pool, tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'BRK2-SPY', mock: true });
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

async function onWithBatch() {
  const { company: c, bank } = await bankCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], companies);
  const batch = await plantApprovedBatch(pool, c, u.b, bank);
  expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
  return { c, batch };
}

/** Points the batch's first payment at `supplierId` (setup only: the payee the attacker wants paid). */
const payee = (batchPaymentId: string, supplierId: string) =>
  pool.query('UPDATE supplier_payments SET supplier_id = $1 WHERE id = $2', [supplierId, batchPaymentId]);

describe('R2-1 — off/on still launders a pending change on a supplier with NO verification history', () => {
  it('a supplier the admin CREATES (with bank details) while the control is on stays unverified across the owner\'s off/on', async () => {
    const { c, batch } = await onWithBatch();
    const created = await inRequest(pool, u.a, c, () => createSupplier(c, {
      name: 'Attacker Supplies', bankName: 'Evil Bank', bankAccountNumber: '62999999999', bankBranchCode: '250655',
      bankAccountType: 'current',
    }, u.a));
    const s = String(created.id);
    await payee(batch.members[0]!.id, s);
    expect((await r.state(u.c, c, s)).state).toBe('unverified');
    expect((await r.eft(u.a, c, batch.id)).state.statusCode).toBe(409); // premise
    expect((await r.toggle(u.b, c, false)).state.statusCode).toBe(200);
    expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
    const eft = await r.eft(u.a, c, batch.id);
    expect({ state: (await r.state(u.c, c, s)).state, eft: eft.state.statusCode })
      .toEqual({ state: 'unverified', eft: 409 });
  });

  it('a supplier that had NO bank details at the first switch-on, given details by the admin later, stays unverified across off/on', async () => {
    const { c, batch } = await onWithBatch();
    const s = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers(id, company_id, name) VALUES($1, $2, 'Blank Ltd')", [s, c]);
    await r.changeBank(u.a, c, s, { bankName: 'Evil Bank', bankAccountNumber: '62999999998', bankBranchCode: '250655' });
    await payee(batch.members[0]!.id, s);
    expect((await r.state(u.c, c, s)).state).toBe('unverified');
    expect((await r.toggle(u.b, c, false)).state.statusCode).toBe(200);
    expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
    const eft = await r.eft(u.a, c, batch.id);
    expect({ state: (await r.state(u.c, c, s)).state, eft: eft.state.statusCode })
      .toEqual({ state: 'unverified', eft: 409 });
  });
});

describe('the switch preview after a first switch-on', () => {
  it('off again, it says switching on would accept 0 — though suppliers with bank details exist', async () => {
    const { c } = await onWithBatch();
    await plantSupplier(pool, c); // added after the first switch-on: no verification history
    expect((await r.toggle(u.b, c, false)).state.statusCode).toBe(200);
    const res = await callRoute(approvalEnforcement, tokens[u.b]!, c, 'GET', undefined, '/api/accounting/approval-enforcement',
      { preview: '1' });
    expect((res.state.body as { data: { preview: Record<string, number> } }).data.preview.supplier_bank_details).toBe(0);
  });
});

describe('CONTROL (expected green) — a supplier with history keeps its verified state across off/on', () => {
  it('unchanged details stay verified; the re-switch-on is not blocked', async () => {
    const { c, batch } = await onWithBatch();
    const s = batch.members[0]!.supplierId;
    expect((await r.toggle(u.b, c, false)).state.statusCode).toBe(200);
    const on = await r.toggle(u.b, c, true);
    expect(on.state.statusCode, JSON.stringify(on.state.body)).toBe(200);
    expect((await r.state(u.c, c, s)).state).toBe('verified');
    expect((await r.eft(u.a, c, batch.id)).state.statusCode).toBe(200);
  });
});

describe('R2-2 (liveness) — an owner-level payment rule does not make the owner\'s own bank change unverifiable', () => {
  it('the owner (setter) is refused; the admin who did not set it verifies', async () => {
    const { c, batch } = await onWithBatch();
    const s = batch.members[0]!.supplierId;
    const rule = await callRoute(approvalRules, tokens[u.b]!, c, 'POST', {
      name: 'owner batches', documentType: 'payment_batch', conditionField: 'total',
      conditionOperator: 'greater_than', conditionValue: 100000, approverRole: 'owner',
    }, '/api/accounting/approval-rules');
    expect(rule.state.statusCode).toBe(200);
    await r.changeBank(u.b, c, s, { bankAccountNumber: '62888888888' });
    const owner = await r.verify(u.b, c, s);
    const admin = await r.verify(u.c, c, s);
    expect(reasonOf(owner)).toBe('SETTER_FORBIDDEN');
    expect(admin.state.statusCode, JSON.stringify(admin.state.body)).toBe(200);
  });
});

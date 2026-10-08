/**
 * Supplier bank-detail verification — WHO may verify (decisions 5 and 7):
 * the people the company's supplier-payment approval rules allow to approve
 * (the strictest active supplier_payment / payment_batch rule's role; with no
 * rule, R-035's default `admin`), never a setter of the current details,
 * except as R-035's sole approver (recorded `self_verified` with the roster
 * snapshot); a person in a cookie session, never an impersonated or MCP one;
 * and only for their own company's suppliers. Recording money that already
 * moved is never blocked by an unverified supplier (decision 1).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { verifySupplierBankDetails } from '@/modules/accounting/services/ap/supplierBankVerification';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, impersonationToken, messageOf } from './r035-pr2.helpers';
import supplierBankVerification from '../../pages/api/accounting/supplier-bank-verification';
import { cleanupPr5, inRequest, payRoutes, plantBatch, plantPayment, plantSupplier } from './r035-pr5.helpers';
import { bankCompany, bankRoutes, verificationsOf } from './supplier-bank-verification.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', c: '', k: '', p: '' };
const r = bankRoutes(pool, tokens);
const pay = payRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'SBV-SPY', mock: true });
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

/** Switched on by `on` (an owner); returns the company, its bank account and one supplier `setter` changed. */
async function changed(members: [string, string][], on: string, setter: string) {
  const { company: c, bank } = await bankCompany(pool, members, companies);
  const s = await plantSupplier(pool, c);
  expect((await r.toggle(on, c, true)).state.statusCode).toBe(200);
  await r.changeBank(setter, c, s, { bankAccountNumber: '62444444444' });
  return { c, bank, s };
}

describe('the verifier role', () => {
  it('with no supplier-payment rule the default is admin: a manager is refused 403, a bookkeeper too (no write access)', async () => {
    const { c, s } = await changed([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'manager'], [u.k, 'bookkeeper']], u.b, u.a);
    const res = await r.verify(u.c, c, s);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('VERIFIER_ROLE_REQUIRED');
    expect((await r.verify(u.k, c, s)).state.statusCode).toBe(403);
    expect((await verificationsOf(pool, s)).map((x) => x.kind)).toEqual(['baseline']);
  });

  it("follows the strictest supplier-payment rule: an owner-level payment_batch rule refuses an admin who set nothing", async () => {
    const { c, s } = await changed([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin'], [u.p, 'owner']], u.b, u.a);
    await plantRule(pool, c, 'manager', { documentType: 'supplier_payment' });
    await plantRule(pool, c, 'owner', { documentType: 'payment_batch' });
    const res = await r.verify(u.c, c, s);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('VERIFIER_ROLE_REQUIRED');
    expect((await r.verify(u.p, c, s)).state.statusCode).toBe(200);
  });
});

describe('the setter is not shed by a formatting-only re-entry', () => {
  it('A redirects the account, C re-types the same digits with spaces: A is still a setter and may not verify', async () => {
    const { c, s } = await changed([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], u.b, u.a);
    await r.changeBank(u.c, c, s, { bankAccountNumber: '624 4444 4444' });
    const setters = (await pool.query('SELECT bank_details_setters::TEXT[] AS s FROM suppliers WHERE id = $1', [s])).rows[0].s;
    expect(setters).toContain(u.a);
    const res = await r.verify(u.a, c, s);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('SETTER_FORBIDDEN');
  });
});

describe('a raised verifier role never leaves the details unverifiable', () => {
  it('owner-level payment rule, the only owner set the details: an admin who did not set them verifies (no dead end)', async () => {
    const { c, s } = await changed([[u.b, 'owner'], [u.c, 'admin'], [u.k, 'manager']], u.b, u.b);
    await plantRule(pool, c, 'owner', { documentType: 'payment_batch', operator: 'greater_than', value: 1000000 });
    const self = await r.verify(u.b, c, s);
    expect(self.state.statusCode).toBe(403);
    expect(reasonOf(self)).toBe('SETTER_FORBIDDEN');
    expect((await r.state(u.c, c, s)).canVerify).toBe(true);
    expect(reasonOf(await r.verify(u.k, c, s))).toBe('VERIFIER_ROLE_REQUIRED');
    expect((await r.verify(u.c, c, s)).state.statusCode).toBe(200);
    expect((await verificationsOf(pool, s)).at(-1)!.kind).toBe('verified');
  });

  it('…only for the owner\'s OWN destination: an admin\'s redirect the owner merely touched still needs the owner level', async () => {
    const { c, s } = await changed([[u.b, 'owner'], [u.a, 'admin'], [u.c, 'admin']], u.b, u.a);
    await plantRule(pool, c, 'owner', { documentType: 'payment_batch', operator: 'greater_than', value: 1000000 });
    await r.changeBank(u.b, c, s, { bankName: 'R035 BANK' }); // the owner touches a column: now a setter too
    const res = await r.verify(u.c, c, s);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('VERIFIER_ROLE_REQUIRED');
  });

  it('…nor when the owner created the account and an admin later changed another bank column (every setter must hold the role)', async () => {
    const { c, s } = await changed([[u.b, 'owner'], [u.a, 'admin'], [u.c, 'admin']], u.b, u.b);
    await plantRule(pool, c, 'owner', { documentType: 'payment_batch', operator: 'greater_than', value: 1000000 });
    await r.changeBank(u.a, c, s, { bankBranchCode: '470010' }); // the admin's change, under the owner's destination
    const res = await r.verify(u.c, c, s);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('VERIFIER_ROLE_REQUIRED');
  });

  it('…but while an owner who did NOT set them exists, the owner-level rule still binds: the admin is refused', async () => {
    const { c, s } = await changed([[u.b, 'owner'], [u.p, 'owner'], [u.c, 'admin']], u.b, u.b);
    await plantRule(pool, c, 'owner', { documentType: 'payment_batch', operator: 'greater_than', value: 1000000 });
    expect(reasonOf(await r.verify(u.c, c, s))).toBe('VERIFIER_ROLE_REQUIRED');
    expect((await r.verify(u.p, c, s)).state.statusCode).toBe(200);
  });
});

describe('the sole-approver exception (R-035 Q2)', () => {
  it('the only member of the verifier rank set the details: they verify, recorded self_verified with the roster', async () => {
    const { c, s } = await changed([[u.b, 'owner'], [u.k, 'bookkeeper']], u.b, u.b);
    const res = await r.verify(u.b, c, s);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const rows = await verificationsOf(pool, s);
    expect(rows.map((x) => [x.kind, x.verified_by])).toEqual([['baseline', u.b], ['self_verified', u.b]]);
    expect(rows[1]!.roster_snapshot).toMatchObject({ requester_role: 'owner', others: [{ user_id: u.k, role: 'bookkeeper' }] });
    expect((await r.state(u.b, c, s)).state).toBe('verified');
  });

  it('not while another member of the rank exists — even one who also set the details', async () => {
    const { c, s } = await changed([[u.a, 'admin'], [u.b, 'owner']], u.b, u.a);
    await r.changeBank(u.b, c, s, { bankBranchCode: '470010' });
    for (const who of [u.a, u.b]) {
      const res = await r.verify(who, c, s);
      expect(res.state.statusCode).toBe(403);
      expect(reasonOf(res)).toBe('SETTER_FORBIDDEN');
    }
  });

  it('when every other admin-or-above member also set the details, the refusal says so (no false "another member must")', async () => {
    const { c, s } = await changed([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], u.b, u.a);
    await r.changeBank(u.c, c, s, { bankBranchCode: '470010' });
    await r.changeBank(u.b, c, s, { bankAccountType: 'savings' });
    const res = await r.verify(u.c, c, s);
    expect(reasonOf(res)).toBe('SETTER_FORBIDDEN');
    expect(messageOf(res)).toMatch(/so did every other member with the admin role or above/);
  });

  it('a suspended second admin does not count: the sole active approver may self-verify', async () => {
    const { c, s } = await changed([[u.b, 'owner'], [u.c, 'admin']], u.b, u.b);
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [u.c]);
    try {
      expect((await r.verify(u.b, c, s)).state.statusCode).toBe(200);
      expect((await verificationsOf(pool, s)).at(-1)!.kind).toBe('self_verified');
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE id = $1', [u.c]);
    }
  });
});

describe('only a person, in their own session, in their own company', () => {
  it('an impersonated session is refused 403 — verify and switching on alike', async () => {
    const { c, s } = await changed([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], u.b, u.a);
    const token = await impersonationToken(pool, u.c, u.p);
    // The panel's hint agrees: the same person may verify in their own session, not under "login as".
    expect((await r.state(u.c, c, s)).canVerify).toBe(true);
    const hint = await callRoute(supplierBankVerification, token, c, 'GET', undefined, '/api/accounting/supplier-bank-verification',
      { supplierId: s });
    expect(dataOf<{ canVerify: boolean }>(hint).canVerify).toBe(false);
    const res = await r.verify(u.c, c, s, {}, token);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('IMPERSONATION_FORBIDDEN');
    const { company: d } = await bankCompany(pool, [[u.b, 'owner']], companies);
    const on = await r.toggle(u.b, d, true, await impersonationToken(pool, u.b, u.p));
    expect(on.state.statusCode).toBe(403);
    expect(reasonOf(on)).toBe('IMPERSONATION_FORBIDDEN');
  });

  it('outside a cookie session (an MCP or job context: no session claims) the service refuses', async () => {
    const { c, s } = await changed([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], u.b, u.a);
    const fingerprint = (await r.state(u.c, c, s)).fingerprint!;
    await expect(inRequest(pool, u.c, c, () => verifySupplierBankDetails({
      companyId: c, userId: u.c, supplierId: s, fingerprint, method: 'other', note: 'agent says so',
    }))).rejects.toMatchObject({ code: 'IMPERSONATION_FORBIDDEN' });
    expect((await verificationsOf(pool, s)).map((x) => x.kind)).toEqual(['baseline']);
  });

  it("company A's verifier cannot see or verify company B's supplier (404), even holding both ids", async () => {
    const { c: b, s } = await changed([[u.a, 'admin'], [u.b, 'owner']], u.b, u.a);
    const { company: a } = await bankCompany(pool, [[u.c, 'admin']], companies);
    expect((await r.toggle(u.c, a, true)).state.statusCode).toBe(200);
    const fingerprint = (await r.state(u.b, b, s)).fingerprint;
    expect((await r.get(u.c, a, s)).state.statusCode).toBe(404);
    const res = await r.verify(u.c, a, s, { fingerprint });
    expect(res.state.statusCode).toBe(404);
    expect((await verificationsOf(pool, s)).map((x) => x.kind)).toEqual(['baseline']);
  });
});

describe('recording is never blocked (decision 1)', () => {
  it('an unverified supplier: payment created, approved and processed; batch approved and processed; bank payment recorded', async () => {
    const { company: c, bank } = await bankCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    const p = await plantPayment(pool, c, u.a, bank);
    const batch = await plantBatch(pool, c, u.a, bank);
    expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
    for (const s of [p.supplierId, batch.members[0]!.supplierId]) await r.changeBank(u.a, c, s, { bankAccountNumber: '62444444444' });
    expect((await r.state(u.b, c, p.supplierId)).state).toBe('unverified');
    for (const action of ['approve', 'process']) {
      expect((await pay.payment(u.a, c, action, p.id)).state.statusCode, action).toBe(200);
      expect((await pay.batch(u.a, c, action, batch.id)).state.statusCode, action).toBe(200);
    }
    const recorded = await inRequest(pool, u.a, c, async (db) => {
      const je = (await db.query(
        "INSERT INTO gl_journal_entries(company_id,entry_date,created_by,status,description) VALUES($1,DATE '2026-09-01',$2,'posted','SBV') RETURNING id",
        [c, u.a])).rows[0].id as string;
      const bt = (await db.query(
        `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,import_batch_id)
         VALUES($1,$2,DATE '2026-09-01',-500,'SBV',gen_random_uuid()) RETURNING id`, [c, bank])).rows[0].id as string;
      return recordSupplierBankPayment({
        companyId: c, supplierId: p.supplierId, bankTxId: bt, bankAccountId: bank, journalEntryId: je,
        amount: 500, paymentDate: '2026-09-01', description: 'SBV bank payment', userId: u.a, autoApply: 'none',
      });
    });
    expect(recorded).toBeTruthy();
  });
});

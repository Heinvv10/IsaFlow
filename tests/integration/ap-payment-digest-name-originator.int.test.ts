/**
 * Migration 923: the supplier_payment / payment_batch approval digest covers the payee NAME (the EFT file's beneficiary
 * name, the Netcash account holder), normalised upper(btrim(name)), and the paying account's bank_account_number /
 * bank_branch_code (the EFT file's originator). So a rename or an originator edit after approval stales it: 409
 * BATCH_CHANGED_SINCE_APPROVAL at file, send and process with enforcement off (migration 922's stored digest), 409
 * APPROVAL_STALE with enforcement on. A case or outer-space change to the name does not. Re-approving is the way out.
 * The re-stamp of digests stored before 923: ap-payment-digest-923-restamp.int.test.ts.
 *
 * Judged by outcome: the file's content, the Netcash sender's calls, the journals and statuses. Netcash is never
 * called: its client is a spy. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule, reasonOf } from './r035-approval.helpers';
import {
  batchState, cleanupPr5, digestOf, enforcePay, inRequest, payCompany, paymentState, plantPayment,
} from './r035-pr5.helpers';
import { CHANGED, digestKit } from './ap-batch-approved-digest.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const { r, eft, netcash, fixture, approve, storedDigest, contentOf } = digestKit(pool, u, tokens, companies);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'NAME-SPY', mock: true });
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

const RENAMED = 'MALLORY HOLDINGS';
const rename = (c: string, supplierId: string, name: string) =>
  inRequest(pool, u.a, c, () => updateSupplier(c, supplierId, { name }, u.a));
const nameOf = async (supplierId: string) =>
  (await pool.query('SELECT name FROM suppliers WHERE id = $1', [supplierId])).rows[0].name as string;
/** The batch's paying (originator) account: one column of it set by a raw write, as any writer of gl_accounts could. */
const setOriginator = (batchId: string, column: 'bank_account_number' | 'bank_branch_code', value: string) => pool.query(
  `UPDATE gl_accounts SET ${column} = $2
   WHERE id = (SELECT bank_account_id FROM supplier_payment_batches WHERE id = $1)`, [batchId, value]);

describe('a payee renamed after approval (enforcement off)', () => {
  it('gets no EFT file (409), and the file never carries the new name', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    await rename(c, supplierId, RENAMED);
    const res = await eft(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe(CHANGED);
    expect(JSON.stringify(res.state.body)).not.toContain('MALLORY');
  });

  it('is not sent to Netcash (409, the sender never called)', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    await rename(c, supplierId, RENAMED);
    const res = await netcash(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe(CHANGED);
    expect(submitEftBatch).not.toHaveBeenCalled();
  });

  it('is not processed: no journal, nothing paid (409)', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    await rename(c, supplierId, RENAMED);
    const res = await r.batch(u.a, c, 'process', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe(CHANGED);
    expect(await batchState(pool, b.id)).toMatchObject({ status: 'approved', journals: 0, paid: 0 });
  });

  it('a change of case or outer spaces only is the same name: file and send go out', async () => {
    const one = await fixture();
    await approve(one.c, one.b.id);
    const name = await nameOf(one.supplierId);
    // Raw: the supplier writer trims, but an importer or a raw write may not.
    await pool.query('UPDATE suppliers SET name = $2 WHERE id = $1', [one.supplierId, `  ${name.toUpperCase()} `]);
    expect(await nameOf(one.supplierId)).toBe(`  ${name.toUpperCase()} `);
    const file = await eft(one.c, one.b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    const two = await fixture();
    await approve(two.c, two.b.id);
    await rename(two.c, two.supplierId, (await nameOf(two.supplierId)).toLowerCase().replace('r035', 'R035'));
    expect((await netcash(two.c, two.b.id)).state.statusCode).toBe(200);
    expect(submitEftBatch).toHaveBeenCalledTimes(1);
  });

  it('a letter that only upper-cases to the same one (dotless i, long s) is a rename: refused', async () => {
    // Only live where the database collation folds them (CI's clusters are en_US.UTF-8, as isaflow_dev is).
    expect((await pool.query("SELECT upper('\u0131') || upper('\u017F') AS u")).rows[0].u).toBe('IS');
    for (const forged of ['MALLORY \u0131NC', 'MALLORY INC \u017FA']) {
      const { c, b, supplierId } = await fixture();
      await pool.query('UPDATE suppliers SET name = $2 WHERE id = $1', [supplierId, forged.includes('\u017F') ? 'MALLORY INC SA' : 'MALLORY INC']);
      await approve(c, b.id);
      await pool.query('UPDATE suppliers SET name = $2 WHERE id = $1', [supplierId, forged]);
      const res = await eft(c, b.id);
      expect(res.state.statusCode, `${forged}: ${JSON.stringify(res.state.body)}`).toBe(409);
      expect(reasonOf(res)).toBe(CHANGED);
    }
  });

  it('an inner change (one more space between words) is a rename: refused', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    await rename(c, supplierId, (await nameOf(supplierId)).replace(' ', '  '));
    expect(reasonOf(await eft(c, b.id))).toBe(CHANGED);
  });

  it('re-approving clears it: the file then carries the new name', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id, u.a);
    const before = await storedDigest(b.id);
    await rename(c, supplierId, RENAMED);
    await approve(c, b.id, u.b);
    expect(await storedDigest(b.id)).not.toBe(before);
    const file = await eft(c, b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(contentOf(file)).toContain('MALLORY');
  });
});

describe('the paying account edited after approval (enforcement off)', () => {
  it('a new originator account number: no file, no send, no process (409)', async () => {
    const one = await fixture();
    await approve(one.c, one.b.id);
    await setOriginator(one.b.id, 'bank_account_number', '40000009999');
    const file = await eft(one.c, one.b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(409);
    expect(reasonOf(file)).toBe(CHANGED);
    expect(reasonOf(await r.batch(u.a, one.c, 'process', one.b.id))).toBe(CHANGED);
    const two = await fixture();
    await approve(two.c, two.b.id);
    await setOriginator(two.b.id, 'bank_account_number', '40000009999');
    expect(reasonOf(await netcash(two.c, two.b.id))).toBe(CHANGED);
    expect(submitEftBatch).not.toHaveBeenCalled();
  });

  it('a new originator branch code: no file (409)', async () => {
    const { c, b } = await fixture();
    await approve(c, b.id);
    await setOriginator(b.id, 'bank_branch_code', '198765');
    const res = await eft(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe(CHANGED);
  });

  it('re-approving clears it: the file then carries the new originator', async () => {
    const { c, b } = await fixture();
    await approve(c, b.id, u.a);
    await setOriginator(b.id, 'bank_account_number', '40000009999');
    await approve(c, b.id, u.b);
    const file = await eft(c, b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(contentOf(file)).toContain('40000009999');
  });

  it('reads the paying account of the batch\'s own company only, as the file does', async () => {
    const { c, b } = await fixture();
    const other = await fixture();
    // A batch pointed (raw) at another company's bank account: the file reads no originator from it, nor does the digest.
    await pool.query('UPDATE supplier_payment_batches SET bank_account_id = (SELECT bank_account_id FROM supplier_payment_batches WHERE id = $2) WHERE id = $1',
      [b.id, other.b.id]);
    const d0 = await digestOf(pool, c, 'payment_batch', b.id);
    await setOriginator(other.b.id, 'bank_account_number', '40000009999');
    expect(await digestOf(pool, c, 'payment_batch', b.id)).toBe(d0);
    expect(await digestOf(pool, other.c, 'payment_batch', other.b.id)).not.toBeNull();
  });
});

describe('under enforcement', () => {
  it('a batch: rename or originator edit after the approval answers APPROVAL_STALE at file, send and process', async () => {
    for (const change of ['rename', 'originator'] as const) {
      const { c, b, supplierId } = await fixture(true);
      await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
      await approve(c, b.id);
      if (change === 'rename') await rename(c, supplierId, RENAMED);
      else await setOriginator(b.id, 'bank_account_number', '40000009999');
      for (const res of [await eft(c, b.id), await netcash(c, b.id), await r.batch(u.a, c, 'process', b.id)]) {
        expect(res.state.statusCode, `${change}: ${JSON.stringify(res.state.body)}`).toBe(409);
        expect(reasonOf(res)).toBe('APPROVAL_STALE');
      }
      expect(submitEftBatch).not.toHaveBeenCalled();
    }
  });

  it('a single payment: rename or paying-account edit between approve and process is refused STALE, nothing paid', async () => {
    for (const change of ['rename', 'number', 'branch'] as const) {
      const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
      await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
      await enforcePay(pool, c, 'supplier_payment', u.b);
      const p = await plantPayment(pool, c, u.a, bank);
      await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', p.id);
      expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
      if (change === 'rename') await rename(c, p.supplierId, RENAMED);
      else await pool.query(`UPDATE gl_accounts SET ${change === 'number' ? 'bank_account_number' : 'bank_branch_code'} = '7' WHERE id = $1`, [bank]);
      const res = await r.payment(u.a, c, 'process', p.id);
      expect(res.state.statusCode, `${change}: ${JSON.stringify(res.state.body)}`).toBe(409);
      expect(reasonOf(res)).toBe('APPROVAL_STALE');
      expect(await paymentState(pool, p.id)).toMatchObject({ status: 'approved', journals: 0, paid: 0 });
      // A fresh approval of the new content clears it.
      await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', p.id);
      expect((await r.payment(u.a, c, 'process', p.id)).state.statusCode).toBe(200);
    }
  });

  it('a single payment: a case-only rename does not stale the approval', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    await enforcePay(pool, c, 'supplier_payment', u.b);
    const p = await plantPayment(pool, c, u.a, bank);
    await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', p.id);
    await rename(c, p.supplierId, ` ${(await nameOf(p.supplierId)).toUpperCase()}`);
    expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
    expect((await r.payment(u.a, c, 'process', p.id)).state.statusCode).toBe(200);
  });
});

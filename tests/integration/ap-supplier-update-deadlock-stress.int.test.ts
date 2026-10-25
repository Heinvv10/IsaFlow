/**
 * Smoke test for the supplier <-> payment lock order (ap-supplier-update-deadlock.int.test.ts is the deterministic
 * proof): payee renames and bank edits through updateSupplier, bank-accounts PUTs, processBatch, eft-generate and
 * single-payment processing, all at once on one company and one paying account. Before the fix every run had one
 * 40P01 on a supplier update. No request may fail with a 5xx or a raw Postgres error (a 40P01 is one). Not asserted
 * here: pg_stat_database.deadlocks, which is database-wide and flushed lazily, so it reads other suites' deadlocks and
 * can miss this one. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, inRequest, plantBatch, plantPayment } from './r035-pr5.helpers';
import { digestKit } from './ap-batch-approved-digest.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 14 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const { r, eft, fixture, approve } = digestKit(pool, u, tokens, companies);

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

describe('STRESS: payee renames and bank edits vs paying-account edits vs processing', () => {
  it('no 500, no deadlock', async () => {
    const { c, b, supplierId } = await fixture(false);
    const bank = (await pool.query('SELECT bank_account_id FROM supplier_payment_batches WHERE id = $1', [b.id])).rows[0].bank_account_id as string;
    const b2 = await plantBatch(pool, c, u.a, bank);
    await approve(c, b.id); await approve(c, b2.id);
    const singles = [await plantPayment(pool, c, u.a, bank), await plantPayment(pool, c, u.a, bank)];
    for (const s of singles) await r.payment(u.a, c, 'approve', s.id);
    const suppliers = [supplierId, ...singles.map((s) => s.supplierId), ...b2.members.map((m) => m.supplierId)];
    const codes: (number | string)[] = [];
    const rec = async <T extends { state: { statusCode: number } }>(p: Promise<T>) => { codes.push((await p).state.statusCode); };
    const guarded = async (p: Promise<unknown>) => { try { await p; } catch (e) { codes.push(`ERR ${(e as { code?: string }).code}`); } };
    await Promise.all([
      (async () => { for (let i = 0; i < 10; i += 1) await rec(callRoute(bankAccounts, tokens[i % 2 ? u.a : u.b]!, c, 'PUT',
        { id: bank, bankAccountNumber: `4000000${2000 + i}`, bankBranchCode: `19876${i % 10}` }, '/api/accounting/bank-accounts')); })(),
      ...suppliers.map((sid, k) => (async () => { for (let i = 0; i < 6; i += 1) {
        await guarded(inRequest(pool, u.a, c, () => updateSupplier(c, sid, i % 2 ? { name: `Renamed ${k}-${i}` } : { bankAccountNumber: `6200${k}00${i}` }, u.a)));
      } })()),
      rec(r.batch(u.a, c, 'process', b.id)), rec(eft(c, b2.id)),
      ...singles.map((s) => rec(r.payment(u.a, c, 'process', s.id))),
    ]);
    expect(codes.filter((x) => typeof x === 'string' || x >= 500), JSON.stringify(codes)).toEqual([]);
  });
});

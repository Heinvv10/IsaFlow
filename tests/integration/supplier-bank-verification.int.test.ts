/**
 * Supplier bank-detail verification (forensic-controls rebuild step 1; Hein's
 * decisions 2026-10-08): with `supplier_bank_details` enforced, a change to a
 * supplier's bank details makes it UNVERIFIED (derived from a fingerprint),
 * and the only two routes that move money — the EFT file and the Netcash
 * submission — refuse (409, nothing written or sent) any batch paying an
 * unverified supplier until a DIFFERENT permitted person verifies. Switching
 * on accepts every supplier's current details as a `baseline`. Independent of
 * payment approval: no payment enforcement is on in these companies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr5, plantBatch, plantSupplier } from './r035-pr5.helpers';
import { bankCompany, bankRoutes, submissionsOf, verificationsOf } from './supplier-bank-verification.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
/** a admin (edits bank details), b owner (switches on), c admin (independent verifier), k bookkeeper. */
const u = { a: '', b: '', c: '', k: '' };
const r = bankRoutes(pool, tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'SBV-SPY', mock: true });
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

/** A company with a two-payee draft batch (suppliers planted WITH bank details), switched on by B. */
async function enforcedBatch() {
  const { company: c, bank } = await bankCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin'], [u.k, 'bookkeeper']], companies);
  const batch = await plantBatch(pool, c, u.a, bank);
  const on = await r.toggle(u.b, c, true);
  expect(on.state.statusCode, JSON.stringify(on.state.body)).toBe(200);
  return { c, bank, batch, s: batch.members[0]!.supplierId };
}

const RAW = { payments: [{ accountHolder: 'Anyone', bankCode: '250655', accountNumber: '62000000009', amount: 100000, reference: 'x' }] };

describe('switching on', () => {
  it('records a baseline, by the switcher, at the current fingerprint, for every supplier with bank details — and none without', async () => {
    const { company: c } = await bankCompany(pool, [[u.b, 'owner']], companies);
    const withBank = [await plantSupplier(pool, c), await plantSupplier(pool, c)];
    const without = crypto.randomUUID();
    await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES($1, $2, $3)', [without, c, 'SBV no bank']);
    expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
    for (const s of withBank) {
      const rows = await verificationsOf(pool, s);
      expect(rows.map((x) => [x.kind, x.verified_by])).toEqual([['baseline', u.b]]);
      const fp = (await pool.query(
        `SELECT supplier_bank_fingerprint(bank_name, bank_account_number, bank_branch_code, bank_account_type, bank_account_holder) AS f
         FROM suppliers WHERE id = $1`, [s])).rows[0].f;
      expect(rows[0]!.fingerprint).toBe(fp);
      expect((await r.state(u.b, c, s)).state).toBe('verified');
    }
    expect(await verificationsOf(pool, without)).toEqual([]);
    expect((await r.state(u.b, c, without)).state).toBe('no_bank_details');
    const audit = await pool.query(
      "SELECT action, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_enforcement'", [c]);
    expect(audit.rows.map((x) => x.action)).toEqual(['create']);
    expect(audit.rows[0].changes.metadata.baselineSuppliers).toBe('2');
  });

  it('the switcher\'s own changes are not baselined: off, change, on again leaves that supplier unverified', async () => {
    const { c, batch, s } = await enforcedBatch();
    expect((await r.toggle(u.b, c, false)).state.statusCode).toBe(200);
    await r.changeBank(u.b, c, s, { bankAccountNumber: '62444444444' });
    expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
    expect((await r.state(u.c, c, s)).state).toBe('unverified');
    expect((await r.state(u.c, c, batch.members[1]!.supplierId)).state).toBe('verified');
    expect((await r.eft(u.a, c, batch.id)).state.statusCode).toBe(409);
    expect((await r.verify(u.b, c, s)).state.statusCode).toBe(403);
    expect((await r.verify(u.c, c, s)).state.statusCode).toBe(200);
  });

  it('off and on again does not baseline someone else\'s pending change: a supplier with history keeps its derived state', async () => {
    const { c, batch, s } = await enforcedBatch();
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62444444444' });
    expect((await r.toggle(u.b, c, false)).state.statusCode).toBe(200);
    expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
    expect((await r.state(u.c, c, s)).state).toBe('unverified');
    expect((await r.eft(u.a, c, batch.id)).state.statusCode).toBe(409);
    // A supplier whose details were never looked at before is still baselined.
    expect((await r.state(u.c, c, batch.members[1]!.supplierId)).state).toBe('verified');
  });

  it('a baselined batch is sendable: EFT file and Netcash submission go out', async () => {
    const { c, batch } = await enforcedBatch();
    expect((await r.eft(u.a, c, batch.id)).state.statusCode).toBe(200);
    const sent = await r.netcash(u.a, c, { batchPaymentId: batch.id });
    expect(sent.state.statusCode, JSON.stringify(sent.state.body)).toBe(200);
    expect(submitEftBatch).toHaveBeenCalledTimes(1);
  });

  it('a manager (below the verifier role) may not switch it on; an admin may not switch it off; the owner may', async () => {
    const { company: c } = await bankCompany(pool, [[u.b, 'owner'], [u.c, 'admin'], [u.k, 'manager']], companies);
    const manager = await r.toggle(u.k, c, true);
    expect(manager.state.statusCode).toBe(403);
    expect(reasonOf(manager)).toBe('VERIFIER_ROLE_REQUIRED');
    expect((await r.toggle(u.c, c, true)).state.statusCode).toBe(200);
    const off = await r.toggle(u.c, c, false);
    expect(off.state.statusCode).toBe(403);
    expect(reasonOf(off)).toBe('RULE_AUTHORITY_REQUIRED');
    expect((await r.toggle(u.b, c, false)).state.statusCode).toBe(200);
  });
});

describe('a bank-detail change blocks money leaving until someone else verifies', () => {
  it('A changes the account: unverified; EFT and Netcash (batch) refuse 409 naming the supplier; nothing is sent or recorded', async () => {
    const { c, batch, s } = await enforcedBatch();
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62444444444' });
    expect((await r.state(u.b, c, s)).state).toBe('unverified');
    const name = (await pool.query('SELECT name FROM suppliers WHERE id = $1', [s])).rows[0].name as string;
    for (const res of [await r.eft(u.a, c, batch.id), await r.netcash(u.a, c, { batchPaymentId: batch.id })]) {
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
      expect(reasonOf(res)).toBe('SUPPLIER_BANK_DETAILS_UNVERIFIED');
      expect(messageOf(res)).toContain(name);
      expect((res.state.body as { error: { details: { suppliers: { id: string }[] } } }).error.details.suppliers)
        .toEqual([{ id: s, name }]);
    }
    expect(submitEftBatch).not.toHaveBeenCalled();
    expect(await submissionsOf(pool, c)).toBe(0);
  });

  it('a raw Netcash payments[] list is refused (400, AP-01: every raw list) whenever the control is on', async () => {
    const { c } = await enforcedBatch();
    const res = await r.netcash(u.a, c, RAW);
    expect(res.state.statusCode).toBe(400);
    expect(submitEftBatch).not.toHaveBeenCalled();
    expect(await submissionsOf(pool, c)).toBe(0);
  });

  it('the setter may not verify (403); another permitted user verifies with method and note; the file then generates', async () => {
    const { c, batch, s } = await enforcedBatch();
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62444444444' });
    const self = await r.verify(u.a, c, s);
    expect(self.state.statusCode).toBe(403);
    expect(reasonOf(self)).toBe('SETTER_FORBIDDEN');
    const ok = await r.verify(u.c, c, s, { method: 'bank_confirmation_letter', note: 'Bank letter dated 2026-10-08' });
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    const st = await r.state(u.b, c, s);
    expect(st.state).toBe('verified');
    expect(st.latest).toMatchObject({ kind: 'verified', method: 'bank_confirmation_letter', note: 'Bank letter dated 2026-10-08' });
    expect((await verificationsOf(pool, s)).map((x) => [x.kind, x.verified_by])).toEqual([['baseline', u.b], ['verified', u.c]]);
    const audit = await pool.query(
      "SELECT action, user_id FROM audit_log WHERE company_id = $1 AND entity_type = 'supplier_bank_details' AND entity_id = $2", [c, s]);
    expect(audit.rows).toEqual([{ action: 'approve', user_id: u.c }]);
    const file = await r.eft(u.a, c, batch.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(dataOf<{ content: string }>(file).content).toContain('62444444444');
  });

  it('every bank column moves the fingerprint: name, branch and type through the writer, the holder by raw SQL', async () => {
    const { c, s } = await enforcedBatch();
    for (const change of [{ bankName: 'Other Bank' }, { bankBranchCode: '470010' }, { bankAccountType: 'savings' }]) {
      await r.changeBank(u.a, c, s, change);
      expect((await r.state(u.b, c, s)).state, JSON.stringify(change)).toBe('unverified');
      expect((await r.verify(u.c, c, s)).state.statusCode).toBe(200);
    }
    // No route writes the holder; whatever does (an import, raw SQL) still unverifies — the state is derived.
    await pool.query("UPDATE suppliers SET bank_account_holder = 'Someone Else' WHERE id = $1", [s]);
    expect((await r.state(u.b, c, s)).state).toBe('unverified');
  });

  it('an edit that changes no bank column leaves it verified; a formatting-only change of the account number too', async () => {
    const { c, s } = await enforcedBatch();
    await r.changeBank(u.a, c, s, { notes: 'just a note' });
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62 000-000 001' });
    expect((await r.state(u.b, c, s)).state).toBe('verified');
  });

  it('a stale fingerprint (the details changed after the verifier looked) is refused 409, and nothing is recorded', async () => {
    const { c, s } = await enforcedBatch();
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62444444444' });
    const seen = (await r.state(u.c, c, s)).fingerprint;
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62555555555' });
    const res = await r.verify(u.c, c, s, { fingerprint: seen });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('FINGERPRINT_STALE');
    expect((await verificationsOf(pool, s)).map((x) => x.kind)).toEqual(['baseline']);
  });

  it('a verify racing a bank edit: the edit holds the supplier, the verify waits, then refuses 409 stale', async () => {
    const { c, s } = await enforcedBatch();
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62444444444' });
    const seen = (await r.state(u.c, c, s)).fingerprint;
    const held = await pool.connect();
    await held.query('BEGIN');
    await held.query("UPDATE suppliers SET bank_account_number = '62999999999' WHERE id = $1", [s]);
    const verifying = r.verify(u.c, c, s, { fingerprint: seen });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await held.query('COMMIT');
    held.release();
    const res = await verifying;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('FINGERPRINT_STALE');
  });

  it('the file read details replaced — and the replacement verified — before its lock: refused, the file is not built from them', async () => {
    const { c, batch, s } = await enforcedBatch();
    const held = await pool.connect();
    await held.query('BEGIN');
    await held.query("UPDATE suppliers SET bank_account_number = '62999999999' WHERE id = $1", [s]);
    await held.query(
      `INSERT INTO supplier_bank_verifications(company_id, supplier_id, fingerprint, kind, method, note, verified_by)
       SELECT company_id, id, supplier_bank_fingerprint(bank_name, bank_account_number, bank_branch_code, bank_account_type,
              bank_account_holder), 'verified', 'other', 'race', $2 FROM suppliers WHERE id = $1`, [s, u.c]);
    const generating = r.eft(u.a, c, batch.id); // reads the old account, then waits on the payee lock
    await new Promise((resolve) => setTimeout(resolve, 500));
    await held.query('COMMIT');
    held.release();
    const res = await generating;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('SUPPLIER_BANK_DETAILS_UNVERIFIED');
    expect((await r.state(u.b, c, s)).state).toBe('verified'); // the NEW details are verified; a fresh file may go
    expect((await r.eft(u.a, c, batch.id)).state.statusCode).toBe(200);
  });

  it('a bank edit racing the EFT file: the file waits, then refuses 409 for the new details', async () => {
    const { c, batch, s } = await enforcedBatch();
    const held = await pool.connect();
    await held.query('BEGIN');
    await held.query("UPDATE suppliers SET bank_account_number = '62999999999' WHERE id = $1", [s]);
    const generating = r.eft(u.a, c, batch.id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await held.query('COMMIT');
    held.release();
    const res = await generating;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('SUPPLIER_BANK_DETAILS_UNVERIFIED');
  });
});

describe('enforcement off', () => {
  it('no gate at all: a changed, never-verified supplier is paid by EFT and Netcash batch; a raw list is refused; verify is refused', async () => {
    const { company: c, bank } = await bankCompany(pool, [[u.a, 'admin'], [u.c, 'admin']], companies);
    const batch = await plantBatch(pool, c, u.a, bank);
    const s = batch.members[0]!.supplierId;
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62444444444' });
    expect((await r.eft(u.a, c, batch.id)).state.statusCode).toBe(200);
    expect((await r.netcash(u.a, c, { batchPaymentId: batch.id })).state.statusCode).toBe(200);
    expect((await r.netcash(u.a, c, RAW)).state.statusCode).toBe(400);
    expect((await r.state(u.c, c, s)).state).toBe('not_enforced');
    const res = await r.verify(u.c, c, s);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('NOT_ENFORCED');
  });
});

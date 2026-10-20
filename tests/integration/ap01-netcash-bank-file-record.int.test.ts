/**
 * AP-01: a bank file is a way of paying. eft-generate leaves a durable audit_log record (action 'export', entity_type
 * 'batch_bank_file', the batch id, who, which bank) in the same transaction and under the same batch lock as the file
 * it serves; netcash/submit refuses a batch whose export has not been released. An owner/admin releases it with a
 * reason (eft-file-release): a later new file re-blocks. Judged by OUTCOME: whether Netcash's sender was called, and
 * what was served. Netcash is never called. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const sender = vi.hoisted(() => ({
  submitEftBatch: vi.fn(),
  park: null as null | { entered: () => void; hold: Promise<void> },
}));
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch: sender.submitEftBatch }));
// The first caller of the gate (a request that holds the batch row and has judged it) can be parked.
vi.mock('@/modules/accounting/services/ap/batchBankFileGate', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/batchBankFileGate')>();
  return {
    ...actual,
    assertBatchMayBeSent: async (...a: Parameters<typeof actual.assertBatchMayBeSent>) => {
      await actual.assertBatchMayBeSent(...a);
      const park = sender.park;
      if (park) { sender.park = null; park.entered(); await park.hold; }
    },
  };
});

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import eftGenerate from '../../pages/api/accounting/eft-generate';
import eftFileRelease from '../../pages/api/accounting/eft-file-release';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, payRoutes, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { admin: '', manager: '', other: '' };
const r = payRoutes(tokens);
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-FILE' };

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
beforeEach(() => { sender.submitEftBatch.mockReset(); sender.submitEftBatch.mockResolvedValue(ACCEPTED); sender.park = null; });
afterAll(async () => {
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, Object.values(u));
});

async function approvedBatch() {
  const { company: c, bank } = await payCompany(pool, [[u.admin, 'admin'], [u.manager, 'manager']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  const b = await plantBatch(pool, c, u.admin, bank);
  expect((await r.batch(u.admin, c, 'approve', b.id)).state.statusCode).toBe(200);
  return { c, b };
}
const submit = (c: string, id: string) => callRoute(netcashSubmit, tokens[u.admin]!, c, 'POST', { batchPaymentId: id }, '/api/accounting/netcash/submit');
const file = (c: string, id: string) => callRoute(eftGenerate, tokens[u.admin]!, c, 'POST', { batchId: id, bank: 'fnb' }, '/api/accounting/eft-generate');
const release = (user: string, c: string, body: Record<string, unknown>) => callRoute(eftFileRelease, tokens[user]!, c, 'POST', body,
  '/api/accounting/eft-file-release');
const exportRows = async (c: string, id: string) => (await pool.query(
  "SELECT user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'batch_bank_file' AND entity_id = $2 AND action = 'export'", [c, id])).rows;

async function waitsOnBatchLock(): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const res = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%supplier_payment_batches%'`);
    if (res.rowCount) return 'waiting';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('nothing finished and nothing waited on a supplier_payment_batches lock');
}

describe('a bank file closes the Netcash channel for its batch (AP-01)', () => {
  it('generating a file records who, which bank and when; a file that fails to build leaves no record', async () => {
    const { c, b } = await approvedBatch();
    expect((await file(c, b.id)).state.statusCode).toBe(200);
    const rows = await exportRows(c, b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(u.admin);
    expect(JSON.stringify(rows[0].changes)).toContain('fnb');
    const { c: c2, b: b2 } = await approvedBatch();
    await pool.query('UPDATE gl_accounts SET is_active = false WHERE company_id = $1', [c2]); // no paying bank account: refused 400
    expect((await file(c2, b2.id)).state.statusCode).toBe(400);
    expect(await exportRows(c2, b2.id)).toHaveLength(0);
  });

  it('file then submit: refused 409 BATCH_BANK_FILE_GENERATED, the sender is never called and nothing is claimed', async () => {
    const { c, b } = await approvedBatch();
    expect((await file(c, b.id)).state.statusCode).toBe(200);
    const res = await submit(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(JSON.stringify(res.state.body)).toContain('BATCH_BANK_FILE_GENERATED');
    expect(sender.submitEftBatch).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::INT AS n FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].n).toBe(0);
  });

  it('concurrent file and submit: at most one payment channel', async () => {
    const { c, b } = await approvedBatch();
    let release!: () => void;
    let entered!: () => void;
    const inGate = new Promise<void>((res) => { entered = res; });
    sender.park = { entered, hold: new Promise<void>((res) => { release = res; }) };
    const fileP = file(c, b.id); // holds the batch row, has judged it, has not built the file
    await inGate;
    const submitP = submit(c, b.id); // waits for the batch row
    const state = await Promise.race([submitP.then(() => 'finished' as const), waitsOnBatchLock()]);
    release();
    const [produced, sent] = await Promise.all([fileP, submitP]);
    const channels = (produced.state.statusCode === 200 ? 1 : 0) + (sender.submitEftBatch.mock.calls.length > 0 ? 1 : 0);
    expect(channels, 'a bank file AND a Netcash send for one batch').toBe(1);
    expect(produced.state.statusCode, JSON.stringify(produced.state.body)).toBe(200);
    expect(sent.state.statusCode, JSON.stringify(sent.state.body)).toBe(409);
    expect(state).toBe('waiting');
  });

  describe('releasing a bank file (eft-file-release)', () => {
    const REASON = 'File downloaded to check it; never uploaded to the bank';

    it('file, release by an admin, then submit: Netcash is sent exactly once, and the release is audit-logged with its reason', async () => {
      const { c, b } = await approvedBatch();
      expect((await file(c, b.id)).state.statusCode).toBe(200);
      expect((await submit(c, b.id)).state.statusCode).toBe(409);
      const rel = await release(u.admin, c, { batchId: b.id, reason: REASON });
      expect(rel.state.statusCode, JSON.stringify(rel.state.body)).toBe(200);
      const audit = (await pool.query(
        "SELECT user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'batch_bank_file' AND entity_id = $2 AND action = 'update'", [c, b.id])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].user_id).toBe(u.admin);
      expect(JSON.stringify(audit[0].changes)).toContain(REASON);
      expect((await submit(c, b.id)).state.statusCode).toBe(200);
      expect(sender.submitEftBatch).toHaveBeenCalledTimes(1);
    });

    it('release, then a NEW file, then submit: refused again, the sender is not called', async () => {
      const { c, b } = await approvedBatch();
      await file(c, b.id);
      expect((await release(u.admin, c, { batchId: b.id, reason: REASON })).state.statusCode).toBe(200);
      expect((await file(c, b.id)).state.statusCode).toBe(200);
      expect((await submit(c, b.id)).state.statusCode).toBe(409);
      expect(sender.submitEftBatch).not.toHaveBeenCalled();
      expect((await exportRows(c, b.id))).toHaveLength(2);
    });

    it('two files then one release frees both', async () => {
      const { c, b } = await approvedBatch();
      await file(c, b.id);
      await file(c, b.id);
      expect((await release(u.admin, c, { batchId: b.id, reason: REASON })).state.statusCode).toBe(200);
      expect((await submit(c, b.id)).state.statusCode).toBe(200);
    });

    it('a manager (below owner/admin) cannot release: 403, and the batch stays closed to Netcash', async () => {
      const { c, b } = await approvedBatch();
      await file(c, b.id);
      expect((await release(u.manager, c, { batchId: b.id, reason: REASON })).state.statusCode).toBe(403);
      expect((await submit(c, b.id)).state.statusCode).toBe(409);
      expect(sender.submitEftBatch).not.toHaveBeenCalled();
    });

    it.each([
      ['no reason', { reason: undefined }],
      ['a blank reason', { reason: '   ' }],
      ['a non-uuid batch', { batchId: 'nope' }],
    ])('%s is refused 400 and releases nothing', async (_n, change) => {
      const { c, b } = await approvedBatch();
      await file(c, b.id);
      const res = await release(u.admin, c, { batchId: b.id, reason: REASON, ...change });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
      expect((await submit(c, b.id)).state.statusCode).toBe(409);
    });

    it('releasing a batch with no file (or one already released) is refused 409', async () => {
      const { c, b } = await approvedBatch();
      expect((await release(u.admin, c, { batchId: b.id, reason: REASON })).state.statusCode).toBe(409);
      await file(c, b.id);
      expect((await release(u.admin, c, { batchId: b.id, reason: REASON })).state.statusCode).toBe(200);
      expect((await release(u.admin, c, { batchId: b.id, reason: REASON })).state.statusCode).toBe(409);
    });

    it('a user in two companies cannot release company A\'s batch from company B: 404 (RLS is membership-wide)', async () => {
      const { c, b } = await approvedBatch();
      await file(c, b.id);
      await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'admin')", [c, u.other]);
      const { company: other } = await payCompany(pool, [[u.other, 'admin']], companies);
      const res = await release(u.other, other, { batchId: b.id, reason: REASON });
      expect(res.state.statusCode).toBe(404);
      expect((await submit(c, b.id)).state.statusCode).toBe(409);
    });
  });

  describe('reading the state (GET eft-file-release, for the batch page)', () => {
    const state = (user: string, c: string, batchId: string) => callRoute(eftFileRelease, tokens[user]!, c, 'GET', undefined,
      '/api/accounting/eft-file-release', { batchId });

    it('shows the unreleased file (bank, who, when) to any member, and nothing once released or when there is none', async () => {
      const { c, b } = await approvedBatch();
      const none = await state(u.manager, c, b.id);
      expect(none.state.statusCode, JSON.stringify(none.state.body)).toBe(200);
      expect((none.state.body as { data: { bankFile: unknown } }).data.bankFile).toBeNull();
      await file(c, b.id);
      const open = (await state(u.manager, c, b.id)).state.body as { data: { bankFile: { bank: string; generatedBy: string; generatedAt: string } } };
      expect(open.data.bankFile).toMatchObject({ bank: 'fnb' });
      expect(open.data.bankFile.generatedBy).toBeTruthy();
      expect(open.data.bankFile.generatedAt).toBeTruthy();
      await release(u.admin, c, { batchId: b.id, reason: 'not used' });
      expect(((await state(u.manager, c, b.id)).state.body as { data: { bankFile: unknown } }).data.bankFile).toBeNull();
    });

    it('does not show company A\'s file to a member of both companies asking from company B', async () => {
      const { c, b } = await approvedBatch();
      await file(c, b.id);
      await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'admin')", [c, u.other]);
      const { company: other } = await payCompany(pool, [[u.other, 'admin']], companies);
      expect(((await state(u.other, other, b.id)).state.body as { data: { bankFile: unknown } }).data.bankFile).toBeNull();
    });

    it('a bad batchId is refused 400', async () => {
      const { c } = await approvedBatch();
      expect((await state(u.admin, c, 'nope')).state.statusCode).toBe(400);
    });
  });
});

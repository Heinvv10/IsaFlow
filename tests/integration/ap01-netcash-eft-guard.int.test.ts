/**
 * AP-01: a batch Netcash may hold must not also be paid by bank file. eft-generate
 * built a file for any approved or processed batch, so a batch already submitted
 * to Netcash (or whose Netcash outcome is unknown) could be paid a second time by
 * uploading the file. eft-generate now refuses 409 while the batch has a
 * netcash_submissions row that is not 'failed'; a definitely rejected submission
 * does not block it. Judged by OUTCOME: the status and whether a file came back.
 * Netcash is never called. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const sender = vi.hoisted(() => ({
  submitEftBatch: vi.fn(),
  park: null as null | { entered: () => void; hold: Promise<void> },
}));
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch: sender.submitEftBatch }));
// The first caller of the gate (a netcash/submit that has locked and judged its batch, not yet claimed it) can be parked.
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
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, payRoutes, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
const r = payRoutes(tokens);

const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-EFT' };
const UNKNOWN = { success: false, outcome: 'unknown', error: 'The operation was aborted' };
const REJECTED = { success: false, outcome: 'rejected', error: 'Invalid account number' };

beforeAll(async () => { user = await createUser(pool, tokens); });
beforeEach(() => { sender.submitEftBatch.mockReset(); sender.park = null; });
afterAll(() => cleanupPr5(pool, companies, [user]));

async function approvedBatch() {
  const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  const b = await plantBatch(pool, c, user, bank);
  expect((await r.batch(user, c, 'approve', b.id)).state.statusCode).toBe(200);
  return { c, b };
}
const submit = (c: string, id: string) => callRoute(netcashSubmit, tokens[user]!, c, 'POST', { batchPaymentId: id }, '/api/accounting/netcash/submit');
const file = (c: string, id: string) => callRoute(eftGenerate, tokens[user]!, c, 'POST', { batchId: id, bank: 'fnb' }, '/api/accounting/eft-generate');

describe('eft-generate against a Netcash submission (AP-01)', () => {
  it('a batch with no Netcash submission gets its file', async () => {
    const { c, b } = await approvedBatch();
    expect((await file(c, b.id)).state.statusCode).toBe(200);
  });

  it.each([['accepted', ACCEPTED], ['unknown', UNKNOWN]])('a batch with an %s Netcash submission gets no file: 409 naming the submission', async (_n, answer) => {
    const { c, b } = await approvedBatch();
    sender.submitEftBatch.mockResolvedValue(answer);
    await submit(c, b.id);
    const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
    const res = await file(c, b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    const body = JSON.stringify(res.state.body);
    expect(body).toContain(id);
    expect(body).toMatch(/Netcash/);
  });

  it('a batch Netcash is still being sent (pending claim) gets no file', async () => {
    const { c, b } = await approvedBatch();
    await pool.query(
      `INSERT INTO netcash_submissions (company_id, submission_type, total_amount_cents, record_count, status, batch_id)
       VALUES ($1, 'eft_payment', 1, 1, 'pending', $2)`, [c, b.id]);
    expect((await file(c, b.id)).state.statusCode).toBe(409);
  });

  it('a batch Netcash definitely rejected gets its file', async () => {
    const { c, b } = await approvedBatch();
    sender.submitEftBatch.mockResolvedValue(REJECTED);
    expect((await submit(c, b.id)).state.statusCode).toBe(400);
    expect((await file(c, b.id)).state.statusCode).toBe(200);
  });

  it('a bank file requested while a submit sits between its status check and its claim waits for it, and is refused', async () => {
    const { c, b } = await approvedBatch();
    sender.submitEftBatch.mockResolvedValue(ACCEPTED);
    let release!: () => void;
    let entered!: () => void;
    const inGate = new Promise<void>((res) => { entered = res; });
    sender.park = { entered, hold: new Promise<void>((res) => { release = res; }) };
    const submitP = submit(c, b.id); // holds the batch row, has judged it, has NOT claimed it yet
    await inGate;
    const fileP = file(c, b.id);
    const state = await Promise.race([fileP.then(() => 'finished' as const), waitsOnBatchLock()]);
    release();
    const [sent, produced] = await Promise.all([submitP, fileP]);
    // Never both channels for one batch: a file AND a Netcash send.
    const fileBuilt = produced.state.statusCode === 200;
    expect(fileBuilt && sender.submitEftBatch.mock.calls.length > 0, 'a bank file was built for a batch Netcash was also sent').toBe(false);
    expect(sent.state.statusCode, JSON.stringify(sent.state.body)).toBe(200);
    expect(produced.state.statusCode, JSON.stringify(produced.state.body)).toBe(409);
    expect(state).toBe('waiting'); // the file request queued behind the submit's lock on the batch row, then found the claim
  });
});

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

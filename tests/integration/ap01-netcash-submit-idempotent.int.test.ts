/**
 * AP-01 (audit 2026-10-18): netcash/submit in batch mode was not idempotent. A
 * double-click, a second tab, or a retry after the 30 s timeout (recorded
 * 'failed' though Netcash may have accepted it) sent every supplier's payment a
 * second time.
 *
 * Fixed by a claim row (netcash_submissions.batch_id, partial UNIQUE index over
 * non-failed rows) COMMITTED in its own transaction before the send and settled
 * in another after it — not in the request's transaction, which withAuth rolls
 * back on any >=500 (and a crash). Judged by
 * OUTCOME: how many times Netcash's sender was called and how many non-failed
 * submission rows the batch has — never by an error code.
 *
 * Deterministic: the first request is parked inside the (mocked) sender, the
 * second is started, and the first is released only once the second has either
 * finished or is waiting on a lock over netcash_submissions. The claim is
 * committed before the send, so the second finishes (refused) while the first
 * is still parked; waiting on a lock would mean the claim rides the request tx.
 * Everything else is the real chain (withAuth, app_user, RLS, Postgres). Netcash
 * itself is never called. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const sender = vi.hoisted(() => ({
  submitEftBatch: vi.fn(),
  results: [] as unknown[],
  park: null as null | { entered: () => void; hold: Promise<void> },
}));
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch: sender.submitEftBatch }));

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-REF-1' };
const REJECTED = { success: false, outcome: 'rejected', error: 'Invalid account number' };
const UNKNOWN = { success: false, outcome: 'unknown', error: 'The operation was aborted' };

beforeAll(async () => { user = await createUser(pool, tokens); });
beforeEach(() => {
  sender.submitEftBatch.mockReset();
  sender.results = [];
  sender.park = null;
  sender.submitEftBatch.mockImplementation(async () => {
    const result = sender.results.shift() ?? ACCEPTED; // decided at call time, so the first caller gets the first result
    const park = sender.park;
    if (park) { sender.park = null; park.entered(); await park.hold; } // only the first call parks
    return result;
  });
});
afterAll(() => cleanupPr5(pool, companies, [user]));

async function fixture() {
  const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, b: await plantBatch(pool, c, user, bank) };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[user]!, c, 'POST',
  { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
const rows = async (c: string) => (await pool.query(
  'SELECT status, batch_reference FROM netcash_submissions WHERE company_id = $1 ORDER BY created_at', [c])).rows as
  { status: string; batch_reference: string | null }[];
const live = async (c: string) => (await rows(c)).filter((r) => r.status !== 'failed');
const is4xx = (code: number) => code >= 400 && code < 500;

/** 'waiting' once a backend of this database waits on a lock while running a statement over netcash_submissions. */
async function waitsOnSubmissionLock(): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%netcash_submissions%'`);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('nothing finished and nothing waited on a netcash_submissions lock');
}

/** Park the first request in the sender; run the second; release the first once the second finished or waits. */
async function race(c: string, batchId: string) {
  let release!: () => void;
  let entered!: () => void;
  const inSender = new Promise<void>((r) => { entered = r; });
  sender.park = { entered, hold: new Promise<void>((r) => { release = r; }) };
  const firstP = submit(c, batchId);
  await inSender;
  const secondP = submit(c, batchId);
  const state = await Promise.race([secondP.then(() => 'finished' as const), waitsOnSubmissionLock()]);
  release();
  const [first, second] = await Promise.all([firstP, secondP]);
  return { state, first, second };
}

describe('netcash/submit batch idempotency (AP-01)', () => {
  it('two concurrent submits of one batch send to Netcash once and record one live submission', async () => {
    const { c, b } = await fixture();
    const { state, first, second } = await race(c, b.id);
    expect(sender.submitEftBatch).toHaveBeenCalledTimes(1);
    expect(await live(c)).toHaveLength(1);
    expect(state).toBe('finished'); // refused at once on the committed claim, while the first is still in the sender
    expect(first.state.statusCode).toBe(200);
    expect(is4xx(second.state.statusCode), JSON.stringify(second.state.body)).toBe(true);
    expect(await rows(c)).toEqual([{ status: 'submitted', batch_reference: 'NC-REF-1' }]);
  });

  it('a retry after an indeterminate outcome (timeout) does not call Netcash again', async () => {
    const { c, b } = await fixture();
    sender.results = [UNKNOWN];
    const first = await submit(c, b.id);
    const second = await submit(c, b.id);
    expect(sender.submitEftBatch).toHaveBeenCalledTimes(1);
    expect(await live(c)).toHaveLength(1);
    // 4xx so withAuth COMMITS the claim; a 5xx would roll it back and re-open the double payment.
    expect(is4xx(first.state.statusCode), JSON.stringify(first.state.body)).toBe(true);
    expect(is4xx(second.state.statusCode), JSON.stringify(second.state.body)).toBe(true);
    expect((await rows(c)).map((r) => r.status)).toEqual(['unknown']);
    expect(JSON.stringify(second.state.body)).toMatch(/check Netcash|outcome unknown/i);
  });

  it('a retry after Netcash definitely rejected the batch is allowed', async () => {
    const { c, b } = await fixture();
    sender.results = [REJECTED, ACCEPTED];
    const first = await submit(c, b.id);
    expect(first.state.statusCode).toBe(400);
    expect((await rows(c)).map((r) => r.status)).toEqual(['failed']);
    const second = await submit(c, b.id);
    expect(second.state.statusCode, JSON.stringify(second.state.body)).toBe(200);
    expect(sender.submitEftBatch).toHaveBeenCalledTimes(2);
    expect((await rows(c)).map((r) => r.status)).toEqual(['failed', 'submitted']);
  });

  it('a submit that arrives while another is in flight is refused; once that was rejected, a resend is allowed', async () => {
    const { c, b } = await fixture();
    sender.results = [REJECTED, ACCEPTED];
    const { first, second } = await race(c, b.id);
    expect(first.state.statusCode).toBe(400);
    expect(is4xx(second.state.statusCode) && second.state.statusCode !== 400, JSON.stringify(second.state.body)).toBe(true);
    expect(sender.submitEftBatch).toHaveBeenCalledTimes(1);
    expect((await rows(c)).map((r) => r.status)).toEqual(['failed']);
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
    expect(sender.submitEftBatch).toHaveBeenCalledTimes(2);
  });

  it('a 500 after the send does not free the batch: the claim was committed on its own', async () => {
    const { c, b } = await fixture();
    // Settling the claim fails after Netcash accepted the batch: the request answers 500 and withAuth rolls it back.
    const fn = `ap01_fail_settle_${c.replace(/-/g, '')}`;
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.company_id = '${c}' AND NEW.status = 'submitted' THEN RAISE EXCEPTION 'ap01 forced settle failure'; END IF; RETURN NEW; END $f$`);
    await pool.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON netcash_submissions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const first = await submit(c, b.id);
      expect(first.state.statusCode).toBeGreaterThanOrEqual(500);
      const second = await submit(c, b.id);
      expect(sender.submitEftBatch).toHaveBeenCalledTimes(1);
      expect(await live(c)).toHaveLength(1);
      expect(is4xx(second.state.statusCode), JSON.stringify(second.state.body)).toBe(true);
      expect((await rows(c)).map((r) => r.status)).toEqual(['pending']);
      // The operator's way out, once Netcash has been checked: set the row 'failed', and the batch may be sent again.
      await pool.query("UPDATE netcash_submissions SET status = 'failed' WHERE company_id = $1 AND status = 'pending'", [c]);
    } finally {
      await pool.query(`DROP TRIGGER ${fn} ON netcash_submissions`);
      await pool.query(`DROP FUNCTION ${fn}()`);
    }
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
    expect(sender.submitEftBatch).toHaveBeenCalledTimes(2);
  });

  it('a batch already submitted is refused 409 naming the earlier submission, without a send', async () => {
    const { c, b } = await fixture();
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
    const again = await submit(c, b.id);
    expect(sender.submitEftBatch).toHaveBeenCalledTimes(1);
    expect(again.state.statusCode).toBe(409);
    const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].id as string;
    expect(JSON.stringify(again.state.body)).toContain(id);
    expect((await pool.query('SELECT batch_id FROM netcash_submissions WHERE company_id = $1', [c])).rows[0].batch_id).toBe(b.id);
  });

  it('two different batches of one company are independent', async () => {
    const { c, b } = await fixture();
    const other = await plantBatch(pool, c, user, (await pool.query(
      "SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'bank'", [c])).rows[0].id as string);
    expect((await submit(c, b.id)).state.statusCode).toBe(200);
    expect((await submit(c, other.id)).state.statusCode).toBe(200);
    expect(sender.submitEftBatch).toHaveBeenCalledTimes(2);
  });

  describe('payee account and branch are validated before anything is claimed or sent', () => {
    const RAW_OK = { accountHolder: 'Raw', bankCode: '250655', accountNumber: '62000000001', amount: 10000, reference: 'R' };
    const rawSubmit = (c: string, p: Record<string, unknown>) => callRoute(netcashSubmit, tokens[user]!, c, 'POST',
      { payments: [RAW_OK, p] }, '/api/accounting/netcash/submit');
    const nothingHappened = async (c: string) => {
      expect(sender.submitEftBatch).not.toHaveBeenCalled();
      expect(await rows(c)).toEqual([]);
    };

    it.each([
      ['an account longer than 11 digits', { bank_account_number: '123456789012' }],
      ['a branch code that is not 6 digits', { bank_branch_code: '25065' }],
      ['an account with no digits left once punctuation is stripped', { bank_account_number: '---' }],
    ])('batch mode: %s is refused 400, nothing claimed, nothing sent', async (_name, change) => {
      const { c, b } = await fixture();
      const [col, val] = Object.entries(change)[0]!;
      await pool.query(`UPDATE suppliers SET ${col} = $1 WHERE id = $2`, [val, b.members[0]!.supplierId]);
      const res = await submit(c, b.id);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
      await nothingHappened(c);
    });

    it('batch mode: an account written with spaces and dashes is sent as digits', async () => {
      const { c, b } = await fixture();
      await pool.query('UPDATE suppliers SET bank_account_number = $1 WHERE id = $2', ['6200 0000-001', b.members[0]!.supplierId]);
      expect((await submit(c, b.id)).state.statusCode).toBe(200);
      const sent = sender.submitEftBatch.mock.calls[0]![2] as { accountNumber: string }[];
      expect(sent.every((x) => /^\d{1,11}$/.test(x.accountNumber))).toBe(true);
    });

  });

  describe('a raw payments[] list is refused outright (no batch to approve or claim)', () => {
    const RAW_OK = { accountHolder: 'Raw', bankCode: '250655', accountNumber: '62000000001', amount: 10000, reference: 'R' };
    it.each([
      ['a well-formed list', [RAW_OK]],
      ['a list with a string amount (NaN total)', [{ ...RAW_OK, amount: '100.50' }]],
      ['a list with a fractional amount', [{ ...RAW_OK, amount: 10.5 }]],
      ['a malformed account', [{ ...RAW_OK, accountNumber: '62A00000001' }]],
    ])('%s: 400, nothing claimed, nothing sent', async (_name, payments) => {
      const { c } = await fixture();
      const res = await callRoute(netcashSubmit, tokens[user]!, c, 'POST', { payments }, '/api/accounting/netcash/submit');
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
      expect(sender.submitEftBatch).not.toHaveBeenCalled();
      expect(await rows(c)).toEqual([]);
    });
  });

  describe('Netcash credentials missing (K-132): nothing is claimed, nothing is "sent"', () => {
    it.each([
      ['no keys at all', 'NULL', 'NULL'],
      ['no payouts key', "'k'", 'NULL'],
      ['an empty service key', "''", "'k'"],
    ])('%s: 400 before the claim, so the batch stays free', async (_n, service, payouts) => {
      const { c, b } = await fixture();
      await pool.query(`UPDATE companies SET netcash_service_key = ${service}, netcash_payouts_key = ${payouts} WHERE id = $1`, [c]);
      const res = await submit(c, b.id);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
      expect(JSON.stringify(res.state.body)).toMatch(/credentials/i);
      expect(sender.submitEftBatch).not.toHaveBeenCalled();
      expect(await rows(c)).toEqual([]);
    });
  });
});

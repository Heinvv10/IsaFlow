/**
 * AP-01 round 12. The settle after Netcash has answered:
 *   R3  is bounded on both paths (lock_timeout and statement_timeout tightened in the settle transaction, and a client
 *       query_timeout above them for a connection that stops answering), so a stalled settle falls into the retry or
 *       AnswerNotRecordedError and frees its send slot; and the cap on sends in flight is per company as well as per
 *       process, so one tenant's stuck sends cannot refuse another's;
 *   B1  the retry recognises this send's own answer by its settle token, even after a poll moved the row;
 *   B2  a retry whose COMMIT reply was lost says the answer MAY not have been recorded.
 * Faults via ap01-netcash-faults.helpers. Judged by outcome: response, row, sends, elapsed time. Disposable DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hold = vi.hoisted(() => ({ submitEftBatch: vi.fn(), getSubmissionStatus: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => hold);

import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { faults, installQueryFaults, resetFaults } from './ap01-netcash-faults.helpers';
import { bounded, tightenSettleTimeouts } from '@/modules/accounting/services/ap/netcashClaimSettle';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantApprovedBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
const ACCEPTED = { success: true, outcome: 'accepted', batchReference: 'NC-BOUND' };
let restorePg = () => {};

beforeAll(async () => { admin = await createUser(pool, tokens); restorePg = installQueryFaults(); });
beforeEach(() => { hold.submitEftBatch.mockReset(); resetFaults(); });
afterEach(() => { delete process.env.NETCASH_MAX_CONCURRENT_SENDS; delete process.env.NETCASH_MAX_CONCURRENT_SENDS_PER_COMPANY; });
afterAll(async () => {
  restorePg();
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, [admin]);
});

async function company() {
  const { company: c, bank } = await payCompany(pool, [[admin, 'admin']], companies);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  return { c, batch: () => plantApprovedBatch(pool, c, admin, bank) };
}
const submit = (c: string, batchId: string) => callRoute(netcashSubmit, tokens[admin]!, c, 'POST', { batchPaymentId: batchId }, '/api/accounting/netcash/submit');
const reason = (r: Awaited<ReturnType<typeof submit>>) => JSON.stringify(r.state.body).match(/"reason":"([A-Z_]+)"/)?.[1];
const rowsOf = async (c: string) => (await pool.query('SELECT status FROM netcash_submissions WHERE company_id = $1', [c])).rows.map((r) => r.status as string);
const SETTLE = /SET status = \$3, batch_reference = \$4, netcash_response = \$5/;
/** `p`, or 'stuck' if it has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), ms))]);

/** A send parked in the stub sender: `answer()` lets Netcash reply. */
async function parked(c: string, batchId: string) {
  let reply!: (r: unknown) => void;
  let entered!: () => void;
  const inSender = new Promise<void>((r) => { entered = r; });
  hold.submitEftBatch.mockImplementationOnce(() => { entered(); return new Promise((r) => { reply = r; }); });
  const done = submit(c, batchId);
  await inSender;
  return { done, answer: () => reply(ACCEPTED) };
}

describe('R3: a stalled settle is bounded and frees its slot; the cap is per company too', () => {
  it('REPRO 3: the row is locked by someone else when Netcash answers: the settle gives up (500, not recorded), the slot frees, another tenant sends', async () => {
    process.env.NETCASH_MAX_CONCURRENT_SENDS = '1';
    const A = await company();
    const B = await company();
    const blocker = await pool.connect();
    try {
      const a = await parked(A.c, (await A.batch()).id);
      const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [A.c])).rows[0].id as string;
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM netcash_submissions WHERE id = $1 FOR UPDATE', [id]);
      a.answer();
      const first = await within(a.done, 20_000);
      hold.submitEftBatch.mockResolvedValue(ACCEPTED);
      const other = first === 'stuck' ? null : await submit(B.c, (await B.batch()).id);
      expect({ first: first === 'stuck' ? 'stuck' : first.state.statusCode, reason: first === 'stuck' ? null : reason(first), other: other?.state.statusCode })
        .toEqual({ first: 500, reason: 'NETCASH_ANSWER_NOT_RECORDED', other: 200 });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('a claim connection that stops answering mid-settle is given up on (client query_timeout), dropped, and the retry records the answer', async () => {
    const A = await company();
    faults.rules.push({ match: SETTLE, claimOnly: true, act: async (run, client) => {
      (client as unknown as { connection: { stream: { pause(): void } } }).connection.stream.pause(); // its replies stop arriving
      return run();
    } });
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const res = await within(submit(A.c, (await A.batch()).id), 25_000);
    expect({ http: res === 'stuck' ? 'stuck' : res.state.statusCode, rows: await rowsOf(A.c) }).toEqual({ http: 200, rows: ['submitted'] });
  }, 30_000);

  it('the send-lock unlock on a connection gone silent is bounded too: the request ends, the connection is dropped, the slot frees', async () => {
    process.env.NETCASH_MAX_CONCURRENT_SENDS = '1';
    const A = await company();
    faults.rules.push({ match: /pg_advisory_unlock\(\$1::INT4/, claimOnly: true, act: async (run, client) => {
      (client as unknown as { connection: { stream: { pause(): void } } }).connection.stream.pause();
      return run();
    } });
    hold.submitEftBatch.mockResolvedValue(ACCEPTED);
    const res = await within(submit(A.c, (await A.batch()).id), 20_000);
    const next = res === 'stuck' ? null : await submit(A.c, (await A.batch()).id);
    expect({ http: res === 'stuck' ? 'stuck' : res.state.statusCode, next: next?.state.statusCode }).toEqual({ http: 200, next: 200 });
  }, 30_000);

  it('the settle timeouts are tighten-only: a tighter session setting is kept, an unset one gets the bound', async () => {
    const client = await pool.connect();
    try {
      const show = async () => (await client.query("SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s")).rows[0];
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '500ms'");
      await client.query("SET LOCAL statement_timeout = '1s'");
      await tightenSettleTimeouts(bounded(client));
      const tighter = await show();
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = 0");
      await client.query("SET LOCAL statement_timeout = '1h'");
      await tightenSettleTimeouts(bounded(client));
      const looser = await show();
      await client.query('ROLLBACK');
      expect({ tighter, looser }).toEqual({ tighter: { l: '500ms', s: '1s' }, looser: { l: '2s', s: '4s' } });
    } finally {
      client.release();
    }
  });

  it('per company: with 2 of company A\'s sends stuck in flight, A\'s third is refused 503 and company B still sends', async () => {
    const A = await company();
    const B = await company();
    const a1 = await parked(A.c, (await A.batch()).id);
    const a2 = await parked(A.c, (await A.batch()).id);
    hold.submitEftBatch.mockResolvedValue(ACCEPTED);
    const third = await A.batch();
    const aThird = await submit(A.c, third.id);
    const b = await submit(B.c, (await B.batch()).id);
    const outcome = { aThird: aThird.state.statusCode, aReason: reason(aThird), aRows: (await rowsOf(A.c)).length, b: b.state.statusCode };
    a1.answer();
    a2.answer();
    await Promise.all([a1.done, a2.done]);
    expect(outcome).toEqual({ aThird: 503, aReason: 'NETCASH_COMPANY_SENDS_BUSY', aRows: 2, b: 200 });
  });
});

describe('B1/B2: what the retry says about an answer it cannot see acknowledged', () => {
  it('B1: the first settle committed (reply lost) and a poll then moved the row: the retry still knows the answer is its own (200)', async () => {
    const A = await company();
    faults.rules.push({ match: /^COMMIT$/, claimOnly: true, skip: 1, act: async (run) => {
      await run();
      // A poll lands before the retry: status and netcash_response both change.
      await pool.query(`UPDATE netcash_submissions SET status = 'processing',
        netcash_response = netcash_response || '{"latestPoll":{"status":"Processing"}}'::JSONB WHERE company_id = $1`, [A.c]);
      throw new Error('injected: reply lost');
    } });
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const res = await submit(A.c, (await A.batch()).id);
    const late = (await pool.query("SELECT netcash_response ? 'lateSendResult' AS late FROM netcash_submissions WHERE company_id = $1", [A.c])).rows[0].late;
    expect({ http: res.state.statusCode, rows: await rowsOf(A.c), late }).toEqual({ http: 200, rows: ['processing'], late: false });
  });

  it('B1 (late branch): a first settle that reopened a row released underneath its send committed, reply lost: the retry still reports reopened', async () => {
    const A = await company();
    const a = await parked(A.c, (await A.batch()).id);
    const id = (await pool.query('SELECT id FROM netcash_submissions WHERE company_id = $1', [A.c])).rows[0].id as string;
    await pool.query("UPDATE netcash_submissions SET status = 'failed' WHERE id = $1", [id]); // released past the guards
    // The claim has committed already: the claim connection's next COMMIT is the settle's.
    faults.rules.push({ match: /^COMMIT$/, claimOnly: true, act: async (run) => { await run(); throw new Error('injected: reply lost'); } });
    a.answer();
    const res = await a.done;
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const again = await submit(A.c, (await pool.query('SELECT batch_id FROM netcash_submissions WHERE id = $1', [id])).rows[0].batch_id);
    expect({ http: res.state.statusCode, reopened: JSON.stringify(res.state.body).includes('"reopened":true'), rows: await rowsOf(A.c),
      resend: again.state.statusCode, sends: hold.submitEftBatch.mock.calls.length })
      .toEqual({ http: 409, reopened: true, rows: ['submitted'], resend: 409, sends: 1 });
  });

  it('B2: the retry\'s COMMIT landed but its reply was lost: 500 that says the answer MAY not have been recorded (check the row and Netcash)', async () => {
    const A = await company();
    faults.rules.push({ match: /^COMMIT$/, claimOnly: true, skip: 1, act: async () => { throw new Error('injected: settle commit'); } });
    faults.rules.push({ match: /^COMMIT$/, claimOnly: false, act: async (run) => { await run(); throw new Error('injected: retry reply lost'); } });
    hold.submitEftBatch.mockResolvedValueOnce(ACCEPTED);
    const res = await submit(A.c, (await A.batch()).id);
    const text = JSON.stringify(res.state.body);
    expect({ http: res.state.statusCode, may: /may not have been recorded/i.test(text), check: /check the submission/i.test(text), rows: await rowsOf(A.c) })
      .toEqual({ http: 500, may: true, check: true, rows: ['submitted'] });
  });
});

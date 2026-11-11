/**
 * The ISV send guard and the correlation id (wave 5 L1b, round 6): sendMayHaveReached judges ALL of a submission's events,
 * never the newest alone, and a correlation id SARS returned is persisted on the draft by the committed event write, so
 * the existing poll can resolve a send whose result could not be recorded.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { inTx } from './helpers/l1FifoFixture';
import {
  applyPollResult, sendMayHaveReached, withEventWriter,
} from '../../src/modules/accounting/services/reports/sarsEfilingRepo';

// The SARS side is faked; the database is real.
const sars = vi.hoisted(() => ({ status: 'unknown' }));
vi.mock('../../src/modules/accounting/services/reports/sarsEfilingConfig', () => ({
  getEfilingConfig: () => ({ baseUrl: 'http://sars.invalid', isvLogin: 'l', activationKey: 'k' }), isEfilingConfigured: () => true,
}));
vi.mock('../../src/modules/accounting/services/reports/sarsEfilingClient', () => ({
  authenticate: async () => ({ token: 't' }),
  pollStatus: async () => ({ status: sars.status, sarsReference: null, errors: [], httpStatus: 200 }),
  submitVAT201: async () => { throw new Error('not used'); },
}));
import { pollVAT201Status } from '../../src/modules/accounting/services/reports/sarsEfilingSubmissionService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
let month = 0;

/** A fresh VAT201 draft (its own period, no return version) and a recorder of its events in order. */
async function draft(): Promise<{ id: string; ev: (type: string, status: string | null, http: number | null, corr: string | null) => Promise<void> }> {
  month += 1;
  const start = `${2010 + month}-01-01`; // a period of its own per draft, with no return version
  const end = `${2010 + month}-02-28`;
  const id = String(((await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status)
    VALUES (${a.fx.companyId}::UUID, 'VAT201', ${start}::DATE, ${end}::DATE, 'draft') RETURNING id`) as Row[])[0]!.id);
  const ev = async (type: string, status: string | null, http: number | null, corr: string | null) => {
    await sql`INSERT INTO sars_efiling_events (company_id, submission_id, event_type, efiling_status, http_status, correlation_id)
      VALUES (${a.fx.companyId}::UUID, ${id}::UUID, ${type}, ${status}, ${http}, ${corr})`;
  };
  return { id, ev };
}
const doubt = (id: string) => inTx(a.fx, () => sendMayHaveReached(a.fx.companyId, id));
const may = async (id: string) => (await doubt(id)) !== null;

describeIfDb('the ISV send guard and the correlation id', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, submissions and eFiling events.');
    a = await seedReturnFixture('RFI', DATABASE_URL!);
  }, 240000);
  afterAll(async () => {
    if (a) await dropReturnFixture(a);
  }, 120000);

  it('an intent with no result is uncertain, whatever event follows it; a result or a 4xx answer clears it', async () => {
    const none = await draft();
    expect(await may(none.id)).toBe(false);
    const timeout = await draft();
    await timeout.ev('submit', 'sending', null, null);
    expect(await may(timeout.id)).toBe(true);
    await timeout.ev('error', null, null, null); // a timeout: no status, no correlation
    expect(await may(timeout.id)).toBe(true); // refused: the request may have been processed
    await timeout.ev('blocked', null, null, null);
    await timeout.ev('poll', null, null, null);
    expect(await may(timeout.id)).toBe(true); // later unrelated events do not hide the intent
    const refused = await draft();
    await refused.ev('submit', 'sending', null, null);
    await refused.ev('error', null, 422, null); // SARS answered and refused: it did not file
    expect(await may(refused.id)).toBe(false);
    const server = await draft();
    await server.ev('submit', 'sending', null, null);
    await server.ev('error', null, 500, null);
    expect(await may(server.id)).toBe(true);
    const done = await draft();
    await done.ev('submit', 'sending', null, null);
    await done.ev('submit', 'received', 202, null); // a result
    expect(await may(done.id)).toBe(false);
  });

  it('ANY event with a correlation id is uncertain, even when later events do not carry it (a 4xx commits a blocked event)', async () => {
    const d = await draft();
    await d.ev('submit', 'received', 202, 'CORR-9');
    await d.ev('blocked', null, null, null);
    await d.ev('error', null, 422, null);
    expect(await may(d.id)).toBe(true);
    expect(await doubt(d.id)).toEqual({ correlationId: 'CORR-9' }); // the id to reconcile
  });

  it('a lost result: the failure event\'s correlation id is persisted on the draft, and the existing poll then records the verdict', async () => {
    const d = await draft();
    const intentAt = (await sql`INSERT INTO sars_efiling_events (company_id, submission_id, event_type, efiling_status, created_by)
      VALUES (${a.fx.companyId}::UUID, ${d.id}::UUID, 'submit', 'sending', ${a.admin.userId}) RETURNING created_at`) as Row[];
    const c = await a.fx.pool.connect();
    try {
      await c.query('BEGIN');
      await als.run({ client: c, userId: a.admin.userId, companyId: a.fx.companyId, claims: { sub: a.admin.userId } } as never, () => withEventWriter(async (events) => {
      await events.write({ companyId: a.fx.companyId, submissionId: d.id, eventType: 'error', httpStatus: null, correlationId: 'CORR-LOST', message: 'connection lost', createdBy: a.admin.userId });
      await events.write({ companyId: a.fx.companyId, submissionId: d.id, eventType: 'error', correlationId: 'CORR-OTHER', createdBy: a.admin.userId });
      }));
      await c.query('ROLLBACK'); // the request fails; the correlation id was committed on the writer's own connection
    } finally {
      c.release();
    }
    const row = async () => ((await sql`SELECT status, efiling_correlation_id, submission_reference FROM sars_submissions WHERE id = ${d.id}::UUID`) as Row[])[0]!;
    expect(await row()).toMatchObject({ status: 'draft', efiling_correlation_id: 'CORR-LOST' }); // set once, never overwritten
    await inTx(a.fx, () => applyPollResult(a.fx.companyId, d.id, { submissionStatus: 'accepted', efilingStatus: 'accepted', sarsReference: 'SARS-REF-9' }));
    // the poll resolved a draft that never got its own submit bookkeeping: it takes the intent's time and actor, on the ISV channel
    const resolved = ((await sql`SELECT status, submission_reference, efiling_channel, submitted_by, submitted_at FROM sars_submissions
      WHERE id = ${d.id}::UUID`) as Row[])[0]!;
    expect(resolved).toMatchObject({ status: 'accepted', submission_reference: 'SARS-REF-9', efiling_channel: 'isv', submitted_by: a.admin.userId });
    expect(new Date(resolved.submitted_at as string).getTime()).toBe(new Date(intentAt[0]!.created_at as string).getTime());
  });

  it('the poll stamps the intent that PRECEDED the correlation-carrying event (else the latest intent), among several intents', async () => {
    const at = (iso: string) => new Date(iso);
    const ev = (id: string, type: string, status: string | null, corr: string | null, when: string, by = a.admin.userId) => sql`INSERT INTO sars_efiling_events
      (company_id, submission_id, event_type, efiling_status, correlation_id, created_by, created_at)
      VALUES (${a.fx.companyId}::UUID, ${id}::UUID, ${type}, ${status}, ${corr}, ${by}, ${at(when).toISOString()}::TIMESTAMPTZ)`;
    const byOf = async (id: string) => String(((await sql`SELECT submitted_by FROM sars_submissions WHERE id = ${id}::UUID`) as Row[])[0]!.submitted_by);
    const poll = (id: string) => inTx(a.fx, () => applyPollResult(a.fx.companyId, id, { submissionStatus: 'accepted', efilingStatus: 'accepted', sarsReference: 'R' }));
    const submittedAt = async (id: string) => new Date(String(((await sql`SELECT submitted_at FROM sars_submissions WHERE id = ${id}::UUID`) as Row[])[0]!.submitted_at)).toISOString();
    // intent 1, then SARS's correlation id, then a later intent 2 (a retry that never answered): the id belongs to intent 1
    const first = await draft();
    await ev(first.id, 'submit', 'sending', null, '2026-01-01T10:00:00Z', a.admin.userId);
    await ev(first.id, 'error', null, 'CORR-A', '2026-01-01T10:00:05Z');
    await ev(first.id, 'submit', 'sending', null, '2026-01-01T12:00:00Z', a.manager.userId); // a different user's later retry
    await sql`UPDATE sars_submissions SET efiling_correlation_id = 'CORR-A' WHERE id = ${first.id}::UUID`;
    await poll(first.id);
    expect(await submittedAt(first.id)).toBe('2026-01-01T10:00:00.000Z');
    expect(await byOf(first.id)).toBe(a.admin.userId); // the actor of the intent that preceded the id, not the later retry's
    // no event carries the id: the latest intent
    const second = await draft();
    await ev(second.id, 'submit', 'sending', null, '2026-02-01T10:00:00Z', a.admin.userId);
    await ev(second.id, 'submit', 'sending', null, '2026-02-01T12:00:00Z', a.manager.userId);
    await sql`UPDATE sars_submissions SET efiling_correlation_id = 'CORR-B' WHERE id = ${second.id}::UUID`;
    await poll(second.id);
    expect(await submittedAt(second.id)).toBe('2026-02-01T12:00:00.000Z');
    expect(await byOf(second.id)).toBe(a.manager.userId);
  });

  it('a draft takes SARS\'s verdict only with a correlation id, whatever the period', async () => {
    const noId = await draft();
    const withId = await draft();
    await sql`UPDATE sars_submissions SET efiling_correlation_id = 'CORR-V' WHERE id = ${withId.id}::UUID`;
    const verdict = (id: string, status: string) => sql`UPDATE sars_submissions SET status = ${status} WHERE id = ${id}::UUID`;
    await expect(verdict(noId.id, 'accepted')).rejects.toThrow(/correlation id/);
    await expect(verdict(noId.id, 'rejected')).rejects.toThrow(/correlation id/);
    await verdict(withId.id, 'rejected'); // allowed: no version for this period, and it has an id
    expect(((await sql`SELECT status FROM sars_submissions WHERE id = ${withId.id}::UUID`) as Row[])[0]!.status).toBe('rejected');
  });

  it('an unknown SARS status is a FULL no-op on a draft (no channel, time or actor), and processing never regresses a verdict', async () => {
    const d = await draft();
    await sql`INSERT INTO sars_efiling_events (company_id, submission_id, event_type, efiling_status, created_by)
      VALUES (${a.fx.companyId}::UUID, ${d.id}::UUID, 'submit', 'sending', ${a.admin.userId})`;
    await sql`UPDATE sars_submissions SET efiling_correlation_id = 'CORR-U' WHERE id = ${d.id}::UUID`;
    const row = async () => ((await sql`SELECT status, efiling_channel, submitted_at, submitted_by, efiling_last_status FROM sars_submissions
      WHERE id = ${d.id}::UUID`) as Row[])[0]!;
    const before = await row();
    sars.status = 'unknown';
    await inTx(a.fx, () => pollVAT201Status(a.fx.companyId, d.id, a.admin.userId));
    expect(await row()).toEqual(before); // nothing stamped
    expect(before).toMatchObject({ status: 'draft', efiling_channel: null, submitted_at: null, submitted_by: null });
    sars.status = 'accepted';
    await inTx(a.fx, () => pollVAT201Status(a.fx.companyId, d.id, a.admin.userId));
    expect(await row()).toMatchObject({ status: 'accepted', efiling_channel: 'isv' });
    sars.status = 'processing';
    await inTx(a.fx, () => pollVAT201Status(a.fx.companyId, d.id, a.admin.userId));
    expect((await row()).status).toBe('accepted'); // not regressed
  });
});

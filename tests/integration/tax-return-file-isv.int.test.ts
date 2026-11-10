/**
 * The ISV send guard and the correlation id (wave 5 L1b, round 6): sendMayHaveReached judges ALL of a submission's events,
 * never the newest alone, and a correlation id SARS returned is persisted on the draft by the committed event write, so
 * the existing poll can resolve a send whose result could not be recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { inTx } from './helpers/l1FifoFixture';
import {
  applyPollResult, sendMayHaveReached, withEventWriter,
} from '../../src/modules/accounting/services/reports/sarsEfilingRepo';

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
});

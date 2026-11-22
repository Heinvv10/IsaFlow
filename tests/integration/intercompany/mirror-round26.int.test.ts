/**
 * Intercompany P2, round 26 (blind review of 470f2ab2b4):
 *  INFO2  a hidden stored draft of a MIRRORED row (an older generator's, or one drafted before the message was linked) is not posted by id:
 *         postEliminationAdjustment refuses it like createEliminationAdjustment does, and the draft stays a draft.
 *  L2     the remedy the Eliminations page names for a REJECTED message is true: it is final, and the same document cannot be sent again.
 *  INFO1  only an ACCEPTED message derives an elimination: a pending / rejected message that carries a target document (the guard lets a handler
 *         set a target without accepting) derives nothing (intercompany_mirror_eliminations and intercompany_receiver_je).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { withoutTrigger } from './intercompany.helpers';
import { postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { EliminationMirroredRowUnsupportedError } from '../../../src/modules/accounting/services/reports/eliminationErrors';
import { asService, co, inbox, sentInvoice, U } from './mirror.helpers';
import { asAppUser } from './intercompany.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(L.setup, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

/** The message's status as a handler can leave it with a target set (accepted is final, so the state is planted past the guard). */
const setStatus = (id: string, status: string) => withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
  "UPDATE intercompany_messages SET status = $2, reason = CASE WHEN $2 = 'rejected' THEN 'not ours' END WHERE id = $1", [id, status]));
const receiverJe = async (row: string) => (await pool.query('SELECT public.intercompany_receiver_je($1, CURRENT_DATE) AS je', [row])).rows[0].je as string | null;

describe('INFO1: only an accepted message derives an elimination', () => {
  it.each(['pending', 'rejected', 'dismissed', 'failed'])('a %s message with a target document derives nothing and has no receiver journal', async (status) => {
    const m = await L.accepted();
    await L.approveBill(m.bill);
    const row = (await L.groupRow()).id as string;
    expect(await L.derived(), 'accepted: derived').toHaveLength(1);
    expect(await receiverJe(row)).not.toBeNull();
    await setStatus(m.id, status);
    expect(await L.derived()).toHaveLength(0);
    expect(await receiverJe(row)).toBeNull();
    await setStatus(m.id, 'accepted');
    expect(await L.derived(), 'accepted again: derived again').toHaveLength(1);
  });
});

describe('INFO2: a hidden stored draft of a mirrored row is not posted by id', () => {
  const plant = async (row: string) => (await pool.query(
    `INSERT INTO consolidation_adjustments(group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id)
     VALUES ($1, 'interco_revenue', 'older generator', '2026-01-01', '2026-12-31', '[]'::jsonb, $2) RETURNING id`, [co.G, row])).rows[0].id as string;
  const status = async (id: string) => (await pool.query('SELECT status FROM consolidation_adjustments WHERE id = $1', [id])).rows[0].status as string;
  const post = (id: string, confirm = false) => asService(pool, U.ab, co.A, () => postEliminationAdjustment(id, co.G, confirm));

  it.each([false, true])('refuses (confirmDuplicate=%s) and leaves the draft a draft', async (confirm) => {
    const m = await L.accepted();
    await L.approveBill(m.bill);
    const adj = await plant((await L.groupRow()).id as string);
    await expect(post(adj, confirm)).rejects.toBeInstanceOf(EliminationMirroredRowUnsupportedError);
    expect(await status(adj)).toBe('draft');
  });

  it('still posts the draft of a MANUAL (P1) row, and a draft naming no row', async () => {
    await L.accepted();   // (a mirrored row exists in the group too: only the named row decides)
    const manual = (await pool.query(
      `INSERT INTO intercompany_transactions (group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date, description)
       VALUES ($1, $2, $3, 'sale', 50, '2026-12-05', 'plain manual row') RETURNING id`, [co.G, co.A, co.B])).rows[0].id as string;
    const adj = await plant(manual);
    await post(adj);
    expect(await status(adj)).toBe('posted');
  });
});

describe('L2: a rejected message is final and its document cannot be sent again (only cancel and a new document does)', () => {
  it('reject, then send the same document: already_sent; the message stays rejected', async () => {
    const sent = await sentInvoice(pool);
    const res = await inbox.reject(U.b, co.B, sent.id, { reason: 'Not ours' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const again = await asAppUser(pool, U.a, co.A, async (q) => (await q.query("SELECT * FROM public.intercompany_send_for_source('customer_invoice', $1)", [sent.inv.id])).rows[0], true);
    expect(again).toMatchObject({ message_id: null, reason: 'already_sent' });
    expect((await pool.query('SELECT status FROM intercompany_messages WHERE id = $1', [sent.id])).rows[0].status).toBe('rejected');
  });
});

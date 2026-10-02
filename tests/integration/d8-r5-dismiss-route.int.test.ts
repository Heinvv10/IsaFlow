/**
 * D8 round 5: POST /api/accounting/provisional/[jeId]/dismiss says what it did.
 * A provisional whose journal was already reversed from the GL has nothing left
 * to reverse — the dismiss only frees its bank line — and the route answered
 * "Provisional entry reversed" all the same.
 */
import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import dismissRoute from '../../pages/api/accounting/provisional/[jeId]/dismiss';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { btState, company, inTx, pool, seedProvisional, useR127Fixture, user } from './r127-double-booking.helpers';

useR127Fixture();

async function dismiss(je: string) {
  const token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = {};
  req.query = { jeId: je };
  req.url = `/api/accounting/provisional/${je}/dismiss`;
  const out = response();
  await dismissRoute(req as never, out.res as never);
  return { ...(out.state as { statusCode: number; body: { message?: string; error?: { code?: string }; data?: { reversalJournalEntryId: string | null } } }),
    retryAfter: (out.res as unknown as { getHeader: (k: string) => unknown }).getHeader('Retry-After') };
}

const contras = async (id: string) => (await pool.query(
  "SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [id])).rows.length;

describe('D8 round 5: the dismiss route reports whether anything was reversed', () => {
  it('a standing provisional: reversed, and says so', async () => {
    const { je, bt } = await seedProvisional({ totalAmount: 115 });

    const state = await dismiss(je);

    expect(state.statusCode).toBe(200);
    expect(state.body.message).toBe('Provisional entry reversed');
    expect(state.body.data?.reversalJournalEntryId).toBeTruthy();
    expect(await contras(je)).toBe(1);
    expect((await btState(bt)).status).toBe('imported');
  });

  it('a provisional already reversed from the GL: nothing posted, the line freed, and the message says that', async () => {
    const { je, bt } = await seedProvisional({ totalAmount: 230 });
    const r = await inTx(() => reverseJournalEntry(company, je, user));

    const state = await dismiss(je);

    expect(state.statusCode).toBe(200);
    expect(state.body.message).toBe('Provisional entry dismissed; its journal was already out of the ledger');
    expect(state.body.data?.reversalJournalEntryId).toBeNull();
    expect(await contras(r.id)).toBe(0);
    expect((await btState(bt)).status).toBe('imported');
  });

  it('a provisional whose journal another request holds: 503 + Retry-After within the lock budget, nothing changed (D8 round 6)', async () => {
    const { je, bt } = await seedProvisional({ totalAmount: 99 });
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE', [je]);
    let state: Awaited<ReturnType<typeof dismiss>>;
    try {
      state = await dismiss(je);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(state.statusCode).toBe(503);
    expect(state.retryAfter).toBe('2');
    expect(state.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(await contras(je)).toBe(0);
    expect((await btState(bt)).status).toBe('provisional');
  }, 30000);
});

/**
 * Intercompany P4-E, fix round 2: `intercompany_connection_allocation_held(connection)` (migration 1029) asked DIRECTLY as app_user, and its
 * INVOKER helper `intercompany_allocation_payer_standing` locked away from the app. Who may ask (a writer of a company on the connection:
 * anyone else is NULL, which the caller holds on), and each arm: an ACCEPTED message holds; a pending, failed or dismissed LOAN message (its
 * payment credited the payer's loan account, cashLegIsLoanAccount) holds while its payer side stands; a BANK-paid one (cashLegIsLoanAccount
 * false: P4-D can never accept it, cash_not_through_loan) holds nothing, nor does a rejected one or one the payer voided. A failed loan
 * message keeps holding whatever the receiver's refusal was (the receiver can fix its side and accept it again; the payer's void, or the
 * receiver's reject, releases it).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, co, U, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup, rawReverseJournal } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { outcomeOf, sentClearable } from './allocation-clear.helpers';
import { allocationsApi, sentAllocation } from './allocation-live.helpers';
import { clearConnect, payerSetup, receiverAccepts } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

const held = (user = U.b, company = co.B, connection: string | null = conn) =>
  asAppUser(pool, user, company, async (q) => (await q.query('SELECT public.intercompany_connection_allocation_held($1::uuid) AS h', [connection])).rows[0].h as boolean | null);
const bothSides = async () => [await held(U.b, co.B), await held(U.a, co.A)];
const setFailed = (message: string) => asAppUser(pool, U.a, co.A, (q) => q.query("UPDATE intercompany_messages SET status = 'failed', error = 'x' WHERE id = $1", [message]), true);

describe('who may ask', () => {
  it('a writer of either company on the connection gets an answer; a viewer, a non-member, a third company or no connection is NULL', async () => {
    expect(await bothSides()).toEqual([false, false]);
    expect(await held(U.avb, co.B)).toBeNull();
    expect(await held(U.va, co.A)).toBeNull();
    expect(await held(U.x, co.B)).toBeNull();
    expect(await held(U.c, co.C)).toBeNull();
    expect(await held(U.b, co.B, crypto.randomUUID())).toBeNull();
    expect(await held(U.b, co.B, null)).toBeNull();
  });

  it('a viewer gets NULL even while the connection is held (not the answer a writer gets)', async () => {
    await sentClearable(pool, conn, { amount: 100 });
    expect(await bothSides()).toEqual([true, true]);
    expect(await held(U.avb, co.B)).toBeNull();
  });

  it('the helper is the definers\' alone: app_user and PUBLIC cannot execute it', async () => {
    const can = async (role: string) => (await pool.query(
      "SELECT has_function_privilege($1, 'public.intercompany_allocation_payer_standing(uuid)', 'EXECUTE') AS c", [role])).rows[0].c as boolean;
    expect(await can('app_user')).toBe(false);
    expect(await can('public')).toBe(false);
    expect(await can('migration_admin')).toBe(true);
    const err = await asAppUser(pool, U.b, co.B, (q) => q.query('SELECT public.intercompany_allocation_payer_standing($1)', [crypto.randomUUID()]))
      .then(() => 'ran', (e: { code?: string }) => e.code);
    expect(err).toBe('42501');
  });
});

describe('each arm', () => {
  it('a pending LOAN message holds; the payer reversing its journal releases it', async () => {
    const s = await sentClearable(pool, conn, { amount: 100 });
    expect(await bothSides()).toEqual([true, true]);
    await rawReverseJournal(pool, s.journal!);
    expect(await bothSides()).toEqual([false, false]);
  });

  it('a pending BANK-paid message holds nothing (P4-D can never accept it)', async () => {
    const s = await sentAllocation(pool, conn, { amount: 100 });
    expect((await pool.query("SELECT payload #>> '{payment,cashLegIsLoanAccount}' AS c FROM intercompany_messages WHERE id = $1", [s.message])).rows[0].c).toBe('false');
    expect(await bothSides()).toEqual([false, false]);
  });

  it('a failed or dismissed BANK-paid message holds nothing either', async () => {
    const failed = await sentAllocation(pool, conn, { amount: 100 });
    await setFailed(failed.message);
    expect(await bothSides()).toEqual([false, false]);
    const dismissed = await sentAllocation(pool, conn, { amount: 100 });
    expect((await allocationsApi.dismiss(U.a, co.A, dismissed.message)).state.statusCode).toBe(200);
    expect(await bothSides()).toEqual([false, false]);
  });

  it('a failed LOAN message holds (whatever the refusal: the receiver can accept it later); a rejected one does not', async () => {
    const s = await sentClearable(pool, conn, { amount: 100 });
    await setFailed(s.message);
    expect(await bothSides()).toEqual([true, true]);
    expect((await allocationsApi.reject(U.a, co.A, s.message, { reason: 'not ours' })).state.statusCode).toBe(200);
    expect(await bothSides()).toEqual([false, false]);
  });

  it('a dismissed LOAN message holds while its payer side stands', async () => {
    const s = await sentClearable(pool, conn, { amount: 100 });
    expect((await allocationsApi.dismiss(U.a, co.A, s.message)).state.statusCode).toBe(200);
    expect(await bothSides()).toEqual([true, true]);
  });

  it('an ACCEPTED message holds, even once the payer side no longer stands', async () => {
    const s = await sentClearable(pool, conn, { amount: 100 });
    expect(outcomeOf(await receiverAccepts(s.message, s.invoice, 100))).toMatchObject({ accepted: true });
    expect(await bothSides()).toEqual([true, true]);
    await rawReverseJournal(pool, s.journal!);
    expect(await bothSides()).toEqual([true, true]);
  });
});

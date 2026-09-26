/**
 * R-032 L5, Hein's extension (2026-09-26): a "Login as" session files nothing
 * with SARS and closes no year. VAT201 filing through the ISV channel, the
 * manual "mark as submitted", the VAT return submission and the year-end close
 * each answer 403 IMPERSONATION_FORBIDDEN with nothing written — no eFiling
 * event, no submission status change, no VAT return, no journal — and no
 * outbound SARS call (every fetch outside GoTrue is faked and recorded).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiHandler } from 'next';
import efilingSubmit from '../../pages/api/accounting/sars/efiling-submit';
import sarsSubmissions from '../../pages/api/accounting/sars/sars-submissions';
import vatReturns from '../../pages/api/accounting/vat-returns/index';
import yearEnd from '../../pages/api/accounting/year-end';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, reasonOf, type Call, type Jar } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'R032 L5 SARS');
const SARS = 'http://sars-efiling.r032.invalid';

async function draft(formType: 'VAT201' | 'EMP201'): Promise<string> {
  const { rows } = await pool.query(`INSERT INTO sars_submissions(company_id,form_type,period_start,period_end,submitted_by)
    VALUES($1,$2,'2026-07-01','2026-08-31',$3) RETURNING id`, [fx.company, formType, fx.target]);
  return rows[0].id as string;
}

beforeAll(async () => {
  await fx.setUp();
  // The ISV channel is ON and pointed at a faked host: without the guard, the
  // submit would reach SARS (or write a 'blocked' eFiling event on the way).
  vi.stubEnv('SARS_EFILING_ENABLED', 'true');
  vi.stubEnv('SARS_EFILING_BASE_URL', SARS);
  vi.stubEnv('SARS_EFILING_ISV_LOGIN', 'r032');
  vi.stubEnv('SARS_EFILING_ISV_KEY', 'r032');
  await pool.query(`UPDATE companies SET vat_number='4123456789' WHERE id=$1`, [fx.company]);
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM sars_efiling_events WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM sars_submissions WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM vat_returns WHERE company_id=$1', [fx.company]);
    await fx.tearDown();
  } finally { await pool.end(); }
});

const state = async () => (await pool.query(`SELECT
    (SELECT count(*) FROM sars_efiling_events WHERE company_id=$1) AS efiling_events,
    (SELECT json_agg(json_build_object('id', id, 'status', status, 'ref', submission_reference) ORDER BY id)
       FROM sars_submissions WHERE company_id=$1) AS submissions,
    (SELECT count(*) FROM vat_returns WHERE company_id=$1) AS vat_returns,
    (SELECT count(*) FROM gl_journal_entries WHERE company_id=$1) AS journals,
    (SELECT count(*) FROM audit_log WHERE company_id=$1) AS audits`, [fx.company])).rows[0];

type Case = { name: string; handler: NextApiHandler; call: () => Promise<Call> };
const CASES: Case[] = [
  { name: 'SARS eFiling VAT201 submit', handler: efilingSubmit,
    call: async () => ({ body: { submissionId: await draft('VAT201'), action: 'submit' } }) },
  { name: 'SARS submission mark_submitted', handler: sarsSubmissions,
    call: async () => ({ body: { id: await draft('EMP201'), action: 'mark_submitted', reference: 'R032-REF' } }) },
  { name: 'VAT return submit', handler: vatReturns,
    call: async () => ({ body: { periodStart: '2026-07-01', periodEnd: '2026-08-31', sarsReference: 'R032' } }) },
  { name: 'year-end close', handler: yearEnd, call: async () => ({ body: { yearLabel: '2026', action: 'close' } }) },
];

describe('R-032 L5 — a Login-as session files nothing with SARS and closes no year', () => {
  let loginAs: Jar;
  beforeAll(async () => { loginAs = await fx.loginAsTarget(); });

  it.each(CASES)('refuses $name with 403, writes nothing and calls no one', async ({ handler, call }) => {
    const request = await call();
    const before = await state();
    const outboundBefore = fx.outbound.length;
    const result = await fx.call(handler, loginAs, request);
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(403);
    expect(reasonOf(result)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await state()).toEqual(before);
    expect(fx.outbound.slice(outboundBefore)).toEqual([]);
  });

  it.each(CASES)('does not refuse $name on the target\'s own session', async ({ handler, call }) => {
    const result = await fx.call(handler, await fx.ownSession(), await call());
    expect(reasonOf(result), JSON.stringify(result.state.body)).not.toBe('IMPERSONATION_FORBIDDEN');
  });
});

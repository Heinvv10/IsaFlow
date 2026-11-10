/**
 * A send to SARS that may have reached it, against the return lifecycle (wave 5 L1b, round 7): the draft's figures are never
 * overwritten, file and finalise refuse while the send is uncertain, and a draft carrying a correlation id cannot take a verdict
 * once the period has a return version.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { inTx } from './helpers/l1FifoFixture';
import { amendV, fileV, fin, useFixture, versionOf } from './helpers/returnFileCalls';
import { applyPollResult } from '../../src/modules/accounting/services/reports/sarsEfilingRepo';
import { saveDraftSubmission, SubmissionNotOpenError } from '../../src/modules/accounting/services/reports/sarsComplianceService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
// bi-monthly periods ending in odd months, none finalised yet
const P1 = { periodStart: '2026-02-01', periodEnd: '2026-03-31' };
const P2 = { periodStart: '2026-04-01', periodEnd: '2026-05-31' };
const P3 = { periodStart: '2026-06-01', periodEnd: '2026-07-31' };

async function draft(p: typeof P1, corr: string | null = null, figures: Record<string, unknown> = {}): Promise<string> {
  return String(((await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, form_data, efiling_correlation_id)
    VALUES (${a.fx.companyId}::UUID, 'VAT201', ${p.periodStart}::DATE, ${p.periodEnd}::DATE, 'draft', ${JSON.stringify(figures)}::jsonb, ${corr})
    RETURNING id`) as Row[])[0]!.id);
}
const event = (id: string, type: string, status: string | null, http: number | null) => sql`INSERT INTO sars_efiling_events
  (company_id, submission_id, event_type, efiling_status, http_status) VALUES (${a.fx.companyId}::UUID, ${id}::UUID, ${type}, ${status}, ${http})`;

describeIfDb('an uncertain send against the return lifecycle', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, submissions, eFiling events and return versions.');
    a = await seedReturnFixture('RFL', DATABASE_URL!);
    useFixture(a);
  }, 240000);
  afterAll(async () => {
    if (a) await dropReturnFixture(a);
  }, 120000);

  it('a draft that holds a correlation id is never updated: the figures SARS received stay', async () => {
    const id = await draft({ periodStart: '2024-01-01', periodEnd: '2024-02-29' }, 'CORR-SENT', { sent: 'figures' });
    await expect(inTx(a.fx, () => saveDraftSubmission(a.fx.companyId, 'VAT201', '2024-01-01', '2024-02-29', { sent: 'changed' }, a.admin.userId)))
      .rejects.toBeInstanceOf(SubmissionNotOpenError);
    expect(((await sql`SELECT form_data FROM sars_submissions WHERE id = ${id}::UUID`) as Row[])[0]!.form_data).toEqual({ sent: 'figures' });
  });

  it('finalise is refused (409) while a send may have reached SARS: a persisted correlation id, or an intent with only a timeout; then it goes through', async () => {
    const withId = await draft(P1, 'CORR-LOST');
    expect((await fin(P1)).status).toBe(409);
    expect(await sql`SELECT 1 FROM tax_return_versions WHERE company_id = ${a.fx.companyId}::UUID`).toHaveLength(0);
    await sql`DELETE FROM sars_submissions WHERE id = ${withId}::UUID`;
    const timeout = await draft(P1);
    await event(timeout, 'submit', 'sending', null);
    await event(timeout, 'error', null, null); // a timeout: no status, no correlation
    expect((await fin(P1)).status).toBe(409);
    await event(timeout, 'error', null, 422); // a later answer from SARS that refused: the intent is resolved (it did not file)
    expect((await fin(P1)).status).toBe(200);
  });

  it('file is refused (409) while a send may have reached SARS (an intent then a timeout), and filing then goes through once it is cleared', async () => {
    const v = versionOf(await fin(P2));
    const d = await draft(P2);
    await event(d, 'submit', 'sending', null);
    await event(d, 'error', null, null);
    const refused = await fileV(String(v.id), { reference: 'R-UNC' }, a.admin.token, 'vat201');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/SEND_UNCERTAIN|may have reached/);
    expect(((await sql`SELECT status FROM tax_return_versions WHERE id = ${String(v.id)}::UUID`) as Row[])[0]!.status).toBe('finalised');
    await event(d, 'submit', 'reconciled', null); // the manual reconcile: a non-intent submit event
    expect((await fileV(String(v.id), { reference: 'R-OK' }, a.admin.token, 'vat201')).status).toBe(200);
    await amendV(String(v.id), { reason: 'cleanup' }, a.admin.token, 'vat201');
  });

  it('a draft carrying a correlation id cannot take SARS\'s verdict once the period has a return version', async () => {
    const v = versionOf(await fin(P3));
    const d = await draft(P3, 'CORR-LATE'); // a persisted id arrives for a period that is now the lifecycle's
    await expect(inTx(a.fx, () => applyPollResult(a.fx.companyId, d, { submissionStatus: 'accepted', efilingStatus: 'accepted', sarsReference: 'R' })))
      .rejects.toThrow(/return lifecycle/);
    expect(((await sql`SELECT status FROM sars_submissions WHERE id = ${d}::UUID`) as Row[])[0]!.status).toBe('draft');
    expect(v.status).toBe('finalised');
  });
});

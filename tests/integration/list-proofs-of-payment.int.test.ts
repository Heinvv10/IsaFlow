/**
 * listProofsOfPayment (MCP list_proofs_of_payment) on real PostgreSQL, run as the MCP transport runs it: app_user,
 * request.jwt.claims and app.current_company_id set (bearerPipeline), the statements on one ALS-bound connection.
 * Pins: company B's POPs are invisible (the service's own company filter, and RLS under app_user); each 991/992
 * outcome and "no row = pending" reach the reply; a POP a person linked to a line by hand is attached_manually (only on
 * a line of its own company that is not removed), never unmatched; every filter; the beneficiary search is literal; the summary
 * counts the whole filter, not the page; a walk serves every POP once.
 *
 * Fixture route: isaflow_test (assertNotProductionDb).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { seedLine, seedPop, setUpPopFixture, tearDownPopFixture, type PopFixture } from './helpers/popSweepFixture';
import { listProofsOfPayment, type PopListFilters, type PopListPage } from '@/modules/accounting/services/capture/pop/popListService';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url, max: 3 });
const [A, B, C, D] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const SAME_DATE_COUNT = 23;
let fx: PopFixture;
const ids: Record<string, string> = {};
const lines: Record<string, string> = {};

/** As app_user in `company`'s tenant context (what the MCP bearer pipeline sets), rolled back. */
async function asTenant(company: string, f: PopListFilters & { limit?: number; offset?: number } = {}): Promise<PopListPage> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.member })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    return await als.run({ client, userId: fx.member, claims: {} },
      () => listProofsOfPayment(company, { limit: 50, offset: 0, ...f }));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
const popIds = (p: PopListPage) => p.rows.map((r) => r.popId).sort();
const q = (text: string, params: unknown[]) => pool.query(text, params);

describeIfDb('list_proofs_of_payment: each POP and what became of it', () => {
  beforeAll(async () => {
    assertNotProductionDb('list-proofs-of-payment inserts companies, bank lines and proofs of payment');
    fx = await setUpPopFixture(pool, [A, B, C, D]);
    const lineDay = fx.day(10);
    for (const k of ['l1', 'l2', 'l3']) lines[k] = await seedLine(fx, A, lineDay, '-3000.00', `ABSA BANK LINE ${k}`);
    const pop = async (key: string, beneficiary: string, date: string, company = A) => {
      ids[key] = (await seedPop(fx, company, { beneficiary, date })).popId;
    };
    await pop('attached', 'Tintswalo G Mabehla', fx.day(10));
    await pop('ambiguous', 'Amoepong Bed and Bre', fx.day(9));
    await pop('notFound', 'Window Test Pty', fx.day(8));
    await pop('refused', 'Refused Payee', fx.day(7));
    await pop('pending', '100% Cotton_Ltd', fx.day(6));
    await pop('pending2', '100X CottonALtd', fx.day(6));
    await pop('other', 'Tintswalo G Mabehla', fx.day(10), B);
    const match = (key: string, outcome: string, cands: string[], refusal: string | null = null, company = A) => q(
      'INSERT INTO proof_of_payment_matches (company_id, proof_of_payment_id, outcome, candidate_bank_tx_ids, refusal) VALUES ($1, $2, $3, $4, $5)',
      [company, ids[key], outcome, cands, refusal]);
    await match('attached', 'attached', [lines.l1!]);
    await match('ambiguous', 'ambiguous', [lines.l2!, lines.l3!]);
    await match('notFound', 'not_found', []);
    await match('refused', 'refused', [lines.l2!], 'already_matched');
    await match('other', 'attached', [lines.l1!], null, B);
    const copy = (key: string, outcome: string, item: string | null, web: string | null, path: string | null, company = A) => q(
      'INSERT INTO pop_archive_copies (company_id, proof_of_payment_id, outcome, drive_item_id, web_url, path) VALUES ($1, $2, $3, $4, $5, $6)',
      [company, ids[key], outcome, item, web, path]);
    await copy('attached', 'archived', 'item-1', 'https://example.sharepoint.com/pop1.pdf', 'POP/2026/11/pop1.pdf');
    await copy('ambiguous', 'too_large', null, null, 'POP/2026/11/pop2.pdf');
    await copy('notFound', 'failed', null, null, null);
    await copy('other', 'archived', 'item-b', 'https://example.sharepoint.com/b.pdf', 'POP/b.pdf', B);
    const attempt = (key: string, attempts: number, tries: number, err: string) => q(
      'INSERT INTO pop_archive_attempts (company_id, proof_of_payment_id, attempts, tries, last_error) VALUES ($1, $2, $3, $4, $5)',
      [A, ids[key], attempts, tries, err]);
    await attempt('notFound', 10, 12, 'graph 400: invalid name');
    await attempt('refused', 1, 3, 'graph 503');
    await q("INSERT INTO pop_archive_targets (company_id, site_id, folder_path) VALUES ($1, 'site-a', 'POP')", [A]);
    // C: a payment run, many POPs on one date (an ORDER BY on the date alone would skip or repeat some between pages).
    await seedPop(fx, C, { beneficiary: 'Earlier Payee', date: fx.day(3) });
    for (let i = 0; i < SAME_DATE_COUNT; i++) await seedPop(fx, C, { beneficiary: `Run Payee ${i}`, date: fx.day(2) });
  });

  afterAll(async () => {
    try { await tearDownPopFixture(fx); } finally { await pool.end(); }
  });

  it('shows only the caller\'s company: company B\'s POP is invisible, by the service\'s filter and under RLS', async () => {
    const mine = Object.entries(ids).filter(([k]) => k !== 'other').map(([, v]) => v).sort();
    // As the pool's owner (RLS does not apply): the service's own company filter is all that separates them.
    const direct = await listProofsOfPayment(A, { limit: 50, offset: 0 });
    expect(popIds(direct)).toEqual(mine);
    expect(direct.total).toBe(6);
    // As app_user in A's context, as MCP runs it: the grants admit the read and RLS agrees.
    const tenant = await asTenant(A);
    expect(popIds(tenant)).toEqual(mine);
    // B sees only its own; A's id never leaks into B's page or counts.
    const b = await asTenant(B);
    expect(popIds(b)).toEqual([ids.other]);
    expect(b.summary.byMatch.attached).toBe(1);
    expect(b.archiveConfigured).toBe(false);
  });

  it('maps each outcome, and no row to pending', async () => {
    const byId = new Map((await asTenant(A)).rows.map((r) => [r.popId, r]));
    expect(byId.get(ids.attached!)!.match).toMatchObject({ status: 'attached', bankTransactionId: lines.l1, candidateBankTransactionIds: [] });
    expect(byId.get(ids.attached!)!.archive).toMatchObject({
      status: 'archived', webUrl: 'https://example.sharepoint.com/pop1.pdf', path: 'POP/2026/11/pop1.pdf', attempts: null, lastError: null,
    });
    expect(byId.get(ids.ambiguous!)!.match).toMatchObject({ status: 'ambiguous', bankTransactionId: null });
    expect(byId.get(ids.ambiguous!)!.match.candidateBankTransactionIds.sort()).toEqual([lines.l2, lines.l3].sort());
    expect(byId.get(ids.ambiguous!)!.archive.status).toBe('too_large');
    expect(byId.get(ids.notFound!)!.match.status).toBe('not_found');
    expect(byId.get(ids.notFound!)!.archive).toMatchObject({ status: 'failed', attempts: 10, tries: 12, lastError: 'graph 400: invalid name' });
    expect(byId.get(ids.refused!)!.match).toMatchObject({ status: 'refused', refusal: 'already_matched', candidateBankTransactionIds: [lines.l2] });
    expect(byId.get(ids.refused!)!.archive).toMatchObject({ status: 'pending', attempts: 1, tries: 3, lastError: 'graph 503' });
    expect(byId.get(ids.pending!)!.match).toMatchObject({ status: 'pending', checkedAt: null, candidateBankTransactionIds: [] });
    expect(byId.get(ids.pending!)!.archive).toMatchObject({ status: 'pending', webUrl: null, attempts: null });
    expect(byId.get(ids.pending!)).toMatchObject({ amount: 3000, payerProfile: 'EXAMPLE TRADING PTY LTD', paymentDate: fx.day(6) });
  });

  it('filters by match status, unmatched, archive status and payment date', async () => {
    expect(popIds(await asTenant(A, { matchStatus: 'pending' }))).toEqual([ids.pending, ids.pending2].sort());
    expect(popIds(await asTenant(A, { matchStatus: 'refused' }))).toEqual([ids.refused]);
    expect(popIds(await asTenant(A, { matchStatus: 'unmatched' })))
      .toEqual([ids.ambiguous, ids.notFound, ids.refused, ids.pending, ids.pending2].sort());
    expect(popIds(await asTenant(A, { archiveStatus: 'pending' }))).toEqual([ids.refused, ids.pending, ids.pending2].sort());
    expect(popIds(await asTenant(A, { archiveStatus: 'failed' }))).toEqual([ids.notFound]);
    expect(popIds(await asTenant(A, { dateFrom: fx.day(9), dateTo: fx.day(7) })))
      .toEqual([ids.ambiguous, ids.notFound, ids.refused].sort());
    expect(popIds(await asTenant(A, { dateFrom: fx.day(6) }))).toEqual([ids.pending, ids.pending2].sort());
  });

  it('matches the beneficiary as a literal, case-insensitive substring: % and _ are not wildcards', async () => {
    expect(popIds(await asTenant(A, { beneficiary: 'mabehla' }))).toEqual([ids.attached]);
    expect(popIds(await asTenant(A, { beneficiary: '100%' }))).toEqual([ids.pending]);
    expect(popIds(await asTenant(A, { beneficiary: 'cotton_ltd' }))).toEqual([ids.pending]);
    expect(popIds(await asTenant(A, { beneficiary: '%' }))).toEqual([ids.pending]);
  });

  it('counts the summary over the whole filter, not the page', async () => {
    const page = await asTenant(A, { limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(6);
    expect(page.archiveConfigured).toBe(true);
    expect(page.summary).toEqual({
      byMatch: { attached: 1, attached_manually: 0, ambiguous: 1, not_found: 1, refused: 1, pending: 2 },
      byArchive: { archived: 1, too_large: 1, failed: 1, pending: 3 },
    });
    const filtered = await asTenant(A, { matchStatus: 'unmatched', limit: 1 });
    expect(filtered.total).toBe(5);
    expect(filtered.summary.byMatch).toEqual({ attached: 0, attached_manually: 0, ambiguous: 1, not_found: 1, refused: 1, pending: 2 });
  });

  it('reads a POP linked to a bank line by hand as attached_manually, whatever the matcher decided, never unmatched', async () => {
    const day = fx.day(12);
    const line = (n: number) => seedLine(fx, D, day, '-3000.00', `ABSA BANK HAND ${n}`);
    const [l1, l2, l3, l4, l5, l6] = [await line(1), await line(2), await line(3), await line(4), await line(5), await line(6)];
    const removed = await seedLine(fx, D, day, '-3000.00', 'ABSA BANK HAND REMOVED', { feedState: 'removed' });
    const bLine = await seedLine(fx, B, day, '-3000.00', 'ABSA BANK OTHER COMPANY');
    const pop = async (name: string, matchedTo: string) => (await seedPop(fx, D, { beneficiary: name, date: day, matchedTo })).popId;
    const decide = (popId: string, outcome: string, cands: string[], refusal: string | null = null) => q(
      'INSERT INTO proof_of_payment_matches (company_id, proof_of_payment_id, outcome, candidate_bank_tx_ids, refusal) VALUES ($1, $2, $3, $4, $5)',
      [D, popId, outcome, cands, refusal]);
    const noRow = await pop('Hand No Row', l1);
    const notFound = await pop('Hand Not Found', l2);
    await decide(notFound, 'not_found', []);
    const ambiguous = await pop('Hand Ambiguous', l3);
    await decide(ambiguous, 'ambiguous', [l3, l4]);
    const refused = await pop('Hand Refused', l5);
    await decide(refused, 'refused', [l5], 'document_backs_other_claim');
    const byMatcher = await pop('Matcher Attached', l6);
    await decide(byMatcher, 'attached', [l6]);
    const onRemoved = await pop('Hand Removed Line', removed);
    const forged = await pop('Hand Other Company', bLine);

    const page = await asTenant(D);
    const byId = new Map(page.rows.map((r) => [r.popId, r.match]));
    for (const [id, l] of [[noRow, l1], [notFound, l2], [ambiguous, l3], [refused, l5]] as const) {
      expect(byId.get(id)).toMatchObject({ status: 'attached_manually', bankTransactionId: l, candidateBankTransactionIds: [] });
    }
    expect(byId.get(byMatcher)).toMatchObject({ status: 'attached', bankTransactionId: l6 });
    // A link to a removed line, or to another company's line, puts the POP on no line of this company.
    expect(byId.get(onRemoved)).toMatchObject({ status: 'pending', bankTransactionId: null });
    expect(byId.get(forged)).toMatchObject({ status: 'pending', bankTransactionId: null });
    expect(page.summary.byMatch).toEqual({ attached: 1, attached_manually: 4, ambiguous: 0, not_found: 0, refused: 0, pending: 2 });

    expect(popIds(await asTenant(D, { matchStatus: 'attached_manually' }))).toEqual([noRow, notFound, ambiguous, refused].sort());
    expect(popIds(await asTenant(D, { matchStatus: 'unmatched' }))).toEqual([onRemoved, forged].sort());
    expect(popIds(await asTenant(D, { matchStatus: 'ambiguous' }))).toEqual([]);
  });

  it('walks every POP exactly once, newest payment first, although many share a date', async () => {
    const seen: string[] = [];
    const dates: string[] = [];
    for (let offset = 0; ; offset += 4) {
      const page = await asTenant(C, { limit: 4, offset });
      seen.push(...page.rows.map((r) => r.popId));
      dates.push(...page.rows.map((r) => r.paymentDate));
      if (offset + 4 >= page.total) break;
    }
    expect(seen).toHaveLength(SAME_DATE_COUNT + 1);
    expect(new Set(seen).size).toBe(SAME_DATE_COUNT + 1);
    expect([...dates].sort().reverse()).toEqual(dates);
    // The tiebreak itself: within a date, id descending (uuid order is its lower-case hex order).
    const keyed = seen.map((id, i) => `${dates[i]} ${id}`);
    expect([...keyed].sort().reverse()).toEqual(keyed);
  });
});

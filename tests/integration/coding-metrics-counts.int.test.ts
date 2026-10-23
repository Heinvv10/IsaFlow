/**
 * loadCodingCounts against a real schema: what the headline counts as coded and as "no click", that an
 * undone run and a hand-corrected line do not count as auto-coded, the decision-log rates, and the
 * first-30-days window from the earlier of the first import batch and the first bank line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { pool, seedCompany, seedLine, seedUser, teardownCompanies, type Co } from './learning-loop.helpers';
import { loadCodingCounts } from '../../src/modules/accounting/services/bank/codingMetricsService';
import { computeCodingMetrics } from '../../src/modules/accounting/services/bank/codingMetrics';

assertDisposable();

const OCT = { month: '2026-10', from: '2026-10-01', to: '2026-11-01' };
let C: Co;
let F: Co; // no import batch: the window falls back to its first line
let E: Co; // nothing at all
let G: Co; // feed lines from August, then one CSV upload in October: the window keeps August
let user = '';

/** A person's decision unless `auto` (ISAFlow posted it) or `byIsaflow` (ISAFlow superseded its own suggestion). */
async function decision(co: Co, txId: string, over: {
  outcome: string; auto?: boolean; byIsaflow?: boolean; at: string; createdAt?: string;
}) {
  const person = !over.auto && !over.byIsaflow && over.outcome !== 'pending';
  await pool.query(
    `INSERT INTO categorization_decisions (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id,
       was_auto_posted, auto_posted_at, posted_journal_entry_id, outcome, decided_at, decided_by, created_at, suggested_at)
     VALUES ($1, $2, 'pattern', $3, $4, CASE WHEN $4 THEN $5::TIMESTAMPTZ END, CASE WHEN $4 THEN gen_random_uuid() END, $6,
             CASE WHEN $6 = 'pending' THEN NULL ELSE $5::TIMESTAMPTZ END, $8, COALESCE($7::TIMESTAMPTZ, $5::TIMESTAMPTZ), $5::TIMESTAMPTZ)`,
    [co.id, txId, co.expense, over.auto ?? false, over.at, over.outcome, over.createdAt ?? null, person ? user : null]);
}

beforeAll(async () => {
  C = await seedCompany('metrics C');
  F = await seedCompany('metrics F');
  E = await seedCompany('metrics E');
  G = await seedCompany('metrics G');
  user = await seedUser([C.id]);
  const run = (await pool.query<{ id: string }>(
    `INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap) VALUES ($1, 'categorization', 0.9, 0) RETURNING id`,
    [C.id])).rows[0]!.id;

  // October lines for C.
  await seedLine(C, { status: 'allocated', ruleId: crypto.randomUUID() }); // rule auto-post: auto
  await seedLine(C, { status: 'allocated', runId: run });                  // gate sweep: auto
  await seedLine(C, { status: 'provisional', runId: run });                // import-path provisional: auto
  await seedLine(C, { status: 'allocated' });                              // a person: coded, not auto
  await seedLine(C, { status: 'allocated' });                              // hand-corrected: run tag cleared, still allocated
  await seedLine(C, { status: 'imported' });                               // undone run: back to imported, no tags
  await seedLine(C, { status: 'excluded' });                               // not coded
  await seedLine(C, { status: 'allocated', runId: run, date: '2026-09-30' }); // outside the period

  // First import 2026-10-05 08:00 SAST; decisions on lines, first decision per line counted in the window.
  await pool.query(
    `INSERT INTO bank_import_batches (company_id, bank_account_id, statement_date, created_at)
     VALUES ($1, $2, '2026-10-05', '2026-10-05T06:00:00Z'), ($1, $2, '2026-10-20', '2026-10-20T06:00:00Z')`, [C.id, C.bank]);
  const d1 = await seedLine(C);
  const d2 = await seedLine(C);
  const d3 = await seedLine(C);
  const d4 = await seedLine(C);
  const d5 = await seedLine(C);
  const d6 = await seedLine(C);
  await decision(C, d1, { outcome: 'accepted', at: '2026-10-06T10:00:00Z' });            // person, accepted, in window
  await decision(C, d2, { outcome: 'recoded', at: '2026-10-07T10:00:00Z' });             // person, recoded, in window
  await decision(C, d3, { outcome: 'rejected', at: '2026-10-08T10:00:00Z' });            // person, rejected
  await decision(C, d4, { outcome: 'accepted', auto: true, at: '2026-10-09T10:00:00Z' }); // auto-posted, stands
  await decision(C, d5, { outcome: 'undone', auto: true, at: '2026-10-10T10:00:00Z' });   // auto-posted, undone
  // ISAFlow posted a different target over its own suggestion (decided_by NULL): not a person's decision.
  await decision(C, d6, { outcome: 'recoded', byIsaflow: true, at: '2026-10-11T10:00:00Z', createdAt: '2026-11-15T00:00:00Z' });
  await decision(C, d1, { outcome: 'accepted', at: '2026-10-31T23:30:00Z' });            // 1 Nov SAST: next month; d1's 2nd decision
  await decision(C, d2, { outcome: 'pending', at: '2026-11-20T10:00:00Z' });             // after the window

  // F: lines but no batch rows -> window from its first line (2026-08-01).
  const f1 = await seedLine(F, { createdAt: '2026-08-01T00:00:00Z' });
  const f2 = await seedLine(F, { createdAt: '2026-08-02T00:00:00Z' });
  await decision(F, f1, { outcome: 'accepted', at: '2026-08-05T00:00:00Z' });
  await decision(F, f2, { outcome: 'recoded', at: '2026-09-15T00:00:00Z' }); // outside F's window

  const g1 = await seedLine(G, { createdAt: '2026-08-01T00:00:00Z' });
  await pool.query(
    `INSERT INTO bank_import_batches (company_id, bank_account_id, statement_date, created_at)
     VALUES ($1, $2, '2026-10-01', '2026-10-01T06:00:00Z')`, [G.id, G.bank]);
  await decision(G, g1, { outcome: 'accepted', at: '2026-08-05T00:00:00Z' });
});

afterAll(async () => {
  try {
    await teardownCompanies([C.id, F.id, E.id, G.id], [user]);
  } finally {
    await pool.end();
  }
});

describe('loadCodingCounts', () => {
  it('headline: coded = provisional/allocated/matched/reconciled in the month; auto = run or rule tag', async () => {
    const [c] = await loadCodingCounts([C.id], OCT);
    // 5 coded October lines (3 auto + the person's + the hand-corrected); the undone, excluded and September
    // lines are not counted. The decision-fixture lines d1..d5 are 'imported' and not coded.
    expect(c).toMatchObject({ linesCoded: 5, linesAutoCoded: 3 });
    expect(computeCodingMetrics(c!).autoCoded.pct).toBe(60);
  });

  it('decision-log counts: human decisions by decided_at (SA month), auto-posts by auto_posted_at', async () => {
    const [c] = await loadCodingCounts([C.id], OCT);
    // d1 accepted, d2 recoded, d3 rejected in October; d1's 1 Nov SAST decision is November's; d6 was
    // superseded by ISAFlow, not decided by a person.
    expect(c).toMatchObject({ suggestionsDecided: 3, suggestionsAccepted: 1, autoPosted: 2, autoPostedReversed: 1 });
  });

  it('first 30 days start at the first import batch; each line\'s FIRST decision in the window counts', async () => {
    const [c] = await loadCodingCounts([C.id], OCT);
    expect(c!.firstBatchAt).toBe('2026-10-05T06:00:00.000Z');
    // C's lines were created with (after) its imports, so the import starts the window.
    expect(new Date(c!.firstLineAt!) > new Date(c!.firstBatchAt!)).toBe(true);
    expect(computeCodingMetrics(c!).firstThirtyDays.windowSource).toBe('import_batch');
    // d1 accepted, d2 recoded, d3 rejected, d4 auto accepted, d5 undone -> 5 decided, 2 accepted.
    expect(c).toMatchObject({ firstWindowDecided: 5, firstWindowAccepted: 2 });
  });

  it('no batch rows: the window starts at the first bank line', async () => {
    const [f] = await loadCodingCounts([F.id], OCT);
    expect(f!.firstBatchAt).toBeNull();
    expect(f!.firstLineAt).toBe('2026-08-01T00:00:00.000Z');
    expect(f).toMatchObject({ firstWindowDecided: 1, firstWindowAccepted: 1 });
    expect(computeCodingMetrics(f!).firstThirtyDays.windowSource).toBe('bank_transaction');
  });

  it('feed lines before the first CSV: the window starts at the first line, not the later upload', async () => {
    const [g] = await loadCodingCounts([G.id], OCT);
    expect(g).toMatchObject({ firstBatchAt: '2026-10-01T06:00:00.000Z', firstLineAt: '2026-08-01T00:00:00.000Z' });
    expect(g).toMatchObject({ firstWindowDecided: 1, firstWindowAccepted: 1 });
    expect(computeCodingMetrics(g!).firstThirtyDays).toMatchObject({
      windowSource: 'bank_transaction', windowStart: '2026-08-01T00:00:00.000Z',
    });
  });

  it('a company with nothing: zeros and no window', async () => {
    const [e] = await loadCodingCounts([E.id], OCT);
    expect(e).toMatchObject({ linesCoded: 0, linesAutoCoded: 0, suggestionsDecided: 0, firstBatchAt: null, firstLineAt: null, decisionLogSince: null });
  });

  it('reads only the companies it is given', async () => {
    const rows = await loadCodingCounts([E.id], OCT);
    expect(rows.map((r) => r.companyId)).toEqual([E.id]);
  });
});

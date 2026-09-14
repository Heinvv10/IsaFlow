/**
 * The `feed_state='posted'` half of the transfer-candidate fence, which had no test.
 *
 * `readBankTransferCandidates` selects opposite legs with `status='imported' AND
 * feed_state='posted'`. A bank-feed row that has not cleared carries feed_state='pending' and
 * status='imported' — the status predicate alone admits it. The consequence is not merely a
 * stray suggestion: the query takes `LIMIT 101` and the caller REFUSES the whole allocation when
 * more than 100 come back, so uncleared rows can crowd out the real counter-leg and turn a valid
 * transfer into "Transfer candidate population exceeds bound".
 *
 * Each case pairs a refused state with an otherwise identical accepted row, so deleting the
 * predicate fails the test rather than silently widening the population.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { transferFixture } from './bankTransferSourcesFixture';
import { readBankTransferCandidates } from '@/modules/accounting/services/bank/bankAllocationTransferSources';

const enabled = process.env.ISAFLOW_FORENSIC_FIXTURE_OPT_IN === '1';

describe.skipIf(!enabled)('transfer candidates and the bank feed state', () => {
  let fx: Awaited<ReturnType<typeof transferFixture>>;
  let source = '';
  let connection = '';

  /**
   * An opposite leg that matches on every axis the query filters except feed_state.
   * `bank_tx_feed_identity_required` (migration 675) forces anything not 'posted' to name the
   * connection and provider id it came from, so a pending row is seeded with both — which is
   * also what a real uncleared feed row looks like.
   */
  async function opposite(feedState: 'pending' | 'posted' | 'removed'): Promise<string> {
    const id = randomUUID();
    await fx.pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,
         status,feed_state,bank_feed_connection_id,provider_transaction_id)
       VALUES($1,$2,$3,'2026-09-09','115.23','Synthetic opposite leg','imported',$4,$5,$6)`,
      [id, fx.f.companyA, fx.to, feedState, feedState === 'posted' ? null : connection,
        feedState === 'posted' ? null : id]);
    return id;
  }

  async function candidateIds(): Promise<string[]> {
    return fx.actor(async ctx => {
      const result = await readBankTransferCandidates(ctx,
        { bankTransactionId: source, counterpartyAccountId: fx.to }, { authority: 'read' });
      return result.oppositeCandidates.map(r => String(r.id));
    });
  }

  beforeAll(async () => {
    fx = await transferFixture();
    source = await fx.bank();  // -115.23 on `from`, 2026-09-09
    const { rows } = await fx.pool.query<{ id: string }>(
      `INSERT INTO bank_feed_connections(company_id,bank_account_id,provider,external_account_id)
       VALUES($1,$2,'stitch',$3) RETURNING id`,
      [fx.f.companyA, fx.to, `synthetic-${randomUUID()}`]);
    connection = rows[0]!.id;
  });
  afterAll(async () => { if (fx) await fx.close(); });

  it('offers a posted opposite leg', async () => {
    const posted = await opposite('posted');
    expect(await candidateIds()).toContain(posted);
  });

  it('does not offer one the bank has not cleared, though its status is imported', async () => {
    const pending = await opposite('pending');
    // The status predicate alone would admit this row: prove it really is 'imported'.
    const { rows } = await fx.pool.query<{ status: string; feed_state: string }>(
      'SELECT status,feed_state FROM bank_transactions WHERE company_id=$1 AND id=$2',
      [fx.f.companyA, pending]);
    expect(rows[0]).toEqual({ status: 'imported', feed_state: 'pending' });

    const ids = await candidateIds();
    expect(ids).not.toContain(pending);
    // ...and the fence is the feed state, not an empty population.
    expect(ids.length).toBeGreaterThan(0);
  });

  it('does not offer one the bank has withdrawn', async () => {
    const removed = await opposite('removed');
    expect(await candidateIds()).not.toContain(removed);
  });

  it('keeps uncleared rows out of the 100-candidate bound they would otherwise exhaust', async () => {
    // 101 pending legs is past the LIMIT 101 the caller measures. If they counted, this call
    // would throw 'Transfer candidate population exceeds bound' and no allocation could proceed.
    const pending = await Promise.all(Array.from({ length: 101 }, () => opposite('pending')));
    expect(new Set(pending).size).toBe(101);
    const ids = await candidateIds();
    expect(ids.some(id => pending.includes(id))).toBe(false);
  });
});

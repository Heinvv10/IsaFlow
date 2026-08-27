/**
 * PRD-11 §3 — the keyset fragment against the REAL query builder.
 *
 * Every other cursor test mocks `@/lib/neon`, where `sql.unsafe` is `s => s`
 * and simply drops the second argument. That mock cannot fail the thing most
 * likely to break: `buildQuery` splices a fragment's `$N` placeholders into the
 * surrounding query and RENUMBERS them by the parameter count so far. Get that
 * offset wrong and the query still runs — with the cursor's date bound to the
 * company_id slot, silently reading the wrong tenant's page or erroring at
 * runtime. So this file mocks nothing: it builds a real LazyQuery (never
 * awaited, so no connection is opened) and reads its text and values.
 */
import { describe, it, expect } from 'vitest';
import { sql } from '@/lib/neon';
import { bankTxKeysetCond } from '@/modules/accounting/services/bank/bankTxCursor';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const CURSOR = { d: '2026-03-05', a: -250.5, id: 'cccccccc-0000-0000-0000-cccccccccccc' };

describe('bankTxKeysetCond — placeholder renumbering through the real buildQuery', () => {
  it('DESC: renumbers the fragment after the preceding params and aligns values', () => {
    const q = sql`SELECT 1 FROM bank_transactions bt
      WHERE bt.company_id = ${COMPANY_ID}::UUID
        AND bt.status = ${'imported'}
        ${bankTxKeysetCond(CURSOR, 'DESC')}
      LIMIT ${25}::INT + 1`;

    // Two params precede the fragment, so its $1..$3 must land on $3..$5.
    expect(q.text).toContain('bt.company_id = $1::UUID');
    expect(q.text).toContain('bt.status = $2');
    expect(q.text).toContain('(bt.transaction_date, bt.amount, bt.id) < ($3::DATE, $4::NUMERIC, $5::UUID)');
    expect(q.text).toContain('LIMIT $6::INT + 1');
    // Positional alignment is the whole point: value N feeds $N.
    expect(q.values).toEqual([COMPANY_ID, 'imported', CURSOR.d, CURSOR.a, CURSOR.id, 25]);
  });

  it('ASC: renumbers a placeholder REUSED inside the fragment to the same slot', () => {
    // The ASC form mentions $1 twice ($1 > date, $1 = date). Both must move to
    // the same new number, and the fragment must still contribute exactly three
    // values — a naive "one placeholder, one value" splice would misalign here.
    const q = sql`SELECT 1 FROM bank_transactions bt
      WHERE bt.company_id = ${COMPANY_ID}::UUID
        ${bankTxKeysetCond(CURSOR, 'ASC')}`;

    expect(q.text).toContain('bt.transaction_date > $2::DATE');
    expect(q.text).toContain('bt.transaction_date = $2::DATE');
    expect(q.text).toContain('(bt.amount, bt.id) < ($3::NUMERIC, $4::UUID)');
    expect(q.text).not.toContain('$5');
    expect(q.values).toEqual([COMPANY_ID, CURSOR.d, CURSOR.a, CURSOR.id]);
  });

  it('contributes no text and no values when there is no cursor', () => {
    const q = sql`SELECT 1 WHERE bt.company_id = ${COMPANY_ID}::UUID ${bankTxKeysetCond(undefined, 'DESC')} AND bt.status = ${'imported'}`;
    expect(q.text).toContain('bt.company_id = $1::UUID');
    expect(q.text).toContain('bt.status = $2');
    expect(q.values).toEqual([COMPANY_ID, 'imported']);
  });

  it('never inlines a cursor value into the SQL text', () => {
    const q = sql`SELECT 1 ${bankTxKeysetCond(CURSOR, 'DESC')}`;
    expect(q.text).not.toContain(CURSOR.d);
    expect(q.text).not.toContain(CURSOR.id);
    expect(q.text).not.toContain('250.5');
  });
});

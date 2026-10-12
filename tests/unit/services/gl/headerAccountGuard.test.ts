/**
 * assertNoHeaderAccountLines (gl/headerAccountGuard) against a stub `q`, no database: what it asks, in what
 * order, and how it names the line it refuses. Which ACCOUNTS are headers is the integration suites' question
 * (tests/integration/header-account-guard*.int.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { assertNoHeaderAccountLines, HeaderAccountRefusal } from '@/modules/accounting/services/gl/headerAccountGuard';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Rows = unknown[];

/** A stub tagged-template `q` answering each call from `answers` in order, recording the values it was given. */
function stub(...answers: Rows[]) {
  const calls: unknown[][] = [];
  const q = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return answers[calls.length - 1] ?? [];
  });
  return { q, calls };
}

const header = (id: string, code: string, name: string) => ({ id, account_code: code, account_name: name });
const line = (glAccountId: string) => ({ glAccountId });

describe('assertNoHeaderAccountLines: when it asks nothing', () => {
  it('no lines', async () => {
    const { q } = stub();
    await assertNoHeaderAccountLines(COMPANY, [], { q });
    expect(q).not.toHaveBeenCalled();
  });

  it('only malformed ids (left to the writer, a cast would abort the transaction)', async () => {
    const { q } = stub();
    await assertNoHeaderAccountLines(COMPANY, [line('not-a-uuid'), line(''), line(undefined as unknown as string)], { q });
    expect(q).not.toHaveBeenCalled();
  });

  it('every id exempt', async () => {
    const { q } = stub();
    await assertNoHeaderAccountLines(COMPANY, [line(A), line(B)], { q, contraAccountIds: [A, B] });
    expect(q).not.toHaveBeenCalled();
  });
});

describe('assertNoHeaderAccountLines: what it asks', () => {
  it('skips malformed ids but judges the well-formed ones: de-duplicated, ascending', async () => {
    const { q, calls } = stub([]);
    await assertNoHeaderAccountLines(COMPANY, [line(B), line('junk'), line(A), line(B)], { q });
    expect(calls[0]).toContainEqual([A, B]);
  });

  it('lower-cases ids: an upper-case line id is judged under its lower-case form', async () => {
    const { q, calls } = stub([]);
    await assertNoHeaderAccountLines(COMPANY, [line(A.toUpperCase())], { q });
    expect(calls[0]).toContainEqual([A]);
  });

  it('an upper-case exemption exempts the lower-case line id (and the reverse)', async () => {
    const one = stub();
    await assertNoHeaderAccountLines(COMPANY, [line(A)], { q: one.q, contraAccountIds: [A.toUpperCase()] });
    expect(one.q).not.toHaveBeenCalled();
    const two = stub();
    await assertNoHeaderAccountLines(COMPANY, [line(A.toUpperCase())], { q: two.q, contraAccountIds: [A] });
    expect(two.q).not.toHaveBeenCalled();
  });

  it('the exemption is per account: only the exempt id is left out of the question', async () => {
    const { q, calls } = stub([]);
    await assertNoHeaderAccountLines(COMPANY, [line(A), line(B), line(C)], { q, contraAccountIds: [B] });
    expect(calls[0]).toContainEqual([A, C]);
  });

  it('does not run the children query when the first returns no subject rows', async () => {
    const { q } = stub([]);
    await assertNoHeaderAccountLines(COMPANY, [line(A)], { q });
    expect(q).toHaveBeenCalledTimes(1);
  });

  it('asks about children only for the subject accounts, in a second statement', async () => {
    const { q, calls } = stub([{ id: B }], []);
    await assertNoHeaderAccountLines(COMPANY, [line(A), line(B)], { q });
    expect(q).toHaveBeenCalledTimes(2);
    expect(calls[1]).toContainEqual([B]);
  });

  it('passes when the subject accounts have no children', async () => {
    const { q } = stub([{ id: A }], []);
    await expect(assertNoHeaderAccountLines(COMPANY, [line(A)], { q })).resolves.toBeUndefined();
  });
});

describe('assertNoHeaderAccountLines: the refusal', () => {
  const refusalOf = async (run: Promise<void>): Promise<HeaderAccountRefusal> => {
    const err = await run.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HeaderAccountRefusal);
    return err as HeaderAccountRefusal;
  };

  it('names the line (1-based in the message, 0-based lineIndex), its code and name', async () => {
    const { q } = stub([{ id: B }], [header(B, '1200', 'Prepayments')]);
    const err = await refusalOf(assertNoHeaderAccountLines(COMPANY, [line(A), line(B)], { q }));
    expect(err.lineIndex).toBe(1);
    expect(err.code).toBe('HEADER_ACCOUNT_REFUSED');
    expect(err.message).toMatch(/^Line 2: 1200 Prepayments is a header with sub-accounts; post to one of them\./);
  });

  it('names the FIRST offending line when several are headers', async () => {
    const { q } = stub([{ id: A }, { id: B }], [header(B, '2000', 'Loans'), header(A, '1200', 'Prepayments')]);
    const err = await refusalOf(assertNoHeaderAccountLines(COMPANY, [line(C), line(B), line(A)], { q }));
    expect(err.lineIndex).toBe(1);
    expect(err.message).toContain('Line 2: 2000 Loans');
  });

  it('matches case-blind: an upper-case line id finds its lower-case row', async () => {
    const { q } = stub([{ id: A }], [header(A, '1200', 'Prepayments')]);
    const err = await refusalOf(assertNoHeaderAccountLines(COMPANY, [line(A.toUpperCase())], { q }));
    expect(err.lineIndex).toBe(0);
  });
});

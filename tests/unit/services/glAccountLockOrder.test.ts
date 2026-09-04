/**
 * `lockGlAccountsForUpdate` issues its locks in ascending id order, whatever
 * order it was asked in.
 *
 * This is the half of the ordering that IS testable without a race. The other
 * half — that ordered acquisition is what turns two opposite merges into a wait
 * rather than a deadlock — rests on `LockRows` being the topmost node in the
 * plan, which is a property of Postgres rather than of this function
 * (`accountMergeLockDb.test.ts` explains why a test for it can only flake).
 *
 * The template is mocked here on purpose: what is under test is the ORDER the
 * statements are issued in, which is a property of the loop and not of the
 * database. A mocked template proves nothing about whether Postgres accepts the
 * statement — that is `accountMergeLockDb.test.ts`'s job, against a real
 * connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const issued: string[] = [];

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({
  // The helper binds exactly one parameter per statement before the company id;
  // record the account id each SELECT was issued for, in order.
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => {
    issued.push(String(values[0]));
    return Promise.resolve([]);
  },
}));
vi.mock('@/lib/als', () => ({
  als: { getStore: () => ({ client: { query: vi.fn(async () => undefined) } }) },
  assertTxUsable: vi.fn(),
}));

import { lockGlAccountsForUpdate } from '@/modules/accounting/services/gl/glAccountLock';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';

beforeEach(() => { issued.length = 0; });

describe('lockGlAccountsForUpdate ordering', () => {
  it('locks A before B when asked for [B, A]', async () => {
    await lockGlAccountsForUpdate(COMPANY, [B, A]);
    expect(issued).toEqual([A, B]);
  });

  it('is the same order however the caller shuffles it', async () => {
    await lockGlAccountsForUpdate(COMPANY, [C, A, B]);
    const first = [...issued];
    issued.length = 0;
    await lockGlAccountsForUpdate(COMPANY, [B, C, A]);
    expect(issued).toEqual(first);
    expect(issued).toEqual([A, B, C]);
  });

  it('locks a repeated id once', async () => {
    // Two merges naming the same account twice would otherwise take the same
    // row lock twice for no reason, and the count would mislead a reader.
    await lockGlAccountsForUpdate(COMPANY, [B, A, B]);
    expect(issued).toEqual([A, B]);
  });
});

/**
 * W18 (wave 7 AQ): the actor id reaches SQL lower-cased — assertMayDecide's own self/author/membership read, and the
 * three approval_requests writers (migration 1050 lowers it again in raise and decide). Every stored id is lower case
 * (uuid text; GoTrue's ids), so an upper-cased spelling of the requester must still read as the requester.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: vi.fn(async () => 'self') }));

import { sql } from '@/lib/neon';
import { assertMayDecide } from '@/modules/accounting/services/gl/approvalAuthority';
import { decideRequestRow, insertRequestRow, rebindRequestRow } from '@/modules/accounting/services/gl/approvalRequestWrites';

const LOWER = '9a11b350-e32c-4ef2-aa68-93d58f8c9ac4';
const UPPER = LOWER.toUpperCase();

/** Every value interpolated into every sql call so far. */
const bound = () => vi.mocked(sql).mock.calls.flatMap((call) => call.slice(1));

beforeEach(() => { vi.mocked(sql).mockClear(); });

describe('the actor id reaches SQL lower-cased', () => {
  it('assertMayDecide: the self, past-requester and membership comparisons read the lower-cased decider', async () => {
    await assertMayDecide('c', 'r', UPPER, 'approved');
    expect(bound()).toContain(LOWER);
    expect(bound()).not.toContain(UPPER);
  });

  it.each([
    ['decideRequestRow', () => decideRequestRow('c', 'r', 'approved', UPPER, null, 'd')],
    ['insertRequestRow', () => insertRequestRow('c', 'supplier_invoice', 'doc', 'rule', UPPER)],
    ['rebindRequestRow', () => rebindRequestRow('c', 'r', null, UPPER, { type: 'supplier_invoice', id: 'doc' })],
  ])('%s', async (_name, call) => {
    await call();
    expect(bound()).toContain(LOWER);
    expect(bound()).not.toContain(UPPER);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  return { ...actual, sql: vi.fn(async () => [] as unknown[]), withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(vi.fn())) };
});

const { sourcesMock } = vi.hoisted(() => ({ sourcesMock: vi.fn() }));
// `loadBankAllocationSources` is the materialisation the guard reads from; the
// rows it locks (bank account, company, GL accounts, periods) are not this
// file's subject, so it is the boundary. Everything between it and the refusal
// — `prepareBankAllocation`'s own ordering — stays real.
vi.mock('@/modules/accounting/services/bank/bankAllocationSources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/bank/bankAllocationSources')>();
  return { ...actual, loadBankAllocationSources: sourcesMock };
});

import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { enterFakeRequestCtx } from '../helpers/requestCtx';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { prepareBankAllocation } from '@/modules/accounting/services/bank/bankAllocationControl';
import { excludeTransaction, matchTransaction, unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { isBankTransactionNotPosted } from '@/modules/accounting/services/bank/bankFeedStateGuard';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';

const CO = 'aaaaaaaa-0000-4000-8000-00000000000c';
const TX = 'bbbbbbbb-0000-4000-8000-0000000000a1';
const GL = 'cccccccc-0000-4000-8000-000000000001';
const GL2 = 'cccccccc-0000-4000-8000-000000000002';
const PERSON = 'dddddddd-0000-4000-8000-000000000003';
const feedRow = (feed_state: string) => ({
  id: TX, company_id: CO, status: 'imported', amount: '-100', feed_state,
  matched_journal_line_id: null, transaction_date: '2026-08-13',
});
const pendingRow = feedRow('pending');
const removedRow = feedRow('removed');

/**
 * `allocateTransaction` and `splitAllocateTransaction` are now adapters into
 * the controls kernel: both compose a plan and prepare it through
 * `prepareBankAllocation`, which is where the feed-state guard moved to (it
 * reads the materialised sources rather than the adapter's locked row). A
 * one-line and a many-line plan are the two shapes those adapters build, so
 * they are what is pinned here — the refusal must still precede the intent
 * INSERT, which is the first write either path performs.
 */
const PLANS: Array<[string, Record<string, unknown>]> = [
  ['allocate', { version: 1, kind: 'account', bankTransactionId: TX, description: 'x',
    lines: [{ accountId: GL, amount: '100', vatCode: 'none' }] }],
  ['split', { version: 1, kind: 'split', bankTransactionId: TX, description: 'x',
    lines: [{ accountId: GL, amount: '60', vatCode: 'none' }, { accountId: GL2, amount: '40', vatCode: 'none' }] }],
];

/** Prepare `plan` inside a real control request whose sources carry `row`. */
async function prepareWith(row: Record<string, unknown>, plan: Record<string, unknown>): Promise<unknown> {
  sourcesMock.mockResolvedValue({ bank: row, invoices: [], fingerprint: 'fp' });
  const client = { query: async () => ({ rows: [], command: 'SELECT' }) } as unknown as PoolClient;
  let caught: unknown;
  await withControlRequest({ client, userId: PERSON, companyId: CO, claims: {} } as never,
    { personId: PERSON, companyId: CO, authMethod: 'cookie' }, async () => {
      try { await prepareBankAllocation(requireControlTx(), plan); } catch (e) { caught = e; }
    });
  return caught;
}

const MUTATORS: Array<[string, () => Promise<unknown>]> = [
  ['match', () => matchTransaction(CO, TX, 'line-1')],
  ['unmatch', () => unmatchTransaction(CO, TX)],
  ['exclude', () => excludeTransaction(CO, TX, 'r')],
];

/**
 * Every query answers with the feed row, except the two the kernel's permission
 * check reads — an authenticated control request loads the member before any
 * service code runs, and answering that with a bank transaction would refuse on
 * permissions and never reach the guard under test.
 */
function answerWith(row: Record<string, unknown>) {
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    if (text.includes('control_lock_permission_principal')) return [{ role: 'admin', is_active: true, status: 'active' }];
    if (text.includes('company_user_permissions')) return [];
    return [row];
  }) as never);
}

const writes = () => vi.mocked(sql).mock.calls
  // The lock SELECT itself carries a `FOR UPDATE` clause, so the write-keyword
  // check must not trip on that — hence the negative lookbehind on `UPDATE`.
  .map((c) => (c[0] as unknown as string[]).join('?'))
  .filter((t) => /\bINSERT\b|(?<!FOR )\bUPDATE\b/i.test(t));

beforeEach(() => {
  vi.mocked(sql).mockReset();
  sourcesMock.mockReset();
  enterFakeRequestCtx();
});

describe('the controlled allocation refuses a pending or removed feed row before its intent', () => {
  it.each(PLANS)('%s — pending', async (_shape, plan) => {
    answerWith(pendingRow);
    const caught = await prepareWith(pendingRow, plan);
    expect(isBankAllocationRefusal(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/pending at the bank/);
    expect(writes()).toEqual([]);
  });

  it.each(PLANS)('%s — removed', async (_shape, plan) => {
    answerWith(removedRow);
    const caught = await prepareWith(removedRow, plan);
    expect(isBankAllocationRefusal(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/removed by the bank/);
    expect(writes()).toEqual([]);
  });
});

describe('locked mutators refuse a pending feed row before writing', () => {
  beforeEach(() => {
    vi.mocked(sql).mockImplementation(async () => [pendingRow] as unknown[]);
  });

  it.each(MUTATORS)('%s', async (_verb, run) => {
    let caught: unknown;
    try { await run(); } catch (e) { caught = e; }
    expect(isBankTransactionNotPosted(caught) || isBankAllocationRefusal(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/pending at the bank/);
    // Only the lock SELECT ran; no INSERT/UPDATE was issued. (The lock SELECT
    // itself carries a `FOR UPDATE` clause, so the write-keyword check must not
    // trip on that — hence the negative lookbehind on `UPDATE`.)
    const texts = vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
    expect(texts.some((t) => /\bINSERT\b|(?<!FOR )\bUPDATE\b/i.test(t))).toBe(false);
  });
});

describe('locked mutators refuse a removed feed row before writing', () => {
  beforeEach(() => {
    vi.mocked(sql).mockImplementation(async () => [removedRow] as unknown[]);
  });

  it.each(MUTATORS)('%s', async (_verb, run) => {
    let caught: unknown;
    try { await run(); } catch (e) { caught = e; }
    expect(isBankTransactionNotPosted(caught) || isBankAllocationRefusal(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/removed by the bank/);
    const texts = vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
    expect(texts.some((t) => /\bINSERT\b|(?<!FOR )\bUPDATE\b/i.test(t))).toBe(false);
  });
});

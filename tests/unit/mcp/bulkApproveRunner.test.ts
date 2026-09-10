/**
 * The refuse / skip / throw contract shared by the three bulk approve tools.
 *
 * These tools POST. Every element is an irreversible journal, so the properties
 * asserted here are the ones that decide whether a batch can leave the ledger
 * half-written:
 *
 *   - a fault in the REQUEST refuses before anything is attempted;
 *   - a fault in the DATA for one document skips and the batch continues;
 *   - anything else THROWS, because only a throw reaches the registry's
 *     savepoint. A `catch -> toolError` returns normally, RELEASES the
 *     savepoint, and the transport's HTTP 200 COMMITS the journals already
 *     posted — the exact shape that would leave 40 bills approved out of 100
 *     with the caller told the batch failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
// withSavepoint is the real contract's centrepiece, so it is exercised rather
// than stubbed away: the fake runs the body and swallows nothing, which is what
// lets a per-element throw be observed here exactly as the registry sees it.
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/mcp/tools/bulkApprovePeriods', () => ({
  resolvePeriodSkips: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodIdForDate: vi.fn(async () => 'period-1'),
}));

import { withSavepoint } from '@/lib/neon';
import { resolvePeriodSkips } from '@/lib/mcp/tools/bulkApprovePeriods';
import {
  getFiscalPeriodIdForDate,
} from '@/modules/accounting/services/gl/fiscalPeriodService';
import { BulkAllocationLineError } from '@/lib/mcp/bulkAllocationLineError';
import {
  type BulkApproveAdapter,
  type DocumentState,
  partitionDocuments,
} from '@/lib/mcp/tools/bulkApproveRunner';
import { postPartitionedDocuments } from '@/lib/mcp/tools/bulkApprovePosting';
import {
  MAX_DOCUMENTS,
  nothingToApproveText,
  parseDocumentIds,
} from '@/lib/mcp/tools/bulkApproveArgs';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const ID = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function state(n: number, status: string, date = '2026-09-01'): DocumentState {
  return { id: ID(n), status, entryDate: date };
}

function adapterOver(
  states: DocumentState[],
  postOne: (ctx: never, id: string) => Promise<{ id: string }> = async (_c, id) => ({ id }),
): BulkApproveAdapter<{ id: string }> {
  return {
    toolName: 'bulk_test',
    savepointPrefix: 'bulk_test_',
    approvableStatuses: ['draft', 'pending_approval'],
    readStates: async () => new Map(states.map((s) => [s.id, s])),
    postOne: postOne as BulkApproveAdapter<{ id: string }>['postOne'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePeriodSkips).mockResolvedValue(new Map());
  vi.mocked(getFiscalPeriodIdForDate).mockResolvedValue('period-1');
  vi.mocked(withSavepoint).mockImplementation(
    (async (_n: string, fn: () => Promise<unknown>) => fn()) as never,
  );
});

describe('parseDocumentIds — faults in the REQUEST refuse', () => {
  it('refuses an empty array', () => {
    expect(parseDocumentIds([], 'invoice_ids')).toBe('invoice_ids must be a non-empty array');
  });

  it('refuses more than the cap, naming the cap', () => {
    const over = Array.from({ length: MAX_DOCUMENTS + 1 }, (_, i) => ID(i));
    expect(parseDocumentIds(over, 'invoice_ids')).toContain(`the maximum is ${MAX_DOCUMENTS}`);
  });

  it('accepts exactly the cap — the boundary is inclusive', () => {
    const at = Array.from({ length: MAX_DOCUMENTS }, (_, i) => ID(i));
    expect(parseDocumentIds(at, 'invoice_ids')).toHaveLength(MAX_DOCUMENTS);
  });

  /**
   * Shape-checked here rather than left to the database: every read casts
   * ::UUID, and a non-uuid raises 22P02 from inside the query, which reaches the
   * agent as GENERIC_FAILURE naming no element.
   */
  it('refuses a non-uuid id, naming its index', () => {
    expect(parseDocumentIds([ID(1), 'not-a-uuid'], 'invoice_ids'))
      .toBe('invoice_ids[1] must be a document id (UUID)');
  });

  /**
   * The OPPOSITE of the bulk CREATE rule, deliberately. There a repeat is one
   * bill sent twice and the second is redundant. Here all elements share one
   * transaction, so the repeat's own read would see the first's committed
   * 'approved' and report a silent skip — and the agent would never learn its
   * list was wrong.
   */
  it('REFUSES a repeated id rather than skipping it', () => {
    const refusal = parseDocumentIds([ID(1), ID(2), ID(1)], 'invoice_ids');
    expect(refusal).toContain('invoice_ids[2] repeats an earlier id');
    expect(refusal).toContain(ID(1));
  });
});

describe('partitionDocuments — faults in the DATA skip', () => {
  it('skips an id the company-scoped read did not return, as "not found"', async () => {
    const { postable, skipped } = await partitionDocuments(
      'company-1', [ID(1), ID(2)], adapterOver([state(1, 'draft')]),
    );
    expect(postable.map((p) => p.id)).toEqual([ID(1)]);
    expect(skipped).toEqual([{ index: 1, document_id: ID(2), reason: 'not found' }]);
  });

  /**
   * The status is NAMED. Flattening every wrong status to "cannot be approved"
   * would tell an agent its CANCELLED document had merely been posted already —
   * two facts with opposite follow-up actions.
   */
  it('skips a wrong status and names it', async () => {
    const { skipped } = await partitionDocuments(
      'company-1', [ID(1)], adapterOver([state(1, 'cancelled')]),
    );
    expect(skipped[0]!.reason).toContain('status is cancelled');
  });

  it('keeps the agent\'s own indexes, not the surviving order', async () => {
    const { postable } = await partitionDocuments(
      'company-1', [ID(1), ID(2), ID(3)],
      adapterOver([state(1, 'cancelled'), state(2, 'draft'), state(3, 'draft')]),
    );
    expect(postable).toEqual([{ index: 1, id: ID(2) }, { index: 2, id: ID(3) }]);
  });

  it('skips a document whose period verdict refuses it, carrying that reason', async () => {
    vi.mocked(resolvePeriodSkips).mockResolvedValue(
      new Map([['2026-08-15', 'fiscal period covering 2026-08-15 is closed — reopen it']]),
    );
    const { postable, skipped } = await partitionDocuments(
      'company-1', [ID(1)], adapterOver([state(1, 'draft', '2026-08-15')]),
    );
    expect(postable).toEqual([]);
    expect(skipped[0]!.reason).toContain('is closed');
  });

  /**
   * A cancelled document's date is irrelevant, and resolving it would let a
   * stale period mask the real reason the element was skipped.
   */
  it('resolves periods only for documents that survived the status check', async () => {
    await partitionDocuments(
      'company-1', [ID(1), ID(2)],
      adapterOver([state(1, 'cancelled', '2020-01-01'), state(2, 'draft', '2026-09-01')]),
    );
    const [, dates] = vi.mocked(resolvePeriodSkips).mock.calls[0]!;
    expect(dates).toEqual(['2026-09-01']);
  });
});

describe('postPartitionedDocuments — what continues and what unwinds', () => {
  const never = () => null;

  it('posts every element in its own savepoint, under the cap on names', async () => {
    const ordered = [{ index: 0, id: ID(1) }, { index: 1, id: ID(2) }];
    await postPartitionedDocuments(ctx, ordered, adapterOver([]), never);
    const names = vi.mocked(withSavepoint).mock.calls.map((c) => c[0] as string);
    expect(names).toEqual(['bulk_test_0', 'bulk_test_1']);
    // withSavepoint THROWS above 31 characters, which would fail the batch
    // before it posted anything.
    for (const n of names) expect(n.length).toBeLessThanOrEqual(31);
  });

  /**
   * A lock timeout is WRITE-FREE by construction — the lock is taken before
   * anything is posted — so failing 99 good documents because one row was
   * briefly busy is the opposite of what a bulk tool is for.
   */
  it('SKIPS a lock timeout and carries on', async () => {
    const lockErr = Object.assign(new Error('busy'), { code: 'SUPPLIER_INVOICE_LOCK_TIMEOUT' });
    const adapter = adapterOver([], async (_c, id) => {
      if (id === ID(2)) throw lockErr;
      return { id };
    });
    const { posted, raced } = await postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1) }, { index: 1, id: ID(2) }, { index: 2, id: ID(3) }],
      adapter, never,
    );
    expect(posted.map((p) => p.id)).toEqual([ID(1), ID(3)]);
    expect(raced).toEqual([{ index: 1, document_id: ID(2), reason: 'locked by another request — retry' }]);
  });

  it('SKIPS a lost race the adapter recognises, keeping the settled status', async () => {
    const adapter = adapterOver([], async (_c, id) => {
      if (id === ID(1)) throw new Error('Cannot approve invoice with status: approved');
      return { id };
    });
    const { posted, raced } = await postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1) }, { index: 1, id: ID(2) }], adapter,
      (err) => {
        const m = /Cannot approve invoice with status: (\S+)/.exec((err as Error).message);
        return m ? `status became ${m[1]}` : null;
      },
    );
    expect(posted.map((p) => p.id)).toEqual([ID(2)]);
    expect(raced[0]!.reason).toBe('status became approved');
  });

  /**
   * The load-bearing one. Anything that is not a recognised skip must THROW, so
   * the registry's savepoint unwinds the journals already posted. Returning an
   * error here would release the savepoint and commit them.
   */
  it('THROWS a typed line error for an unrecognised failure, naming the element', async () => {
    const adapter = adapterOver([], async (_c, id) => {
      if (id === ID(2)) throw new Error('VAT Input system account not found');
      return { id };
    });
    await expect(postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1) }, { index: 1, id: ID(2) }], adapter, never,
    )).rejects.toBeInstanceOf(BulkAllocationLineError);
  });

  it('names the failing index and id, and stops rather than posting the rest', async () => {
    const posted: string[] = [];
    const adapter = adapterOver([], async (_c, id) => {
      if (id === ID(2)) throw new Error('closed period');
      posted.push(id);
      return { id };
    });
    const err = await postPartitionedDocuments(
      ctx,
      [{ index: 0, id: ID(1) }, { index: 5, id: ID(2) }, { index: 6, id: ID(3) }],
      adapter, never,
    ).catch((e: unknown) => e as BulkAllocationLineError);
    expect(err).toBeInstanceOf(BulkAllocationLineError);
    expect((err as BulkAllocationLineError).index).toBe(5);
    expect((err as BulkAllocationLineError).transactionId).toBe(ID(2));
    // ID(3) never ran: the batch is being unwound, not continued.
    expect(posted).toEqual([ID(1)]);
  });

  /**
   * A pg error's message names the table, column and constraint that failed,
   * which is schema disclosure to a tenant-scoped API. Anything carrying a
   * SQLSTATE is reduced to that code.
   */
  it('reduces a driver error to its SQLSTATE, leaking no schema', async () => {
    const pgErr = Object.assign(
      new Error('insert or update on table "gl_journal_lines" violates foreign key constraint "fk_x"'),
      { code: '23503' },
    );
    const adapter = adapterOver([], async () => { throw pgErr; });
    const err = await postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1) }], adapter, never,
    ).catch((e: unknown) => e as BulkAllocationLineError);
    expect((err as BulkAllocationLineError).detail).toBe('database error 23503');
    expect((err as BulkAllocationLineError).detail).not.toContain('gl_journal_lines');
  });

  it('posts sequentially — concurrent statements corrupt the savepoint stack', async () => {
    const order: string[] = [];
    const adapter = adapterOver([], async (_c, id) => {
      order.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`end:${id}`);
      return { id };
    });
    await postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1) }, { index: 1, id: ID(2) }], adapter, never,
    );
    expect(order).toEqual([`start:${ID(1)}`, `end:${ID(1)}`, `start:${ID(2)}`, `end:${ID(2)}`]);
  });
});

describe('nothingToApproveText', () => {
  /**
   * A batch where everything skipped must REFUSE, not report `posted: 0`.
   * An agent reading a success with nothing posted believes the work was done.
   */
  it('names how many were skipped and why', () => {
    const text = nothingToApproveText([
      { index: 0, document_id: ID(1), reason: 'not found' },
      { index: 1, document_id: ID(2), reason: 'status is cancelled — only draft can be approved' },
    ]);
    expect(text).toContain('2 skipped');
    expect(text).toContain('not found');
    expect(text).toContain('Nothing was posted');
  });

  it('collapses repeated reasons rather than repeating one reason 100 times', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      index: i, document_id: ID(i), reason: 'not found',
    }));
    expect(nothingToApproveText(many).match(/not found/g)).toHaveLength(1);
  });
});

/**
 * Adversarial review, 2026-09-08. A deadlock is fatal — Postgres has already
 * aborted this transaction, so the batch cannot continue — but it is RETRYABLE,
 * and the difference decides whether the agent re-sends the batch or abandons
 * it. Reported through safeLineDetail it reads as `database error 40P01`, which
 * names no action.
 */
describe('postPartitionedDocuments — a deadlock is fatal but retryable', () => {
  it('names the deadlock and says to retry, rather than a bare SQLSTATE', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const adapter = adapterOver([], async () => { throw deadlock; });
    const err = await postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1) }], adapter, () => null,
    ).catch((e: unknown) => e as BulkAllocationLineError);
    expect(err).toBeInstanceOf(BulkAllocationLineError);
    expect((err as BulkAllocationLineError).detail).toContain('deadlock');
    expect((err as BulkAllocationLineError).detail).toContain('retry');
    expect((err as BulkAllocationLineError).detail).toContain('nothing was posted');
  });

  /** Still fatal: it must NOT be swallowed into a skip and let the batch run on. */
  it('does not continue the batch after a deadlock', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const posted: string[] = [];
    const adapter = adapterOver([], async (_c, id) => {
      if (id === ID(1)) throw deadlock;
      posted.push(id);
      return { id };
    });
    await expect(postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1) }, { index: 1, id: ID(2) }], adapter, () => null,
    )).rejects.toBeInstanceOf(BulkAllocationLineError);
    expect(posted).toEqual([]);
  });
});

/**
 * Adversarial review, 2026-09-08 (MEDIUM). "Auto-creatable" is not "created".
 * `resolvePeriodSkips` passes any date whose fiscal year is inside the
 * auto-create window, assuming `ensureFiscalPeriodForDate` will build it — but
 * that call RETHROWS when the build genuinely fails (a partially-created year
 * already carrying the label, or a range that overlaps existing periods). On
 * element 37 of a historical reload that would unwind all 100, which is exactly
 * what the period pre-check exists to prevent.
 *
 * Decided by OUTCOME — does a period cover the date now? — never by the error's
 * wording, which pg rewords and localises.
 */
describe('postPartitionedDocuments — a period that could not be created is a skip', () => {
  const boom = () => new Error('Fiscal year 2019 already exists');

  it('SKIPS the element when no period covers its date afterwards', async () => {
    vi.mocked(getFiscalPeriodIdForDate).mockResolvedValue(null);
    const adapter = adapterOver([], async (_c, id) => {
      if (id === ID(2)) throw boom();
      return { id };
    });
    const { posted, raced } = await postPartitionedDocuments(
      ctx,
      [{ index: 0, id: ID(1), entryDate: '2026-09-01' },
       { index: 1, id: ID(2), entryDate: '2019-06-15' },
       { index: 2, id: ID(3), entryDate: '2026-09-01' }],
      adapter, () => null,
    );
    // The other 99 survive — the whole point.
    expect(posted.map((p) => p.id)).toEqual([ID(1), ID(3)]);
    expect(raced[0]!.reason).toContain('no fiscal period could be resolved or created');
    expect(raced[0]!.reason).toContain('2019-06-15');
  });

  /** The other direction: a period exists, so the failure was something else. */
  it('still THROWS when a period does cover the date — the fault was real', async () => {
    vi.mocked(getFiscalPeriodIdForDate).mockResolvedValue('period-1');
    const adapter = adapterOver([], async () => { throw boom(); });
    await expect(postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1), entryDate: '2026-09-01' }], adapter, () => null,
    )).rejects.toBeInstanceOf(BulkAllocationLineError);
  });

  /** A document with no date cannot be diagnosed this way, so it stays fatal. */
  it('throws when the element carries no date to check', async () => {
    vi.mocked(getFiscalPeriodIdForDate).mockResolvedValue(null);
    const adapter = adapterOver([], async () => { throw boom(); });
    await expect(postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1) }], adapter, () => null,
    )).rejects.toBeInstanceOf(BulkAllocationLineError);
    expect(getFiscalPeriodIdForDate).not.toHaveBeenCalled();
  });
});

/**
 * Adversarial review, 2026-09-08 (MEDIUM). The AR arm's compare-and-swap is
 * stronger than a lock against double-posting and WEAKER against hanging: the
 * loser blocks for the winner's whole transaction, which for a bulk approve is
 * 100 PDF renders and uploads. approveCustomerInvoice now bounds that at 5s and
 * raises a typed error, so the runner must treat it like the other two arms'.
 */
describe('postPartitionedDocuments — every arm\'s lock timeout is a skip', () => {
  it.each([
    'SUPPLIER_INVOICE_LOCK_TIMEOUT',
    'CREDIT_NOTE_LOCK_TIMEOUT',
    'CUSTOMER_INVOICE_LOCK_TIMEOUT',
  ])('skips %s rather than failing the batch', async (code) => {
    const busy = Object.assign(new Error('busy'), { code });
    const adapter = adapterOver([], async (_c, id) => {
      if (id === ID(1)) throw busy;
      return { id };
    });
    const { posted, raced } = await postPartitionedDocuments(
      ctx, [{ index: 0, id: ID(1) }, { index: 1, id: ID(2) }], adapter, () => null,
    );
    expect(posted.map((p) => p.id)).toEqual([ID(2)]);
    expect(raced[0]!.reason).toContain('retry');
  });
});

/**
 * Adversarial review, 2026-09-08 (LOW). customer_invoices.invoice_date is
 * NULLABLE, unlike its supplier and credit-note twins. fmtDate(null) is '',
 * which matches no period window and would fall through to the auto-create
 * branch, where fiscalYearOfDate throws on an unparseable date — a whole batch
 * lost to one undated row.
 */
describe('partitionDocuments — an undated document is skipped, not fatal', () => {
  it('skips a null document date and never asks for a period verdict on it', async () => {
    const { postable, skipped } = await partitionDocuments(
      'company-1', [ID(1), ID(2)],
      adapterOver([
        { id: ID(1), status: 'draft', entryDate: null as unknown as string },
        { id: ID(2), status: 'draft', entryDate: '2026-09-01' },
      ]),
    );
    expect(postable.map((p) => p.id)).toEqual([ID(2)]);
    expect(skipped[0]!.reason).toContain('no document date');
    const [, dates] = vi.mocked(resolvePeriodSkips).mock.calls[0]!;
    expect(dates).toEqual(['2026-09-01']);
  });
});

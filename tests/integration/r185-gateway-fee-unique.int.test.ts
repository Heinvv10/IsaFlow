/**
 * R-185: the Paystack fee journal is posted once per reference, under concurrency.
 *
 * `postGatewayFee` guarded the fee leg with SELECT-then-insert only. Two dedupe-path deliveries
 * for one reference (two webhook bodies for a receipt already banked) could both pass the SELECT
 * and both post the fee. The window is opened deterministically: straight after delivery A's
 * guard SELECT finds nothing, delivery B runs to COMMIT; then A carries on. A partial unique
 * index (migration 852) refuses A's insert, and A, by outcome, finds B's fee journal and stands
 * down without failing its delivery.
 *
 * R-193 (2026-10-05): the dedupe read now LOCKS the receipt (`findSettledReceipt`, FOR UPDATE OF cp),
 * so a second dedupe-path delivery waits at that read until the first one ends and then finds its
 * fee journal by the guard. The two route-level races below are re-pinned to that contract: B is
 * seen blocked BEHIND A on the receipt read, and nobody stands down on a 23505. The index stays the
 * backstop (its own SQL tests below); the stand-down by outcome is unit-tested
 * (tests/unit/services/ar/gatewayFeeIdempotency.test.ts).
 *
 * Real Postgres (isaflow-fixture-r185), real webhook route; only the Paystack client is stubbed.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, B, SECRET, checkout, cleanup, deliver, invoice, ledger, pool, seed, settlement } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

assertDisposable();

const AGENT = 'system:paystack-receipt:v1';

type Hook = { match: (text: string) => boolean; run: () => Promise<void> };
const h = vi.hoisted(() => ({ hook: null as null | Hook, fired: 0 }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: vi.fn(async () => { throw new Error('Paystack must not be asked in this test'); }),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));
// Every statement goes to the real database. After the first statement an armed hook matches has
// returned, the hook runs once, inside that delivery's transaction.
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const hook = h.hook;
    if (hook && hook.match(strings.join('?'))) {
      h.hook = null;
      h.fired += 1;
      return original.sql(strings, ...values).then(async (rows) => { await hook.run(); return rows; });
    }
    return original.sql(strings, ...values);
  };
  Object.assign(sql, { transaction: original.sql.transaction, unsafe: original.sql.unsafe, query: original.sql.query });
  return { ...original, sql };
});

const standDowns = vi.spyOn(log, 'info');
/** The codes the stand-down log carried for this reference: one per delivery that lost. */
const stoodDown = (ref: string) => standDowns.mock.calls
  .filter(([msg, data]) => msg === 'Gateway fee already posted by a concurrent delivery'
    && (data as { reference?: string }).reference === ref)
  .map(([, data]) => (data as { code?: unknown }).code);

/** Live fee journals for the reference, as the guard counts them. */
const feeJournals = async (ref: string) => Number((await pool.query<{ n: string }>(
  `SELECT count(*) AS n FROM gl_journal_entries
   WHERE company_id = $1 AND reference = $2 AND posting_agent = $3 AND status IS DISTINCT FROM 'reversed'`,
  [A.id, ref, AGENT])).rows[0]!.n);
/** Every journal carrying the reference, whatever its status: a stray draft counts here. */
const anyJournals = async (ref: string) => Number((await pool.query<{ n: string }>(
  'SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1 AND reference = $2', [A.id, ref])).rows[0]!.n);
const eventsOf = async (ref: string) => (await pool.query<{ processed: boolean; processing_error: string | null }>(
  'SELECT processed, processing_error FROM paystack_webhook_events WHERE reference = $1 ORDER BY received_at, id', [ref])).rows;

const isFeeGuard = (text: string) => /^\s*SELECT/.test(text) && text.includes('FROM gl_journal_entries')
  && text.includes('AND reference =') && text.includes('AND posting_agent =');
/** The webhook's processed stamp: after the whole fee path, before COMMIT. */
const isProcessedStamp = (text: string) => text.includes('UPDATE paystack_webhook_events') && text.includes('SET processed = TRUE');

/** Wait until a backend in this database is blocked BY A's backend running `like` (B behind A). */
async function blockedBy(aPid: number, like: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
       WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))
         AND state = 'active' AND query ILIKE $2`, [aPid, like]);
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`B never blocked behind A on ${like}`);
}
/** The R-193 dedupe read, which B now waits at. */
const RECEIPT_READ = '%FROM customer_payments cp%FOR UPDATE OF cp%';

/** A receipt banked by a delivery that carried no fee: the next delivery with `fees` is on the dedupe path. */
async function bankedWithoutFee(): Promise<{ id: string; ref: string }> {
  const id = await invoice(A);
  const ref = await checkout(A, id);
  expect((await deliver(ref, 11500, 'ZAR', { id: 1850 })).statusCode).toBe(200);
  expect(await feeJournals(ref)).toBe(0);
  return { id, ref };
}

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await seed(A);
  await seed(B);
  clearSystemAccountCache();
});
beforeEach(() => { h.hook = null; h.fired = 0; standDowns.mockClear(); });
afterAll(async () => { vi.unstubAllEnvs(); await cleanup([A, B]); });

describe('R-185: two dedupe-path deliveries for one reference', () => {
  it('post the fee once; the second waits for the first at the receipt lock (R-193), answers 200 and commits', async () => {
    const { id, ref } = await bankedWithoutFee();

    let reached!: () => void;
    let release!: () => void;
    let aPid = 0;
    const inWindow = new Promise<void>((r) => { reached = r; });
    h.hook = { match: isFeeGuard, run: async () => {
      aPid = Number((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
      reached();
      return new Promise<void>((r) => { release = r; });
    } };

    // A stops after its guard found no fee journal; B (a different body, same reference) then
    // waits behind A at the receipt read (R-193), and A resumes into the insert and commits.
    const a = deliver(ref, 11500, 'ZAR', { id: 1851, fees: 300 });
    await inWindow;
    const bP = deliver(ref, 11500, 'ZAR', { id: 1852, fees: 300 });
    await blockedBy(aPid, RECEIPT_READ);
    release();
    const [aRes, b] = await Promise.all([a, bP]);

    expect(h.fired).toBe(1);
    expect(b.statusCode).toBe(200);
    expect(aRes.statusCode).toBe(200);
    expect(await feeJournals(ref)).toBe(1);
    expect(await anyJournals(ref)).toBe(1);
    // B's guard found A's committed fee journal: nothing collided on the index.
    expect(stoodDown(ref)).toEqual([]);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '112.00', feeExpense: '3.00', balanced: true });
    expect((await settlement(A, ref, id)).payments).toHaveLength(1);
    // Every delivery's transaction committed, including the loser's processed stamp after the fee path.
    expect(await eventsOf(ref)).toEqual([
      { processed: true, processing_error: null },
      { processed: true, processing_error: null },
      { processed: true, processing_error: null },
    ]);
  });
});

describe('R-185: B arrives while A holds its uncommitted fee journal', () => {
  /**
   * A posts the fee and stops at its processed stamp, uncommitted. Before R-193 B's guard could
   * not see A's row, so B inserted and blocked behind A on `uq_gl_je_company_entry_number`, and
   * stood down by outcome once A committed. Now B blocks earlier, at the receipt read (A holds the
   * receipt lock), observed in pg_stat_activity. Then A ends: committed, B's guard sees A's fee
   * journal; rolled back, B posts the fee itself.
   */
  async function interleave(aEnds: 'commit' | 'rollback') {
    const { ref } = await bankedWithoutFee();
    let reached!: () => void;
    let release!: () => void;
    let aPid = 0;
    const inWindow = new Promise<void>((r) => { reached = r; });
    h.hook = { match: isProcessedStamp, run: async () => {
      // Runs inside A's transaction, so this is A's backend.
      aPid = Number((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
      reached();
      return new Promise<void>((resolve, reject) => {
        release = aEnds === 'commit' ? resolve : () => reject(new Error('r185: A rolls back'));
      });
    } };
    const a = deliver(ref, 11500, 'ZAR', { id: 1854, fees: 300 });
    await inWindow;
    const b = deliver(ref, 11500, 'ZAR', { id: 1855, fees: 300 });
    await blockedBy(aPid, RECEIPT_READ);
    release();
    const [aRes, bRes] = await Promise.all([a, b]);
    expect(h.fired).toBe(1);
    return { ref, aRes, bRes };
  }

  it('A commits: B finds its fee journal with 200, exactly one fee journal', async () => {
    const { ref, aRes, bRes } = await interleave('commit');
    expect(aRes.statusCode).toBe(200);
    expect(bRes.statusCode).toBe(200);
    expect(await feeJournals(ref)).toBe(1);
    expect(await anyJournals(ref)).toBe(1);
    expect(stoodDown(ref)).toEqual([]);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '112.00', feeExpense: '3.00', balanced: true });
    expect((await eventsOf(ref)).map((e) => e.processed)).toEqual([true, true, true]);
  });

  it('A rolls back: B posts the fee, exactly one fee journal', async () => {
    const { ref, aRes, bRes } = await interleave('rollback');
    expect(aRes.statusCode).toBe(500);
    expect(bRes.statusCode).toBe(200);
    expect(await feeJournals(ref)).toBe(1);
    expect(await anyJournals(ref)).toBe(1);
    expect(stoodDown(ref)).toEqual([]);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '112.00', feeExpense: '3.00', balanced: true });
    expect((await eventsOf(ref)).map((e) => e.processed)).toEqual([true, false, true]);
  });
});

describe('R-185: the guard is scoped to the company', () => {
  it("another company's live fee journal for the same reference does not stop A's fee", async () => {
    const { ref } = await bankedWithoutFee();
    await pool.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, reference, posting_agent, created_by)
       VALUES ($1, CURRENT_DATE, 'r185 other company fee', 'auto_payment', 'posted', $2, $3, $4)`, [B.id, ref, AGENT, B.user]);
    expect((await deliver(ref, 11500, 'ZAR', { id: 1856, fees: 300 })).statusCode).toBe(200);
    expect(await feeJournals(ref)).toBe(1);
    expect(await ledger(A, ref)).toMatchObject({ bankNet: '112.00', feeExpense: '3.00', balanced: true });
  });
});

describe('R-185: a fee post that fails for any other reason still fails', () => {
  it('a closed period: the delivery answers 500 and leaves no fee journal, not even a draft', async () => {
    const { ref } = await bankedWithoutFee();
    const closed = (await pool.query<{ id: string }>(
      `UPDATE fiscal_periods SET status = 'closed'
       WHERE company_id = $1 AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE AND status <> 'closed'
       RETURNING id`, [A.id])).rows.map((r) => r.id);
    expect(closed.length).toBeGreaterThan(0);
    try {
      expect((await deliver(ref, 11500, 'ZAR', { id: 1853, fees: 300 })).statusCode).toBe(500);
    } finally {
      await pool.query(`UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND id = ANY($2::uuid[])`, [A.id, closed]);
    }
    expect(await anyJournals(ref)).toBe(0);
    const events = await eventsOf(ref);
    expect(events[1]).toMatchObject({ processed: false });
    expect(events[1]!.processing_error).not.toBeNull();
  });
});

describe('R-185: the index targets fee journals only', () => {
  /** Insert a journal header in a transaction that is always rolled back. */
  async function insertPair(first: Record<string, unknown>, second: Record<string, unknown>): Promise<string | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of [first, second]) {
        await client.query(
          `INSERT INTO gl_journal_entries (id, company_id, entry_date, description, source, status, reference, posting_agent, created_by)
           VALUES ($1, $2, CURRENT_DATE, 'r185 probe', 'auto_payment', $3, $4, $5, $6)`,
          [randomUUID(), row.company ?? A.id, 'status' in row ? row.status : 'posted', row.reference ?? null, row.agent ?? AGENT, A.user]);
      }
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? 'unknown';
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  const ref = () => `r185_${randomUUID().slice(0, 12)}`;

  it('refuses a second live fee journal for one (company, reference), draft or posted', async () => {
    const r = ref();
    expect(await insertPair({ reference: r }, { reference: r })).toBe('23505');
    expect(await insertPair({ reference: r, status: 'draft' }, { reference: r })).toBe('23505');
    expect(await insertPair({ reference: r, status: null }, { reference: r })).toBe('23505');
  });

  it('admits the receipt journals (same agent, NULL reference), another agent, a reversed row', async () => {
    const r = ref();
    expect(await insertPair({}, {})).toBeNull();
    expect(await insertPair({ reference: r }, { reference: r, agent: 'human:someone' })).toBeNull();
    expect(await insertPair({ reference: r, status: 'reversed' }, { reference: r })).toBeNull();
  });
});

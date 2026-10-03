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
 * Real Postgres (isaflow-fixture-r185), real webhook route; only the Paystack client is stubbed.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { A, SECRET, checkout, cleanup, deliver, invoice, ledger, pool, seed, settlement } from './r181-settlement.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { log } from '@/lib/logger';

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

/** Wait until another backend is blocked on a lock while inserting a journal (B behind A's index entry). */
async function insertBlockedOnLock(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'
         AND query ILIKE '%INSERT INTO gl_journal_entries%'`);
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('B never blocked on the journal insert');
}

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
  clearSystemAccountCache();
});
beforeEach(() => { h.hook = null; h.fired = 0; standDowns.mockClear(); });
afterAll(async () => { vi.unstubAllEnvs(); await cleanup([A]); });

describe('R-185: two dedupe-path deliveries for one reference', () => {
  it('post the fee once; the loser answers 200 and its transaction commits', async () => {
    const { id, ref } = await bankedWithoutFee();

    let reached!: () => void;
    let release!: () => void;
    const inWindow = new Promise<void>((r) => { reached = r; });
    h.hook = { match: isFeeGuard, run: () => { reached(); return new Promise<void>((r) => { release = r; }); } };

    // A stops after its guard found no fee journal; B (a different body, same reference) then
    // runs outside A's transaction to COMMIT, and A resumes into the insert.
    const a = deliver(ref, 11500, 'ZAR', { id: 1851, fees: 300 });
    await inWindow;
    const b = await deliver(ref, 11500, 'ZAR', { id: 1852, fees: 300 });
    release();
    const aRes = await a;

    expect(h.fired).toBe(1);
    expect(b.statusCode).toBe(200);
    expect(aRes.statusCode).toBe(200);
    expect(await feeJournals(ref)).toBe(1);
    expect(await anyJournals(ref)).toBe(1);
    expect(stoodDown(ref)).toEqual(['23505']);
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

describe('R-185: B inserts while A holds its uncommitted fee journal', () => {
  /**
   * A posts the fee and stops at its processed stamp, uncommitted. B's guard cannot see A's row,
   * so B inserts and blocks behind A (observed in pg_stat_activity). Then A ends. B blocks on
   * `uq_gl_je_company_entry_number`, not on 852's index: the entry-number trigger is MAX+1 over
   * committed rows, so B computes A's number, and that older index is checked first. The outcome
   * re-read does not care which constraint fired.
   */
  async function interleave(aEnds: 'commit' | 'rollback') {
    const { ref } = await bankedWithoutFee();
    let reached!: () => void;
    let release!: () => void;
    const inWindow = new Promise<void>((r) => { reached = r; });
    h.hook = { match: isProcessedStamp, run: () => {
      reached();
      return new Promise<void>((resolve, reject) => {
        release = aEnds === 'commit' ? resolve : () => reject(new Error('r185: A rolls back'));
      });
    } };
    const a = deliver(ref, 11500, 'ZAR', { id: 1854, fees: 300 });
    await inWindow;
    const b = deliver(ref, 11500, 'ZAR', { id: 1855, fees: 300 });
    await insertBlockedOnLock();
    release();
    const [aRes, bRes] = await Promise.all([a, b]);
    expect(h.fired).toBe(1);
    return { ref, aRes, bRes };
  }

  it('A commits: B stands down with 200, exactly one fee journal', async () => {
    const { ref, aRes, bRes } = await interleave('commit');
    expect(aRes.statusCode).toBe(200);
    expect(bRes.statusCode).toBe(200);
    expect(await feeJournals(ref)).toBe(1);
    expect(await anyJournals(ref)).toBe(1);
    expect(stoodDown(ref)).toEqual(['23505']);
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

describe('R-185: a fee post that fails for any other reason still fails', () => {
  it('a closed period: the delivery answers 500 and leaves no fee journal, not even a draft', async () => {
    const { ref } = await bankedWithoutFee();
    await pool.query(
      `UPDATE fiscal_periods SET status = 'closed'
       WHERE company_id = $1 AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE`, [A.id]);
    try {
      expect((await deliver(ref, 11500, 'ZAR', { id: 1853, fees: 300 })).statusCode).toBe(500);
    } finally {
      await pool.query(`UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND status = 'closed'`, [A.id]);
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

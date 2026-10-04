/**
 * A reconciliation session claims ALLOCATED lines and counts each one matched
 * to its own allocation journal line (bankReconciliationClaim.ts).
 *
 * Before: start claimed only `status = 'imported'` lines and auto-match read
 * only those, so on books allocated through the bank feed a session claimed and
 * matched nothing and could never complete (VF1 claimed its 256 unallocated
 * lines and matched 0; SBSA, every line allocated, claimed 0).
 *
 * These are SQL-SHAPE tests against a rendering fake of `sql`: they pin which
 * predicates each statement carries and in what order the statements run. The
 * behaviour against a real database is in
 * tests/integration/bank-recon-self-match.int.test.ts (needs DATABASE_URL).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Rendered { text: string; values: unknown[] }

const { fake } = vi.hoisted(() => {
  const queries: Rendered[] = [];
  let respond: (q: Rendered) => unknown[] = () => [];
  class Frag {
    constructor(readonly strings: readonly string[], readonly values: unknown[]) {}
    render(): Rendered {
      let text = '';
      const values: unknown[] = [];
      this.strings.forEach((s, i) => {
        text += s;
        if (i >= this.values.length) return;
        const v = this.values[i];
        if (v instanceof Frag) {
          const inner = v.render();
          text += inner.text;
          values.push(...inner.values);
        } else {
          text += `<${String(v)}>`;
          values.push(v);
        }
      });
      return { text: text.replace(/\s+/g, ' '), values };
    }
    then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown): Promise<unknown> {
      const q = this.render();
      queries.push(q);
      return Promise.resolve().then(() => respond(q)).then(ok, bad);
    }
  }
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => new Frag(strings, values);
  return {
    fake: {
      queries, tag,
      setResponder(fn: (q: Rendered) => unknown[]) { respond = fn; },
    },
  };
});

vi.mock('@/lib/neon', async (importOriginal) => ({
  fmtDate: (await importOriginal<typeof import('@/lib/neon')>()).fmtDate,
  sql: Object.assign(fake.tag, { unsafe: vi.fn(() => '') }),
  withTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tag),
  withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(),
  transaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  startReconciliation, completeReconciliation, getReconciliationById, previewReconciliationClaim,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { autoMatchTransactions } from '@/modules/accounting/services/bank/bankAutoMatchService';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_CO = 'ffffffff-0000-0000-0000-00000000000f';
const BANK = '025b058b-adf6-45d9-9bf9-a3a543083c04';
const REC = 'eeeeeeee-0000-0000-0000-000000000005';
const STMT = '2025-04-24';

const reconRow = (o: Record<string, unknown> = {}) => ({
  id: REC, company_id: CO, bank_account_id: BANK, statement_date: STMT,
  statement_balance: 4271.54, gl_balance: 4271.54, reconciled_balance: 4271.54, difference: 0,
  status: 'in_progress', started_by: 'u', started_at: 'now', created_at: 'now', updated_at: 'now', ...o,
});

const find = (needle: string) => fake.queries.filter((q) => q.text.includes(needle));
const one = (needle: string) => {
  const hits = find(needle);
  expect(hits, `exactly one query containing ${needle}`).toHaveLength(1);
  return hits[0]!;
};
const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));

beforeEach(() => {
  fake.queries.length = 0;
  fake.setResponder(() => []);
});

describe('startReconciliation — claim', () => {
  beforeEach(() => fake.setResponder((q) => {
    if (q.text.includes('AS gl_balance')) return [{ gl_balance: '4271.54' }];
    if (q.text.includes('INSERT INTO bank_reconciliations')) return [reconRow()];
    if (q.text.includes("bt.status = 'imported'")) return ids(2);
    if (q.text.includes("bt.status = 'allocated'")) return ids(575);
    return [];
  }));

  it('claims allocated lines as self-matched and reports them as matched', async () => {
    const r = await startReconciliation(CO, BANK, STMT, 4271.54, 'u');
    expect(r.selfMatched).toBe(575);
    expect(r.claimedUnallocated).toBe(2);
    expect(r.matchedCount).toBe(575);
    expect(r.unmatchedCount).toBe(2);
  });

  it('self-matches only a posted, unreversed line of THIS bank account inside the statement date', async () => {
    await startReconciliation(CO, BANK, STMT, 4271.54, 'u');
    const q = one("bt.status = 'allocated'").text;
    expect(q).toContain('UPDATE bank_transactions bt');
    expect(q).toContain(`SET reconciliation_id = <${REC}>::UUID`);
    expect(q).toContain('bt.matched_journal_line_id IS NOT NULL');
    expect(q).toContain(`bt.transaction_date <= <${STMT}>::DATE`);
    expect(q).toContain('own_jl.id = bt.matched_journal_line_id');
    expect(q).toContain('own_jl.gl_account_id = bt.bank_account_id');
    expect(q).toContain("own_je.status = 'posted'");
    expect(q).toContain('own_je.reversed_at IS NULL');
    expect(q).toContain(`own_je.entry_date <= <${STMT}>::DATE`);
    expect(q).toContain("bt.feed_state = 'posted'");
  });

  it('still claims unallocated (imported) lines — bounded by the statement date now too', async () => {
    await startReconciliation(CO, BANK, STMT, 4271.54, 'u');
    const q = one("bt.status = 'imported'").text;
    expect(q).toContain(`bt.transaction_date <= <${STMT}>::DATE`);
    expect(q).toContain(`bt.bank_account_id = <${BANK}>::UUID`);
  });

  it('never claims reconciled or excluded lines, nor one held by an in-progress session', async () => {
    await startReconciliation(CO, BANK, STMT, 4271.54, 'u');
    for (const q of find('UPDATE bank_transactions')) {
      expect(q.text).not.toMatch(/status\s*(=|IN)\s*\(?'(reconciled|excluded)'/);
      // A stale stamp from a COMPLETED session is re-claimable; an open session's is not.
      expect(q.text).toContain("held.status = 'in_progress'");
      expect(q.text).toContain('bt.reconciliation_id IS NULL OR NOT EXISTS');
    }
  });

  it('scopes every statement by company, and only this company', async () => {
    await startReconciliation(CO, BANK, STMT, 4271.54, 'u');
    expect(fake.queries.length).toBeGreaterThanOrEqual(4);
    for (const q of fake.queries) {
      expect(q.values).toContain(CO);
      expect(q.values).not.toContain(OTHER_CO);
    }
    // The self-match subquery pins BOTH journal tables to the company.
    const q = one("bt.status = 'allocated'").text;
    expect(q).toContain(`own_jl.company_id = <${CO}>::UUID`);
    expect(q).toContain(`own_je.company_id = <${CO}>::UUID`);
  });
});

describe('session counts', () => {
  it('count an allocated line with a valid own journal line as matched, anything else allocated as unmatched', async () => {
    fake.setResponder(() => [reconRow({ matched_count: '575', unmatched_count: '0' })]);
    const r = await getReconciliationById(CO, REC);
    expect(r?.matchedCount).toBe(575);
    const q = fake.queries[0]!.text;
    expect(q).toMatch(/bt\.status = 'matched' OR \( bt\.status = 'allocated'.*own_je\.entry_date <= br\.statement_date.*AS matched_count/);
    expect(q).toMatch(/bt\.status = 'imported' OR \( bt\.status = 'allocated' AND NOT .*AS unmatched_count/);
    expect(fake.queries[0]!.values).not.toContain(OTHER_CO);
  });
});

describe('completeReconciliation', () => {
  // D12: the header is locked FOR UPDATE first (bankReconciliationService / reconciliationSessionLock).
  const HEADER_LOCK = 'FOR UPDATE OF r';
  it('locks the header, recomputes the live balance, then reconciles matched AND self-matched allocated lines', async () => {
    fake.setResponder((q) => {
      if (q.text.includes(HEADER_LOCK)) return [reconRow()];
      if (q.text.includes('SELECT br.*')) return [reconRow({ matched_count: '575' })];
      if (q.text.includes("SET status = 'completed'")) return [reconRow({ status: 'completed' })];
      return [];
    });
    const done = await completeReconciliation(CO, REC, 'u');
    expect(done.status).toBe('completed');

    const order = fake.queries.map((q) => q.text);
    const recompute = order.findIndex((t) => t.includes('SET (gl_balance, reconciled_balance)'));
    const read = order.findIndex((t) => t.includes('SELECT br.*'));
    expect(recompute).toBeGreaterThanOrEqual(0);
    expect(recompute).toBeLessThan(read);
    expect(order.findIndex((t) => t.includes(HEADER_LOCK)), 'the header lock comes first').toBe(0);
    // The recompute never rewrites a completed (audit) reconciliation.
    expect(order[recompute]).toContain("br.status = 'in_progress'");

    const mark = one("SET status = 'reconciled'");
    expect(mark.text).toContain("bt.status = 'matched' OR ( bt.status = 'allocated'");
    expect(mark.text).toContain('own_je.reversed_at IS NULL');
    expect(mark.text).toContain(`bt.company_id = <${CO}>::UUID`);
    expect(mark.values).not.toContain(OTHER_CO);
  });

  it('refuses a non-zero difference and marks nothing', async () => {
    fake.setResponder((q) => (q.text.includes(HEADER_LOCK) ? [reconRow()]
      : q.text.includes('SELECT br.*') ? [reconRow({ difference: 12.5 })] : []));
    await expect(completeReconciliation(CO, REC, 'u')).rejects.toThrow(/difference is R12\.50/);
    expect(find("SET status = 'reconciled'")).toHaveLength(0);
  });

  it('refuses a session that is already completed (D12: the shared 409, read under its lock) — nothing re-marked', async () => {
    fake.setResponder((q) => (q.text.includes(HEADER_LOCK) ? [reconRow({ status: 'completed' })] : []));
    await expect(completeReconciliation(CO, REC, 'u')).rejects.toThrow(/is completed — reopen it first/);
    expect(find("SET status = 'reconciled'")).toHaveLength(0);
    expect(find('SET (gl_balance, reconciled_balance)'), 'not even the recompute').toHaveLength(0);
  });
});

describe('autoMatchTransactions — unallocated lines keep auto-match', () => {
  it('reads only imported lines, bounded to the session and its statement date', async () => {
    await autoMatchTransactions(CO, BANK, REC);
    const q = one('SELECT id, amount, transaction_date').text;
    expect(q).toContain("status = 'imported'");
    expect(q).not.toContain("'allocated'");
    expect(q).toContain(`reconciliation_id = <${REC}>::UUID`);
    expect(q).toContain('transaction_date <= (SELECT r.statement_date FROM bank_reconciliations r');
    expect(q).toContain(`r.company_id = <${CO}>::UUID`);
  });

  it('without a session it is unbounded, as before', async () => {
    await autoMatchTransactions(CO, BANK);
    const q = one('SELECT id, amount, transaction_date');
    expect(q.text).toContain('<null>::UUID IS NULL');
  });

  it('matches imported lines against GL lines inside the session statement date', async () => {
    fake.setResponder((q) => (q.text.includes('SELECT id, amount, transaction_date')
      ? [{ id: 't1', amount: -100, transaction_date: '2025-04-10', reference: null, description: 'X' }]
      : []));
    await autoMatchTransactions(CO, BANK, REC);
    const gl = one('FROM gl_journal_lines jl').text;
    expect(gl).toContain('je.entry_date <= (SELECT r.statement_date');
  });
});

describe('previewReconciliationClaim (dry run)', () => {
  it('counts what start would claim, with the same bounds, writing nothing', async () => {
    fake.setResponder(() => [{ unallocated: '2', self_matched: '575' }]);
    const p = await previewReconciliationClaim(CO, BANK, STMT);
    expect(p).toEqual({ claimedUnallocated: 2, selfMatched: 575 });
    expect(fake.queries).toHaveLength(1);
    const q = fake.queries[0]!.text;
    expect(q).not.toMatch(/UPDATE|INSERT|DELETE/);
    expect(q).toContain(`bt.transaction_date <= <${STMT}>::DATE`);
    expect(q).toContain("held.status = 'in_progress'");
    expect(fake.queries[0]!.values).toContain(CO);
  });
});

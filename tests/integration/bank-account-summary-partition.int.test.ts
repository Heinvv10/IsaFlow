/**
 * WP1 PR-B: the bank summary's counts partition the account's posted lines, and agree with the list they open.
 *
 * One posted line per cell of the status table (spec §5 PR-B), plus a line pending at the bank, a removed one, and
 * another company's line filed against this bank account id. Every matched line has its own journal line
 * (uq_bank_tx_matched_line). Read as the bearer pipeline reads (app_user, company GUC), so RLS is in the path.
 *
 * Expected buckets (LINE_BUCKET_SQL): allocated 7 (provisional 1), suggested 2, unallocated 2, excluded 2 = 13 posted;
 * to code 4, in +R250.32, out −R400.43; awaiting review 8; pending at the bank 1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import bankAccountSummaries from '../../pages/api/accounting/bank-account-summaries';
import { getBankAccountSummaries, type BankAccountSummary } from '@/modules/accounting/services/bank/bankAccountSummaryService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { mapTxRow } from '@/modules/accounting/services/bank/bankTxRowMapper';
import { TX_SELECT } from '@/modules/accounting/services/bank/bankTxQueryFragments';
import { LINE_BUCKET_SQL, lineBucketOf } from '@/modules/accounting/services/bank/bankLineBucket';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { asToken, bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let u = '';
let f: BankCompany;
let other: BankCompany;
const inactive = { withBalance: '', empty: '', awaiting: '' };

/** A posted journal: one DR line per amount on `bank`, one CR on expA. Returns the bank lines' ids, in order. */
async function postedJournal(company: BankCompany, bank: string, amounts: number[]): Promise<{ je: string; lines: string[] }> {
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by)
     VALUES($1,$2,DATE '2026-09-01','WP1 partition','manual','draft',$3) RETURNING id`,
    [company.c, `JE-${crypto.randomUUID().slice(0, 8)}`, u])).rows[0].id as string;
  const lines: string[] = [];
  for (const amount of amounts) {
    lines.push((await pool.query(
      `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
       VALUES($1,$2,$3,$4,0,'bank') RETURNING id`, [company.c, je, bank, amount])).rows[0].id as string);
  }
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
     VALUES($1,$2,$3,0,$4,'contra')`, [company.c, je, company.expA, amounts.reduce((s, a) => s + a, 0)]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [je]);
  return { je, lines };
}

type Line = {
  amount: number; status?: string | null; match?: boolean; reviewed?: boolean; suggested?: boolean;
  allocationType?: string; provisional?: boolean; feed?: 'pending' | 'removed';
};
const CELLS: Record<string, Line> = {
  importedNone: { amount: -100.10 },
  importedSuggested: { amount: 250.25, suggested: true },
  importedTypeOnly: { amount: -300.33, allocationType: 'account' },
  provisional: { amount: -40.00, status: 'provisional', provisional: true },
  allocatedUnreviewed: { amount: -50.00, status: 'allocated', match: true },
  allocatedReviewed: { amount: -60.00, status: 'allocated', match: true, reviewed: true },
  matched: { amount: 70.00, status: 'matched', match: true },
  reconciledMatched: { amount: 80.00, status: 'reconciled', match: true },
  reconciledSage: { amount: -90.00, status: 'reconciled' },
  excluded: { amount: -11.11, status: 'excluded' },
  excludedKeptMatch: { amount: -12.12, status: 'excluded', match: true },
  nullStatus: { amount: 0.07, status: null },
  importedMatched: { amount: -13.13, match: true },
  pending: { amount: -999.99, feed: 'pending' },
  removed: { amount: -888.88, feed: 'removed' },
};

async function plantLine(company: BankCompany, bank: string, line: Line, journal: { je: string; line?: string },
  feedConnection: string | null): Promise<string> {
  return (await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status,
       matched_journal_line_id, reviewed_at, reviewed_by, suggested_gl_account_id, allocation_type, provisional_je_id,
       feed_state, bank_feed_connection_id, provider_transaction_id)
     VALUES($1,$2,DATE '2026-09-01',$3,'WP1 partition',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [company.c, bank, line.amount, line.status === undefined ? 'imported' : line.status,
      line.match ? journal.line : null, line.reviewed ? new Date('2026-09-02T08:00:00Z') : null, line.reviewed ? u : null,
      line.suggested ? company.expB : null, line.allocationType ?? null, line.provisional ? journal.je : null,
      line.feed ?? 'posted', line.feed ? feedConnection : null, line.feed ? `prov-${crypto.randomUUID()}` : null],
  )).rows[0].id as string;
}

async function bankAccount(company: BankCompany, code: string, active: boolean): Promise<string> {
  return (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
     VALUES ($1,$2,$3,'asset','debit',$4,'bank') RETURNING id`, [company.c, code, `WP1 ${code}`, active])).rows[0].id as string;
}

const summaries = (company = f.c) => asToken(pool, u, company, () => getBankAccountSummaries(company, { asAt: '2026-12-31' }));
const mine = async (): Promise<BankAccountSummary> => (await summaries()).accounts.find((a) => a.id === f.bank)!;
const listTotal = (filters: Parameters<typeof getBankTransactions>[1]) =>
  asToken(pool, u, f.c, async () => (await getBankTransactions(f.c, { bankAccountId: f.bank, ...filters })).total);

beforeAll(async () => {
  u = await createUser(pool, tokens);
  f = await bankCompany(pool, [[u, 'admin']], companies);
  other = await bankCompany(pool, [[u, 'admin']], companies);
  const matched = Object.values(CELLS).filter((l) => l.match).map(() => 1);
  const journal = await postedJournal(f, f.bank, matched);
  const feed = (await pool.query(
    `INSERT INTO bank_feed_connections(company_id, bank_account_id, provider, status) VALUES($1,$2,'extension','active') RETURNING id`,
    [f.c, f.bank])).rows[0].id as string;
  let next = 0;
  for (const line of Object.values(CELLS)) {
    await plantLine(f, f.bank, line, { je: journal.je, line: line.match ? journal.lines[next++] : undefined }, feed);
  }
  // Another company's imported line filed against THIS bank account id: a filter on bank_account_id alone counts it.
  await plantLine(other, f.bank, { amount: -5555.55 }, { je: journal.je }, null);

  // Inactive accounts: one holding a ledger balance (posted before it was retired), one with nothing, one with a line
  // still awaiting review.
  inactive.withBalance = await bankAccount(f, `IB${f.c.slice(0, 4)}`, true);
  await postedJournal(f, inactive.withBalance, [123.45]);
  inactive.empty = await bankAccount(f, `IE${f.c.slice(0, 4)}`, false);
  inactive.awaiting = await bankAccount(f, `IA${f.c.slice(0, 4)}`, false);
  await plantLine(f, inactive.awaiting, { amount: -1.00 }, { je: journal.je }, null);
  await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [inactive.withBalance]);
}, 60000);

afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET provisional_je_id = NULL WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [u]);
});

describe('GET bank-account-summaries — the counts partition the posted lines', () => {
  it('buckets: 7 allocated (1 provisional), 2 suggested, 2 unallocated, 2 excluded = 13 posted', async () => {
    const s = await mine();
    const posted = Number((await pool.query(
      "SELECT COUNT(*) FROM bank_transactions WHERE company_id = $1 AND bank_account_id = $2 AND feed_state = 'posted'",
      [f.c, f.bank])).rows[0].count);
    expect(s.counts).toEqual({
      posted: 13, allocated: 7, provisional: 1, suggested: 2, unallocated: 2, excluded: 2, toCode: 4,
      awaitingReview: 8, pendingAtBank: 1,
    });
    expect(s.counts.posted).toBe(posted);
    const { allocated, suggested, unallocated, excluded, toCode, provisional } = s.counts;
    expect(allocated + suggested + unallocated + excluded).toBe(s.counts.posted);
    expect(toCode).toBe(suggested + unallocated);
    expect(provisional).toBeLessThanOrEqual(allocated);
  });

  it('each bucket equals the list total for that allocation filter', async () => {
    const s = await mine();
    expect({
      allocated: await listTotal({ allocationFilter: 'allocated' }),
      suggested: await listTotal({ allocationFilter: 'suggested' }),
      unallocated: await listTotal({ allocationFilter: 'unallocated' }),
      excluded: await listTotal({ status: 'excluded' }),
    }).toEqual({ allocated: s.counts.allocated, suggested: s.counts.suggested, unallocated: s.counts.unallocated,
      excluded: s.counts.excluded });
  });

  it('awaiting review is the New tab total less the lines pending at the bank; New + Reviewed + Excluded = posted', async () => {
    const s = await mine();
    const newTab = await listTotal({ status: 'imported' });
    const reviewed = await listTotal({ status: 'matched' });
    const excludedTab = await listTotal({ status: 'excluded' });
    expect(s.counts.awaitingReview).toBe(newTab - s.counts.pendingAtBank);
    expect(s.counts.awaitingReview + reviewed + excludedTab).toBe(s.counts.posted);
  });

  it('spec §7 (#1442): posted − excluded − reconciled vs the card\'s unreconciledCount — two named disagreements', async () => {
    // The identity does not hold as written, for two reasons, both pinned here and reported (not bent to agree):
    //   1. the NULL-status line: UNRECONCILED_LINE_SQL is `status NOT IN ('reconciled', 'excluded')`, and
    //      NULL NOT IN (...) is not true, so the card leaves it out; the bucket count keeps it (posted, not excluded,
    //      not reconciled). −1.
    //   2. the other company's line filed against THIS bank id: getBankAccountsStatus's LATERAL filters
    //      bt.bank_account_id only, with no bt.company_id, and RLS does not hide it either, so the card counts it. +1.
    // On this fixture the two cancel, which is why they are asserted separately rather than as one difference.
    const s = await mine();
    const one = async (where: string, company = f.c) => Number((await pool.query(
      `SELECT COUNT(*) FROM bank_transactions bt WHERE bt.company_id = $1 AND bt.bank_account_id = $2
         AND bt.feed_state = 'posted' AND ${where}`, [company, f.bank])).rows[0].count);
    const reconciled = await one("bt.status = 'reconciled'");
    const nullStatus = await one('bt.status IS NULL');
    const foreign = await one('TRUE', other.c);
    const card = (await asToken(pool, u, f.c, () => getBankAccountsStatus(f.c))).find((a) => a.id === f.bank)!;
    expect({ reconciled, nullStatus, foreign }).toEqual({ reconciled: 2, nullStatus: 1, foreign: 1 });
    expect(card.unreconciledCount).toBe(s.counts.posted - s.counts.excluded - reconciled - nullStatus + foreign);
  });

  it('in / out are the to-code lines\' amounts, exact cents', async () => {
    const s = await mine();
    expect({ in: s.toCodeInCents, out: s.toCodeOutCents }).toEqual({ in: 25025 + 7, out: -10010 - 30033 });
  });

  it('the SQL bucket of every line equals lineBucketOf(mapTxRow(row))', async () => {
    const rows = await asToken(pool, u, f.c, async () => (await sql`${sql.unsafe(TX_SELECT)}
      WHERE bt.company_id = ${f.c}::UUID AND bt.bank_account_id = ${f.bank}::UUID`) as Record<string, unknown>[]);
    const sqlBuckets = new Map((await pool.query(
      `SELECT bt.id, ${LINE_BUCKET_SQL} AS bucket FROM bank_transactions bt WHERE bt.company_id = $1 AND bt.bank_account_id = $2`,
      [f.c, f.bank])).rows.map((r) => [String(r.id), String(r.bucket)]));
    expect(rows).toHaveLength(Object.keys(CELLS).length);
    for (const row of rows) {
      const tx = mapTxRow(row);
      expect(lineBucketOf(tx), `${tx.status}/${tx.feedState}`).toBe(sqlBuckets.get(tx.id));
    }
  });

  it('inactive accounts: shown with a balance or with lines awaiting review, hidden with neither', async () => {
    const { accounts } = await summaries();
    const byId = new Map(accounts.map((a) => [a.id, a]));
    expect(byId.get(inactive.withBalance)).toMatchObject({ isActive: false, ledgerCents: 12345 });
    expect(byId.get(inactive.awaiting)).toMatchObject({ isActive: false, ledgerCents: 0, counts: { awaitingReview: 1 } });
    expect(byId.has(inactive.empty)).toBe(false);
    expect(byId.get(f.bank2)).toMatchObject({ isActive: true, ledgerCents: 0 }); // an active empty account is shown
  });

  it('another company never sees this company\'s lines, and its own line on this bank id is on no card here', async () => {
    const { accounts } = await summaries(other.c);
    expect(accounts.map((a) => a.id).sort()).toEqual([other.bank, other.bank2].sort());
    expect(accounts.every((a) => a.counts.posted === 0)).toBe(true);
  });

  it('the route answers the same summaries through withAuth, read-only', async () => {
    const res = await callRoute(bankAccountSummaries as never, tokens[u]!, f.c, 'GET', undefined,
      '/api/accounting/bank-account-summaries');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const body = (res.state.body as { data: { asAt: string; accounts: BankAccountSummary[] } }).data;
    expect(body.asAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.accounts.find((a) => a.id === f.bank)!.counts).toEqual((await mine()).counts);
  });

  it('takes no row lock and writes nothing: no transaction id assigned, only AccessShareLock held', async () => {
    const held = await asToken(pool, u, f.c, async () => {
      await getBankAccountSummaries(f.c);
      return (await sql`
        SELECT txid_current_if_assigned() AS xid,
               ARRAY(SELECT DISTINCT mode FROM pg_locks
                      WHERE pid = pg_backend_pid() AND locktype NOT IN ('virtualxid') ORDER BY mode) AS modes`) as
        { xid: string | null; modes: string[] }[];
    });
    expect(held[0]).toEqual({ xid: null, modes: ['AccessShareLock'] });
  });
});

/**
 * Sage ledger import must post exactly-balanced journals, or none.
 *
 * ⚠️ READ THIS BEFORE TRUSTING THE SCENARIOS BELOW. importLedgerTransactions
 * CANNOT CURRENTLY RUN: it selects slt.document_number / slt.sage_account_id /
 * slt.ff_project_id and joins sage_accounts on sa.sage_account_id, and none of
 * those columns exist — the live table is (id, sage_id, account_code,
 * transaction_date, description, debit, credit, reference, gl_journal_entry_id,
 * migration_status, imported_at, company_id). The first statement throws 42703.
 * Production has 0 rows in sage_ledger_transactions and 0 journals with
 * posting_agent='import:sage', and nothing in the repo writes that table.
 *
 * These tests therefore fabricate a table shape that does not exist. They pin
 * the SERVICE LOGIC so a future schema reconciliation cannot ship the old
 * unvalidated behaviour back; they do NOT demonstrate anything about production
 * today. An earlier version of this docstring claimed the defects were
 * "reachable from POST /api/accounting/sage-migration-action" and that this path
 * produced 34 zero-line headers in production. Both were wrong — those 34
 * headers are legacy loanPaymentService entries (posting_agent='legacy:human',
 * 2026-04-20, demo company).
 *
 * The three logic defects the service DID have:
 *
 *  1. The balance gate was `Math.abs(totalDebit - totalCredit) > 0.02`, so a
 *     group of Dr 100.00 / Cr 100.02 would pass. The header was INSERTed
 *     straight into status='posted', and trg_gl_je_balanced is BEFORE UPDATE,
 *     so nothing downstream checked it. Migration 509's source CHECK cannot help
 *     either — this path writes source='manual', which has always been valid.
 *  2. A group whose rows are ALL zero passed that gate (0 - 0 <= 0.02), got its
 *     posted header, and then wrote NO lines, because `activeLines` filtered
 *     them all out.
 *  3. entry_number was `SAGE-<document_number>` — UNIQUE per company, and keyed
 *     on the document number ALONE, so two legitimate groups sharing a document
 *     number on different dates would collide (23505) and be logged as failures.
 *
 * The whole group is now validated before anything is written, and posts
 * through createJournalEntry/postJournalEntry.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

const { sqlMock, txMock, createMock, postMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { transaction: vi.fn() }),
  txMock: vi.fn(),
  createMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  transaction: txMock,
  withTransaction: vi.fn(),
  fmtDate: (d: unknown) => String(d),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: createMock,
  postJournalEntry: postMock,
}));
vi.mock('@/modules/accounting/services/core/sageMigrationService', () => ({
  startRun: vi.fn().mockResolvedValue('run-1'),
  completeRun: vi.fn(async (_id, total, succeeded, failed, skipped) => ({
    total, succeeded, failed, skipped,
  })),
  failRun: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/captureDeduplicationService', () => ({
  computeFingerprint: vi.fn(() => 'fp'),
}));

import { importLedgerTransactions } from '@/modules/accounting/services/core/sageImportService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

type Line = { glAccountId: string; debit: number; credit: number };
const sum = (ls: Line[], k: 'debit' | 'credit') => ls.reduce((t, l) => t + l[k], 0);

interface SageRow {
  id: string;
  document_number: string;
  transaction_date: string;
  description?: string;
  debit: number;
  credit: number;
  gl_account_id: string;
  ff_project_id?: string | null;
}

/**
 * @param rows            pending sage_ledger_transactions
 * @param alreadyImported id of an existing non-reversed journal for the group,
 *                        i.e. what the idempotency guard finds on a re-import
 */
function withRows(
  rows: SageRow[],
  alreadyImported: string | null = null,
  existingShape?: { line_count: number; total_debit: number },
) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM gl_journal_entries')) {
      return Promise.resolve(alreadyImported ? [{ id: alreadyImported }] : []);
    }
    // Content check behind the relink: does the existing journal actually hold
    // this group's lines? Defaults to matching the group being imported.
    if (text.includes('FROM gl_journal_lines')) {
      const active = rows.filter(r => Number(r.debit) !== 0 || Number(r.credit) !== 0);
      return Promise.resolve([existingShape ?? {
        line_count: active.length,
        total_debit: active.reduce((t, r) => t + Number(r.debit || 0), 0),
      }]);
    }
    return Promise.resolve(rows);
  }) as never);
}

/** Statements handed to `transaction()` — used to inspect status updates. */
function txStatements(): string[] {
  return txMock.mock.calls.flatMap((call) => {
    const build = call[0] as (t: unknown) => unknown[];
    const captured: string[] = [];
    const fakeTag = (strings: TemplateStringsArray) => {
      captured.push(Array.isArray(strings) ? strings.join('') : String(strings));
      return {};
    };
    try { build(fakeTag); } catch { /* shape differences are not the subject */ }
    return captured;
  });
}

function row(over: Partial<SageRow>): SageRow {
  return {
    id: 'row-1',
    document_number: 'INV001',
    transaction_date: '2026-08-13',
    description: 'Sage line',
    debit: 0,
    credit: 0,
    gl_account_id: 'acct-1',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ id: 'je-sage-1' });
  postMock.mockResolvedValue({ id: 'je-sage-1', status: 'posted' });
  txMock.mockResolvedValue([]);
});

describe('importLedgerTransactions', () => {
  it('posts an exactly-balanced group through the posting service', async () => {
    withRows([
      row({ id: 'a', debit: 100, credit: 0, gl_account_id: 'acct-exp' }),
      row({ id: 'b', debit: 0, credit: 100, gl_account_id: 'acct-bank' }),
    ]);

    const result = await importLedgerTransactions(COMPANY, USER);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith(COMPANY, 'je-sage-1', USER);
    const input = createMock.mock.calls[0]![1] as { lines: Line[]; reference: string };
    expect(sum(input.lines, 'debit')).toBe(100);
    expect(sum(input.lines, 'credit')).toBe(100);
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it('REFUSES a two-cent imbalance instead of absorbing it', async () => {
    withRows([
      row({ id: 'a', debit: 100.00, credit: 0 }),
      row({ id: 'b', debit: 0, credit: 100.02 }),
    ]);

    const result = await importLedgerTransactions(COMPANY, USER);

    // Old gate was `> 0.02`, so this posted permanently unbalanced.
    expect(createMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(txStatements().some(s => s.includes("migration_status = 'failed'"))).toBe(true);
  });

  it('does NOT create a posted header for an all-zero group', async () => {
    withRows([
      row({ id: 'a', debit: 0, credit: 0 }),
      row({ id: 'b', debit: 0, credit: 0 }),
    ]);

    const result = await importLedgerTransactions(COMPANY, USER);

    // This is what produced 34 posted 'manual' headers with zero lines in prod.
    expect(createMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
  });

  it('drops zero-value rows from the journal but still clears them off pending', async () => {
    withRows([
      row({ id: 'a', debit: 100, credit: 0 }),
      row({ id: 'b', debit: 0, credit: 100 }),
      row({ id: 'z', debit: 0, credit: 0 }),
    ]);

    await importLedgerTransactions(COMPANY, USER);

    const input = createMock.mock.calls[0]![1] as { lines: Line[] };
    expect(input.lines).toHaveLength(2);
    // A zero row left on 'pending' would be re-selected by every later run.
    const updates = txStatements().filter(s => s.includes("migration_status = 'imported'"));
    expect(updates).toHaveLength(3);
  });

  it('puts SAGE-<doc> in reference, not entry_number', async () => {
    withRows([
      row({ id: 'a', debit: 50, credit: 0 }),
      row({ id: 'b', debit: 0, credit: 50 }),
    ]);

    await importLedgerTransactions(COMPANY, USER);

    // entry_number is UNIQUE per company and the old ref keyed on the document
    // number alone, so the same doc on two dates collided with 23505.
    const input = createMock.mock.calls[0]![1] as { reference: string };
    expect(input.reference).toBe('SAGE-INV001');
  });

  it('imports the same document number on two dates as two separate journals', async () => {
    withRows([
      row({ id: 'a', document_number: 'INV001', transaction_date: '2026-08-13', debit: 50, credit: 0 }),
      row({ id: 'b', document_number: 'INV001', transaction_date: '2026-08-13', debit: 0, credit: 50 }),
      row({ id: 'c', document_number: 'INV001', transaction_date: '2026-09-13', debit: 70, credit: 0 }),
      row({ id: 'd', document_number: 'INV001', transaction_date: '2026-09-13', debit: 0, credit: 70 }),
    ]);

    const result = await importLedgerTransactions(COMPANY, USER);

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ succeeded: 2, failed: 0 });
  });

  // The tag used to live in entry_number under uq_gl_je_company_entry_number,
  // so a second import hit 23505. Moving it to `reference` removed that, and
  // migration_status='pending' does NOT replace it: resetMigration sets every
  // row back to 'pending' and NULLs gl_journal_entry_id WITHOUT reversing the
  // journals, so import → reset → import posted the whole ledger twice, both
  // sets balanced and nothing to catch it.
  it('does NOT re-post a group that already has a journal — it relinks', async () => {
    withRows([
      row({ id: 'a', debit: 100, credit: 0 }),
      row({ id: 'b', debit: 0, credit: 100 }),
    ], 'je-existing');

    const result = await importLedgerTransactions(COMPANY, USER);

    expect(createMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ succeeded: 0, skipped: 1 });
    // The rows are relinked to the journal that already exists, so they leave
    // 'pending' and are not retried forever.
    expect(txStatements().some(s => s.includes("migration_status = 'imported'"))).toBe(true);
  });

  it('REFUSES to relink when the existing journal does not contain the group', async () => {
    // Sage re-syncs a correcting third line onto the same document and date,
    // the operator resets, and the re-import finds the 2-line journal. Relinking
    // blind would mark the new line 'imported' against a journal that does not
    // hold its amount — the row claims to be in the GL and is not.
    withRows([
      row({ id: 'a', debit: 100, credit: 0 }),
      row({ id: 'b', debit: 0, credit: 60 }),
      row({ id: 'c', debit: 0, credit: 40 }),
    ], 'je-existing', { line_count: 2, total_debit: 100 });

    const result = await importLedgerTransactions(COMPANY, USER);

    expect(createMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1, skipped: 0 });
    expect(txStatements().some(s => s.includes("migration_status = 'failed'"))).toBe(true);
  });

  it('marks rows failed when the group throws, so it is not silently retried forever', async () => {
    withRows([
      row({ id: 'a', debit: 100, credit: 0 }),
      row({ id: 'b', debit: 0, credit: 100 }),
    ]);
    createMock.mockRejectedValue(new Error('A line must have a non-zero debit or credit amount'));

    const result = await importLedgerTransactions(COMPANY, USER);

    // The generic catch used to leave rows on 'pending': a group that can never
    // succeed was re-attempted by every future run while the report said failed.
    expect(result).toMatchObject({ failed: 1 });
    expect(txStatements().some(s => s.includes("migration_status = 'failed'"))).toBe(true);
  });

  it('records a group as failed when posting throws, without claiming success', async () => {
    withRows([
      row({ id: 'a', debit: 100, credit: 0 }),
      row({ id: 'b', debit: 0, credit: 100 }),
    ]);
    postMock.mockRejectedValue(new Error('Cannot post to closed fiscal period'));

    const result = await importLedgerTransactions(COMPANY, USER);

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
  });
});

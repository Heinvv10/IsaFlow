/**
 * The background job that reads an uploaded bank statement. It runs after the request committed,
 * outside any transaction and as the pool role with no row-level security, so EVERY statement it
 * issues must name the company; and every move out of 'extracting' is a guarded UPDATE, so a row
 * that was retried, rolled back or deleted meanwhile is never overwritten by a late result.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedBankStatement } from '@/modules/accounting/types/documentCapture.types';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  extract: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: m.info, warn: m.warn, error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankStatementExtraction', () => ({ extractBankStatementFromDocument: m.extract }));

import { StatementReadError } from '@/modules/accounting/services/bank/vlmStatementPages';
import { effectiveExtractionState } from '@/modules/accounting/services/bank/statementExtractionState';
import { runBankStatementExtraction } from '@/modules/accounting/services/bank/bankStatementExtractionJob';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const BANK = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC = 'cccccccc-0000-0000-0000-000000000003';
const IMPORT = 'eeeeeeee-0000-0000-0000-000000000005';
/** The attempt the claimed row holds: a retry bumps it. */
const ATTEMPT = 3;

interface Call { text: string; values: unknown[] }
const calls: Call[] = [];
const squash = (t: string) => t.replace(/::\w+/g, '').replace(/\s+/g, ' ').trim();
const text = (c: Call) => squash(c.text);
const callsOn = (needle: string) => calls.filter((c) => text(c).includes(needle));

/** What the database says, by statement. `claim`/`final` are the rows each guarded statement returns. */
let db: { claim: unknown[]; final: unknown[]; existing: unknown[]; failedRows: unknown[] };

const tx = (date: string | null, description: string, amount: number) => (
  { date, description, amount, balance: null, reference: null, transactionType: null });
const extraction = (over: Partial<ExtractedBankStatement> = {}): ExtractedBankStatement => ({
  bankName: 'FNB', accountNumber: '1', statementPeriod: { from: '2026-03-01', to: '2026-03-31' },
  openingBalance: 100, closingBalance: 70, confidence: 0.85, warnings: ['w1'],
  transactions: [tx('2026-03-05', 'Shop', -10), tx('2026-03-06', 'Fuel', -20)], ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  calls.length = 0;
  db = { claim: [{ bank_account_id: BANK, source_document_id: DOC, extraction_attempt: ATTEMPT }], final: [{ id: IMPORT }], existing: [], failedRows: [{ id: IMPORT }] };
  m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const c = { text: strings.join('?'), values };
    calls.push(c);
    const t = text(c);
    if (t.startsWith('SELECT bank_account_id')) return db.claim;
    if (t.includes('FROM bank_transactions')) return db.existing;
    if (t.includes("status = 'extracted'")) return db.final;
    if (t.includes("SET status = 'failed'")) return db.failedRows;
    return [{ id: IMPORT }];
  });
  m.extract.mockResolvedValue(extraction());
});

describe('runBankStatementExtraction — success', () => {
  it('moves the row from extracting to extracted with the rows, counts and balances', async () => {
    await runBankStatementExtraction(CO, IMPORT);
    const [done] = callsOn("status = 'extracted'");
    expect(done).toBeDefined();
    expect(text(done)).toContain("WHERE id = ? AND company_id = ? AND status = 'extracting'");
    expect(done.values).toContain(IMPORT);
    expect(done.values).toContain(CO);
    expect(done.values).toContain('2026-03-01');
    expect(done.values).toContain(100);
    expect(done.values).toContain(70);
    const summary = JSON.parse(done.values.find((v) => typeof v === 'string' && v.startsWith('{"rows"')) as string) as
      { rows: Array<{ description: string; amount: number }>; warnings: string[] };
    expect(summary.rows.map((r) => [r.description, r.amount])).toEqual([['Shop', -10], ['Fuel', -20]]);
    expect(summary.warnings).toEqual(['w1']);
    expect(done.values).toContain(2);
    expect(text(done)).toContain('extraction_error = NULL, extraction_error_code = NULL');
  });

  it('flags a row that duplicates a bank transaction already on the account and counts it', async () => {
    db.existing = [{ id: 'tx-1', transaction_date: '2026-03-05', amount: -10, description: 'Shop' }];
    await runBankStatementExtraction(CO, IMPORT);
    const [done] = callsOn("status = 'extracted'");
    const summary = JSON.parse(done.values.find((v) => typeof v === 'string' && v.startsWith('{"rows"')) as string) as
      { rows: Array<{ isDuplicate: boolean }> };
    expect(summary.rows.map((r) => r.isDuplicate)).toEqual([true, false]);
    expect(done.values).toContain(1);
    const [dedup] = callsOn('FROM bank_transactions');
    expect(text(dedup)).toContain('company_id = ?');
    expect(dedup.values).toContain(CO);
    expect(dedup.values).toContain(BANK);
  });

  it('keeps no date for a line outside the ledger window and says why', async () => {
    m.extract.mockResolvedValue(extraction({ transactions: [tx('0001-06-01', 'ancient', -10), tx('2026-03-05', 'modern', -11)] }));
    await runBankStatementExtraction(CO, IMPORT);
    const [done] = callsOn("status = 'extracted'");
    const summary = JSON.parse(done.values.find((v) => typeof v === 'string' && v.startsWith('{"rows"')) as string) as
      { rows: Array<{ date: string }>; warnings: string[] };
    expect(summary.rows.map((r) => r.date)).toEqual(['', '2026-03-05']);
    expect(summary.warnings.join(' ')).toMatch(/0001-06-01 is outside 1900-01-01 to 2199-12-31 \(ancient\)/);
  });

  it('reads the document, and asks the extractor for it, by company', async () => {
    await runBankStatementExtraction(CO, IMPORT);
    expect(m.extract.mock.calls[0][0]).toBe(CO);
    expect(m.extract.mock.calls[0][1]).toBe(DOC);
  });

  it('logs by outcome: a result that matched no row is not reported as complete', async () => {
    db.final = [];
    await runBankStatementExtraction(CO, IMPORT);
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('no longer extracting'), expect.anything(), expect.anything());
    expect(m.info.mock.calls.map((c) => String(c[0])).join('|')).not.toContain('extraction complete');
  });
});

describe('runBankStatementExtraction — claim', () => {
  it('does nothing for a row that is not extracting (retried, rolled back, deleted)', async () => {
    db.claim = [];
    await runBankStatementExtraction(CO, IMPORT);
    expect(m.extract).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(text(calls[0])).toContain("company_id = ? AND status = 'extracting'");
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('no longer extracting'), expect.anything(), expect.anything());
  });
});

describe('runBankStatementExtraction — failure', () => {
  const failedWith = () => {
    const [failed] = callsOn("SET status = 'failed'");
    return failed;
  };

  it('stores the user-safe message and code of a read error, guarded to extracting', async () => {
    m.extract.mockRejectedValue(new StatementReadError('too_many_pages', 'This statement has 31 pages; the most IsaFlow reads is 20.'));
    await expect(runBankStatementExtraction(CO, IMPORT)).resolves.toBeUndefined();
    const f = failedWith();
    expect(f.values).toContain('This statement has 31 pages; the most IsaFlow reads is 20.');
    expect(f.values).toContain('too_many_pages');
    expect(text(f)).toContain("WHERE id = ? AND company_id = ? AND status = 'extracting'");
    expect(f.values).toContain(CO);
  });

  it('fails with its own retryable code when the read found no transaction at all (never ends extracted with 0 rows)', async () => {
    m.extract.mockResolvedValue(extraction({ transactions: [] }));
    await runBankStatementExtraction(CO, IMPORT);
    expect(callsOn("status = 'extracted'")).toEqual([]);
    const f = failedWith();
    expect(f.values).toContain('no_transactions');
    const message = f.values.find((v) => typeof v === 'string' && v.startsWith('No transactions were found')) as string;
    expect(message).toContain('no activity there is nothing to import');
    expect(message).toContain('retry the import');
    expect(effectiveExtractionState({ status: 'failed', extraction_error: message, extraction_error_code: 'no_transactions' }).retryable).toBe(true);
  });

  it('hides an unexpected error behind a generic message', async () => {
    m.extract.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.9:5432'));
    await runBankStatementExtraction(CO, IMPORT);
    const f = failedWith();
    expect(f.values).toContain('The statement could not be read. Retry the import.');
    expect(JSON.stringify(f.values)).not.toContain('ECONNREFUSED');
  });

  it('fails the row when saving the result throws (nothing is left extracting)', async () => {
    m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const c = { text: strings.join('?'), values };
      calls.push(c);
      const t = text(c);
      if (t.startsWith('SELECT bank_account_id')) return db.claim;
      if (t.includes('FROM bank_transactions')) return [];
      if (t.includes("status = 'extracted'")) throw new Error('invalid input syntax for type date');
      return [{ id: IMPORT }];
    });
    await runBankStatementExtraction(CO, IMPORT);
    expect(failedWith()).toBeDefined();
  });

  it('does not throw even when recording the failure fails', async () => {
    m.extract.mockRejectedValue(new Error('boom'));
    m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const t = squash(strings.join('?'));
      if (t.startsWith('SELECT bank_account_id')) return db.claim;
      throw new Error('db down');
    });
    await expect(runBankStatementExtraction(CO, IMPORT)).resolves.toBeUndefined();
  });
});

describe('runBankStatementExtraction — heartbeat', () => {
  it('records each page read on the row, guarded to this company and to extracting', async () => {
    m.extract.mockImplementation(async (_co: string, _doc: string, onProgress: (d: number, t: number) => Promise<void>) => {
      await onProgress(3, 12);
      return extraction();
    });
    await runBankStatementExtraction(CO, IMPORT);
    const [beat] = callsOn('extraction_heartbeat_at = NOW()');
    expect(beat).toBeDefined();
    expect(text(beat)).toContain("WHERE id = ? AND company_id = ? AND status = 'extracting'");
    expect(text(beat)).toContain('extraction_pages_done = ?, extraction_pages_total = ?');
    expect(beat.values).toEqual([3, 12, IMPORT, CO, ATTEMPT]);
  });
});

describe('every statement the job issues', () => {
  it('names the company', async () => {
    m.extract.mockImplementation(async (_co: string, _doc: string, onProgress: (d: number, t: number) => Promise<void>) => {
      await onProgress(1, 2);
      return extraction();
    });
    await runBankStatementExtraction(CO, IMPORT);
    m.extract.mockRejectedValue(new Error('x'));
    await runBankStatementExtraction(CO, IMPORT);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) {
      expect(text(c), text(c)).toContain('company_id = ?');
      expect(c.values, text(c)).toContain(CO);
    }
  });
});

describe('a read that was retried meanwhile (extraction_attempt)', () => {
  const guarded = (c: Call) => {
    expect(text(c), text(c)).toContain('AND extraction_attempt = ?');
    expect(c.values, text(c)).toContain(ATTEMPT);
  };

  it('claims the row and learns its attempt', async () => {
    await runBankStatementExtraction(CO, IMPORT);
    expect(text(calls[0])).toMatch(/^SELECT bank_account_id, source_document_id, extraction_attempt FROM/);
  });

  it('writes its result only while it still holds the attempt it claimed', async () => {
    await runBankStatementExtraction(CO, IMPORT);
    guarded(callsOn("status = 'extracted'")[0]!);
  });

  it('records its failure only while it still holds the attempt it claimed', async () => {
    m.extract.mockRejectedValue(new Error('x'));
    await runBankStatementExtraction(CO, IMPORT);
    guarded(callsOn("SET status = 'failed'")[0]!);
  });

  it('beats only while it still holds the attempt it claimed', async () => {
    m.extract.mockImplementation(async (_co: string, _doc: string, onProgress: (d: number, t: number) => Promise<void>) => {
      await onProgress(1, 2);
      return extraction();
    });
    await runBankStatementExtraction(CO, IMPORT);
    guarded(callsOn('extraction_heartbeat_at = NOW()')[0]!);
  });

  it('a late failure of the old read leaves the retried row alone (no row matched, nothing thrown)', async () => {
    m.extract.mockRejectedValue(new Error('x'));
    db.failedRows = [];
    await expect(runBankStatementExtraction(CO, IMPORT)).resolves.toBeUndefined();
    expect(m.info).toHaveBeenCalledWith('bankStatementOcr: extraction failed', expect.objectContaining({ recorded: false }), 'bank-stmt-ocr');
  });
});

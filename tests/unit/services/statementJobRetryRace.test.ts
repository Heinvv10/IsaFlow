/**
 * A stale 'extracting' row can be retried while the job that was reading it is still alive (a slow VLM, not
 * a dead process). The retry re-arms the row (extraction_attempt + 1) and a second job reads it. The first job
 * must then change NOTHING: not fail the row, not finish it, not beat its heartbeat.
 *
 * The fake database below keeps ONE row and evaluates the guards in the statements the jobs really issue
 * (status and extraction_attempt in the WHERE clause), so this fails when a guard is missing, whatever the
 * wording of the statement. The sibling job tests pin the wording; this one pins the effect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), extractBank: vi.fn(), extractSupplier: vi.fn() }));
vi.mock('@/lib/neon', () => ({
  sql: m.sql,
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(m.sql),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankStatementExtraction', () => ({ extractBankStatementFromDocument: m.extractBank }));
vi.mock('@/modules/accounting/services/capture/supplierStatementExtraction', () => ({ extractSupplierStatementFromDocument: m.extractSupplier }));
vi.mock('@/modules/accounting/services/capture/supplierStatementMeasure', () => ({ measureOurSide: async () => ({ isaflowBalance: 0, variance: 0 }) }));
vi.mock('@/modules/accounting/services/capture/supplierStatementReconDb', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/supplierStatementReconDb')>()),
  loadSupplierInvoices: async () => [],
}));

import { effectiveExtractionState } from '@/modules/accounting/services/bank/statementExtractionState';
import { runBankStatementExtraction } from '@/modules/accounting/services/bank/bankStatementExtractionJob';
import { runSupplierStatementExtraction } from '@/modules/accounting/services/capture/supplierStatementExtractionJob';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const ROW = 'eeeeeeee-0000-0000-0000-000000000005';

interface Row { status: string; attempt: number; heartbeats: number; lastBeat: number; error: string | null; finished: boolean; lineWrites: number }
let row: Row;

/** Render a statement with its values inlined, so a guard is read from the text the database would see. */
function render(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? JSON.stringify(values[i]) : ''), '').replace(/::\w+/g, '').replace(/\s+/g, ' ');
}
/** Whether the row satisfies the status and attempt tests this statement's WHERE clause carries. */
function matches(sqlText: string): boolean {
  const where = sqlText.slice(sqlText.indexOf('WHERE'));
  const status = /status = '(\w+)'/.exec(where);
  const attempt = /extraction_attempt = (\d+)/.exec(where);
  return (!status || status[1] === row.status) && (!attempt || Number(attempt[1]) === row.attempt);
}

beforeEach(() => {
  vi.resetAllMocks();
  row = { status: 'extracting', attempt: 3, heartbeats: 0, lastBeat: Date.now(), error: null, finished: false, lineWrites: 0 };
  m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const t = render(strings, values);
    if (t.includes('supplier_statement_lines')) { row.lineWrites += 1; return []; }
    if (t.includes('FROM bank_transactions')) return [];
    if (t.trimStart().startsWith('SELECT')) {
      // the claim and the supplier's lock both name status = 'extracting'
      return row.status === 'extracting' && matches(t) ? [{ id: ROW, supplier_id: 's', bank_account_id: 'b', source_document_id: 'd', extraction_attempt: row.attempt }] : [];
    }
    if (!matches(t)) return [];
    if (t.includes("SET status = 'failed'")) { row.status = 'failed'; row.error = 'x'; }
    else if (t.includes("status = 'extracted'") || t.includes("status = 'unreconciled'")) { row.status = 'finished'; row.finished = true; }
    else if (t.includes('extraction_heartbeat_at = NOW()')) { row.heartbeats += 1; row.lastBeat = Date.now(); }
    return [{ id: ROW }];
  });
});

/** The row as the retry left it, untouched by the job that was reading before it. */
function expectRetriedRowUntouched() {
  expect(row.status).toBe('extracting');
  expect(row.attempt).toBe(4);
  expect(row.error).toBeNull();
  expect(row.finished).toBe(false);
  expect(row.heartbeats).toBe(0);
  expect(row.lineWrites).toBe(0);
}
const retryWhileReading = () => { row.attempt += 1; };

type Progress = (done: number, total: number) => Promise<void>;
const bankStatement = { bankName: null, accountNumber: null, statementPeriod: null, openingBalance: null, closingBalance: null, confidence: 1, warnings: [], transactions: [{ date: '2026-03-05', description: 'x', amount: -1, balance: null, reference: null, transactionType: null }] };
const supplierStatement = { supplierName: 'A', statementDate: '2026-03-31', periodStart: null, periodEnd: null, openingBalance: 0, closingBalance: 1, warnings: [], lines: [{ date: '2026-03-02', reference: 'I', description: 'w', debit: 1 }] };

describe.each([
  ['bank', runBankStatementExtraction, m.extractBank, bankStatement],
  ['supplier', runSupplierStatementExtraction, m.extractSupplier, supplierStatement],
] as const)('the %s job, when its row is re-armed by a retry while it reads', (_kind, run, extract, statement) => {
  it('finishing late writes nothing', async () => {
    extract.mockImplementation(async () => { retryWhileReading(); return statement; });
    await run(CO, ROW);
    expectRetriedRowUntouched();
  });

  it('failing late does not fail the retried row', async () => {
    extract.mockImplementation(async () => { retryWhileReading(); throw new Error('boom'); });
    await run(CO, ROW);
    expectRetriedRowUntouched();
  });

  it('a late heartbeat does not touch the retried row', async () => {
    extract.mockImplementation(async (_co: string, _doc: string, onProgress: Progress) => {
      retryWhileReading();
      await onProgress(1, 2);
      return statement;
    });
    await run(CO, ROW);
    expectRetriedRowUntouched();
  });

  it('control: with no retry the same job finishes the row', async () => {
    extract.mockResolvedValue(statement);
    await run(CO, ROW);
    expect(row.finished).toBe(true);
  });
});

describe.each([
  ['bank', runBankStatementExtraction, m.extractBank, bankStatement],
  ['supplier', runSupplierStatementExtraction, m.extractSupplier, supplierStatement],
] as const)('the %s job, while it waits behind other reads for a VLM slot', (_kind, run, extract, statement) => {
  const minutes = (n: number) => n * 60_000;
  const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  const shownAs = () => effectiveExtractionState({ status: row.status, extraction_heartbeat_at: new Date(row.lastBeat) }).status;

  beforeEach(() => { vi.useFakeTimers(); row.lastBeat = Date.now(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is never shown as interrupted during a 20 minute wait that finishes no page', async () => {
    extract.mockImplementation(async () => { await wait(minutes(20)); return statement; });
    const job = run(CO, ROW);
    for (let minute = 1; minute <= 19; minute += 1) {
      await vi.advanceTimersByTimeAsync(minutes(1));
      expect(shownAs(), `minute ${minute}`).toBe('extracting');
    }
    await vi.advanceTimersByTimeAsync(minutes(1));
    await job;
    expect(row.finished).toBe(true);
  });

  it('stops beating when the job fails, so the row it leaves is judged by its last sign of life', async () => {
    extract.mockImplementation(async () => { await wait(minutes(3)); throw new Error('boom'); });
    const job = run(CO, ROW);
    await vi.advanceTimersByTimeAsync(minutes(3));
    await job;
    const beats = row.heartbeats;
    await vi.advanceTimersByTimeAsync(minutes(30));
    expect(row.heartbeats).toBe(beats);
  });

  it('does not keep beating a row a retry has re-armed meanwhile', async () => {
    extract.mockImplementation(async () => { await wait(minutes(1) + 30_000); retryWhileReading(); await wait(minutes(10)); return statement; });
    const job = run(CO, ROW);
    await vi.advanceTimersByTimeAsync(minutes(1));
    expect(row.heartbeats).toBe(1); // beat at 1 minute, before the retry
    await vi.advanceTimersByTimeAsync(minutes(11));
    await job;
    expect(row.heartbeats).toBe(1);
    expect(row.attempt).toBe(4);
    expect(row.finished).toBe(false);
  });
});

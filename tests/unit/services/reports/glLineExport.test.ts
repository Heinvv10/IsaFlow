/**
 * Flat GL-line export (ledger brief §4 v1 / §9) — the parts that do not need a
 * database: the row contract, the fiscal calendar per company, the CSV cell
 * rules, the MCP tool's paging / summary / scope handling, and the CSV route's
 * streaming (backpressure, a failure after the first byte, headers).
 *
 * The SQL — tenancy on every join, keyset order, the summary predicate — runs
 * against a real database in tests/integration/gl-line-export.int.test.ts.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const logError = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: (...a: unknown[]) => logError(...a), warn: vi.fn(), debug: vi.fn() } }));
// Each page's financial years are the registry's (March-based unless a test sets fakeRegistry).
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../../helpers/fiscalYearSqlFake')).registryMock());
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-10-09T08:00:00.000Z'),
}));
// The auth wrapper is the identity here; its Bearer / cookie / scope behaviour on
// this route is tests/unit/api/glLinesExportAuth.test.ts.
vi.mock('@/lib/auth/withBearerOrCookieAuth', () => ({ withBearerOrCookieAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn().mockResolvedValue(true) }));

import {
  GL_LINE_EXPORT_COLUMNS,
  GL_LINE_EXPORT_SCHEMA_VERSION,
  csvLine,
  exportCell,
  journalTypeOf,
  periodOf,
  toExportRow,
} from '@/modules/accounting/services/reports/glLineExportRows';
import { nextCursorOf } from '@/modules/accounting/services/reports/glLineExportService';
import { withFiscalYears } from '@/modules/accounting/services/reports/glLineExportFiscalYears';
import { fakeRegistry, resetFakeRegistry, TRANSITION_YEARS } from '../../../helpers/fiscalYearSqlFake';
import { GlExportScopeRefusal, exportGlLinesTool } from '@/lib/mcp/tools/exportGlLines';
import { REFUSAL_CODES } from '@/lib/mcp/tools/refusalCodes';
import type { McpToolContext } from '@/lib/mcp/types';
import handler from '../../../../pages/api/accounting/gl-lines-export';

const CO = '11111111-1111-4111-8111-111111111111';
const CTX = { userId: 'u1', companyId: CO, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
const payload = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sqlText = (call: unknown[]) => (Array.isArray(call[0]) ? (call[0] as string[]).join('$') : '');
const callsMatching = (needle: string) => sqlMock.mock.calls.filter((c) => sqlText(c).includes(needle)).length;

/** A synthetic ledger of `n` lines in balanced pairs, in page order. */
function ledger(n: number) {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const entry = Math.floor(i / 2);
    const amount = 100 + entry;
    rows.push({
      line_id: uuid(i + 1), entry_id: uuid(10_000 + entry), entry_date: `2026-04-${String(1 + (entry % 28)).padStart(2, '0')}`,
      debit: i % 2 === 0 ? amount : 0, credit: i % 2 === 0 ? 0 : amount,
      entry_number: `JE-2026-${String(entry).padStart(5, '0')}`, source: 'manual', status: 'posted',
      account_code: i % 2 === 0 ? '5000' : '1100', account_name: 'acc', is_cash: i % 2 === 1, period_locked: false,
    });
  }
  return rows.sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date))
    || String(a.entry_id).localeCompare(String(b.entry_id)) || String(a.line_id).localeCompare(String(b.line_id)));
}

/** Route the export's queries; the page query honours the cursor and LIMIT. failPage: every page after the first fails. */
function routeSql(rows: Array<Record<string, unknown>>, failPage = false) {
  sqlMock.mockImplementation((strings: TemplateStringsArray | undefined, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('$') : '';
    if (text.includes('AS row_count')) {
      return Promise.resolve([{
        row_count: rows.length, posted_row_count: rows.length, txn_count: new Set(rows.map((r) => r.entry_id)).size,
        control_total: '0.00', unbalanced_txn_count: 0,
        first_date: rows[0]?.entry_date ?? null, last_date: rows.at(-1)?.entry_date ?? null,
      }]);
    }
    if (text.includes('FROM companies')) return Promise.resolve([{ name: 'Velocity Fibre (Pty) Ltd' }]);
    if (text.includes('WITH page AS')) {
      // Bound values: company x2, from x2, to x2, postedOnly, cDate x2, cEntry, cLine, limit, ...
      const [cDate, cEntry, cLine, limit] = [values[7], values[9], values[10], values[11]] as [string | null, string, string, number];
      if (failPage && cDate !== null) return Promise.reject(new Error('connection terminated'));
      const after = cDate === null ? rows : rows.filter((r) =>
        [String(r.entry_date), String(r.entry_id), String(r.line_id)].join('|') > [cDate, cEntry, cLine].join('|'));
      return Promise.resolve(after.slice(0, limit));
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => { sqlMock.mockReset(); logError.mockReset(); });

describe('export_gl_lines — paging and the summary', () => {
  it('pages to exhaustion over every line once, with the summary on the first page only', async () => {
    routeSql(ledger(1_037));
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    const summaries: unknown[] = [];
    do {
      const body = payload(await exportGlLinesTool.handler({ limit: 250, ...(cursor ? { cursor } : {}) }, CTX));
      expect(body.completenessFault).toBeUndefined();
      expect(body.rowsTotal).toBe(1_037);
      summaries.push(body.summary);
      const idx = (body.columns as string[]).indexOf('Line_ID');
      for (const r of body.rows as unknown[][]) seen.add(String(r[idx]));
      cursor = (body.next_cursor as string | null) ?? undefined;
      pages++;
    } while (cursor !== undefined && pages < 50);
    expect(seen.size).toBe(1_037);
    expect(pages).toBe(5);
    expect((summaries[0] as { rowCount: number }).rowCount).toBe(1_037);
    expect(summaries.slice(1)).toEqual([null, null, null, null]);
    // The whole-window aggregate ran once, not once per page.
    expect(callsMatching('AS row_count')).toBe(1);
  });

  it('detail summary returns the control block and no rows', async () => {
    routeSql(ledger(10));
    const body = payload(await exportGlLinesTool.handler({ detail: 'summary' }, CTX));
    expect(body.rows).toEqual([]);
    expect((body.summary as { rowCount: number }).rowCount).toBe(10);
    expect(body.truncated).toBe(false);
  });

  it('rejects a forged cursor before any query', async () => {
    routeSql(ledger(2));
    const r = await exportGlLinesTool.handler({ cursor: 'bm90LWEtY3Vyc29y' }, CTX);
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('export_gl_lines table=counterparties needs read:contacts', () => {
  it('refuses read:reports alone with a registered code, before any query', async () => {
    const err = await exportGlLinesTool.handler({ table: 'counterparties' }, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlExportScopeRefusal);
    expect(REFUSAL_CODES.has((err as GlExportScopeRefusal).code)).toBe(true);
    expect((err as Error).message).toContain('read:contacts');
    expect(sqlMock).not.toHaveBeenCalled();
  });
  // Served with read:contacts: tests/integration/gl-line-export.int.test.ts.
});

describe('the CSV route streams with backpressure and fails loudly mid-stream', () => {
  function fakeRes(writeResults: boolean[] = []) {
    const res = Object.assign(new EventEmitter(), {
      headers: {} as Record<string, string>,
      headersSent: false,
      writableEnded: false,
      chunks: [] as string[],
      setHeader(k: string, v: string) { res.headers[k] = v; return res; },
      status() { return res; },
      write: vi.fn((c: string) => { res.headersSent = true; res.chunks.push(c); return writeResults.shift() ?? true; }),
      end: vi.fn(() => { res.writableEnded = true; }),
      destroy: vi.fn(),
      json: vi.fn(),
    });
    return res;
  }
  const run = (res: ReturnType<typeof fakeRes>, query: Record<string, string> = {}) =>
    (handler as unknown as (q: unknown, s: unknown) => Promise<void>)({ method: 'GET', query, companyId: CO }, res);

  it('writes header + every line, no X-Row-Count, Cache-Control no-store', async () => {
    routeSql(ledger(12_345));
    const res = fakeRes();
    await run(res);
    const lines = res.chunks.join('').split('\n').filter((l) => l !== '');
    expect(lines[0]).toBe(GL_LINE_EXPORT_COLUMNS.join(','));
    expect(lines.length - 1).toBe(12_345);
    expect(res.headers['X-Row-Count']).toBeUndefined();
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['X-Control-Total']).toBe('0.00');
    expect(res.headers['X-Schema-Version']).toBe(GL_LINE_EXPORT_SCHEMA_VERSION);
    expect(res.end).toHaveBeenCalled();
  });

  it('reads the first page before the header, then waits for drain before reading the next', async () => {
    routeSql(ledger(5_001));
    const res = fakeRes([false]);
    const done = run(res);
    await vi.waitFor(() => expect(res.write).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 25));
    expect(callsMatching('WITH page AS')).toBe(1);
    res.emit('drain');
    await done;
    expect(callsMatching('WITH page AS')).toBe(2);
    expect(res.end).toHaveBeenCalled();
  });

  it('a page failure after the header destroys the connection and logs, instead of ending a short file', async () => {
    routeSql(ledger(5_001), true);
    const res = fakeRes();
    await run(res);
    expect(res.destroy).toHaveBeenCalledWith(expect.any(Error));
    expect(res.end).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });

  it('a client gone while waiting for drain stops the export: no further read, nothing logged as a failure', async () => {
    routeSql(ledger(5_001));
    const res = fakeRes([false]);
    const done = run(res);
    await vi.waitFor(() => expect(res.write).toHaveBeenCalledTimes(1));
    res.emit('close');
    await done;
    expect(callsMatching('WITH page AS')).toBe(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('a failure before the first byte propagates (the error handler answers 500)', async () => {
    sqlMock.mockRejectedValue(new Error('db down'));
    const res = fakeRes();
    await expect(run(res)).rejects.toThrow('db down');
    expect(res.write).not.toHaveBeenCalled();
  });
});

describe('row shape', () => {
  const entity = { name: 'Velocity Fibre (Pty) Ltd' };

  it('signs, VAT identity, FY, bank account on cash lines, linked documents', () => {
    const credit = toExportRow({
      line_id: uuid(1), entry_id: uuid(2), entry_date: '2025-03-17', debit: '0.00', credit: '1150.00',
      entry_number: 'JE-2025-00001', source: 'auto_supplier_payment', status: 'posted', vat_type: null,
      account_code: '1544331', account_name: 'Bank VF1', account_type: 'asset', is_cash: true, period_locked: true,
      fy_label: 'FY26', fy_period_no: 1,
      cc2_code: null, counterparty_name: 'Glowmark', counterparty_type: 'Supplier', linked_document_count: '2',
    }, entity);
    expect(credit.Amount_Excl_VAT).toBe(-1150);
    expect(credit.Debit_Credit).toBe('CR');
    expect(credit.Amount_Incl_VAT).toBe((credit.Amount_Excl_VAT as number) + (credit.VAT_Amount as number));
    expect(credit.FY).toBe('FY26');
    expect(credit.FY_Period_No).toBe(1);
    expect(credit.Period).toBe('2025-03-01');
    expect(credit.Bank_Account_Code).toBe('1544331');
    expect(credit.Journal_Type).toBe('Bank');
    expect(credit.Posting_Status).toBe('Posted');
    expect(credit.Period_Locked).toBe(true);
    expect(credit.Txn_ID).toBe('JE-2025-00001');
    expect(credit.Entity).toBe('Velocity Fibre (Pty) Ltd');
    expect(credit.Linked_Document_Count).toBe(2);
    expect(credit.Schema_Version).toBe(GL_LINE_EXPORT_SCHEMA_VERSION);
    expect(credit.CC2_Code).toBeNull();
    // FY and FY_Period_No are the row's registry year, not derived from a start month here.
    expect(toExportRow({ ...credit, fy_label: 'FY27', fy_period_no: 14 }, entity)).toMatchObject({ FY: 'FY27', FY_Period_No: 14 });
    // pgTypes parses DATE as a string; a Date (a local-midnight one, as a raw
    // driver hands back) keeps its calendar day — on this UTC+2 host the UTC
    // day would be the 31st of March.
    expect(toExportRow({ ...credit, entry_date: new Date(2025, 3, 1) }, entity).Txn_Date).toBe('2025-04-01');
  });

  it('Period is the first of the transaction month', () => {
    expect(periodOf('2026-02-28')).toBe('2026-02-01');
    expect(periodOf('2025-12-31')).toBe('2025-12-01');
  });
});

describe('FY and FY_Period_No come from the registry year holding the date', () => {
  const rows = (...dates: string[]) => dates.map((d) => ({ entry_date: d }));
  const fy = async (...dates: string[]) =>
    (await withFiscalYears('c1', rows(...dates))).map((r) => [r.fy_label, r.fy_period_no]);

  beforeEach(() => { resetFakeRegistry(); });

  it('names the year by the calendar year it ENDS in: March year', async () => {
    expect(await fy('2026-02-28', '2026-03-01', '2026-10-09')).toEqual([['FY26', 12], ['FY27', 1], ['FY27', 8]]);
  });

  it('follows a July year', async () => {
    fakeRegistry.years = []; fakeRegistry.templateMonth = 7;
    expect(await fy('2025-06-30', '2025-07-01', '2026-01-15')).toEqual([['FY25', 12], ['FY26', 1], ['FY26', 7]]);
  });

  it('is the calendar year for a January year', async () => {
    fakeRegistry.years = []; fakeRegistry.templateMonth = 1;
    expect(await fy('2025-12-31', '2026-01-01')).toEqual([['FY25', 12], ['FY26', 1]]);
  });

  it('opens a December-start year in December', async () => {
    fakeRegistry.years = []; fakeRegistry.templateMonth = 12;
    expect(await fy('2025-12-01', '2025-11-30')).toEqual([['FY26', 1], ['FY25', 12]]);
  });

  it('counts a 14-month transition year 1 to 14, and keeps a past year on its stored dates', async () => {
    fakeRegistry.years = TRANSITION_YEARS; fakeRegistry.templateMonth = undefined;
    expect(await fy('2025-12-31', '2026-01-01', '2027-02-28', '2027-03-01'))
      .toEqual([['FY26', 12], ['FY27', 1], ['FY27', 14], ['FY28', 1]]);
  });

  it('resolves a page spanning two years once per year, not once per line', async () => {
    const { fiscalYearForDate } = await import('@/modules/accounting/services/gl/fiscalYearRegistry');
    vi.mocked(fiscalYearForDate).mockClear();
    await fy('2026-01-05', '2026-01-06', '2026-02-10', '2026-03-05', '2026-03-06');
    expect(fiscalYearForDate).toHaveBeenCalledTimes(2);
  });

  it('does not touch the row\'s other columns', async () => {
    const [out] = await withFiscalYears('c1', [{ entry_date: '2026-03-01', line_id: 'L1', debit: '5' }]);
    expect(out).toMatchObject({ line_id: 'L1', debit: '5', entry_date: '2026-03-01' });
  });
});

describe('row shape (continued)', () => {
  it('journal types per source, credit notes by side', () => {
    expect(journalTypeOf('auto_supplier_invoice', null)).toBe('Supplier invoice');
    expect(journalTypeOf('auto_credit_note', 'supplier')).toBe('Supplier credit note');
    expect(journalTypeOf('auto_credit_note', 'customer')).toBe('Customer credit note');
    expect(journalTypeOf('auto_depreciation', null)).toBe('Depreciation');
    expect(journalTypeOf('something_new', null)).toBe('Journal');
  });

  it('CSV cells: negative decimals raw, text quoted and formula-guarded, blank is blank', () => {
    expect(exportCell('Amount_Excl_VAT', -1150)).toBe('-1150.00');
    expect(exportCell('Amount_Excl_VAT', 0.1 + 0.2)).toBe('0.30');
    expect(exportCell('FY_Period_No', 7)).toBe('7');
    expect(exportCell('Linked_Document_Count', 2)).toBe('2');
    expect(exportCell('Counterparty_Name', 'Say "hi", ok')).toBe('"Say ""hi"", ok"');
    for (const lead of ['=', '+', '-', '@', '|', '\t', '\r']) {
      expect(exportCell('Line_Description', `${lead}cmd`)).toBe(`"'${lead}cmd"`);
    }
    expect(exportCell('Line_Description', '=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(exportCell('Line_Description', ' =1+1')).toBe('" =1+1"');
    expect(exportCell('CC2_Code', null)).toBe('');
    expect(exportCell('Period_Locked', false)).toBe('false');
    expect(csvLine(['a', 'b'], { a: 1, b: null })).toBe('1.00,');
  });

  it('nextCursorOf stops on a short page', () => {
    const rows = ledger(3);
    expect(nextCursorOf(rows, 5)).toBeNull();
    expect(nextCursorOf(rows, 3)).toEqual({
      entryDate: String(rows[2]!.entry_date), entryId: String(rows[2]!.entry_id), lineId: String(rows[2]!.line_id),
    });
  });
});

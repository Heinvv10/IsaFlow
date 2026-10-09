/**
 * Flat GL-line export (ledger brief §4 v1 / §9).
 *
 *   - Paging to exhaustion yields exactly the summary's rowCount — the GL line
 *     count for the window — through both the MCP tool and the CSV endpoint.
 *   - Amounts are signed (debit positive, credit negative) and written as plain
 *     decimals: the shared csvCell would prefix a credit's minus with a quote.
 *   - FY runs March–February and is named by the year it ends.
 *   - Every row satisfies incl = excl + VAT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-10-09T08:00:00.000Z'),
}));

import {
  GL_LINE_EXPORT_COLUMNS,
  GL_LINE_EXPORT_SCHEMA_VERSION,
  csvLine,
  exportCell,
  fiscalOf,
  journalTypeOf,
  nextCursorOf,
  toExportRow,
} from '@/modules/accounting/services/reports/glLineExportService';
import { exportGlLinesTool } from '@/lib/mcp/tools/exportGlLines';
import type { McpToolContext } from '@/lib/mcp/types';

const CO = '11111111-1111-4111-8111-111111111111';
const CTX = { userId: 'u1', companyId: CO, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
const payload = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A synthetic ledger of `n` lines in balanced pairs, as the page query returns them. */
function ledger(n: number) {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const entry = Math.floor(i / 2);
    const amount = 100 + entry;
    rows.push({
      line_id: uuid(i + 1), entry_id: uuid(10_000 + entry), entry_date: `2026-04-${String(1 + (entry % 28)).padStart(2, '0')}`,
      debit: i % 2 === 0 ? amount : 0, credit: i % 2 === 0 ? 0 : amount,
      entry_number: `JE-2026-${String(entry).padStart(5, '0')}`, source: 'manual', status: 'posted',
      account_code: i % 2 === 0 ? '5000' : '1100', account_name: 'acc', account_type: i % 2 === 0 ? 'expense' : 'asset',
      is_cash: i % 2 === 1, period_locked: false,
    });
  }
  rows.sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date))
    || String(a.entry_id).localeCompare(String(b.entry_id)) || String(a.line_id).localeCompare(String(b.line_id)));
  return rows;
}

/** Route the export's three queries; the page query honours the cursor and LIMIT. */
function routeSql(rows: Array<Record<string, unknown>>) {
  sqlMock.mockImplementation((strings: TemplateStringsArray | undefined, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('$') : '';
    if (text.includes('AS row_count')) {
      return Promise.resolve([{
        row_count: rows.length, posted_row_count: rows.length,
        txn_count: new Set(rows.map((r) => r.entry_id)).size, control_total: '0.00',
        unbalanced_txn_count: 0, first_date: rows[0]?.entry_date ?? null, last_date: rows.at(-1)?.entry_date ?? null,
      }]);
    }
    if (text.includes('SELECT name FROM companies')) return Promise.resolve([{ name: 'Velocity Fibre (Pty) Ltd' }]);
    if (text.includes('WITH page AS')) {
      // Bound values in order: company x2, from x2, to x2, postedOnly, cDate x2, cEntry, cLine, limit, ...
      const cDate = values[7] as string | null;
      const cEntry = values[9] as string | null;
      const cLine = values[10] as string | null;
      const limit = values[11] as number;
      const after = cDate === null
        ? rows
        : rows.filter((r) => [String(r.entry_date), String(r.entry_id), String(r.line_id)].join('|')
          > [cDate, cEntry, cLine].join('|'));
      return Promise.resolve(after.slice(0, limit));
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => sqlMock.mockReset());

describe('export row count equals the GL line count for the window', () => {
  it('paging export_gl_lines to exhaustion yields exactly summary.rowCount distinct lines', async () => {
    const rows = ledger(1_037);
    routeSql(rows);
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let rowCount = -1;
    do {
      const body = payload(await exportGlLinesTool.handler(
        { date_from: '2026-04-01', date_to: '2026-04-30', limit: 250, ...(cursor ? { cursor } : {}) }, CTX,
      ));
      rowCount = (body.summary as { rowCount: number }).rowCount;
      expect(body.completenessFault).toBeUndefined();
      const lineIdx = (body.columns as string[]).indexOf('Line_ID');
      for (const r of body.rows as unknown[][]) seen.add(String(r[lineIdx]));
      cursor = (body.next_cursor as string | null) ?? undefined;
      pages++;
    } while (cursor !== undefined && pages < 50);
    expect(rowCount).toBe(1_037);
    expect(seen.size).toBe(1_037);
    expect(pages).toBe(5);
  });

  it('the signed amounts of a balanced ledger sum to the zero control total', async () => {
    const rows = ledger(40);
    routeSql(rows);
    const body = payload(await exportGlLinesTool.handler({ limit: 500 }, CTX));
    const idx = (body.columns as string[]).indexOf('Amount_Excl_VAT');
    const cents = (body.rows as unknown[][]).reduce((s, r) => s + Math.round(Number(r[idx]) * 100), 0);
    expect(cents).toBe(0);
    expect((body.summary as { controlTotal: number }).controlTotal).toBe(0);
  });

  it('detail summary returns the control block and no rows', async () => {
    routeSql(ledger(10));
    const body = payload(await exportGlLinesTool.handler({ detail: 'summary' }, CTX));
    expect(body.rows).toEqual([]);
    expect((body.summary as { rowCount: number }).rowCount).toBe(10);
    expect(body.truncated).toBe(false);
  });

  it('rejects a forged cursor', async () => {
    routeSql(ledger(2));
    const r = await exportGlLinesTool.handler({ cursor: 'bm90LWEtY3Vyc29y' }, CTX);
    expect((r as { isError?: boolean }).isError).toBe(true);
  });
});

describe('the CSV endpoint writes every line once', () => {
  it('streams header + summary.rowCount lines, with the §9.2 facts as headers', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({
      withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h,
    }));
    vi.doMock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
    vi.doMock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn().mockResolvedValue(true) }));
    const rows = ledger(12_345);
    routeSql(rows);
    const { default: handler } = await import('../../../../pages/api/accounting/gl-lines-export');
    const chunks: string[] = [];
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => { headers[k] = v; return res; },
      status: () => res,
      write: (c: string) => { chunks.push(c); return true; },
      end: vi.fn(),
      send: vi.fn(),
      json: vi.fn(),
    };
    await (handler as (q: unknown, s: unknown) => Promise<void>)(
      { method: 'GET', query: {}, companyId: CO }, res,
    );
    const lines = chunks.join('').split('\n').filter((l) => l !== '');
    expect(lines[0]).toBe(GL_LINE_EXPORT_COLUMNS.join(','));
    expect(lines.length - 1).toBe(12_345);
    expect(headers['X-Row-Count']).toBe('12345');
    expect(headers['X-Control-Total']).toBe('0.00');
    expect(headers['X-Schema-Version']).toBe(GL_LINE_EXPORT_SCHEMA_VERSION);
    expect(res.end).toHaveBeenCalled();
  });
});

describe('row shape', () => {
  it('signs, VAT identity, FY, bank account on cash lines', () => {
    const credit = toExportRow({
      line_id: uuid(1), entry_id: uuid(2), entry_date: '2025-03-17', debit: '0.00', credit: '1150.00',
      entry_number: 'JE-2025-00001', source: 'auto_supplier_payment', status: 'posted', vat_type: null,
      account_code: '1544331', account_name: 'Bank VF1', account_type: 'asset', is_cash: true, period_locked: true,
      cc2_code: null, counterparty_name: 'Glowmark', counterparty_type: 'Supplier',
    }, 'Velocity Fibre (Pty) Ltd');
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
    expect(credit.Schema_Version).toBe(GL_LINE_EXPORT_SCHEMA_VERSION);
    expect(credit.CC2_Code).toBeNull();
  });

  it('FY boundaries: Feb closes the year, Mar opens the next', () => {
    expect(fiscalOf('2026-02-28')).toEqual({ period: '2026-02-01', fy: 'FY26', fyPeriodNo: 12 });
    expect(fiscalOf('2026-03-01')).toEqual({ period: '2026-03-01', fy: 'FY27', fyPeriodNo: 1 });
    expect(fiscalOf('2026-10-09')).toEqual({ period: '2026-10-01', fy: 'FY27', fyPeriodNo: 8 });
    expect(fiscalOf('2025-04-30').fyPeriodNo).toBe(2);
  });

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
    expect(exportCell('Counterparty_Name', 'Say "hi", ok')).toBe('"Say ""hi"", ok"');
    expect(exportCell('Line_Description', '=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
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

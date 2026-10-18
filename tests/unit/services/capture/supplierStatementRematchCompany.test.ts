/**
 * Rematch rewrites a reconciliation's lines. The company of the caller must reach every line write
 * (the lines table has no company column of its own), not only the header read before them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), measure: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(m.sql, { unsafe: vi.fn().mockReturnValue('') }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/capture/supplierStatementMeasure', () => ({ measureOurSide: m.measure }));

import { rematchLines } from '@/modules/accounting/services/capture/supplierStatementReconService';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUP = 'bbbbbbbb-0000-0000-0000-000000000002';
const RECON = 'eeeeeeee-0000-0000-0000-000000000005';
const squash = (t: string) => t.replace(/::\w+/g, '').replace(/\s+/g, ' ').trim();

const header = {
  id: RECON, company_id: CO, supplier_id: SUP, supplier_name: 'Acme', source_document_id: 'doc', status: 'unreconciled',
  statement_date: '2026-03-31', period_start: null, period_end: null, supplier_balance: 115, isaflow_balance: 0, variance: 0,
  missing_in_isaflow_count: 0, missing_in_statement_count: 0, amount_diff_count: 0, created_at: new Date(), reconciled_at: null,
  extraction_heartbeat_at: null, extraction_error: null, extraction_error_code: null, extraction_pages_done: null, extraction_pages_total: null,
};
const line = { id: 'l1', reconciliation_id: RECON, line_date: '2026-03-02', reference: 'INV-1', description: 'w', debit: 115, credit: 0, running_balance: null };

interface Call { text: string; values: unknown[] }
const calls: Call[] = [];

beforeEach(() => {
  calls.length = 0;
  m.sql.mockReset();
  m.measure.mockResolvedValue({ isaflowBalance: 0, variance: 115 });
  m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = squash(strings.join('?'));
    calls.push({ text, values });
    if (text.startsWith('SELECT * FROM supplier_statement_reconciliations')) return [header];
    if (text.startsWith('SELECT * FROM supplier_statement_lines')) return [line];
    if (text.includes('FROM supplier_invoices')) return [];
    if (text.includes('FROM supplier_statement_reconciliations ssr')) return [header];
    if (text.includes('FROM supplier_statement_lines ssl')) return [];
    return [];
  });
});

describe('rematchLines', () => {
  it('names the caller\'s company in every write it makes to the lines and to the header', async () => {
    await rematchLines(CO, RECON);
    const writes = calls.filter((c) => /^(INSERT|UPDATE|DELETE)/.test(c.text));
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const w of writes) {
      expect(w.text, w.text).toMatch(/company_id = \?/);
      expect(w.values, w.text).toContain(CO);
    }
  });
});

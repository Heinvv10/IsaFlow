/**
 * supplier_statement_lines has no company column: its rows belong to a company through their parent
 * reconciliation. A write by reconciliation id alone would trust the caller to have checked that
 * company; the statements here check it themselves, so a wrong company can neither delete nor add
 * a line, and persistLinesAndUpdateCounts cannot touch another company's header.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(m.sql, { unsafe: vi.fn().mockReturnValue('') }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { persistLinesAndUpdateCounts, replaceStatementLines } from '@/modules/accounting/services/capture/supplierStatementReconDb';
import type { LineInsert } from '@/modules/accounting/services/capture/supplierStatementMatchHelper';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const RECON = 'eeeeeeee-0000-0000-0000-000000000005';
const squash = (t: string) => t.replace(/::\w+/g, '').replace(/\s+/g, ' ').trim();
const OWNED = 'EXISTS (SELECT 1 FROM supplier_statement_reconciliations r WHERE r.id = ? AND r.company_id = ?)';

interface Call { text: string; values: unknown[] }
const calls: Call[] = [];
const line: LineInsert = {
  reconciliationId: RECON, lineDate: '2026-03-02', reference: 'INV-1', description: 'w', debit: 115, credit: 0,
  runningBalance: null, matchedInvoiceId: null, matchConfidence: null, mismatchReason: 'missing_in_isaflow',
};

beforeEach(() => {
  calls.length = 0;
  m.sql.mockReset();
  m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: squash(strings.join('?')), values });
    return [];
  });
});

describe('replaceStatementLines', () => {
  it('deletes and inserts only under a reconciliation that belongs to the company', async () => {
    await replaceStatementLines(m.sql, CO, RECON, [line, line]);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.text).toContain(OWNED);
      expect(c.values.filter((v) => v === CO)).toHaveLength(1);
      expect(c.values).toContain(RECON);
    }
  });

  it('still deletes by reconciliation id, so only that reconciliation\'s lines go', async () => {
    await replaceStatementLines(m.sql, CO, RECON, []);
    expect(calls[0]!.text).toMatch(/^DELETE FROM supplier_statement_lines WHERE reconciliation_id = \? AND EXISTS/);
  });
});

describe('persistLinesAndUpdateCounts', () => {
  it('writes the lines under the company, and updates only that company\'s header', async () => {
    await persistLinesAndUpdateCounts(CO, RECON, [line]);
    const update = calls.find((c) => c.text.startsWith('UPDATE supplier_statement_reconciliations'))!;
    expect(update.text).toContain('WHERE id = ? AND company_id = ?');
    expect(update.values.slice(-2)).toEqual([RECON, CO]);
    for (const c of calls.filter((x) => x.text.includes('supplier_statement_lines'))) expect(c.text).toContain(OWNED);
  });
});

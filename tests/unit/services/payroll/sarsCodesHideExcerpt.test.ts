/**
 * Master plan wave 7 SC (W19, W24; coordinator Q7): official_excerpt holds PDF bleed, so no read path selects or
 * serves it any more (the column and its data stay). W24: a 41xx row with the workbook's own labels parses as
 * `deduction` / `employer`; the parser needs no new category.
 */
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ queries: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    st.queries.push(strings.join('?'));
    return [{
      code: '4102', effective_year: 2027, category: 'deduction', description: 'Pension', status: 'active',
      foreign_code: null, code_pair: null, applicability_note: null, rationalisation_note: null,
      source_document: null, source_url: null, official_excerpt: 'PDF BLEED', brs_version: '1',
    }];
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { getSarsCode, refreshCache } from '@/modules/accounting/services/payroll/sarsCodesService';
import { listCodes } from '@/modules/admin/services/sarsCodesAdminService';
import { parseSarsCodesXlsxBuffer } from '@/modules/admin/services/sarsCodesParser';

beforeEach(() => { st.queries = []; refreshCache(); });

describe('W19: official_excerpt is not selected or served', () => {
  it('the tenant catalogue neither selects nor returns it', async () => {
    const c = await getSarsCode('4102', 2027);
    expect(st.queries.join('\n')).not.toContain('official_excerpt');
    expect(st.queries.join('\n')).not.toMatch(/\.\*|\*\s+FROM|SELECT\s+\*/i); // explicit column list, no star
    expect(c).not.toBeNull();
    expect(c).not.toHaveProperty('officialExcerpt');
  });

  it('the admin list neither selects nor returns it', async () => {
    await listCodes(2027);
    expect(st.queries.join('\n')).not.toContain('official_excerpt');
    expect(st.queries.join('\n')).not.toMatch(/\.\*|\*\s+FROM|SELECT\s+\*/i); // explicit column list, no star
  });
});

describe('W24: 41xx rows map onto existing categories', () => {
  it('parses Deduction and Employer Contribution 41xx rows without an error', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Master_Codes');
    ws.addRow(['Code', 'Category', 'Status', 'Description']);
    ws.addRow(['4102', 'Deduction', 'Active / General', 'Pension fund']);
    ws.addRow(['4150', 'Employer Contribution', 'Active / General', 'SDL']);
    const out = await parseSarsCodesXlsxBuffer(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(out.errors).toEqual([]);
    expect(out.rows.map((r) => [r.code, r.category])).toEqual([['4102', 'deduction'], ['4150', 'employer']]);
  });
});

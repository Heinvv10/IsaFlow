/**
 * P3.5 (B1): the "CIPC annual return submitted" checklist item always
 * reported not-ready ("companies.cipc_annual_return_submitted column not
 * yet added") — the column now exists (mig 503); the service must read it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  fmtDate: (val: unknown) => {
    if (!val) return '';
    const s = String(val);
    return s.includes('T') ? s.split('T')[0] : s;
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const computePisScoreForDocument = vi.fn();
vi.mock('@/modules/accounting/services/afs/pisCalculatorService', () => ({
  computePisScoreForDocument: (...a: unknown[]) => computePisScoreForDocument(...a),
}));

import { generateCipcFilingGuide } from '@/modules/accounting/services/afs/cipcFilingGuideService';

function routeSql(handlers: Array<{ match: RegExp; rows: unknown[] }>) {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    const h = handlers.find((x) => x.match.test(text));
    return Promise.resolve(h ? h.rows : []);
  });
}

const BASE_DOC_ROW = {
  id: 'doc-1',
  fiscal_year: 2025,
  status: 'signed_off',
  pis_score: 10,
  reporting_framework: 'ifrs_smes',
  name: 'Acme (Pty) Ltd',
  registration_number: '2020/123456/07',
  financial_year_start: 3,
};

describe('generateCipcFilingGuide — CIPC annual return checklist item', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    computePisScoreForDocument.mockReset();
    computePisScoreForDocument.mockResolvedValue({
      total: 10,
      requiredAudit: 'voluntary',
      requiredCipcFiling: 'fas_only',
      dataUnavailable: [],
    });
  });

  it('reports not ready when the company has not submitted the annual return', async () => {
    routeSql([
      { match: /FROM afs_documents/, rows: [{ ...BASE_DOC_ROW, cipc_annual_return_submitted: false, cipc_annual_return_submitted_at: null }] },
      { match: /FROM afs_sections/, rows: [] },
    ]);

    const guide = await generateCipcFilingGuide('co-1', 'doc-1');
    const item = guide.documentsReady.find(d => d.label === 'CIPC annual return submitted');

    expect(item).toBeDefined();
    expect(item!.ready).toBe(false);
    expect(item!.detail).not.toMatch(/column not yet added/i);
  });

  it('reports ready with the submission date when the company has submitted the annual return', async () => {
    routeSql([
      {
        match: /FROM afs_documents/,
        rows: [{
          ...BASE_DOC_ROW,
          cipc_annual_return_submitted: true,
          cipc_annual_return_submitted_at: '2026-05-01T10:00:00.000Z',
        }],
      },
      { match: /FROM afs_sections/, rows: [] },
    ]);

    const guide = await generateCipcFilingGuide('co-1', 'doc-1');
    const item = guide.documentsReady.find(d => d.label === 'CIPC annual return submitted');

    expect(item).toBeDefined();
    expect(item!.ready).toBe(true);
    expect(item!.detail).toContain('2026-05-01');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const original = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  // unsafe returns its text, so a shared SQL fragment shows up among a call's values.
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn((text: string) => text) });
  return { ...original, sql: sqlFn };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/documentStorageService', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/core/documentStorageService')>(
    '@/modules/accounting/services/core/documentStorageService');
  return { ...actual, verifyEntityOwnership: vi.fn() };
});

import { hasBankLineDocumentSql } from '@/modules/accounting/services/bank/bankLineDocumentSql';
import { sql } from '@/lib/neon';
import { verifyEntityOwnership } from '@/modules/accounting/services/core/documentStorageService';
import {
  listEntityDocuments,
  listBankAttachments,
  listTransactionsWithoutDocuments,
} from '@/modules/accounting/services/core/documentQueryService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';

function texts() {
  return vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as TemplateStringsArray).join('?'));
}

beforeEach(() => {
  vi.mocked(sql).mockReset();
  vi.mocked(verifyEntityOwnership).mockReset();
});

describe('listEntityDocuments', () => {
  it('refuses before reading anything when the entity is not this company\'s', async () => {
    vi.mocked(verifyEntityOwnership).mockResolvedValue(false);
    const res = await listEntityDocuments(COMPANY, 'customer_invoice', ENTITY, 50, 0);
    expect(res).toEqual({ ok: false, reason: 'entity_not_found' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('refuses an entity_type the store does not hold', async () => {
    const res = await listEntityDocuments(COMPANY, 'bank_transaction', ENTITY, 50, 0);
    expect(res).toEqual({ ok: false, reason: 'invalid_entity_type' });
    expect(verifyEntityOwnership).not.toHaveBeenCalled();
  });

  it('returns direct and cross-linked documents, each labelled with its source', async () => {
    vi.mocked(verifyEntityOwnership).mockResolvedValue(true);
    vi.mocked(sql)
      .mockResolvedValueOnce([{ id: 'd1', entity_type: 'customer_invoice', entity_id: ENTITY, uploaded_at: '2026-09-01T00:00:00Z', is_active: true }] as never)
      .mockResolvedValueOnce([{ id: 'd2', entity_type: 'credit_note', entity_id: 'other', uploaded_at: '2026-09-02T00:00:00Z', is_active: true, link_reason: 'same supplier' }] as never);

    const res = await listEntityDocuments(COMPANY, 'customer_invoice', ENTITY, 50, 0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.documents.map((d) => [d.id, d.source])).toEqual([['d1', 'direct'], ['d2', 'linked']]);
    expect(res.documents[1]!.linkReason).toBe('same supplier');
  });
});

describe('listBankAttachments', () => {
  it('scopes by company through the parent bank transaction — the attachment table has no company_id', async () => {
    vi.mocked(sql).mockResolvedValue([] as never);
    await listBankAttachments(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(texts()[0]).toMatch(/bt\.company_id\s*=\s*\?/);
  });

  it('returns one row per attachment with the transaction it supports', async () => {
    // Calls in order: the shared CTE fragment (never awaited on its own), the rows, the count.
    vi.mocked(sql).mockReturnValueOnce('docs-cte' as never).mockResolvedValueOnce([{
      id: 'a1', bank_transaction_id: 'tx1', file_name: 'slip.pdf', file_size: 1200,
      created_at: '2026-09-01T00:00:00Z', uploaded_by: 'u1', store: 'bank_attachment',
      transaction_date: '2026-09-01', amount: '-10500.00', tx_description: 'Makro', reference: 'REF1',
    }] as never).mockResolvedValueOnce([{ cnt: 1 }] as never);

    const res = await listBankAttachments(COMPANY, { from: '2026-09-01', to: '2026-09-30', limit: 50 });
    expect(res.rowsTotal).toBe(1);
    expect(res.rows[0]).toMatchObject({
      id: 'a1', store: 'bank_attachment', bankTransactionId: 'tx1', fileName: 'slip.pdf', amount: -10500,
    });
  });
});

describe('listTransactionsWithoutDocuments', () => {
  /** The rows and totals queries answer by their text; the nested fragments (scope, filters) answer []. */
  function answer(rows: unknown[], totals: unknown) {
    vi.mocked(sql).mockImplementation(((strings: TemplateStringsArray) => {
      const t = strings.join('?');
      if (t.includes('ORDER BY ABS(s.amount)')) return Promise.resolve(rows);
      if (t.includes('AS universe')) return Promise.resolve([totals]);
      return [] as never;
    }) as never);
  }

  it('answers "which transactions over R10,000 have no supporting evidence", with the evidence totals', async () => {
    answer([{
      id: 'tx1', transaction_date: '2026-09-01', amount: '-12000.00',
      description: 'Cash withdrawal', reference: 'R1', status: 'allocated', own: false, settled: false,
    }], { universe: 40, with_own: 30, with_settled: 9, no_evidence: 1, unsupported: 1, latest: null });

    const res = await listTransactionsWithoutDocuments(COMPANY, {
      from: '2026-01-01', to: '2026-12-31', minAmount: 10000, limit: 50,
    });
    expect(res.rows[0]).toMatchObject({ amount: -12000, evidence: 'none' });
    expect(res).toMatchObject({ rowsTotal: 1, universeTotal: 40, withOwnDocument: 30, withSettledDocument: 9, noEvidence: 1 });
  });

  it('labels a row own before settled_document', async () => {
    answer([{ id: 'a', amount: 1, own: true, settled: true }, { id: 'b', amount: 1, own: false, settled: true }], {});
    const res = await listTransactionsWithoutDocuments(COMPANY, { from: '2026-01-01', to: '2026-12-31', minAmount: 0, limit: 50, strict: true });
    expect(res.rows.map((r) => r.evidence)).toEqual(['own', 'settled_document']);
  });

  it('compares the ABSOLUTE amount and tests the line\'s own documents with the grid\'s definition', async () => {
    answer([], {});
    await listTransactionsWithoutDocuments(COMPANY, { from: '2026-01-01', to: '2026-12-31', minAmount: 10000, limit: 50 });
    const all = vi.mocked(sql).mock.calls.flatMap((c) => [(c[0] as unknown as TemplateStringsArray).join('?'), ...c.slice(1)]);
    expect(all.some((t) => typeof t === 'string' && /ABS\(bt\.amount\)\s*>=\s*\?/.test(t))).toBe(true);
    // Uploads and linked captured documents both count (bank/bankLineDocumentSql), the paperclip's own definition.
    expect(all).toContain(hasBankLineDocumentSql('bt'));
  });
});

describe('uploadFileName', () => {
  it('prefixes a name shaped like a captured-document copy, and leaves every other name alone', async () => {
    const { uploadFileName } = await import('@/modules/accounting/services/bank/bankLineDocumentSql');
    const id = '22222222-2222-4222-8222-222222222222';
    expect(uploadFileName(`${id}_scan.pdf`)).toBe(`upload_${id}_scan.pdf`);
    expect(uploadFileName(`${id.toUpperCase()}_scan.pdf`)).toBe(`upload_${id.toUpperCase()}_scan.pdf`);
    expect(uploadFileName('slip.png')).toBe('slip.png');
    expect(uploadFileName(`x${id}_scan.pdf`)).toBe(`x${id}_scan.pdf`);
    expect(uploadFileName(`${id}.pdf`)).toBe(`${id}.pdf`);
  });
});

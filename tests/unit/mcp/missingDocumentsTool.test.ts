import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/core/missingDocumentsService', () => ({ listMissingDocuments: vi.fn() }));

import { listMissingDocuments } from '@/modules/accounting/services/core/missingDocumentsService';
import { listMissingDocumentsTool } from '@/lib/mcp/tools/missingDocuments';
import { todayInSast } from '@/lib/saDateParser';
import { shiftYearISO } from '@/lib/dateUtils';
import { assertEnvelopeSound, decodeCursor, encodeCursor } from '@/lib/mcp/contracts';
import type { MissingDocumentPage, MissingDocumentRow } from '@/modules/accounting/services/core/missingDocumentsTypes';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ID_A = '22222222-2222-4222-8222-222222222222';
const ALL_SCOPES = ['read:reports', 'read:invoices', 'read:bank-tx', 'read:vat'];
const ctx = (scopes: string[] = ALL_SCOPES) =>
  ({ companyId: COMPANY, userId: 'u1', scopes, tokenJti: 't', oauthAppId: null }) as never;
const payload = (res: { content: { text: string }[] }) => JSON.parse(res.content[0]!.text) as Record<string, unknown>;

const row = (over: Partial<MissingDocumentRow> = {}): MissingDocumentRow => ({
  entityType: 'supplier_invoice', entityId: ID_A, documentDate: '2026-06-10', amount: 115, cents: 11500,
  reference: 'B-1', counterparty: 'Acme', description: null, status: 'approved', reason: null, ...over,
});
const page = (over: Partial<MissingDocumentPage> = {}): MissingDocumentPage => ({
  rows: [row()], next: null,
  summary: [{ entityType: 'supplier_invoice', candidates: 4, withDocument: 3, missing: 1, missingAmount: 115 }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMissingDocuments).mockResolvedValue(page());
});

describe('list_missing_documents', () => {
  it('is a read on read:reports', () => {
    expect(listMissingDocumentsTool.write).toBe(false);
    expect(listMissingDocumentsTool.scope).toBe('read:reports');
  });

  it('scopes the query by the token\'s company and echoes the default 12-month window', async () => {
    const res = payload(await listMissingDocumentsTool.handler({}, ctx()) as never);
    assertEnvelopeSound(res as never);
    const f = vi.mocked(listMissingDocuments).mock.calls[0]![0];
    expect(f.companyId).toBe(COMPANY);
    expect(f.types).toEqual(['supplier_invoice', 'customer_invoice', 'credit_note', 'bank_transaction', 'vat_journal']);
    expect(res.to).toBe(todayInSast());
    expect(res.from).toBe(shiftYearISO(todayInSast(), -1));
    expect(f.minAmount).toBe(0);
  });

  it('reads only the types the token has the scope for and names the rest', async () => {
    const res = payload(await listMissingDocumentsTool.handler({}, ctx(['read:reports', 'read:invoices'])) as never);
    expect(vi.mocked(listMissingDocuments).mock.calls[0]![0].types).toEqual(['supplier_invoice', 'customer_invoice', 'credit_note']);
    expect(res.skipped_entity_types).toEqual([
      { entity_type: 'bank_transaction', needs_scope: 'read:bank-tx' },
      { entity_type: 'vat_journal', needs_scope: 'read:vat' },
    ]);
  });

  it('refuses a type named explicitly without its scope, before any query', async () => {
    const res = await listMissingDocumentsTool.handler(
      { entity_types: ['bank_transaction'] }, ctx(['read:reports', 'read:invoices'])) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('read:bank-tx');
    expect(listMissingDocuments).not.toHaveBeenCalled();
  });

  it('refuses a token that can read none of the types', async () => {
    const res = await listMissingDocumentsTool.handler({}, ctx(['read:reports'])) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(listMissingDocuments).not.toHaveBeenCalled();
  });

  it.each([
    [{ entity_types: ['journal'] }, 'entity_types'],
    [{ entity_types: [] }, 'entity_types'],
    [{ from: '2026-07-01', to: '2026-06-01' }, 'from must not be after to'],
    [{ min_amount: -1 }, 'min_amount'],
    [{ min_amount: '10' }, 'min_amount'],
    [{ cursor: 'nonsense' }, 'invalid cursor'],
    [{ cursor: encodeCursor({ parts: ['12', 'supplier_invoice', 'not-a-uuid'] }) }, 'invalid cursor'],
    [{ cursor: encodeCursor({ parts: ['-5', 'supplier_invoice', ID_A] }) }, 'invalid cursor'],
    [{ cursor: encodeCursor({ parts: ['5', 'journal', ID_A] }) }, 'invalid cursor'],
  ])('refuses bad input %j before any query', async (args, text) => {
    const res = await listMissingDocumentsTool.handler(args, ctx()) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain(text);
    expect(listMissingDocuments).not.toHaveBeenCalled();
  });

  it('refuses a range wider than 24 months, and serves exactly 24', async () => {
    const wide = await listMissingDocumentsTool.handler({ from: '2024-06-29', to: '2026-06-30' }, ctx()) as { isError?: boolean; content: { text: string }[] };
    expect(wide.isError).toBe(true);
    expect(wide.content[0]!.text).toContain('24 months');
    expect(listMissingDocuments).not.toHaveBeenCalled();
    const edge = await listMissingDocumentsTool.handler({ from: '2024-06-30', to: '2026-06-30' }, ctx()) as { isError?: boolean };
    expect(edge.isError).toBeFalsy();
    expect(listMissingDocuments).toHaveBeenCalledTimes(1);
  });

  it('refuses an uncastable date instead of aborting the transaction', async () => {
    const res = await listMissingDocumentsTool.handler({ from: '2026-13-45' }, ctx()) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(listMissingDocuments).not.toHaveBeenCalled();
  });

  it('passes the cursor to the service and returns the service\'s next key as next_cursor', async () => {
    vi.mocked(listMissingDocuments).mockResolvedValue(page({ next: { cents: 11500, entityType: 'supplier_invoice', id: ID_A } }));
    const cursor = encodeCursor({ parts: ['20000', 'bank_transaction', ID_A.toUpperCase()] });
    const res = payload(await listMissingDocumentsTool.handler({ cursor, limit: 5 }, ctx()) as never);
    const f = vi.mocked(listMissingDocuments).mock.calls[0]![0];
    expect(f.after).toEqual({ cents: 20000, entityType: 'bank_transaction', id: ID_A });
    expect(f.limit).toBe(5);
    expect(decodeCursor(res.next_cursor as string, 3)?.parts).toEqual(['11500', 'supplier_invoice', ID_A]);
  });

  it('rowsTotal is the missing rows over the whole range, not the page', async () => {
    vi.mocked(listMissingDocuments).mockResolvedValue(page({
      summary: [
        { entityType: 'supplier_invoice', candidates: 40, withDocument: 30, missing: 10, missingAmount: 1150 },
        { entityType: 'bank_transaction', candidates: 9, withDocument: 5, missing: 4, missingAmount: 800 },
      ],
    }));
    const res = payload(await listMissingDocumentsTool.handler({}, ctx()) as never);
    expect(res.rowsTotal).toBe(14);
    expect(res.truncated).toBe(true);
    expect((res.summary as Record<string, unknown>[])[1]).toEqual({
      entity_type: 'bank_transaction', candidates: 9, with_document: 5, missing: 4, missing_amount: 800,
    });
  });

  it('detail summary serves the summary only and fetches one row', async () => {
    const res = payload(await listMissingDocumentsTool.handler({ detail: 'summary', limit: 100 }, ctx()) as never);
    expect(res.rows).toEqual([]);
    expect(res.next_cursor).toBeNull();
    expect(vi.mocked(listMissingDocuments).mock.calls[0]![0].limit).toBe(1);
    expect((res.summary as unknown[]).length).toBe(1);
  });

  it('names the tool that files the missing document and carries the VAT reason', async () => {
    vi.mocked(listMissingDocuments).mockResolvedValue(page({
      rows: [
        row({ entityType: 'bank_transaction' }),
        row({ entityType: 'vat_journal', reason: 'no_document' }),
        row(),
      ],
    }));
    const rows = payload(await listMissingDocumentsTool.handler({}, ctx()) as never).rows as Record<string, unknown>[];
    expect(rows.map((r) => r.attach_with)).toEqual(['attach_entity_document', 'link_document_to_journal', 'attach_entity_document']);
    expect(rows[1]!.reason).toBe('no_document');
    expect('reason' in rows[0]!).toBe(false);
  });
});

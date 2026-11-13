/**
 * External references on MCP creates (brief step 3): argument parsing, the replay/lock helper,
 * and find_by_external_ref. The service SQL has its own suite against a real schema
 * (tests/integration/external-ref-service.int.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/core/externalRefService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/core/externalRefService')>()),
  findByExternalRef: vi.fn(),
  lockExternalRef: vi.fn(),
  stampExternalRef: vi.fn(),
}));

import { findByExternalRef, lockExternalRef, stampExternalRef, type ExternalRefMatch } from '@/modules/accounting/services/core/externalRefService';
import { createReplayOrLock, findByExternalRefTool, parseCreateRef, stampCreated } from '@/lib/mcp/tools/externalRef';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ctx = (scopes = ['read:invoices', 'read:reports', 'read:bank-tx', 'read:contacts']): McpToolContext =>
  ({ userId: 'u', companyId: COMPANY, scopes, tokenJti: 'j', oauthAppId: null, companyRole: 'admin' });

const match = (over: Partial<ExternalRefMatch> = {}): ExternalRefMatch => ({
  entityType: 'supplier_invoice', id: 'bill-1', number: 'INV0663', status: 'draft', date: '2026-10-01',
  totalAmount: 115, live: true, externalDocumentNumber: 'SIV5490', ...over,
});
const parse = (r: McpToolResult) => { expect(r.isError, r.content[0]!.text).toBeFalsy(); return JSON.parse(r.content[0]!.text) as Record<string, any>; };

beforeEach(() => vi.resetAllMocks());

describe('parseCreateRef', () => {
  it('is null when no reference is given, so a create is unchanged', () => {
    expect(parseCreateRef({})).toBeNull();
  });
  it('needs external_system with external_ref, and external_ref with the others', () => {
    expect(parseCreateRef({ external_ref: '123' })).toMatch(/external_system is required/);
    expect(parseCreateRef({ external_system: 'sage' })).toMatch(/external_ref is required/);
    expect(parseCreateRef({ external_document_number: 'SIV1' })).toMatch(/external_ref is required/);
    expect(parseCreateRef({ external_ref: 5, external_system: 'sage' })).toMatch(/expected a string/);
  });
  it('trims and lower-cases the system', () => {
    expect(parseCreateRef({ external_ref: ' 3629825983 ', external_system: 'Sage', external_document_number: 'SIV0003762' }))
      .toEqual({ system: 'sage', ref: '3629825983', documentNumber: 'SIV0003762' });
  });
});

describe('createReplayOrLock', () => {
  const ref = { system: 'sage', ref: '42', documentNumber: null };

  it('does nothing without a reference', async () => {
    expect(await createReplayOrLock(ctx(), 'supplier_invoice', null)).toBeNull();
    expect(lockExternalRef).not.toHaveBeenCalled();
  });

  it('locks, then returns the live row and writes nothing (the key stays free)', async () => {
    vi.mocked(findByExternalRef).mockResolvedValue([match(), match({ id: 'bill-old', live: false })]);
    const r = await createReplayOrLock(ctx(), 'supplier_invoice', ref);
    expect(lockExternalRef).toHaveBeenCalledWith(COMPANY, 'supplier_invoice', 'sage', '42');
    expect(vi.mocked(lockExternalRef).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(findByExternalRef).mock.invocationCallOrder[0]!);
    expect(r!.wroteNothing).toBe(true);
    expect(parse(r!)).toMatchObject({ already_existed: true, id: 'bill-1', number: 'INV0663', external_ref: '42' });
  });

  it('says when the request differs from the stored record (a corrected source document)', async () => {
    vi.mocked(findByExternalRef).mockResolvedValue([match({ number: 'INV0663', date: '2026-10-01', totalAmount: 115 })]);
    const out = parse((await createReplayOrLock(ctx(), 'supplier_invoice', ref, {
      expect: { number: 'INV0663', date: '2026-10-02', totalAmount: 120 },
    }))!);
    expect(out.payload_differs).toBe(true);
    expect(out.differences).toEqual([
      { field: 'date', existing: '2026-10-01', requested: '2026-10-02' },
      { field: 'total_amount', existing: 115, requested: 120 },
    ]);
    expect(out.note).toMatch(/DIFFERS/);
  });

  it('a matching replay says payload_differs: false', async () => {
    vi.mocked(findByExternalRef).mockResolvedValue([match()]);
    const out = parse((await createReplayOrLock(ctx(), 'supplier_invoice', ref, { expect: { number: 'INV0663', date: '2026-10-01' } }))!);
    expect(out.payload_differs).toBe(false);
    expect(out.differences).toBeUndefined();
  });

  it('goes on to create when only superseded rows carry the reference', async () => {
    vi.mocked(findByExternalRef).mockResolvedValue([match({ live: false })]);
    expect(await createReplayOrLock(ctx(), 'supplier_invoice', ref)).toBeNull();
    expect(lockExternalRef).toHaveBeenCalled();
  });

  it('passes the credit-note side through', async () => {
    vi.mocked(findByExternalRef).mockResolvedValue([]);
    await createReplayOrLock(ctx(), 'credit_note', ref, { creditNoteType: 'supplier' });
    expect(findByExternalRef).toHaveBeenCalledWith(COMPANY, 'credit_note', 'sage', '42', { creditNoteType: 'supplier' });
  });

  it('stampCreated writes only when a reference was given', async () => {
    await stampCreated(ctx(), 'journal', 'je-1', null);
    expect(stampExternalRef).not.toHaveBeenCalled();
    await stampCreated(ctx(), 'journal', 'je-1', ref);
    expect(stampExternalRef).toHaveBeenCalledWith(COMPANY, 'journal', 'je-1', ref);
  });
});

describe('find_by_external_ref', () => {
  it('is a read open to any write role, scoped per kind in the handler', () => {
    expect(findByExternalRefTool.write).toBe(false);
    expect(findByExternalRefTool.inputSchema.additionalProperties).toBe(false);
  });

  it('maps a Sage code to its kind and side, and returns the live record plus superseded rows', async () => {
    vi.mocked(findByExternalRef).mockResolvedValue([
      match({ entityType: 'credit_note', id: 'cn-1', creditNoteType: 'supplier' }),
      match({ entityType: 'credit_note', id: 'cn-0', live: false, status: 'cancelled', creditNoteType: 'supplier' }),
    ]);
    const out = parse(await findByExternalRefTool.handler({ source: 'Sage', kind: 'ret', id: 3629825983 }, ctx()));
    expect(findByExternalRef).toHaveBeenCalledWith(COMPANY, 'credit_note', 'sage', '3629825983', { creditNoteType: 'supplier' });
    expect(out).toMatchObject({ found: true, kind: 'credit_note', record: { id: 'cn-1' }, superseded: [{ id: 'cn-0', status: 'cancelled' }] });
  });

  it('says found: false with no record', async () => {
    vi.mocked(findByExternalRef).mockResolvedValue([]);
    expect(parse(await findByExternalRefTool.handler({ source: 'sage', kind: 'siv', id: '1' }, ctx())))
      .toMatchObject({ found: false, record: null, superseded: [] });
  });

  it('refuses a kind the token cannot list, before reading', async () => {
    const r = await findByExternalRefTool.handler({ source: 'sage', kind: 'bank', id: '1' }, ctx(['read:invoices']));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('read:bank-tx');
    expect(findByExternalRef).not.toHaveBeenCalled();
  });

  it('refuses an unknown kind or a missing id', async () => {
    expect((await findByExternalRefTool.handler({ source: 'sage', kind: 'quote', id: '1' }, ctx())).isError).toBe(true);
    expect((await findByExternalRefTool.handler({ source: 'sage', kind: 'siv', id: '' }, ctx())).isError).toBe(true);
  });
});

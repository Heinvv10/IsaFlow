/** listBankLineAttachmentsCapped: the newest `limit` documents of a line, and whether older ones were left out. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: Object.assign((...a: unknown[]) => sqlMock(...a), { unsafe: (s: string) => s }) }));

import { listBankLineAttachmentsCapped, listBankLineAttachments, countBankLineAttachments, BANK_LINE_ATTACHMENT_LIST_MAX, BANK_LINE_ATTACHMENT_BYTE_BUDGET } from '@/modules/accounting/services/capture/capturedAttachmentLinks';

const copy = (i: number) => ({ id: `a${i}`, bank_transaction_id: 't', file_url: 'data:x', file_name: `f${i}`, file_size: 1, uploaded_by: null, created_at: `2026-01-${String(10 + i).padStart(2, '0')}T00:00:00Z`, document_id: null, file_type: null });

describe('capped attachment list', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([copy(1), copy(2), copy(3)]); // uploads (the SQL asks for limit + 1)
    sqlMock.mockResolvedValueOnce([]); // linked captured documents with no copy yet
  });

  it('asks the database for limit + 1 newest uploads, returns the newest `limit`, and says it cut', async () => {
    const r = await listBankLineAttachmentsCapped('co', 't', 2);
    expect(r.truncated).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual(['a3', 'a2']);
    const [strings, ...values] = sqlMock.mock.calls[0]!;
    expect((strings as string[]).join('?')).toMatch(/ORDER BY created_at DESC, id DESC\s+LIMIT \?::INT/);
    expect(values).toContain(3);
  });

  it('a line within the cap is whole and not truncated', async () => {
    const r = await listBankLineAttachmentsCapped('co', 't', 3);
    expect(r).toMatchObject({ truncated: false });
    expect(r.items).toHaveLength(3);
  });

  it('the uncapped reader (documents routing) still returns everything', async () => {
    const all = await listBankLineAttachments('co', 't');
    expect(all).toHaveLength(3);
    expect(sqlMock.mock.calls[0]!.slice(1).includes(null)).toBe(true); // LIMIT NULL: no limit
  });

  it('equal timestamps order by id, newest first (a stable page boundary)', async () => {
    sqlMock.mockReset();
    const same = '2026-02-01T00:00:00Z';
    sqlMock.mockResolvedValueOnce([{ ...copy(1), id: 'a1', created_at: same }, { ...copy(1), id: 'a3', created_at: same }, { ...copy(1), id: 'a2', created_at: same }]);
    sqlMock.mockResolvedValueOnce([]);
    const r = await listBankLineAttachmentsCapped('co', 't', 2);
    expect(r.items.map((i) => i.id)).toEqual(['a3', 'a2']);
  });

  it('a byte budget cuts in SQL (running sum, newest row always kept), reports truncation and drops older uncopied docs', async () => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([{ ...copy(5), copies_total: '9' }, { ...copy(4), copies_total: '9' }]); // 2 of 9 fit the budget
    sqlMock.mockResolvedValueOnce([{ id: 'u1', file_name: 'old.pdf', file_type: 'pdf', size: 1, created_at: '2026-01-01T00:00:00Z' }]); // older than the cut
    const r = await listBankLineAttachmentsCapped('co', 't', 100, 1234);
    expect(r.truncated).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual(['a5', 'a4']);
    const [strings, ...values] = sqlMock.mock.calls[0]!;
    const text = (strings as string[]).join('?');
    expect(text).toMatch(/SUM\(octet_length\(bta\.file_url\)\) OVER \(ORDER BY bta\.created_at DESC, bta\.id DESC\)/);
    expect(text).toMatch(/rn = 1 OR \?::BIGINT IS NULL OR running_bytes <= \?::BIGINT/);
    expect(values.filter((v) => v === 1234)).toHaveLength(2);
  });

  it('the byte budget is 25 MB', () => { expect(BANK_LINE_ATTACHMENT_BYTE_BUDGET).toBe(25 * 1024 * 1024); });

  it('the cap is 100', () => { expect(BANK_LINE_ATTACHMENT_LIST_MAX).toBe(100); });

  it('countBankLineAttachments counts with the row badge\'s predicate (attachmentCountSql) in the company', async () => {
    sqlMock.mockReset().mockResolvedValue([{ n: 137 }]);
    expect(await countBankLineAttachments('co', 't')).toBe(137);
    const [strings, ...values] = sqlMock.mock.calls[0]!;
    expect(values).toEqual(expect.arrayContaining(['t', 'co']));
    // sql.unsafe is mocked to return its text, which shows up as a value: it is the shared fragment
    expect(values.some((v) => typeof v === 'string' && v.includes('bank_transaction_attachments') && v.includes('captured_documents'))).toBe(true);
    expect((strings as string[]).join('?')).toMatch(/bt\.company_id = \?::uuid/);
  });
});

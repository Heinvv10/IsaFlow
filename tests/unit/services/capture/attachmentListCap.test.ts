/** listBankLineAttachmentsCapped: the newest `limit` documents of a line, and whether older ones were left out. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: Object.assign((...a: unknown[]) => sqlMock(...a), { unsafe: (s: string) => s }) }));

import { listBankLineAttachmentsCapped, listBankLineAttachments } from '@/modules/accounting/services/capture/capturedAttachmentLinks';

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
    expect((strings as string[]).join('?')).toMatch(/ORDER BY bta\.created_at DESC\s+LIMIT \?::INT/);
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
});

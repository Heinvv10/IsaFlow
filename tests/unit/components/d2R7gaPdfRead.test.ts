import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { log } from '@/lib/logger';
import { parseBankPdf } from '@/modules/accounting/utils/bankPdfParser';

describe('parseBankPdf on a file that is not a readable PDF', () => {
  it('says so in a plain sentence, with no library error text, and logs the raw error', async () => {
    const r = await parseBankPdf(Buffer.from('this is not a pdf'), 'fnb');
    expect(r.transactions).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.error).toBe('Could not read the PDF file - it may be damaged or password-protected. Please upload a CSV file instead.');
    expect(r.errors[0]?.error).not.toMatch(/PDF read error|Invalid PDF|structure/i);
    expect(log.error).toHaveBeenCalledWith('Failed to parse PDF buffer', expect.objectContaining({ error: expect.anything() }), 'accounting-pdf');
  });
});

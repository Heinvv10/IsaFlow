import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
// A line that parses but whose description step throws: reaches each parser's catch.
vi.mock('@/modules/accounting/utils/bankPdfParserUtils', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/utils/bankPdfParserUtils')>()),
  cleanDescription: () => { throw new Error('boom: internal detail'); },
}));

import { log } from '@/lib/logger';
import { parseCapitecStatement } from '@/modules/accounting/utils/bankPdfParserCapitec';
import { parseFnbStatement } from '@/modules/accounting/utils/bankPdfParserFnb';
import { parseNedbankStatement } from '@/modules/accounting/utils/bankPdfParserNedbank';
import { parseStandardBankStatement } from '@/modules/accounting/utils/bankPdfParserStandardBank';

const LINE = '15 Jan 2026 Coffee shop 100.00 500.00';
const CASES: Array<[string, (t: string) => { errors: { row: number; error: string }[] }, string, string]> = [
  ['Capitec', parseCapitecStatement, 'Date Description Money out Money in Balance\n15/01/2026 Coffee shop 100.00 500.00', 'Capitec'],
  ['FNB', parseFnbStatement, 'Date Description Amount Balance\n' + LINE + '\nTotal 1', 'FNB'],
  ['Nedbank', parseNedbankStatement, 'Date Transaction Amount Balance\n' + LINE + '\nTotal 1', 'Nedbank'],
  ['Standard Bank', parseStandardBankStatement, 'Date Description Amount Balance\n' + LINE + '\nTotal 1', 'Standard Bank'],
];

beforeEach(() => { vi.mocked(log.warn).mockClear(); });

describe.each(CASES)('%s PDF parser: a line that cannot be read', (_n, parse, text, bank) => {
  it('reports a plain sentence naming the bank, and logs the raw error', () => {
    const r = parse(text);
    expect(r.errors.length).toBeGreaterThan(0);
    const e = r.errors[0]!;
    expect(e.error).toBe(`Could not read this ${bank} statement line - check it in the PDF and add it by hand if needed`);
    expect(e.error).not.toMatch(/boom|Parse error/);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(bank), expect.objectContaining({ row: e.row, error: expect.any(Error) }), 'accounting-pdf');
  });
});

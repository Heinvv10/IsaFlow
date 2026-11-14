/**
 * adminCsvExport.csvRow (audit 3.8): text that starts like a formula is written as
 * text ('=…), but a number is a number: -5 stays -5, quoted, never '-5.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: vi.fn() }));

import { csvRow, sendAuditedCsv, textFilterSet } from '@/modules/admin/services/adminCsvExport';

describe('csvRow', () => {
  it('quotes every cell, neutralises formula text, leaves numbers alone', () => {
    expect(csvRow([-5, 3.5, 0, '=1+1', '+SUM(A1)', '@x', 'plain', 'say "hi"'])).toBe(
      `"-5","3.5","0","'=1+1","'+SUM(A1)","'@x","plain","say ""hi"""`);
  });

  it('a plain signed decimal string is a number too (pg numeric/bigint); anything more is neutralised', () => {
    expect(csvRow(['-5', '-12.50', '42', '0.5'])).toBe(`"-5","-12.50","42","0.5"`);
    expect(csvRow(['-5+1', '-1e3', '- 5', '-5\t', '-.5', '+5', '-'])).toBe(
      `"'-5+1","'-1e3","'- 5","'-5\t","'-.5","'+5","'-"`);
  });

  it('writes null as empty, booleans as words, dates as ISO-8601, objects as JSON (neutralised)', () => {
    expect(csvRow([null, undefined, true, false, new Date('2026-11-14T10:00:00Z'), { a: 1 }])).toBe(
      `"","","true","false","2026-11-14T10:00:00.000Z","{""a"":1}"`);
  });
});

describe('textFilterSet', () => {
  it('records whether a free-text filter was applied, never its text', () => {
    expect(textFilterSet('ann@example.com')).toBe(true);
    expect(textFilterSet(null)).toBe(false);
  });
});

describe('sendAuditedCsv', () => {
  it('puts only [A-Za-z0-9._-] of the file name into Content-Disposition', async () => {
    const headers = new Map<string, unknown>();
    const res = { setHeader: (k: string, v: unknown) => headers.set(k, v), status: () => res, send: () => res };
    const req = { user: { id: 'admin-1' }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    await sendAuditedCsv(req as never, res as never, {
      export: 'audit', filename: 'a"b\r\nX-Evil: 1;.csv', filters: {}, header: ['h'], lines: [],
    });
    expect(headers.get('Content-Disposition')).toBe('attachment; filename="a_b__X-Evil__1_.csv"');
  });
});

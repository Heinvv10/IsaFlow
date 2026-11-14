/**
 * adminCsvExport.csvRow (audit 3.8): text that starts like a formula is written as
 * text ('=…), but a number is a number: -5 stays -5, quoted, never '-5.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: vi.fn() }));

import { csvRow, textFilterSet } from '@/modules/admin/services/adminCsvExport';

describe('csvRow', () => {
  it('quotes every cell, neutralises formula text, leaves numbers alone', () => {
    expect(csvRow([-5, 3.5, 0, '-5', '=1+1', '+SUM(A1)', '@x', 'plain', 'say "hi"'])).toBe(
      `"-5","3.5","0","'-5","'=1+1","'+SUM(A1)","'@x","plain","say ""hi"""`);
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

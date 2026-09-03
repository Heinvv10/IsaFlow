import { describe, expect, it } from 'vitest';
import {
  buildEnvelope,
  isDetailLevel,
  type ExcludedRow,
} from '@/lib/mcp/contracts/envelope';

const BASE = { as_at: '2026-09-03', posted_through: '2026-09-03T10:00:00.000Z' };

describe('buildEnvelope', () => {
  it('derives rowsReturned and truncated from the page and the total', () => {
    const env = buildEnvelope({ ...BASE, rows: [1, 2, 3], rowsTotal: 118, detail: 'standard' });
    expect(env.rowsReturned).toBe(3);
    expect(env.rowsTotal).toBe(118);
    expect(env.truncated).toBe(true);
  });

  it('is not truncated when the page is the whole book', () => {
    const env = buildEnvelope({ ...BASE, rows: [1, 2], rowsTotal: 2, detail: 'standard' });
    expect(env.truncated).toBe(false);
    expect(env.next_cursor).toBeNull();
  });

  it('throws when rowsTotal is below the rows served — the count and page queries disagree', () => {
    expect(() =>
      buildEnvelope({ ...BASE, rows: [1, 2, 3], rowsTotal: 2, detail: 'standard' }),
    ).toThrow(/rowsTotal/);
  });

  it('refuses to serve rows at detail "summary"', () => {
    expect(() =>
      buildEnvelope({ ...BASE, rows: [1], rowsTotal: 1, detail: 'summary' }),
    ).toThrow(/summary/);
  });

  it('reports a summary as complete rather than truncated', () => {
    const env = buildEnvelope({ ...BASE, rows: [], rowsTotal: 118, detail: 'summary' });
    expect(env.truncated).toBe(false);
    expect(env.rowsReturned).toBe(0);
    expect(env.rowsTotal).toBe(118);
  });

  it('always returns excludedRows as an array, never undefined', () => {
    const env = buildEnvelope({ ...BASE, rows: [], rowsTotal: 0, detail: 'standard' });
    expect(env.excludedRows).toEqual([]);
  });

  it('carries the excluded rows and their amounts through', () => {
    // The R1,058,000 null-due-date invoice that vanished from the aged debtors.
    const excluded: ExcludedRow[] = [
      { id: 'inv-133', reason: 'null_due_date', amount: 1058000, documentNumber: 'INV0000133' },
    ];
    const env = buildEnvelope({
      ...BASE,
      rows: [],
      rowsTotal: 0,
      detail: 'standard',
      excludedRows: excluded,
    });
    expect(env.excludedRows[0]?.amount).toBe(1058000);
    expect(env.excludedRows[0]?.reason).toBe('null_due_date');
  });

  it('omits figureBasis entirely when not supplied rather than emitting undefined', () => {
    const env = buildEnvelope({ ...BASE, rows: [], rowsTotal: 0, detail: 'standard' });
    expect('figureBasis' in env).toBe(false);
  });

  it('keeps as_at and posted_through verbatim so a figure can be re-derived', () => {
    const env = buildEnvelope({ ...BASE, rows: [], rowsTotal: 0, detail: 'standard' });
    expect(env.as_at).toBe('2026-09-03');
    expect(env.posted_through).toBe('2026-09-03T10:00:00.000Z');
  });
});

describe('isDetailLevel', () => {
  it.each(['summary', 'standard', 'full'])('accepts %s', (v) => {
    expect(isDetailLevel(v)).toBe(true);
  });
  it.each(['invoices', 'boxes', '', 'FULL', null, 3])('rejects %s', (v) => {
    expect(isDetailLevel(v)).toBe(false);
  });
});

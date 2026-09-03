import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeSound,
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

  // A read tool runs with NO savepoint: a throw here aborts the request
  // transaction and the caller gets a 500 with the Flow debit unrefunded.
  it('never throws when the count and page queries disagree', () => {
    expect(() =>
      buildEnvelope({ ...BASE, rows: [1, 2, 3], rowsTotal: 2, detail: 'standard' }),
    ).not.toThrow();
  });

  it('records the count/page disagreement as a fault and raises the total to what it served', () => {
    const env = buildEnvelope({ ...BASE, rows: [1, 2, 3], rowsTotal: 2, detail: 'standard' });
    expect(env.completenessFault).toMatch(/rowsTotal/);
    // An understated total reads as "this is the whole book" — the worse error.
    expect(env.rowsTotal).toBe(3);
    expect(env.truncated).toBe(false);
  });

  it('drops rows served at detail "summary" and says so', () => {
    const env = buildEnvelope({ ...BASE, rows: [1], rowsTotal: 1, detail: 'summary' });
    expect(env.rows).toEqual([]);
    expect(env.rowsReturned).toBe(0);
    expect(env.completenessFault).toMatch(/summary/);
  });

  // The finding this whole contract exists to prevent: a report filters
  // `WHERE due_date IS NOT NULL` in BOTH its count and its page, forgets to
  // collect the excluded rows, and hands over an internally consistent envelope
  // that is missing R1,058,000.
  it('catches rows that are neither included nor excluded, against the universe', () => {
    const env = buildEnvelope({
      ...BASE,
      rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      rowsTotal: 10,
      universeTotal: 11,
      detail: 'standard',
    });
    expect(env.completenessFault).toMatch(/1 unaccounted/);
  });

  it('is silent when the excluded rows account for the difference', () => {
    const env = buildEnvelope({
      ...BASE,
      rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      rowsTotal: 10,
      universeTotal: 11,
      excludedRows: [{ id: 'inv-133', reason: 'null_due_date', amount: 1058000 }],
      detail: 'standard',
    });
    expect(env.completenessFault).toBeUndefined();
    expect(() => assertEnvelopeSound(env)).not.toThrow();
  });

  it('counts excluded rows against the universe even on a paged report', () => {
    const env = buildEnvelope({
      ...BASE,
      rows: [1, 2],
      rowsTotal: 118,
      universeTotal: 120,
      excludedRows: [{ id: 'a', reason: 'no_control_account' }],
      detail: 'standard',
    });
    expect(env.completenessFault).toMatch(/119 rows accounted for/);
  });

  it('assertEnvelopeSound turns a fault into a test failure', () => {
    const env = buildEnvelope({ ...BASE, rows: [1, 2, 3], rowsTotal: 2, detail: 'standard' });
    expect(() => assertEnvelopeSound(env)).toThrow(/completeness fault/);
  });

  it('omits completenessFault entirely when the arithmetic holds', () => {
    const env = buildEnvelope({ ...BASE, rows: [1], rowsTotal: 1, universeTotal: 1, detail: 'standard' });
    expect('completenessFault' in env).toBe(false);
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

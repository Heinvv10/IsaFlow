import { describe, expect, it } from 'vitest';
import { diffSets, fieldDiff, recordedAfter, tbDeltas } from '@/modules/accounting/services/audit/comparisonDiff';
import { neutraliseCell, toCsv } from '@/modules/accounting/services/audit/csv';
import { sumMoney } from '@/modules/accounting/services/audit/documents';

const k = (id: string, row: Record<string, string | null>, h = id) => ({ id, row, materialHash: h });

describe('diffSets', () => {
  it('splits added, removed and changed by id and hash, with field-level before / after', () => {
    const before = [k('a', { x: '1' }), k('b', { x: '2', y: null }), k('c', { x: '3' })];
    const after = [k('a', { x: '1' }), k('b', { x: '9', y: 'new' }, 'b2'), k('d', { x: '4' })];
    const d = diffSets(before, after);
    expect(d.added.map((r) => r.id)).toEqual(['d']);
    expect(d.removed.map((r) => r.id)).toEqual(['c']);
    expect(d.changed.map((c) => [c.after.id, c.fields])).toEqual([['b', [
      { field: 'x', before: '2', after: '9' }, { field: 'y', before: null, after: 'new' }]]]);
  });
  it('the same hash is unchanged even if the row objects differ in key order', () => {
    expect(diffSets([k('a', { x: '1', y: '2' })], [k('a', { y: '2', x: '1' })]).changed).toEqual([]);
  });
  it('fieldDiff treats a missing key as null', () => {
    expect(fieldDiff({ a: '1' }, { a: '1', b: null }, ['a', 'b'])).toEqual([]);
    expect(fieldDiff({ a: '1' }, {}, ['a'])).toEqual([{ field: 'a', before: '1', after: null }]);
  });
  it('a column frozen after the base was taken is not a change to every row (blind r2 M2)', () => {
    // The base froze {x}; today's rows carry a newly frozen column too, set on some rows and null on others.
    const before = [k('a', { x: '1' }), k('b', { x: '2' }), k('c', { x: '3' })];
    const after = [k('a', { x: '1', vat: 'S' }, 'a2'), k('b', { x: '2', vat: null }, 'b2'), k('c', { x: '7', vat: 'Z' }, 'c2')];
    const d = diffSets(before, after);
    expect(d.changed.map((c) => [c.after.id, c.fields])).toEqual([['c', [{ field: 'x', before: '3', after: '7' }]]]);
    expect(d.notCompared).toEqual(['vat']);
    expect(diffSets(after, before).notCompared).toEqual(['vat']);
    expect(diffSets([k('a', { x: '1' })], [k('a', { x: '1' })]).notCompared).toEqual([]);
  });
});

describe('recordedAfter', () => {
  const taken = '2026-07-01T10:00:00.000000Z';
  it('is true when created or posted after the snapshot, false otherwise', () => {
    expect(recordedAfter({ created_at: '2026-07-01T10:00:00.000001Z', posted_at: null }, taken)).toBe(true);
    expect(recordedAfter({ created_at: '2026-06-01T00:00:00.000000Z', posted_at: '2026-07-02T00:00:00.000000Z' }, taken)).toBe(true);
    expect(recordedAfter({ created_at: '2026-06-01T00:00:00.000000Z', posted_at: taken }, taken)).toBe(false);
  });
});

describe('tbDeltas', () => {
  it('lists only accounts whose closing moved, with exact decimal movement', () => {
    const before = [{ accountId: 'a', row: { closing: '100.10', account_code: '1', account_name: 'A' } },
      { accountId: 'b', row: { closing: '5.00', account_code: '2', account_name: 'B' } }];
    const after = [{ accountId: 'a', row: { closing: '100.30', account_code: '1', account_name: 'A' } },
      { accountId: 'b', row: { closing: '5.00', account_code: '2', account_name: 'B' } },
      { accountId: 'c', row: { closing: '-0.20', account_code: '3', account_name: 'C' } }];
    expect(tbDeltas(before, after)).toEqual([
      { accountId: 'a', code: '1', name: 'A', before: '100.10', after: '100.30', delta: '0.20' },
      { accountId: 'c', code: '3', name: 'C', before: '0.00', after: '-0.20', delta: '-0.20' }]);
  });
});

describe('sumMoney', () => {
  it('sums two-place decimals exactly, including negatives', () => {
    expect(sumMoney(['0.10', '0.20', '-0.05', null, '1000000000.99'])).toBe('1000000001.24');
    expect(sumMoney([])).toBe('0.00');
    expect(sumMoney(['-1.5'])).toBe('-1.50');
    expect(() => sumMoney(['1e3'])).toThrow(/not a decimal/);
  });
});

describe('CSV neutralisation', () => {
  it('prefixes a formula-looking cell, leaves a negative number alone', () => {
    for (const s of ['=1+1', '+SUM(A1)', '-cmd', '@x', '\tx', '\rx']) expect(neutraliseCell(s)).toBe(`'${s}`);
    expect(neutraliseCell('-1000.00')).toBe('-1000.00');
    expect(neutraliseCell('plain')).toBe('plain');
    expect(neutraliseCell(null)).toBe('');
  });
  it('quotes every cell and doubles quotes', () => {
    expect(toCsv(['a', 'b'], [['x"y', '=HYPERLINK("u")']])).toBe('"a","b"\r\n"x""y","\'=HYPERLINK(""u"")"\r\n');
  });
});
